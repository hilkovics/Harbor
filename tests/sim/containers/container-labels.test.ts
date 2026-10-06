// R2 / TR2-01 (ADR-039): štítky kontajnera na jednotke — `sizeFt`, `containerType`, `oog`, `teuOf`, validácia voči defu, TEU u držiteľa a save roundtrip.
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_SIZES,
  DEFAULT_CONTAINER_LABELS,
  FEET_PER_TEU,
  IMPORT_LABELS,
  CargoError,
  CargoLedger,
  CargoStateError,
  cargoLabelsProblem,
  containerLabelsDefProblem,
  isContainerSize,
  teuOf,
  teuOfSize,
  type CargoUnit,
} from '@sim/cargo';
import { loadBundledDefs } from '@sim/defs';
import { EXPORT_CONTRACT, EXPORT_LABELS, TEU, at, createHarness, id } from '../cargo/cargo-fixtures';

const DEFS = loadBundledDefs();
const SHIP = 40;

const withSize = (sizeFt: 20 | 40): Pick<CargoUnit, 'sizeFt'> => ({ sizeFt });

describe('teuOf a veľkosti kontajnera', () => {
  it('20′ = 1 TEU, 40′ = 2 TEU; stopy na TEU sú 20', () => {
    expect(FEET_PER_TEU).toBe(20);
    expect([...CONTAINER_SIZES]).toEqual([20, 40]);
    expect(teuOf(withSize(20))).toBe(1);
    expect(teuOf(withSize(40))).toBe(2);
    expect([teuOfSize(20), teuOfSize(40)]).toEqual([1, 2]);
  });

  it('isContainerSize prijme len 20 a 40', () => {
    expect([20, 40].every(isContainerSize)).toBe(true);
    for (const bad of [0, 10, 30, 45, '20', null, undefined, 20.5]) expect(isContainerSize(bad), String(bad)).toBe(false);
  });

  it('predvolené štítky: 20′, dry, bez nadrozmeru; IMPORT_LABELS ich nesie', () => {
    expect(DEFAULT_CONTAINER_LABELS).toEqual({ sizeFt: 20, containerType: 'dry', oog: false });
    expect(IMPORT_LABELS).toMatchObject(DEFAULT_CONTAINER_LABELS);
  });
});

describe('cargoLabelsProblem — štítky kontajnera', () => {
  const FULL = { ...IMPORT_LABELS };
  const problemOf = (patch: Record<string, unknown>): string | undefined => {
    const problem = cargoLabelsProblem({ ...FULL, ...patch } as Parameters<typeof cargoLabelsProblem>[0], null);
    return problem === undefined ? undefined : `${problem.field}: ${problem.problem}`;
  };

  it('platné: 20 aj 40, typ dry, oog false', () => {
    expect(problemOf({})).toBeUndefined();
    expect(problemOf({ sizeFt: 40 })).toBeUndefined();
  });

  it.each([
    ['veľkosť 30', { sizeFt: 30 }, /^sizeFt: veľkosť musí byť jedna z: 20, 40, dostal 30/],
    ['veľkosť ako reťazec', { sizeFt: '40' }, /^sizeFt:/],
    ['chýbajúca veľkosť', { sizeFt: undefined }, /^sizeFt:/],
    ['prázdny typ', { containerType: '' }, /^containerType: musí byť neprázdny reťazec/],
    ['typ ako číslo', { containerType: 5 }, /^containerType:/],
    ['oog ako číslo', { oog: 1 }, /^oog: musí byť boolean/],
    ['oog chýba', { oog: undefined }, /^oog:/],
  ])('%s → problém', (_name, patch, problem) => {
    expect(problemOf(patch)).toMatch(problem);
  });
});

describe('containerLabelsDefProblem — súlad s container_types.json', () => {
  const types = DEFS.containerTypes;

  it('dry 20 a 40 sú platné', () => {
    expect(containerLabelsDefProblem({ sizeFt: 20, containerType: 'dry', oog: false }, types)).toBeUndefined();
    expect(containerLabelsDefProblem({ sizeFt: 40, containerType: 'dry', oog: false }, types)).toBeUndefined();
  });

  it('neznámy typ → problém na containerType so zoznamom známych', () => {
    const problem = containerLabelsDefProblem({ sizeFt: 20, containerType: 'reefer', oog: false }, types);
    expect(problem?.field).toBe('containerType');
    expect(problem?.problem).toMatch(/neznámy typ kontajnera 'reefer' \(známe: dry\)/);
  });

  it('nadrozmer pri type bez oogChance je chyba', () => {
    expect(containerLabelsDefProblem({ sizeFt: 20, containerType: 'dry', oog: true }, types)?.field).toBe('oog');
  });
});

