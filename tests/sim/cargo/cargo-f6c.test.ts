// Prázdne kontajnery, linky a tranship v ledgeri (T6C-01, ADR-034): štítky podľa smeru (`DIRECTION_LABEL_RULES`), stav kvality
// (`setStatus`, `cargoStatusProblem`), miesto vzniku podľa smeru, reťazce prázdneho a prekládky (existujúce prechody stačia),
// konzervácia a roundtrip stavu. Správanie (návrat, kontrola, oprava, nakládka) dodajú T6C-02 / T6C-03.
import { describe, expect, it } from 'vitest';
import {
  CARGO_DIRECTIONS,
  CARGO_SPAWN_KIND_BY_DIRECTION,
  CARGO_STATUSES,
  CargoError,
  CargoLedger,
  CargoTransitionError,
  DEFAULT_CARGO_STATUS,
  EMPTY_WEIGHT_CLASS,
  DEFAULT_CONTAINER_LABELS,
  IMPORT_LABELS,
  cargoLabelsProblem,
  cargoStatusProblem,
  isCargoStatus,
  type CargoUnitLabelsInput,
} from '@sim/cargo';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import { EXPORT_LABELS, TEU, at, createHarness, flushMoves, id, moveThrough, snapshot, viaJson } from './cargo-fixtures';

const TRUCK = 60;
const SHIP_A = 90;
const SHIP_B = 91;
const TRANSHIP_CONTRACT = 88 as ContractId;
const EMPTY_LABELS: CargoUnitLabelsInput = { direction: 'empty', voyageId: null, lineId: 'northern_star', destinationPort: null, weightClass: EMPTY_WEIGHT_CLASS };
const TRANSHIP_LABELS: CargoUnitLabelsInput = { direction: 'tranship', voyageId: 12 as VoyageId, lineId: 'golden_wave', destinationPort: 'Hamburg', weightClass: 'medium' };

/** Prázdny kontajner: príchod kamiónom, depo, výdaj exportérovi (`exported`) — reťazec rozhodnutia 9 orchestrátora. */
const EMPTY_TO_EXPORTER = [at.ramp(50, 0), at.vehicle(30), at.storage(40, 5), at.vehicle(31), at.ramp(50, 1), at.truck(61), at.exported()];
/** Prázdny kontajner do lode (repositioning): depo → vozidlo → hák → loď → odplávalo. */
const EMPTY_TO_SHIP = [at.ramp(50, 0), at.vehicle(30), at.storage(40, 5), at.vehicle(31), at.crane(20), at.ship(SHIP_B), at.shipped()];
/** Prekládka: vykládka z lode A pod hákom, sklad, nakládka na loď B (reverzný reťazec), `shipped`. */
const TRANSHIP_CHAIN = [at.crane(20), at.vehicle(30), at.storage(40, 6), at.vehicle(31), at.crane(21), at.ship(SHIP_B), at.shipped()];

describe('smery a stavy (tabuľky)', () => {
  it('smery import, export, tranship, empty; stavy available, damaged, in_repair; predvolený stav available', () => {
    expect([...CARGO_DIRECTIONS]).toEqual(['import', 'export', 'tranship', 'empty']);
    expect([...CARGO_STATUSES]).toEqual(['available', 'damaged', 'in_repair']);
    expect(DEFAULT_CARGO_STATUS).toBe('available');
    expect(EMPTY_WEIGHT_CLASS).toBe('light');
    expect(CARGO_STATUSES.every(isCargoStatus)).toBe(true);
    expect(isCargoStatus('lost')).toBe(false);
  });

  it('miesto vzniku: import a tranship na lodi, export a prázdny v kamióne', () => {
    expect(CARGO_SPAWN_KIND_BY_DIRECTION).toEqual({ import: 'on_ship', export: 'in_truck', tranship: 'on_ship', empty: 'in_truck' });
  });
});

