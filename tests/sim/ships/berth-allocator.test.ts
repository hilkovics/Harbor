// BerthAllocator (T02-05, ARCHITECTURE §5.4, ADR-016 bod alokácie): skupina s dĺžkou, hĺbkou a kompatibilným
// žeriavom; v skupine najmenší počet kotvísk, potom najmenší index po pobreží; úsek musí byť voľný, mať kompatibilný
// žeriav a pás vody pre šírku lode. Čistá funkcia — svet nemení.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { allocateBerths, hasCompatibleCrane, type BerthRequest } from '@sim/ships';
import type { World } from '@sim/world';
import {
  BULK_CRANE,
  CRANE,
  DEEP_SHIP,
  EAST_BERTH,
  GAP_BERTH,
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
