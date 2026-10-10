// CargoLedger (ARCHITECTURE §7.1, pravidlo 2): jediný zdroj polohy nákladu — create/move, atomickosť pri chybe,
// CargoMoved { unitId, from, to, tick }, indexy podľa držiteľa, `exported` ako konečný stav a konzervácia.
import { describe, expect, it } from 'vitest';
import {
  CARGO_HOLDER_KINDS,
  CARGO_LOCATION_KINDS,
  CARGO_TRANSITIONS,
  CargoError,
  CargoTransitionError,
  holderIdOf,
  type CargoHolderKind,
  type CargoLocation,
  type CargoLocationKind,
} from '@sim/cargo';
import { Rng, type ContractId, type EntityId } from '@sim/core';
import {
  CONTAINER_CHAIN,
  GRAIN,
  GRAIN_BATCH,
  LIQUID_CHAIN,
  RORO_CHAIN,
  RTG_DISCHARGE_CHAIN,
  RTG_LOAD_CHAIN,
  SAMPLE_LOCATIONS,
  TEU,
  at,
  createHarness,
  flushMoves,
  id,
  importUnit,
  moveThrough,
  snapshot,
  type LedgerHarness,
} from './cargo-fixtures';

const SHIP = 100;
const OTHER_SHIP = 101;
const CRANE = 20;
const BERTH = 10;

/** Harness s `count` jednotkami TEU na lodi `SHIP` (id 1…count). */
function withUnits(count: number, options: Parameters<typeof createHarness>[0] = {}): LedgerHarness & { units: EntityId[] } {
  const harness = createHarness(options);
  const units = Array.from({ length: count }, () => harness.ledger.create(TEU, at.ship(SHIP)).id);
  return { ...harness, units };
}

/** Očakáva, že `action` vyhodí chybu `code` a pozorovateľný stav (ledger, id, udalosti) ostane nezmenený. */
function expectAtomicFailure(harness: LedgerHarness, action: () => void, code: CargoError['code']): CargoError {
  const before = snapshot(harness);
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CargoError);
  const error = caught as CargoError;
  expect(error.code).toBe(code);
  expect(snapshot(harness)).toEqual(before);
  harness.ledger.assertConservation();
  return error;
}