describe('cargoLabelsProblem — pravidlá štítkov podľa smeru', () => {
  const problemOf = (labels: Partial<Record<keyof CargoUnitLabelsInput, unknown>>, contractId: unknown): string | undefined => {
    const problem = cargoLabelsProblem({ ...DEFAULT_CONTAINER_LABELS, ...EMPTY_LABELS, ...labels } as Record<keyof CargoUnitLabelsInput, unknown>, contractId);
    return problem === undefined ? undefined : `${problem.field}: ${problem.problem}`;
  };

  it('platné kombinácie: ladiaca loď (import bez kontraktu a linky), import kontraktu, export, tranship, prázdny', () => {
    expect(cargoLabelsProblem(IMPORT_LABELS, null)).toBeUndefined();
    expect(cargoLabelsProblem({ ...IMPORT_LABELS, voyageId: 4 as VoyageId, lineId: 'blue_anchor' }, 4)).toBeUndefined();
    expect(cargoLabelsProblem({ ...DEFAULT_CONTAINER_LABELS, ...EXPORT_LABELS }, 77)).toBeUndefined();
    expect(cargoLabelsProblem({ ...DEFAULT_CONTAINER_LABELS, ...TRANSHIP_LABELS }, TRANSHIP_CONTRACT)).toBeUndefined();
    expect(cargoLabelsProblem({ ...DEFAULT_CONTAINER_LABELS, ...EMPTY_LABELS }, null)).toBeUndefined();
  });

  it.each([
    ['tranship bez kontraktu', { ...TRANSHIP_LABELS }, null, /direction: tranship jednotka musí mať kontrakt/],
    ['tranship bez voyage', { ...TRANSHIP_LABELS, voyageId: null }, TRANSHIP_CONTRACT, /voyageId: tranship jednotka musí mať voyage/],
    ['tranship bez linky', { ...TRANSHIP_LABELS, lineId: null }, TRANSHIP_CONTRACT, /lineId: tranship jednotka musí mať linku/],
    ['tranship bez cieľového prístavu', { ...TRANSHIP_LABELS, destinationPort: null }, TRANSHIP_CONTRACT, /destinationPort: tranship jednotka musí mať cieľový prístav/],
    ['prázdny s kontraktom', { ...EMPTY_LABELS }, 5, /empty jednotka nemá kontrakt/],
    ['prázdny s voyage', { ...EMPTY_LABELS, voyageId: 5 as VoyageId }, null, /voyageId: empty jednotka nemá voyage/],
    ['prázdny bez linky', { ...EMPTY_LABELS, lineId: null }, null, /lineId: empty jednotka musí mať linku/],
    ['prázdny s cieľovým prístavom', { ...EMPTY_LABELS, destinationPort: 'Hamburg' }, null, /destinationPort: empty jednotka nemá cieľový prístav/],
    ['prázdna linka (reťazec)', { ...EMPTY_LABELS, lineId: '' }, null, /lineId: musí byť null alebo neprázdny reťazec/],
    ['linka ako číslo', { ...EMPTY_LABELS, lineId: 3 }, null, /lineId: musí byť null alebo neprázdny reťazec/],
    ['neznámy smer', { ...EMPTY_LABELS, direction: 'sideways' }, null, /smer musí byť jeden z: import, export, tranship, empty/],
  ])('%s → problém', (_name, labels, contractId, problem) => {
    expect(problemOf(labels, contractId)).toMatch(problem);
  });
});

