// Výber zo skladu so stohmi (TR2-06b; ADR-039 bod 6, dodatok TR2-06b): `rehandleRoom` (koľko kontajnerov sa dá preložiť v bloku), `unitPickable` (vrátane
// rezervovaných kontajnerov nad cieľom), gating dispatchera (`assignOpenJobs`), `logistics.buryReserveColumns` (def) a usadenie rezervácie `settleYardDrop`
// s vytlačenou rezerváciou.
import { describe, expect, it } from 'vitest';
import { DefRegistry } from '@sim/defs';
import type { EntityId } from '@sim/core';
import { TransportJob, assignOpenJobs, chooseYardSlot, rehandleRoom, unitPickable } from '@sim/logistics';
import { settleYardDrop } from '@sim/logistics/yard-settle';
import type { CargoUnit } from '@sim/cargo';
import type { YardBlock } from '@sim/modules';
import type { World } from '@sim/world';
import { APRON_MODULES, DEFS, RAW_DEFS } from '../world/world-fixtures';
import { YARD_W, buyVehicle, unitsOnApron } from './dispatch-fixtures';
import { exportLabels, newUnit, openLoadJob, stubVoyageArrivals, yardTestWorld } from './yard-fixtures';

/** Uloží jednotku na bunku `(bay, row, tier)` bloku priamo cez ledger (ako pri obnove save). */
function place(world: World, block: YardBlock, bay: number, row: number, tier: number, unit: CargoUnit = newUnit(world)): CargoUnit {
  world.cargo.move(unit.id, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(bay, row, tier) });
  return world.cargo.get(unit.id) as CargoUnit; // čerstvý záznam z ledgera (poloha po presune)
}

/** Zaplní stohy bloku po výšku `heights[row][bay]` 20′ jednotkami (okrem stohov s výškou 0). */
function fill(world: World, block: YardBlock, heights: readonly (readonly number[])[]): void {
  heights.forEach((rowHeights, row) => rowHeights.forEach((height, bay) => {
    for (let tier = 0; tier < height; tier++) place(world, block, bay, row, tier);
  }));
}

const FULL = [3, 3, 3, 3] as const;

function unit(world: World, id: EntityId): CargoUnit {
  const found = world.cargo.get(id);
  if (found === undefined) throw new Error('jednotka neexistuje');
  return found;
}

describe('rehandleRoom — koľko kontajnerov sa dá preložiť v tom istom bloku', () => {
  it('súčet voľných vrstiev stohov, ktoré smie rehandling použiť; pôvodný stoh a plné stohy sa nepočítajú', () => {
    const { world, yards } = yardTestWorld(DEFS, 3050, [YARD_W]);
    const block = yards[0];
    // Rad 0: pôvodný stoh (1, 0) s cieľom + blokátorom, stoh (0, 0) výška 1, stoh (2, 0) výška 2, (3, 0) plný; ostatné rady plné.
    const target = place(world, block, 1, 0, 0);
    const blocker = place(world, block, 1, 0, 1);
    fill(world, block, [[1, 0, 2, 3], FULL, FULL, FULL]);
    // Pôvodný stoh (1, 0) sa vynecháva; (0, 0): 2 voľné vrstvy, (2, 0): 1, ostatné 0.
    expect(rehandleRoom(world, block, blocker, block.positionOfSlot(block.slotOf(1, 0, 0)))).toBe(3);
    expect(block.burialDepth(target.id)).toBe(1);
  });

  it('stoh, ktorého vrch je 40′ (alebo prázdny pár pre 40′), 20′ nepustí; 40′ použije len pár bays rovnakej výšky', () => {
    const { world, yards } = yardTestWorld(DEFS, 3050, [YARD_W]);
    const block = yards[0];
    const wide = (): CargoUnit => newUnit(world, { ...exportLabels(1, 'medium', 40) }, 7);
    // Pár (2, 3) rad 0: cieľ 40′ + blokátor 40′; pár (0, 1) rad 0: jeden 40′ (výška 1) -> pre 40′ 2 voľné vrstvy.
    const target = place(world, block, 2, 0, 0, wide());
    const blocker = place(world, block, 2, 0, 1, wide());
    place(world, block, 0, 0, 0, wide());
    // Ostatné rady plné 20′ stohmi: stohy s 20′ navrchu 40′ nepustia.
    fill(world, block, [[0, 0, 0, 0], FULL, FULL, FULL]);
    expect(rehandleRoom(world, block, blocker, block.positionOfSlot(block.slotOf(2, 0, 0)))).toBe(2);
    expect(block.burialDepth(target.id)).toBe(1);
  });
});

