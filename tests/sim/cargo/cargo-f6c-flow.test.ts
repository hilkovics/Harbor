// Počítadlá smerov v ledgeri a stowage prázdnych (T6C-03, ADR-034 bod 10): `countExportsAt` počíta export a prázdne (náklad na nakládku už
// podľa smeru), `countTranshipAt` prekládku (na lodi A vykladaná, na lodi B naložená — rozlišuje kontrakt); konzervácia kontroluje obe
// počítadlá; stowage radí plné pred prázdnymi (`STOWAGE_DIRECTION_RANK`), v rámci toho podľa hmotnostnej triedy a id.
import { describe, expect, it } from 'vitest';
import {
  CARGO_HOLDER_KINDS,
  CARGO_LOCATION_KINDS,
  CargoLedger,
  EMPTY_WEIGHT_CLASS,
  OUTBOUND_BY_DIRECTION,
  STOWAGE_DIRECTION_RANK,
  compareStowageOrder,
  findConservationViolation,
  type CargoBucketView,
  type CargoLedgerView,
  type CargoLocationKind,
  type CargoUnitLabelsInput,
} from '@sim/cargo';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import { EXPORT_LABELS, TEU, at, createHarness, id, moveThrough, viaJson } from './cargo-fixtures';

const SHIP = 70;
const TRUCK = 60;
const EMPTY_LABELS: CargoUnitLabelsInput = { direction: 'empty', voyageId: null, lineId: 'blue_anchor', destinationPort: null, weightClass: EMPTY_WEIGHT_CLASS };
const TRANSHIP_LABELS: CargoUnitLabelsInput = { direction: 'tranship', voyageId: 3 as VoyageId, lineId: 'blue_anchor', destinationPort: 'Hamburg', weightClass: 'medium' };
const TRANSHIP_CONTRACT = 5 as ContractId;
const EXPORT_CONTRACT = 6 as ContractId;
/** Prázdny z depa na loď (repositioning): depo → vozidlo → hák → loď (bez `shipped`). */
const EMPTY_TO_SHIP = [at.ramp(50, 0), at.vehicle(30), at.storage(40, 5), at.vehicle(31), at.crane(20), at.ship(SHIP)];
/** Prekládka z lode A cez sklad na loď B (bez `shipped`). */
const TRANSHIP_TO_B = [at.crane(20), at.vehicle(30), at.storage(40, 6), at.vehicle(31), at.crane(21), at.ship(SHIP)];

describe('OUTBOUND_BY_DIRECTION', () => {
  it('export a prázdny sú náklad na nakládku už podľa smeru; import a prekládka nie (prekládku rozlišuje kontrakt)', () => {
    expect(OUTBOUND_BY_DIRECTION).toEqual({ import: false, export: true, tranship: false, empty: true });
  });
});

describe('CargoLedger.countExportsAt a countTranshipAt (T6C-03)', () => {
  it('prázdny naložený na loď sa počíta do exportov, prekládka na loď A a B do countTranshipAt; odplávanie počítadlá upraví', () => {
    const { ledger } = createHarness();
    const imp = ledger.create(TEU, at.ship(SHIP));
    const tranA = ledger.create(TEU, at.ship(SHIP), TRANSHIP_CONTRACT, TRANSHIP_LABELS);
    expect([ledger.countAt('on_ship', id(SHIP)), ledger.countExportsAt('on_ship', id(SHIP)), ledger.countTranshipAt('on_ship', id(SHIP))]).toEqual([2, 0, 1]);
    const empty = ledger.create(TEU, at.truck(TRUCK), null, EMPTY_LABELS);
    moveThrough(ledger, empty.id, [at.ramp(50, 0), at.vehicle(30), at.storage(40, 5), at.vehicle(31), at.crane(20), at.ship(SHIP)]);
    expect([ledger.countAt('on_ship', id(SHIP)), ledger.countExportsAt('on_ship', id(SHIP)), ledger.countTranshipAt('on_ship', id(SHIP))]).toEqual([3, 1, 1]);
    ledger.move(empty.id, { kind: 'shipped' });
    expect([ledger.countAt('on_ship', id(SHIP)), ledger.countExportsAt('on_ship', id(SHIP))]).toEqual([2, 0]);
    // prekládka sa z lode A vyloží (on_ship → in_crane) a počítadlo klesne; imp ostáva
    ledger.move(tranA.id, at.crane(20));
    expect([ledger.countAt('on_ship', id(SHIP)), ledger.countTranshipAt('on_ship', id(SHIP))]).toEqual([1, 0]);
    expect(ledger.get(imp.id)?.direction).toBe('import');
    expect(ledger.countTranshipAt('on_ship', id(999))).toBe(0);
    ledger.assertConservation();
  });

  it('prekládka naložená na loď B (po reťazci vykládka → sklad → nakládka) sa počíta do countTranshipAt lode B', () => {
    const { ledger } = createHarness();
    const unit = ledger.create(TEU, at.ship(SHIP + 1), TRANSHIP_CONTRACT, TRANSHIP_LABELS);
    moveThrough(ledger, unit.id, TRANSHIP_TO_B);
    expect(ledger.countTranshipAt('on_ship', id(SHIP))).toBe(1);
    expect(ledger.countTranshipAt('on_ship', id(SHIP + 1))).toBe(0);
    ledger.assertConservation();
  });

  it('obnova zo save zostaví obe počítadlá z jednotiek', () => {
    const harness = createHarness();
    const empty = harness.ledger.create(TEU, at.truck(TRUCK), null, EMPTY_LABELS);
    moveThrough(harness.ledger, empty.id, EMPTY_TO_SHIP);
    harness.ledger.create(TEU, at.ship(SHIP), TRANSHIP_CONTRACT, TRANSHIP_LABELS);
    const restored = CargoLedger.fromState(viaJson(harness.ledger.getState()), harness.deps);
    expect([restored.countExportsAt('on_ship', id(SHIP)), restored.countTranshipAt('on_ship', id(SHIP)), restored.countAt('on_ship', id(SHIP))]).toEqual([1, 1, 2]);
    restored.assertConservation();
  });
});