describe('CargoLedger.create — štítky kontajnera a TEU u držiteľa', () => {
  it('bez štítkov dostane 20′ dry bez nadrozmeru; 40′ sa uloží a vráti v snímke', () => {
    const { ledger } = createHarness();
    const plain = ledger.create(TEU, at.ship(SHIP));
    expect(plain).toMatchObject({ sizeFt: 20, containerType: 'dry', oog: false });
    const big = ledger.create(TEU, at.ship(SHIP), null, { ...IMPORT_LABELS, sizeFt: 40 });
    expect(big.sizeFt).toBe(40);
    expect(ledger.get(big.id)?.sizeFt).toBe(40);
  });

  it('štítky exportu (smer, linka, prístav) môžu niesť aj veľkosť; chýbajúce štítky kontajnera sa doplnia', () => {
    const { ledger } = createHarness();
    const unit = ledger.create(TEU, at.truck(7), EXPORT_CONTRACT, { ...EXPORT_LABELS, sizeFt: 40 });
    expect([unit.direction, unit.sizeFt, unit.containerType, unit.oog]).toEqual(['export', 40, 'dry', false]);
  });

  it.each([
    ['veľkosť 30', { sizeFt: 30 as 20 }, /sizeFt/],
    ['neznámy typ', { containerType: 'reefer' }, /containerType: neznámy typ kontajnera 'reefer'/],
    ['nadrozmer pri dry', { oog: true }, /oog/],
  ])('create odmietne: %s (CargoError invalid_input, id sa nespotrebuje)', (_name, patch, message) => {
    const harness = createHarness();
    const before = harness.ids.getState().nextId;
    let error: unknown;
    try {
      harness.ledger.create(TEU, at.ship(SHIP), null, { ...IMPORT_LABELS, ...patch });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CargoError);
    expect((error as CargoError).code).toBe('invalid_input');
    expect((error as CargoError).message).toMatch(message);
    expect(harness.ids.getState().nextId).toBe(before);
    expect(harness.ledger.liveCount).toBe(0);
  });

  it('teuAt sčíta TEU držiteľa (20′ = 1, 40′ = 2) a sleduje presuny aj odchod z mapy', () => {
    const { ledger } = createHarness();
    const a = ledger.create(TEU, at.ship(SHIP));
    const b = ledger.create(TEU, at.ship(SHIP), null, { ...IMPORT_LABELS, sizeFt: 40 });
    ledger.create(TEU, at.ship(SHIP + 1), null, { ...IMPORT_LABELS, sizeFt: 40 });
    expect([ledger.teuAt('on_ship', id(SHIP)), ledger.countAt('on_ship', id(SHIP))]).toEqual([3, 2]);
    expect(ledger.teuAt('on_ship', id(SHIP + 1))).toBe(2);
    expect(ledger.teuAt('on_ship', id(999))).toBe(0);
    ledger.move(b.id, at.crane(20));
    expect(ledger.teuAt('on_ship', id(SHIP))).toBe(1);
    expect(ledger.teuAt('in_crane', id(20))).toBe(2);
    ledger.move(a.id, at.crane(21));
    expect(ledger.teuAt('on_ship', id(SHIP))).toBe(0);
  });
});

describe('save: štítky kontajnera v ledgeri', () => {
  it('getState → JSON → fromState zachová veľkosť, typ a oog; kľúče jednotky obsahujú nové štítky v poradí', () => {
    const harness = createHarness();
    harness.ledger.create(TEU, at.ship(SHIP));
    harness.ledger.create(TEU, at.ship(SHIP), null, { ...IMPORT_LABELS, sizeFt: 40 });
    const state = harness.ledger.getState();
    expect(Object.keys(state.units[1]).slice(7, 12)).toEqual(['weightClass', 'sizeFt', 'containerType', 'oog', 'hold']);
    const raw = JSON.parse(JSON.stringify(state)) as unknown;
    const restored = CargoLedger.fromState(raw, harness.deps);
    expect(restored.getState()).toEqual(state);
    expect(restored.teuAt('on_ship', id(SHIP))).toBe(3);
    expect(JSON.stringify(restored.getState())).toBe(JSON.stringify(state));
  });

  const mutate = (patch: Record<string, unknown>): unknown => {
    const harness = createHarness();
    harness.ledger.create(TEU, at.ship(SHIP));
    const raw = JSON.parse(JSON.stringify(harness.ledger.getState())) as { units: Record<string, unknown>[] };
    Object.assign(raw.units[0], patch);
    return CargoLedger.fromState.bind(CargoLedger, raw, harness.deps)();
  };

  it.each([
    ['veľkosť 30', { sizeFt: 30 }, '/units/0/sizeFt'],
    ['neznámy typ kontajnera', { containerType: 'reefer' }, '/units/0/containerType'],
    ['nadrozmer pri dry', { oog: true }, '/units/0/oog'],
    ['oog ako reťazec', { oog: 'false' }, '/units/0/oog'],
  ])('fromState odmietne: %s → CargoStateError na %s', (_name, patch, path) => {
    let error: unknown;
    try {
      mutate(patch);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CargoStateError);
    expect((error as CargoStateError).path).toBe(path);
  });

  it('save bez štítkov kontajnera (starý tvar) sa odmietne ako chýbajúci kľúč', () => {
    const harness = createHarness();
    harness.ledger.create(TEU, at.ship(SHIP));
    const raw = JSON.parse(JSON.stringify(harness.ledger.getState())) as { units: Record<string, unknown>[] };
    delete raw.units[0]['sizeFt'];
    expect(() => CargoLedger.fromState(raw, harness.deps)).toThrow(/sizeFt/);
  });
});