describe('unitPickable — vrátane rezervovaných kontajnerov nad cieľom', () => {
  it('navrchu ležiaca jednotka a jednotka mimo bloku sa dajú vybrať vždy', () => {
    const { world, yards } = yardTestWorld(DEFS, 3050, [YARD_W]);
    const top = place(world, yards[0], 1, 0, 0);
    expect(unitPickable(world, top)).toBe(true);
    expect(unitPickable(world, newUnit(world))).toBe(true); // vo vozidle
  });

  it('zavalená jednotka: vybrať sa dá len keď je pre kontajnery nad ňou miesto (rehandleRoom ≥ hĺbka)', () => {
    const { world, yards } = yardTestWorld(DEFS, 3050, [YARD_W]);
    const block = yards[0];
    const target = place(world, block, 1, 0, 0);
    place(world, block, 1, 0, 1);
    fill(world, block, [[0, 0, 0, 0], FULL, FULL, FULL]); // v radoch 1–3 plno, v rade 0 sú voľné stohy (0, 0), (2, 0), (3, 0)
    expect(unitPickable(world, target)).toBe(true);
    // Zaplniť všetky voľné stohy: pre blokátor nezostane miesto.
    fill(world, block, [[3, 0, 3, 3]]);
    expect(unitPickable(world, target)).toBe(false);
    // Z jedného stohu odíde vrchný kontajner: miesto pre jediný blokátor je a jednotka je znova vyberateľná.
    world.cargo.move(block.topUnit(3, 0) as EntityId, { kind: 'in_vehicle', vehicleId: 903 as EntityId });
    expect(unitPickable(world, target)).toBe(true);
  });

  it('rezervovaný kontajner nad cieľom sa počíta ako kontajner, ktorý treba preložiť (hĺbka 1 aj bez uloženého blokátora)', () => {
    const { world, yards } = yardTestWorld(DEFS, 3050, [YARD_W]);
    const block = yards[0];
    const target = place(world, block, 1, 0, 0);
    const incoming = unit(world, newUnit(world).id);
    block.reserveFor(block.slotOf(1, 0, 1), incoming);
    expect([block.burialDepth(target.id), block.topBlockerOf(target.id)]).toEqual([1, null]);
    expect(unitPickable(world, target)).toBe(true); // ostatné stohy sú prázdne: miesto je
    // Ostatné stohy plné (45 + cieľ 1 + rezervácia 1 = 47 z 48) -> pre rezervovaný kontajner nie je kam, jednotka sa nevyberie.
    fill(world, block, [[3, 0, 3, 3], FULL, FULL, FULL]);
    expect(unitPickable(world, target)).toBe(false);
    // Rezervácia sa zruší (kontajner nad cieľ nepríde): jednotka je navrchu a zasa vyberateľná.
    block.release(block.slotOf(1, 0, 1));
    expect(unitPickable(world, target)).toBe(true);
  });
});

describe('dispatcher: vozidlo sa nepriradí jobu s jednotkou, ktorú nemožno vybrať', () => {
  it('assignOpenJobs preskočí job zavalenej jednotky bez miesta na rehandling; po uvoľnení bloku ho priradí', () => {
    const { world, berth, yards, depotId } = yardTestWorld(DEFS, 3050, [YARD_W]);
    const block = yards[0];
    const depot = world.modules.get(depotId);
    buyVehicle(world, depot as never);
    const target = place(world, block, 1, 0, 0);
    const blocker = place(world, block, 1, 0, 1);
    fill(world, block, [[3, 0, 3, 3], FULL, FULL, FULL]); // blok bez miesta pre blokátor (stoh (0, 0) je plný)
    expect(unitPickable(world, target)).toBe(false);
    const job = openLoadJob(world, berth, target.id);
    assignOpenJobs(world);
    expect(job.state).toBe('open');
    // Blokátor odíde (vo vozidle) a miesto sa uvoľní — job je znova priraditeľný.
    world.cargo.move(blocker.id, { kind: 'in_vehicle', vehicleId: 903 as EntityId });
    assignOpenJobs(world);
    expect(job.state).toBe('assigned');
  });
});

