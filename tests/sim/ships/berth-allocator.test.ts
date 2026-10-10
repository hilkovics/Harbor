// BerthAllocator (T02-05, ARCHITECTURE §5.4, ADR-016 bod alokácie): skupina s dĺžkou a kompatibilným žeriavom;
// v skupine najmenší počet kotvísk, potom najmenší index po pobreží; úsek musí byť voľný, mať kompatibilný žeriav,
// pás vody pre šírku lode a každé kotvisko dosť hlboké pre ponor (T02-14). Čistá funkcia — svet nemení.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { BerthModule } from '@sim/modules';
import { allocateBerths, berthReadiness, hasCompatibleCrane, type BerthRequest } from '@sim/ships';
import type { World } from '@sim/world';
import {
  BULK_CRANE,
  CRANE,
  DEEP_BERTH,
  DEEP_SHIP,
  DEEP_ZONE_BERTH,
  EAST_BERTH,
  GAP_BERTH,
  SHALLOW_NEIGHBOR_BERTH,
  ROOT_BERTH_ID,
  SHIP_DEFS,
  WEST_BERTH,
  WIDE_SHIP,
  berth,
  newWorld,
  placeModule,
} from './ship-fixtures';

const request = (classId: string, cargoCategory: BerthRequest['cargoCategory'] = 'container'): BerthRequest => ({
  def: SHIP_DEFS.ships.get(classId),
  cargoCategory,
});

const ids = (world: World, req: BerthRequest): EntityId[] | null => allocateBerths(world, req)?.map((b) => b.id) ?? null;

describe('allocateBerths — dĺžka a počet kotvísk', () => {
  it('feeder (6) dostane samotný Root (8); handy (10) na samotnom Roote nemá miesto → null', () => {
    const world = newWorld();
    expect(ids(world, request('feeder'))).toEqual([ROOT_BERTH_ID]);
    expect(ids(world, request('handy'))).toBeNull();
  });

  it('Root + (48,14) = skupina 16: handy dostane oba v poradí po pobreží, feeder len Root (najmenší počet, najmenší index)', () => {
    const world = newWorld();
    const east = placeModule(world, 'berth_standard', EAST_BERTH);
    expect(ids(world, request('handy'))).toEqual([ROOT_BERTH_ID, east]);
    expect(ids(world, request('feeder'))).toEqual([ROOT_BERTH_ID]);
  });

  it('berth oddelený medzerou (30,14) netvorí s Rootom skupinu 16 → handy null', () => {
    const world = newWorld();
    placeModule(world, 'berth_standard', GAP_BERTH);
    expect(world.berthGroups.map((g) => g.totalLength)).toEqual([8, 8]);
    expect(ids(world, request('handy'))).toBeNull();
  });

  it('tri kotviská (32, 40, 48), žeriav len na Roote: handy dostane prvý dvojúsek so žeriavom [West, Root]', () => {
    const world = newWorld();
    const east = placeModule(world, 'berth_standard', EAST_BERTH);
    const west = placeModule(world, 'berth_standard', WEST_BERTH);
    expect(world.berthGroups[0].berthIds).toEqual([west, ROOT_BERTH_ID, east]);
    expect(ids(world, request('handy'))).toEqual([west, ROOT_BERTH_ID]);
    expect(ids(world, request('feeder'))).toEqual([ROOT_BERTH_ID]);
  });
});