describe('cargoStatusProblem — stav kvality', () => {
  it('available bez opravy a damaged bez opravy sú platné pre prázdny; in_repair vyžaduje repairUntilTick', () => {
    expect(cargoStatusProblem('available', null, 'import')).toBeUndefined();
    expect(cargoStatusProblem('available', null, 'empty')).toBeUndefined();
    expect(cargoStatusProblem('damaged', null, 'empty')).toBeUndefined();
    expect(cargoStatusProblem('in_repair', 100, 'empty')).toBeUndefined();
    expect(cargoStatusProblem('in_repair', 0, 'empty')).toBeUndefined();
  });

  it.each([
    ['in_repair bez ticku', 'in_repair', null, 'empty', /repairUntilTick celé číslo ≥ 0/],
    ['in_repair so záporným tickom', 'in_repair', -1, 'empty', /repairUntilTick celé číslo ≥ 0/],
    ['in_repair s necelým tickom', 'in_repair', 1.5, 'empty', /repairUntilTick celé číslo ≥ 0/],
    ['damaged s tickom', 'damaged', 5, 'empty', /repairUntilTick má len jednotka v oprave/],
    ['available s tickom', 'available', 5, 'empty', /repairUntilTick má len jednotka v oprave/],
    ['damaged import', 'damaged', null, 'import', /len prázdny kontajner/],
    ['v oprave export', 'in_repair', 5, 'export', /len prázdny kontajner/],
    ['neznámy stav', 'lost', null, 'empty', /stav musí byť jeden z/],
  ] as const)('%s → problém', (_name, status, repairUntilTick, direction, problem) => {
    expect(cargoStatusProblem(status, repairUntilTick, direction)).toMatch(problem);
  });
});

describe('CargoLedger.create — prázdny kontajner a prekládka', () => {
  it('prázdny vzniká v kamióne s linkou, bez kontraktu, status available; udalosť nevzniká', () => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.truck(TRUCK), null, EMPTY_LABELS);
    expect(unit).toEqual({
      id: 1,
      typeId: TEU,
      contractId: null,
      voyageId: null,
      lineId: 'northern_star',
      direction: 'empty',
      destinationPort: null,
      weightClass: 'light',
      sizeFt: 20,
      containerType: 'dry',
      oog: false,
      hold: null,
      status: 'available',
      repairUntilTick: null,
      quantity: 1,
      location: at.truck(TRUCK),
    });
    expect(Object.isFrozen(unit)).toBe(true);
    expect(harness.ledger.unitsAt('in_truck', id(TRUCK))).toEqual([unit.id]);
    expect(harness.events.pending).toBe(0);
  });

  it('prekládka vzniká na lodi A (ako import) so štítkami kontraktu, linkou a cieľovým prístavom', () => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.ship(SHIP_A), TRANSHIP_CONTRACT, TRANSHIP_LABELS);
    expect(unit).toMatchObject({ direction: 'tranship', contractId: TRANSHIP_CONTRACT, voyageId: 12, lineId: 'golden_wave', destinationPort: 'Hamburg', status: 'available' });
    expect(harness.ledger.unitsAt('on_ship', id(SHIP_A))).toEqual([unit.id]);
    expect(harness.ledger.countExportsAt('on_ship', id(SHIP_A))).toBe(0);
  });

  it.each([
    ['prázdny na lodi', at.ship(SHIP_A), null, EMPTY_LABELS],
    ['prekládka v kamióne', at.truck(TRUCK), TRANSHIP_CONTRACT, TRANSHIP_LABELS],
    ['prázdny na rampe', at.ramp(50, 0), null, EMPTY_LABELS],
  ])('%s → CargoTransitionError, stav bez zmeny', (_name, location, contractId, labels) => {
    const harness = createHarness();
    const before = snapshot(harness);
    expect(() => harness.ledger.create(TEU, location, contractId, labels)).toThrow(CargoTransitionError);
    expect(snapshot(harness)).toEqual(before);
  });

  it.each([
    ['prázdny s kontraktom', 5 as ContractId, EMPTY_LABELS, /empty jednotka nemá kontrakt/],
    ['prázdny bez linky', null, { ...EMPTY_LABELS, lineId: null }, /empty jednotka musí mať linku/],
  ])('%s → CargoError(invalid_input), id sa nespotrebuje', (_name, contractId, labels, problem) => {
    const harness = createHarness();
    const before = snapshot(harness);
    let caught: unknown;
    try {
      harness.ledger.create(TEU, at.truck(TRUCK), contractId, labels);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CargoError);
    expect((caught as CargoError).code).toBe('invalid_input');
    expect((caught as CargoError).message).toMatch(problem);
    expect(snapshot(harness)).toEqual(before);
  });
});