describe('logistics.rehandleSpareCells (def) — rezerva buniek pri priraďovaní vozidla', () => {
  it('s rezervou 2 sa vozidlo jobu zavalenej jednotky priradí až keď je miesto pre kontajnery nad ňou plus rezerva; pri vzniku jobu a pri príchode stačí samotné miesto', () => {
    const { world, berth, yards, depotId } = yardTestWorld(DEFS, 3050, [YARD_W]);
    expect(world.defs.logistics.rehandleSpareCells).toBe(2);
    const block = yards[0];
    buyVehicle(world, world.modules.get(depotId) as never);
    const target = place(world, block, 1, 0, 0);
    place(world, block, 1, 0, 1);
    fill(world, block, [[0, 0, 0, 3], FULL, FULL, FULL]); // voľné stohy (0, 0) a (2, 0): miesto pre 6 kontajnerov
    fill(world, block, [[2, 0, 1, 0]]); // (0, 0) výška 2, (2, 0) výška 1: miesto 1 + 2 = 3
    expect(rehandleRoom(world, block, unit(world, block.topUnit(1, 0) as EntityId), block.positionOfSlot(block.slotOf(1, 0, 0)))).toBe(3);
    expect(unitPickable(world, target)).toBe(true); // samotné miesto (depth 1 ≤ 3)
    expect(unitPickable(world, target, 2)).toBe(true); // 1 + 2 ≤ 3
    expect(unitPickable(world, target, 3)).toBe(false);
    // Jeden stoh sa zaplní: miesto 2 — pre samotný rehandling stačí, s rezervou 2 job nevznikne / nepridelí sa.
    place(world, block, 0, 0, 2);
    expect(unitPickable(world, target)).toBe(true);
    expect(unitPickable(world, target, 2)).toBe(false);
    const job = openLoadJob(world, berth, target.id);
    assignOpenJobs(world);
    expect(job.state).toBe('open');
  });
});

describe('logistics.buryReserveColumns (def) — kedy plánovač smie zavaliť skôr odchádzajúci kontajner', () => {
  const oneColumn = (buryReserveColumns: number): DefRegistry =>
    DefRegistry.fromRaw({
      ...RAW_DEFS,
      logistics: { ...RAW_DEFS.logistics, buryReserveColumns },
      modules: { ...APRON_MODULES, items: APRON_MODULES.items.map((item) => (item.id === 'container_yard_small' ? { ...item, params: { ...item.params, capacityUnits: 3 } } : item)) },
    });

  it.each([
    [0, true],
    [4, false],
  ])('buryReserveColumns %i: neskorší export na skorší stoh v bloku s jediným stĺpcom — povolené: %s', (reserve, allowed) => {
    const { world, berth, yards } = yardTestWorld(oneColumn(reserve), 3050, [YARD_W]);
    expect(world.defs.logistics.buryReserveColumns).toBe(reserve);
    const restore = stubVoyageArrivals(world, { 1: 1000, 2: 9000 });
    const earlier = newUnit(world, exportLabels(1, 'medium'), 7);
    place(world, yards[0], 0, 0, 0, earlier); // skorší odchod leží dole
    const later = newUnit(world, exportLabels(2, 'medium'), 8);
    expect(chooseYardSlot(world, later, berth) !== null).toBe(allowed);
    restore();
  });
});

describe('settleYardDrop s vytlačenou rezerváciou', () => {
  it('vozidlo, ktoré príde skôr, dostane skutočnú vrstvu; job druhej rezervácie dostane vytlačený slot (rebindStorageTarget)', () => {
    const { world, berth, yards } = yardTestWorld(DEFS, 3050, [YARD_W]);
    const block = yards[0];
    const [first, second] = unitsOnApron(world, [0, 1]);
    const [lower, upper] = [block.slotOf(1, 1, 0), block.slotOf(1, 1, 1)];
    block.reserveFor(lower, unit(world, first));
    block.reserveFor(upper, unit(world, second));
    const mk = (unitId: EntityId, apronSlot: number, slot: number): TransportJob => {
      const job = new TransportJob({ id: world.ids.next(), unitIds: [unitId], from: { kind: 'on_apron', berthId: berth.id, slot: apronSlot }, to: { kind: 'in_storage', moduleId: block.id, slot }, createdTick: 0 });
      world.addJob(job);
      return job;
    };
    const [jobFirst, jobSecond] = [mk(first, 0, lower), mk(second, 1, upper)];
    // `second` (rezervovaný na vrstvu 1) príde prvý do prázdneho stohu: usadí sa na vrstvu 0, `first` je vytlačený na vrstvu 1.
    settleYardDrop(world, jobSecond);
    expect([jobSecond.to, jobFirst.to]).toEqual([
      { kind: 'in_storage', moduleId: block.id, slot: lower },
      { kind: 'in_storage', moduleId: block.id, slot: upper },
    ]);
    expect(block.reservedSlots()).toEqual([lower, upper]);
    expect(block.findStackProblem()).toBeUndefined();
    // Druhé vozidlo už nemá čo usadzovať: jeho rezervácia je na výške stohu (po uložení prvej jednotky).
    world.cargo.move(second, { kind: 'in_vehicle', vehicleId: 903 as EntityId });
    world.cargo.move(second, jobSecond.to);
    block.commit(lower, second);
    settleYardDrop(world, jobFirst);
    expect(jobFirst.to).toEqual({ kind: 'in_storage', moduleId: block.id, slot: upper });
  });
});