describe('allocateBerths — žeriav, obsadenosť, hĺbka, šírka', () => {
  it('úsek musí mať kompatibilný žeriav: feeder pri žeriave len na (48,14) dostane (48,14), nie Root', () => {
    const world = newWorld();
    const east = placeModule(world, 'berth_standard', EAST_BERTH);
    // Root žeriav je kontajnerový; sypká loď potrebuje sypký žeriav — ten stojí na (48,14).
    placeModule(world, BULK_CRANE, { x: 51, y: 14 });
    expect(ids(world, request('feeder', 'bulk'))).toEqual([east]);
    expect(hasCompatibleCrane(world, berth(world, ROOT_BERTH_ID), 'bulk')).toBe(false);
    expect(hasCompatibleCrane(world, berth(world, east), 'bulk')).toBe(true);
  });

  it('skupina bez kompatibilného žeriavu sa preskočí (berth (30,14) bez žeriavu) aj keď je prvá podľa id', () => {
    const world = newWorld();
    const gap = placeModule(world, 'berth_standard', GAP_BERTH);
    expect(world.berthGroups[0].berthIds).toEqual([gap]);
    expect(ids(world, request('feeder'))).toEqual([ROOT_BERTH_ID]);
  });

  it('skupiny sa prechádzajú podľa id: kompatibilný žeriav v oboch → prvá skupina', () => {
    const world = newWorld();
    const gap = placeModule(world, 'berth_standard', GAP_BERTH);
    placeModule(world, CRANE, { x: 33, y: 14 });
    expect(ids(world, request('feeder'))).toEqual([gap]);
  });

  it('obsadené alebo rezervované kotvisko (dockedShipId) sa nepoužije; úsek cez obsadené kotvisko tiež nie', () => {
    const world = newWorld();
    const east = placeModule(world, 'berth_standard', EAST_BERTH);
    placeModule(world, CRANE, { x: 51, y: 14 });
    berth(world, ROOT_BERTH_ID).dockedShipId = 500 as EntityId;
    expect(ids(world, request('feeder'))).toEqual([east]);
    expect(ids(world, request('handy'))).toBeNull();
    berth(world, east).dockedShipId = 501 as EntityId;
    expect(ids(world, request('feeder'))).toBeNull();
  });

  it('ponor: loď s draftClass 2 pri skupine s minDepth 1 → null', () => {
    const world = newWorld();
    expect(world.berthGroups[0].minDepth).toBe(1);
    expect(ids(world, request(DEEP_SHIP))).toBeNull();
  });

  it('ponor po kotviskách (T02-14): hlboký úsek vyhovuje aj vedľa plytkého suseda v tej istej skupine', () => {
    const world = newWorld();
    const deep = placeModule(world, DEEP_BERTH, DEEP_ZONE_BERTH);
    const shallow = placeModule(world, 'berth_standard', SHALLOW_NEIGHBOR_BERTH);
    placeModule(world, CRANE, { x: 9, y: 12 });
    const group = world.berthGroups.find((candidate) => candidate.berthIds.includes(deep));
    expect(group).toMatchObject({ berthIds: [deep, shallow], totalLength: 16, minDepth: 1 });
    expect([berth(world, deep).depthClass, berth(world, shallow).depthClass]).toEqual([2, 1]);
    // Skupina s minDepth 1 sa pre ponor 2 nevyradí — rozhoduje hĺbka kotvísk úseku.
    expect(ids(world, request(DEEP_SHIP))).toEqual([deep]);
    expect(ids(world, request('feeder'))).toEqual([deep]);
    // Loď dlhšia než hlboké kotvisko by potrebovala aj plytkého suseda → žiadny úsek.
    const longDeep: BerthRequest = { def: { lengthCells: 10, widthCells: 2, draftClass: 2 }, cargoCategory: 'container' };
    expect(ids(world, longDeep)).toBeNull();
  });

  it('ponor po kotviskách: žeriav len na plytkom kotvisku → hlboká loď null, plytká dostane plytké kotvisko', () => {
    const world = newWorld();
    placeModule(world, DEEP_BERTH, DEEP_ZONE_BERTH);
    const shallow = placeModule(world, 'berth_standard', SHALLOW_NEIGHBOR_BERTH);
    placeModule(world, CRANE, { x: 17, y: 12 });
    expect(ids(world, request(DEEP_SHIP))).toBeNull();
    expect(ids(world, request('feeder'))).toEqual([shallow]);
  });

  it('šírka: loď širšia než pás vody kotviska (frontWaterCells 3) → null', () => {
    const world = newWorld();
    expect(SHIP_DEFS.ships.get(WIDE_SHIP).widthCells).toBeGreaterThan(berth(world, ROOT_BERTH_ID).params.frontWaterCells);
    expect(ids(world, request(WIDE_SHIP))).toBeNull();
  });

  it('svet nemení (žiadna rezervácia)', () => {
    const world = newWorld();
    const before = JSON.stringify(world.serialize());
    allocateBerths(world, request('feeder'));
    expect(berth(world, ROOT_BERTH_ID).dockedShipId).toBeNull();
    expect(JSON.stringify(world.serialize())).toBe(before);
  });
});

// T06-08b (review src/sim po T06-07, ADR-031 dodatok): pripravenosť posudzuje aj statickú dosiahnuteľnosť úseku
// (predikát podľa prvého kotviska úseku). Poradie verdiktov: ready > no_crane (dosiahnuteľný úsek bez žeriavu) >
// unreachable (úsek tvarom vyhovuje, ale loď k nemu nedopláva) > no_berth.
describe('berthReadiness — dosiahnuteľnosť úseku (T06-08b)', () => {
  /** Predikát dosiahnuteľnosti: prvé kotvisko úseku je v `firsts`. */
  const only =
    (...firsts: EntityId[]) =>
    (first: BerthModule): boolean =>
      firsts.includes(first.id);

  it('bez predikátu sa dosiahnuteľnosť neposudzuje (ready); nedosiahnuteľný jediný úsek so žeriavom → unreachable', () => {
    const world = newWorld();
    expect(berthReadiness(world, request('feeder'))).toBe('ready');
    expect(berthReadiness(world, request('feeder'), only())).toBe('unreachable');
    expect(berthReadiness(world, request('feeder'), only(ROOT_BERTH_ID))).toBe('ready');
  });

  it('dosiahnuteľný úsek bez žeriavu má prednosť pred nedosiahnuteľným so žeriavom → no_crane', () => {
    const world = newWorld();
    const east = placeModule(world, 'berth_standard', EAST_BERTH);
    expect(berthReadiness(world, request('feeder'), only(east))).toBe('no_crane');
  });

  it('handy (10): rozhoduje prvé kotvisko dvojúseku — [Root, East] aj [West, Root] majú žeriav', () => {
    const world = newWorld();
    const east = placeModule(world, 'berth_standard', EAST_BERTH);
    const west = placeModule(world, 'berth_standard', WEST_BERTH);
    expect(berthReadiness(world, request('handy'), only(ROOT_BERTH_ID))).toBe('ready');
    expect(berthReadiness(world, request('handy'), only(west))).toBe('ready');
    expect(berthReadiness(world, request('handy'), only(east))).toBe('unreachable');
  });

  it('úsek, ktorý tvarom nevyhovuje, predikát nevolá; bez úseku → no_berth', () => {
    const world = newWorld();
    const asked: EntityId[] = [];
    const record = (first: BerthModule): boolean => {
      asked.push(first.id);
      return true;
    };
    expect(berthReadiness(world, request('handy'), record)).toBe('no_berth');
    expect(berthReadiness(world, request(WIDE_SHIP), record)).toBe('no_berth');
    expect(asked).toEqual([]);
  });
});