describe('reťazce prázdneho a prekládky (existujúce prechody §7.1 stačia)', () => {
  it('prázdny: in_truck → at_ramp → in_vehicle → in_storage → in_vehicle → at_ramp → in_truck → exported (výdaj exportérovi)', () => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.truck(TRUCK), null, EMPTY_LABELS);
    moveThrough(harness.ledger, unit.id, EMPTY_TO_EXPORTER);
    expect(harness.ledger.exportedCount).toBe(1);
    expect(harness.ledger.shippedCount).toBe(0);
    expect(flushMoves(harness.events)).toHaveLength(EMPTY_TO_EXPORTER.length);
  });

  it('prázdny: … → in_crane → on_ship → shipped (repositioning) a konzervácia created = živé + exported + shipped', () => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.truck(TRUCK), null, EMPTY_LABELS);
    const other = harness.ledger.create(TEU, at.truck(TRUCK + 1), null, EMPTY_LABELS);
    moveThrough(harness.ledger, unit.id, EMPTY_TO_SHIP);
    expect(harness.ledger.shippedCount).toBe(1);
    expect(harness.ledger.liveCount).toBe(1);
    expect(harness.ledger.get(other.id)).toBeDefined();
    harness.ledger.assertConservation();
  });

  it('prekládka: loď A → hák → vozidlo → sklad → vozidlo → hák → loď B → shipped (bez predaja zmeškaného nikdy exported)', () => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.ship(SHIP_A), TRANSHIP_CONTRACT, TRANSHIP_LABELS);
    moveThrough(harness.ledger, unit.id, TRANSHIP_CHAIN);
    expect(harness.ledger.shippedCount).toBe(1);
    expect(harness.ledger.exportedCount).toBe(0);
  });

  it('prázdny nemôže preskočiť sklad: in_vehicle → on_ship nie je povolený prechod', () => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.truck(TRUCK), null, EMPTY_LABELS);
    moveThrough(harness.ledger, unit.id, [at.ramp(50, 0), at.vehicle(30)]);
    const before = snapshot(harness);
    expect(() => harness.ledger.move(unit.id, at.ship(SHIP_B))).toThrow(CargoTransitionError);
    expect(snapshot(harness)).toEqual(before);
  });
});