describe('CargoLedger.create', () => {
  it('id zo spoločného alokátora, quantity = unitsPerBatch, contractId predvolene null, lokácia na lodi', () => {
    const harness = createHarness();
    expect(harness.ids.next()).toBe(1); // iná entita (napr. loď) dostala id 1
    const teu = harness.ledger.create(TEU, at.ship(SHIP));
    const grain = harness.ledger.create(GRAIN, at.ship(SHIP), 77 as ContractId);
    expect(teu).toEqual(importUnit({ id: id(2), location: at.ship(SHIP) }));
    expect(grain).toEqual(importUnit({ id: id(3), typeId: GRAIN, contractId: 77 as ContractId, quantity: GRAIN_BATCH, location: at.ship(SHIP) }));
    expect(Object.keys(teu)).toEqual(['id', 'typeId', 'contractId', 'voyageId', 'lineId', 'direction', 'destinationPort', 'weightClass', 'sizeFt', 'containerType', 'oog', 'hold', 'status', 'repairUntilTick', 'reefer', 'quantity', 'location']);
    expect(harness.ids.next()).toBe(4);
  });

  it('vrátená jednotka a jej lokácia sú zmrazené a nezdieľajú objekt volajúceho', () => {
    const { ledger } = createHarness();
    const input = { kind: 'on_ship', shipId: id(SHIP) } as { kind: 'on_ship'; shipId: EntityId };
    const unit = ledger.create(TEU, input);
    input.shipId = id(OTHER_SHIP);
    expect(Object.isFrozen(unit)).toBe(true);
    expect(Object.isFrozen(unit.location)).toBe(true);
    expect(unit.location).toEqual(at.ship(SHIP));
    expect(ledger.get(unit.id)).toBe(unit);
    expect(ledger.unitsOnShip(id(OTHER_SHIP))).toEqual([]);
  });

  it('vznik nemá udalosť (ohlási ho zdroj, napr. ShipSpawned) a zvýši počítadlá', () => {
    const harness = createHarness();
    harness.ledger.create(TEU, at.ship(SHIP));
    harness.ledger.create(TEU, at.ship(OTHER_SHIP));
    expect(harness.events.pending).toBe(0);
    expect(harness.ledger.createdCount).toBe(2);
    expect(harness.ledger.liveCount).toBe(2);
    expect(harness.ledger.exportedCount).toBe(0);
    expect(harness.ledger.countByKind('on_ship')).toBe(2);
    expect(harness.ledger.countAt('on_ship', id(SHIP))).toBe(1);
    harness.ledger.assertConservation();
  });

  it('neznámy typ nákladu → CargoError unknown_cargo_type, stav ani id sa nezmenia', () => {
    const harness = withUnits(1);
    const error = expectAtomicFailure(harness, () => harness.ledger.create('crude_oil', at.ship(SHIP)), 'unknown_cargo_type');
    expect(error.message).toMatch(/neznámy typ nákladu 'crude_oil'/);
  });

  it('neplatná lokácia → CargoError invalid_input s cestou', () => {
    const harness = withUnits(1);
    const bad = { kind: 'on_ship', shipId: 0 } as unknown as CargoLocation;
    const error = expectAtomicFailure(harness, () => harness.ledger.create(TEU, bad), 'invalid_input');
    expect(error.message).toMatch(/CargoLedger\.create: neplatná lokácia\/shipId/);
  });

  it.each(CARGO_LOCATION_KINDS.filter((kind) => kind !== 'on_ship'))(
    'vznik v %s → CargoTransitionError (from = null), stav sa nezmení',
    (kind) => {
      const harness = withUnits(1);
      const error = expectAtomicFailure(harness, () => harness.ledger.create(TEU, SAMPLE_LOCATIONS[kind]), 'transition');
      expect(error).toBeInstanceOf(CargoTransitionError);
      const transition = error as CargoTransitionError;
      expect(transition.unitId).toBeNull();
      expect(transition.from).toBeNull();
      expect(transition.to).toEqual(SAMPLE_LOCATIONS[kind]);
      expect(transition.message).toMatch(/nová jednotka: nepovolený prechod vznik v .*on_ship/);
    },
  );

  it.each([0, -1, 1.5])('contractId %s → CargoError invalid_input', (contractId) => {
    const harness = withUnits(1);
    expectAtomicFailure(harness, () => harness.ledger.create(TEU, at.ship(SHIP), contractId as ContractId), 'invalid_input');
  });
});