describe('findConservationViolation — počítadlo prekládky indexu', () => {
  /** Úplný pohľad (všetky druhy držiteľov) s jednou prekládkou na lodi a počítadlom `tranships` indexu lode. */
  function view(tranships: number | undefined): CargoLedgerView {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.ship(SHIP), TRANSHIP_CONTRACT, TRANSHIP_LABELS);
    const buckets = new Map<CargoLocationKind, Map<EntityId, CargoBucketView>>(CARGO_HOLDER_KINDS.map((kind) => [kind as CargoLocationKind, new Map<EntityId, CargoBucketView>()]));
    buckets.get('on_ship')?.set(id(SHIP), { units: [unit.id], slots: null, exports: 0, ...(tranships === undefined ? {} : { tranships }) });
    const counts = Object.fromEntries(CARGO_LOCATION_KINDS.map((kind) => [kind, kind === 'on_ship' ? 1 : 0])) as Record<CargoLocationKind, number>;
    return { units: new Map([[unit.id, unit]]), buckets, counts, createdCount: 1 };
  }

  it('zhoda prejde, nezhoda sa pomenuje, pohľad bez počítadla sa nekontroluje', () => {
    expect(findConservationViolation(view(1))).toBeUndefined();
    expect(findConservationViolation(view(undefined))).toBeUndefined();
    expect(findConservationViolation(view(0))).toBe('index on_ship(shipId=70): počítadlo jednotiek prekládky 0, v indexe ich je 1');
  });
});

describe('stowage — plné pred prázdnymi', () => {
  const key = (idValue: number, weightClass: 'light' | 'medium' | 'heavy', direction?: 'export' | 'tranship' | 'empty') => ({ id: idValue as EntityId, weightClass, direction });

  it('poradie smeru: plné (export, prekládka) pred prázdnymi; prázdny je posledný aj keď je „ťažší“ a má nižšie id', () => {
    expect(STOWAGE_DIRECTION_RANK).toEqual({ import: 0, export: 0, tranship: 0, empty: 1 });
    expect(compareStowageOrder(key(9, 'light', 'export'), key(1, 'heavy', 'empty'))).toBeLessThan(0);
    expect(compareStowageOrder(key(1, 'heavy', 'empty'), key(9, 'light', 'export'))).toBeGreaterThan(0);
    expect(compareStowageOrder(key(9, 'light', 'tranship'), key(1, 'light', 'empty'))).toBeLessThan(0);
  });

  it('v rámci smeru platí hmotnostná trieda a potom id; kľúč bez smeru sa berie ako plná jednotka', () => {
    expect(compareStowageOrder(key(5, 'heavy', 'export'), key(2, 'medium', 'tranship'))).toBeLessThan(0);
    expect(compareStowageOrder(key(2, 'light', 'empty'), key(3, 'light', 'empty'))).toBeLessThan(0);
    expect(compareStowageOrder(key(7, 'medium'), key(4, 'medium', 'export'))).toBeGreaterThan(0);
    const sorted = [key(1, 'light', 'empty'), key(2, 'medium', 'export'), key(3, 'heavy', 'export'), key(4, 'light', 'tranship'), key(5, 'heavy', 'empty')].sort(compareStowageOrder).map((item) => item.id);
    expect(sorted).toEqual([3, 2, 4, 5, 1]);
  });

  it('export z ledgera: štítky exportu nesú smer, takže jednotka CargoUnit vstupuje do porovnania priamo', () => {
    const { ledger } = createHarness();
    const full = ledger.create(TEU, at.truck(TRUCK), EXPORT_CONTRACT, { ...EXPORT_LABELS, weightClass: 'light' });
    const empty = ledger.create(TEU, at.truck(TRUCK + 1), null, EMPTY_LABELS);
    expect(compareStowageOrder(full, empty)).toBeLessThan(0);
    expect(compareStowageOrder(empty, full)).toBeGreaterThan(0);
  });
});