describe('CargoLedger.setStatus — kontrola a M&R', () => {
  const emptyInStorage = () => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.truck(TRUCK), null, EMPTY_LABELS);
    moveThrough(harness.ledger, unit.id, [at.ramp(50, 0), at.vehicle(30), at.storage(40, 5)]);
    harness.events.flush();
    return { harness, unitId: unit.id };
  };

  it('available → damaged → in_repair → available mení len stav: poloha, poradie v indexe aj počítadlá ostanú, udalosť nevzniká', () => {
    const { harness, unitId } = emptyInStorage();
    const { ledger } = harness;
    const other = ledger.create(TEU, at.truck(TRUCK + 1), null, EMPTY_LABELS).id;
    moveThrough(ledger, other, [at.ramp(50, 1), at.vehicle(31), at.storage(40, 2)]);
    harness.events.flush();
    const order = ledger.unitsAt('in_storage', id(40));
    const damaged = ledger.setStatus(unitId, 'damaged');
    expect(damaged).toMatchObject({ status: 'damaged', repairUntilTick: null, location: at.storage(40, 5) });
    const repairing = ledger.setStatus(unitId, 'in_repair', 777);
    expect(repairing).toMatchObject({ status: 'in_repair', repairUntilTick: 777 });
    const repaired = ledger.setStatus(unitId, 'available');
    expect(repaired).toMatchObject({ status: 'available', repairUntilTick: null });
    expect(ledger.get(unitId)).toBe(repaired);
    expect(ledger.unitsAt('in_storage', id(40))).toEqual(order);
    expect(Object.isFrozen(repaired)).toBe(true);
    expect(harness.events.pending).toBe(0);
    ledger.assertConservation();
  });

  it('predchádzajúca snímka jednotky sa nezmení (zmrazená hodnota)', () => {
    const { harness, unitId } = emptyInStorage();
    const before = harness.ledger.get(unitId)!;
    harness.ledger.setStatus(unitId, 'damaged');
    expect(before.status).toBe('available');
  });

  it.each([
    ['in_repair bez ticku', 'in_repair', null, /repairUntilTick celé číslo ≥ 0/],
    ['damaged s tickom', 'damaged', 9, /repairUntilTick má len jednotka v oprave/],
    ['neznámy stav', 'lost', null, /stav musí byť jeden z/],
  ] as const)('%s → CargoError(invalid_input), stav sa nezmení', (_name, status, repairUntilTick, problem) => {
    const { harness, unitId } = emptyInStorage();
    const before = snapshot(harness);
    let caught: unknown;
    try {
      harness.ledger.setStatus(unitId, status as never, repairUntilTick);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CargoError);
    expect((caught as CargoError).code).toBe('invalid_input');
    expect((caught as CargoError).message).toMatch(problem);
    expect(snapshot(harness)).toEqual(before);
  });

  it('import jednotku poškodiť nemožno; neznáma a odídená jednotka → unknown_unit', () => {
    const harness = createHarness();
    const imported = harness.ledger.create(TEU, at.ship(SHIP_A));
    expect(() => harness.ledger.setStatus(imported.id, 'damaged')).toThrow(/len prázdny kontajner/);
    expect(() => harness.ledger.setStatus(999 as EntityId, 'damaged')).toThrow(CargoError);
    const empty = harness.ledger.create(TEU, at.truck(TRUCK), null, EMPTY_LABELS);
    moveThrough(harness.ledger, empty.id, EMPTY_TO_EXPORTER);
    let code: string | undefined;
    try {
      harness.ledger.setStatus(empty.id, 'damaged');
    } catch (error) {
      code = (error as CargoError).code;
    }
    expect(code).toBe('unknown_unit');
  });

  it('setHold na prázdny kontajner (VGM) sa odmietne — hold má len export', () => {
    const { harness, unitId } = emptyInStorage();
    expect(() => harness.ledger.setHold(unitId, { reason: 'vgm', untilTick: 5 })).toThrow(/len export/);
  });

  it('presun zachová stav kvality (oprava prežije prechod do vozidla)', () => {
    const { harness, unitId } = emptyInStorage();
    harness.ledger.setStatus(unitId, 'in_repair', 321);
    harness.ledger.move(unitId, at.vehicle(31));
    expect(harness.ledger.get(unitId)).toMatchObject({ status: 'in_repair', repairUntilTick: 321, location: at.vehicle(31) });
  });
});

describe('stav ledgera s linkou a stavom kvality', () => {
  it('getState → JSON → fromState zachová linku, status a repairUntilTick v kanonickom poradí; roundtrip je identický', () => {
    const harness = createHarness();
    const { ledger } = harness;
    const a = ledger.create(TEU, at.truck(TRUCK), null, EMPTY_LABELS);
    const b = ledger.create(TEU, at.truck(TRUCK + 1), null, { ...EMPTY_LABELS, lineId: 'blue_anchor' });
    ledger.create(TEU, at.ship(SHIP_A), TRANSHIP_CONTRACT, TRANSHIP_LABELS);
    moveThrough(ledger, a.id, [at.ramp(50, 0), at.vehicle(30), at.storage(40, 1)]);
    moveThrough(ledger, b.id, [at.ramp(50, 1), at.vehicle(31), at.storage(40, 0)]);
    ledger.setStatus(a.id, 'in_repair', 4000);
    ledger.setStatus(b.id, 'damaged');
    const state = ledger.getState();
    expect(viaJson(state)).toEqual(state);
    const units = state.units.filter((unit) => unit.direction === 'empty');
    expect(units.map((unit) => [unit.lineId, unit.status, unit.repairUntilTick])).toEqual(
      expect.arrayContaining([['northern_star', 'in_repair', 4000], ['blue_anchor', 'damaged', null]]),
    );
    const restored = CargoLedger.fromState(viaJson(state), createHarness({ nextId: 10 }).deps);
    expect(restored.getState()).toEqual(state);
    expect(restored.get(a.id)).toMatchObject({ lineId: 'northern_star', status: 'in_repair', repairUntilTick: 4000 });
  });
});