describe('CargoLedger.move — nepovolený prechod a atomickosť', () => {
  it('on_ship → in_storage → CargoTransitionError s jednotkou, from, to a povolenými cieľmi', () => {
    const harness = withUnits(1);
    const [unitId] = harness.units;
    const error = expectAtomicFailure(harness, () => harness.ledger.move(unitId, at.storage(40, 0)), 'transition');
    expect(error).toBeInstanceOf(CargoTransitionError);
    expect(error.name).toBe('CargoTransitionError');
    const transition = error as CargoTransitionError;
    expect(transition.unitId).toBe(unitId);
    expect(transition.from).toEqual(at.ship(SHIP));
    expect(transition.to).toEqual(at.storage(40, 0));
    expect(transition.message).toBe(
      'CargoLedger: jednotka #1: nepovolený prechod on_ship(shipId=100) → in_storage(moduleId=40, slot=0) — ' +
        "z 'on_ship' smie ísť len do: in_crane, in_pipeline, in_vehicle, shipped",
    );
  });

  it.each(
    CARGO_LOCATION_KINDS.filter((kind) => kind !== 'on_ship' && !(CARGO_TRANSITIONS.get('on_ship') ?? []).includes(kind)),
  )('on_ship → %s je odmietnutý bez zmeny stavu', (kind) => {
    const harness = withUnits(2);
    expectAtomicFailure(harness, () => harness.ledger.move(harness.units[0], SAMPLE_LOCATIONS[kind]), 'transition');
  });

  it('presun v rámci toho istého druhu (apron slot 0 → slot 1) nie je prechod', () => {
    const harness = withUnits(1);
    const [unitId] = harness.units;
    moveThrough(harness.ledger, unitId, [at.crane(CRANE), at.apron(BERTH, 0)]);
    harness.events.flush();
    expectAtomicFailure(harness, () => harness.ledger.move(unitId, at.apron(BERTH, 1)), 'transition');
  });

  it('neznáma jednotka → CargoError unknown_unit', () => {
    const harness = withUnits(1);
    const error = expectAtomicFailure(harness, () => harness.ledger.move(id(999), at.crane(CRANE)), 'unknown_unit');
    expect(error.message).toMatch(/#999 neexistuje/);
  });

  it('neplatný cieľ → CargoError invalid_input (pred kontrolou prechodu)', () => {
    const harness = withUnits(1);
    const bad = { kind: 'in_crane', craneId: 'x' } as unknown as CargoLocation;
    const error = expectAtomicFailure(harness, () => harness.ledger.move(harness.units[0], bad), 'invalid_input');
    expect(error.message).toMatch(/CargoLedger\.move\(#1\): neplatná lokácia\/craneId/);
  });

  it('obsadený slot apronu → CargoError slot_occupied; iný berth s rovnakým slotom je voľný', () => {
    const harness = withUnits(3);
    const [a, b, c] = harness.units;
    moveThrough(harness.ledger, a, [at.crane(CRANE), at.apron(BERTH, 2)]);
    harness.ledger.move(b, at.crane(CRANE + 1));
    harness.events.flush();
    const error = expectAtomicFailure(harness, () => harness.ledger.move(b, at.apron(BERTH, 2)), 'slot_occupied');
    expect(error.message).toBe(
      'CargoLedger: jednotka #2: miesto on_apron(berthId=10, slot=2) už obsadila jednotka #1',
    );
    harness.ledger.move(b, at.apron(BERTH + 1, 2));
    moveThrough(harness.ledger, c, [at.crane(CRANE), at.apron(BERTH, 3)]);
    expect(harness.ledger.unitAtSlot('on_apron', id(BERTH), 2)).toBe(a);
    expect(harness.ledger.unitAtSlot('on_apron', id(BERTH + 1), 2)).toBe(b);
  });

  it('uvoľnený slot (jednotka odišla do vozidla) môže obsadiť ďalšia jednotka', () => {
    const harness = withUnits(2);
    const [a, b] = harness.units;
    moveThrough(harness.ledger, a, [at.crane(CRANE), at.apron(BERTH, 0), at.vehicle(30)]);
    moveThrough(harness.ledger, b, [at.crane(CRANE), at.apron(BERTH, 0)]);
    expect(harness.ledger.unitAtSlot('on_apron', id(BERTH), 0)).toBe(b);
  });

  it('obsadený slot skladu → slot_occupied; kamión drží viac jednotiek', () => {
    const harness = withUnits(3);
    const [a, b, c] = harness.units;
    const toVehicle = [at.crane(CRANE), at.apron(BERTH, 0), at.vehicle(30)];
    moveThrough(harness.ledger, a, [...toVehicle, at.storage(40, 5)]);
    moveThrough(harness.ledger, b, toVehicle);
    harness.events.flush();
    expectAtomicFailure(harness, () => harness.ledger.move(b, at.storage(40, 5)), 'slot_occupied');
    harness.ledger.move(b, at.truck(50));
    moveThrough(harness.ledger, c, [...toVehicle, at.truck(50)]);
    expect(harness.ledger.unitsAt('in_truck', id(50))).toEqual([b, c]);
    expect(harness.ledger.unitAtSlot('in_truck', id(50), 1)).toBeUndefined();
  });

  it('exported je konečný: exportovaná jednotka sa už nepohne (unknown_unit) a get vráti undefined', () => {
    const harness = withUnits(1);
    const [unitId] = harness.units;
    moveThrough(harness.ledger, unitId, CONTAINER_CHAIN);
    harness.events.flush();
    expect(harness.ledger.get(unitId)).toBeUndefined();
    for (const kind of CARGO_LOCATION_KINDS) {
      expectAtomicFailure(harness, () => harness.ledger.move(unitId, SAMPLE_LOCATIONS[kind]), 'unknown_unit');
    }
  });
});

describe('CargoLedger.move — úspešný presun a CargoMoved', () => {
  it('emituje práve jednu udalosť CargoMoved { type, unitId, from, to, tick } s aktuálnym tickom', () => {
    const harness = withUnits(1, { tick: 41 });
    const [unitId] = harness.units;
    harness.ledger.move(unitId, at.crane(CRANE));
    harness.clock.tick = 42;
    harness.ledger.move(unitId, at.apron(BERTH, 3));
    expect(harness.events.flush()).toEqual([
      { type: 'CargoMoved', unitId, from: at.ship(SHIP), to: at.crane(CRANE), tick: 41 },
      { type: 'CargoMoved', unitId, from: at.crane(CRANE), to: at.apron(BERTH, 3), tick: 42 },
    ]);
  });

  it('udalosť nesie zmrazené lokácie nezávislé od objektu volajúceho; get vráti novú snímku', () => {
    const harness = withUnits(1);
    const [unitId] = harness.units;
    const before = harness.ledger.get(unitId);
    const target = { kind: 'in_crane', craneId: id(CRANE) } as { kind: 'in_crane'; craneId: EntityId };
    harness.ledger.move(unitId, target);
    target.craneId = id(CRANE + 5);
    const [event] = flushMoves(harness.events);
    expect(Object.isFrozen(event.from)).toBe(true);
    expect(Object.isFrozen(event.to)).toBe(true);
    expect(event.to).toEqual(at.crane(CRANE));
    expect(event.to).not.toBe(target);
    const after = harness.ledger.get(unitId);
    expect(after?.location).toBe(event.to);
    expect(before?.location).toEqual(at.ship(SHIP)); // stará snímka sa nezmenila
    expect(after).not.toBe(before);
    expect(after).toEqual({ ...before, location: at.crane(CRANE) });
    expect(harness.ledger.countAt('in_crane', id(CRANE))).toBe(1);
    expect(harness.ledger.countAt('in_crane', id(CRANE + 5))).toBe(0);
  });

  it.each([
    ['container/bulk', CONTAINER_CHAIN],
    ['liquid/gas', LIQUID_CHAIN],
    ['RoRo', RORO_CHAIN],
  ])('celý importný reťazec %s až po exported: udalosť za každý krok, jednotka opustí ledger', (_name, chain) => {
    const harness = withUnits(2);
    const [unitId, other] = harness.units;
    moveThrough(harness.ledger, unitId, chain);
    const moves = flushMoves(harness.events);
    expect(moves.map((event) => event.to)).toEqual(chain);
    expect(moves.map((event) => event.from)).toEqual([at.ship(SHIP), ...chain.slice(0, -1)]);
    expect(moves.every((event) => event.unitId === unitId)).toBe(true);
    expect(harness.ledger.get(unitId)).toBeUndefined();
    expect(harness.ledger.exportedCount).toBe(1);
    expect(harness.ledger.countByKind('exported')).toBe(1);
    expect(harness.ledger.liveCount).toBe(1);
    expect(harness.ledger.createdCount).toBe(2);
    expect(harness.ledger.get(other)?.location).toEqual(at.ship(SHIP));
    for (const location of chain.slice(0, -1)) {
      const holder = holderIdOf(location) as EntityId;
      expect(harness.ledger.countAt(location.kind as CargoHolderKind, holder), location.kind).toBe(0);
    }
  });
});

describe('CargoLedger — stroj bloku (in_handler, ADR-040)', () => {
  const MACHINE = 95;

  it('vykládka a nakládka cez RTG: každý krok je CargoMoved, in_handler drží jednotku len medzi vozidlom a stohom', () => {
    const harness = withUnits(1);
    const [unit] = harness.units;
    moveThrough(harness.ledger, unit, RTG_DISCHARGE_CHAIN.slice(0, 3));
    expect(harness.ledger.countAt('in_handler', id(MACHINE))).toBe(1);
    expect(harness.ledger.unitsAt('in_handler', id(MACHINE))).toEqual([unit]);
    expect(harness.ledger.countAt('in_vehicle', id(30))).toBe(0);
    harness.ledger.move(unit, RTG_DISCHARGE_CHAIN[3]);
    expect(harness.ledger.countAt('in_handler', id(MACHINE))).toBe(0);
    moveThrough(harness.ledger, unit, RTG_LOAD_CHAIN);
    expect(flushMoves(harness.events).map((move) => `${move.from.kind}→${move.to.kind}`)).toEqual([
      'on_ship→in_crane',
      'in_crane→in_vehicle',
      'in_vehicle→in_handler',
      'in_handler→in_storage',
      'in_storage→in_handler',
      'in_handler→in_vehicle',
      'in_vehicle→in_crane',
      'in_crane→on_ship',
      'on_ship→shipped',
    ]);
    harness.ledger.assertConservation();
  });

  it('stroj drží najviac jednu jednotku: druhá do toho istého in_handler → slot_occupied, stav sa nezmení; iný stroj je voľný', () => {
    const harness = withUnits(3);
    const [first, second, third] = harness.units;
    for (const unit of [first, second, third]) moveThrough(harness.ledger, unit, [at.crane(CRANE), at.vehicle(30)]);
    harness.ledger.move(first, at.handler(MACHINE));
    expectAtomicFailure(harness, () => harness.ledger.move(second, at.handler(MACHINE)), 'slot_occupied');
    harness.ledger.move(third, at.handler(MACHINE + 1));
    harness.ledger.move(first, at.storage(40, 3));
    harness.ledger.move(second, at.handler(MACHINE));
    expect(harness.ledger.unitsAt('in_handler', id(MACHINE))).toEqual([second]);
    harness.ledger.assertConservation();
  });

  it('žeriav ani kamión nesiahnu do in_handler (nepovolený prechod, stav sa nezmení)', () => {
    const harness = withUnits(1);
    const [unit] = harness.units;
    harness.ledger.move(unit, at.crane(CRANE));
    expectAtomicFailure(harness, () => harness.ledger.move(unit, at.handler(MACHINE)), 'transition');
  });
});

describe('CargoLedger — indexy podľa držiteľa', () => {
  it('unitsOnShip: vzostupne podľa id, oddelene pre každú loď; výber zo stredu zachová poradie', () => {
    const harness = createHarness();
    const ids = [SHIP, OTHER_SHIP, SHIP, SHIP, OTHER_SHIP].map((ship) => harness.ledger.create(TEU, at.ship(ship)).id);
    expect(harness.ledger.unitsOnShip(id(SHIP))).toEqual([ids[0], ids[2], ids[3]]);
    expect(harness.ledger.unitsOnShip(id(OTHER_SHIP))).toEqual([ids[1], ids[4]]);
    harness.ledger.move(ids[2], at.crane(CRANE));
    expect(harness.ledger.unitsOnShip(id(SHIP))).toEqual([ids[0], ids[3]]);
  });

  it('unitsOnApron: poradie príchodu (FIFO), nie poradie id ani slotov', () => {
    const harness = withUnits(3);
    const [a, b, c] = harness.units;
    moveThrough(harness.ledger, c, [at.crane(CRANE), at.apron(BERTH, 0)]);
    moveThrough(harness.ledger, a, [at.crane(CRANE), at.apron(BERTH, 3)]);
    moveThrough(harness.ledger, b, [at.crane(CRANE), at.apron(BERTH, 1)]);
    expect(harness.ledger.unitsOnApron(id(BERTH))).toEqual([c, a, b]);
    harness.ledger.move(a, at.vehicle(30));
    expect(harness.ledger.unitsOnApron(id(BERTH))).toEqual([c, b]);
    expect(harness.ledger.unitsAt('in_vehicle', id(30))).toEqual([a]);
  });

  it('unitsAt vracia kópiu — dá sa iterovať počas presunov z nej (vyloženie celej lode)', () => {
    const harness = withUnits(4);
    const onShip = harness.ledger.unitsOnShip(id(SHIP));
    expect(harness.ledger.unitsOnShip(id(SHIP))).not.toBe(onShip);
    onShip.forEach((unitId, slot) => {
      moveThrough(harness.ledger, unitId, [at.crane(CRANE), at.apron(BERTH, slot)]);
    });
    expect(onShip).toEqual(harness.units);
    expect(harness.ledger.unitsOnShip(id(SHIP))).toEqual([]);
    expect(harness.ledger.unitsOnApron(id(BERTH))).toEqual(harness.units);
    expect(harness.ledger.countAt('on_ship', id(SHIP))).toBe(0);
  });

  it('neznámy držiteľ: prázdny zoznam, počet 0, žiadna jednotka na slote ani prvá jednotka', () => {
    const { ledger } = withUnits(1);
    for (const kind of CARGO_HOLDER_KINDS) {
      expect(ledger.unitsAt(kind, id(12345))).toEqual([]);
      expect(ledger.countAt(kind, id(12345))).toBe(0);
      expect(ledger.unitAtSlot(kind, id(12345), 0)).toBeUndefined();
      expect(ledger.firstUnitAt(kind, id(12345))).toBeUndefined();
    }
  });

  it('firstUnitAt: loď → najmenšie id (aj po presune zo stredu), apron → najstaršia jednotka (T02-05)', () => {
    const harness = createHarness();
    const ids = [SHIP, SHIP, SHIP].map((ship) => harness.ledger.create(TEU, at.ship(ship)).id);
    expect(harness.ledger.firstUnitAt('on_ship', id(SHIP))).toBe(ids[0]);
    moveThrough(harness.ledger, ids[0], [at.crane(CRANE), at.apron(BERTH, 3)]);
    expect(harness.ledger.firstUnitAt('on_ship', id(SHIP))).toBe(ids[1]);
    moveThrough(harness.ledger, ids[2], [at.crane(CRANE), at.apron(BERTH, 0)]);
    expect(harness.ledger.firstUnitAt('on_apron', id(BERTH))).toBe(ids[0]);
    expect(harness.ledger.firstUnitAt('on_ship', id(SHIP))).toBe(ids[1]);
  });

  it('unitAtIndex: pozícia v poradí indexu (apron FIFO) bez kópie; mimo rozsahu a neznámy držiteľ → undefined (T03-05)', () => {
    const harness = withUnits(3);
    const [a, b, c] = harness.units;
    moveThrough(harness.ledger, c, [at.crane(CRANE), at.apron(BERTH, 0)]);
    moveThrough(harness.ledger, a, [at.crane(CRANE), at.apron(BERTH, 3)]);
    moveThrough(harness.ledger, b, [at.crane(CRANE), at.apron(BERTH, 1)]);
    const count = harness.ledger.countAt('on_apron', id(BERTH));
    const seen = Array.from({ length: count }, (_, i) => harness.ledger.unitAtIndex('on_apron', id(BERTH), i));
    expect(seen).toEqual(harness.ledger.unitsOnApron(id(BERTH)));
    expect(seen).toEqual([c, a, b]);
    expect(harness.ledger.unitAtIndex('on_apron', id(BERTH), count)).toBeUndefined();
    expect(harness.ledger.unitAtIndex('on_apron', id(BERTH), -1)).toBeUndefined();
    expect(harness.ledger.unitAtIndex('on_apron', id(12345), 0)).toBeUndefined();
  });

  it('unitAtSlot funguje len pre jedinečné miesta (apron, sklad)', () => {
    const harness = withUnits(1);
    const [unitId] = harness.units;
    moveThrough(harness.ledger, unitId, [at.crane(CRANE), at.apron(BERTH, 2)]);
    expect(harness.ledger.unitAtSlot('on_apron', id(BERTH), 2)).toBe(unitId);
    expect(harness.ledger.unitAtSlot('on_apron', id(BERTH), 1)).toBeUndefined();
    moveThrough(harness.ledger, unitId, [at.vehicle(30), at.storage(40, 9)]);
    expect(harness.ledger.unitAtSlot('on_apron', id(BERTH), 2)).toBeUndefined();
    expect(harness.ledger.unitAtSlot('in_storage', id(40), 9)).toBe(unitId);
  });
});

describe('CargoLedger — konzervácia', () => {
  it('prázdny ledger spĺňa invariant', () => {
    const { ledger } = createHarness();
    expect(() => ledger.assertConservation()).not.toThrow();
    for (const kind of CARGO_LOCATION_KINDS) expect(ledger.countByKind(kind)).toBe(0);
  });

  it('náhodná prechádzka 3 000 krokov (Rng so seedom): invariant po každom kroku, súčet počtov = createdCount', () => {
    const harness = createHarness();
    const { ledger } = harness;
    const rng = new Rng(20260930);
    const HOLDERS = 3;
    const SLOTS = 4;
    let rejectedSlots = 0;

    const randomTarget = (kind: CargoLocationKind): CargoLocation => {
      const holder = 1 + rng.int(0, HOLDERS - 1);
      const slot = rng.int(0, SLOTS - 1);
      const sample: Record<string, unknown> = { ...SAMPLE_LOCATIONS[kind] };
      for (const key of Object.keys(sample)) {
        if (key === 'slot' || key === 'dock') sample[key] = slot;
        else if (key !== 'kind') sample[key] = holder;
      }
      return sample as CargoLocation;
    };

    for (let step = 0; step < 3000; step++) {
      const live = CARGO_HOLDER_KINDS.flatMap((kind) =>
        Array.from({ length: HOLDERS }, (_, i) => ledger.unitsAt(kind, id(i + 1))).flat(),
      );
      if (live.length === 0 || rng.int(0, 9) === 0) {
        ledger.create(rng.pick([TEU, GRAIN]), randomTarget('on_ship'));
      } else {
        const unitId = rng.pick(live);
        const from = ledger.get(unitId)?.location.kind ?? 'exported';
        const to = randomTarget(rng.pick(CARGO_TRANSITIONS.get(from) ?? []));
        const before = snapshot(harness);
        try {
          ledger.move(unitId, to);
        } catch (error) {
          expect(error).toBeInstanceOf(CargoError);
          expect((error as CargoError).code).toBe('slot_occupied');
          expect(snapshot(harness)).toEqual(before);
          rejectedSlots += 1;
        }
      }
      ledger.assertConservation();
      const total = CARGO_LOCATION_KINDS.reduce((sum, kind) => sum + ledger.countByKind(kind), 0);
      expect(total).toBe(ledger.createdCount);
      expect(ledger.liveCount + ledger.exportedCount + ledger.shippedCount).toBe(ledger.createdCount);
    }
    harness.events.flush();
    // Prechádzka musí reálne pokryť export po súši aj odplávanie (ADR-032) a konflikty slotov, inak test nič nedokazuje.
    expect(ledger.exportedCount).toBeGreaterThan(0);
    expect(ledger.shippedCount).toBeGreaterThan(0);
    expect(rejectedSlots).toBeGreaterThan(0);
  });
});
