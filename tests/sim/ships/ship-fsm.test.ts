// Ship + FSM lode (T02-05, ARCHITECTURE §7.4, ADR-016): tabuľka prechodov (presne karta T02-05), vlastnosti stavov,
// Ship.transition (jediné miesto zmeny stavu, nepovolený prechod bez zmeny), validácia konštruktora a toState.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import {
  SERIALIZED_SHIP_KEYS,
  SHIP_STATES,
  SHIP_STATE_TRAITS,
  SHIP_TRANSITIONS,
  Ship,
  ShipError,
  holdingAllows,
  isShipTransitionAllowed,
  type ShipInit,
  type ShipState,
} from '@sim/ships';
import { BULKER, GRAIN, SHIP_DEFS, TEU } from './ship-fixtures';

const FEEDER = SHIP_DEFS.ships.get('feeder');
const CONTAINER = SHIP_DEFS.cargoTypes.get(TEU);

function ship(overrides: Partial<ShipInit> = {}): Ship {
  return new Ship({ id: 7 as EntityId, def: FEEDER, cargoType: CONTAINER, state: 'inbound', x: 48.5, y: 0.5, heading: 180, ...overrides });
}

/** Trasa s tromi bodmi (pre `waypointIndex` až 3). */
const ROUTE3 = [
  { x: 48.5, y: 3.5 },
  { x: 48.5, y: 7.5 },
  { x: 44.5, y: 7.5, heading: 270 as const },
];

/** Karta T02-05 + ADR-029 (`arriving` → `inbound`) + ADR-032 (`lashing`): presne tieto prechody, nič iné. */
const EXPECTED: readonly (readonly [ShipState, ShipState])[] = [
  ['arriving', 'inbound'],
  ['inbound', 'waiting_anchorage'],
  ['inbound', 'berthing'],
  ['waiting_anchorage', 'berthing'],
  ['berthing', 'docked'],
  ['docked', 'undocking'],
  ['docked', 'lashing'],
  ['lashing', 'undocking'],
  ['undocking', 'outbound'],
  ['outbound', 'despawned'],
];

describe('SHIP_TRANSITIONS', () => {
  it('obsahuje každý stav a presne prechody z karty T02-05 a ADR-029; despawned je konečný', () => {
    expect([...SHIP_TRANSITIONS.keys()]).toEqual([...SHIP_STATES]);
    const listed = [...SHIP_TRANSITIONS].flatMap(([from, targets]) => targets.map((to) => [from, to] as const));
    expect(listed).toEqual(EXPECTED);
    expect(SHIP_TRANSITIONS.get('despawned')).toEqual([]);
  });

  it.each(SHIP_STATES.flatMap((from) => SHIP_STATES.map((to) => [from, to] as const)))('isShipTransitionAllowed(%s → %s)', (from, to) => {
    expect(isShipTransitionAllowed(from, to)).toBe(EXPECTED.some(([a, b]) => a === from && b === to));
  });
});

describe('SHIP_STATE_TRAITS', () => {
  it('kotviská: vždy berthing, docked a lashing, smie inbound (rezervácia pri vstupe) a undocking (do konca dráhy); anchorage smie inbound, vždy waiting_anchorage (T5B-04b); vodu pred kotviskom blokuje berthing/docked/lashing/undocking', () => {
    const where = (key: 'blocksBerthWater' | 'moored' | 'onMap' | 'lashes'): ShipState[] => SHIP_STATES.filter((state) => SHIP_STATE_TRAITS[state][key]);
    const holding = (key: 'berths' | 'anchorage', value: string): ShipState[] => SHIP_STATES.filter((state) => SHIP_STATE_TRAITS[state][key] === value);
    expect(holding('berths', 'always')).toEqual(['berthing', 'docked', 'lashing']);
    expect(holding('berths', 'optional')).toEqual(['inbound', 'undocking']);
    expect(holding('anchorage', 'optional')).toEqual(['inbound']);
    // Loď bez anchorage zo save v5 (čakala na konci dráhy) parser presunie pred vstup (ADR-029 addendum).
    expect(holding('anchorage', 'always')).toEqual(['waiting_anchorage']);
    expect(where('blocksBerthWater')).toEqual(['berthing', 'docked', 'lashing', 'undocking']);
    // T02-14: pri kotvisku (dockPoint + DOCKED_HEADING) stojí dokovaná loď a loď v lashingu (ADR-032).
    expect(where('moored')).toEqual(['docked', 'lashing']);
    // ADR-032 bod 11: odpočet lashingu má len stav lashing.
    expect(where('lashes')).toEqual(['lashing']);
    // ADR-029: pred vstupom (a po odchode) loď nezaberá bunky; na mape sa lode neprekrývajú bez výnimky.
    expect(SHIP_STATES.filter((state) => !SHIP_STATE_TRAITS[state].onMap)).toEqual(['arriving', 'despawned']);
    expect([holdingAllows('always', 0), holdingAllows('always', 1), holdingAllows('never', 1), holdingAllows('optional', 0), holdingAllows('optional', 2)]).toEqual([false, true, false, true, true]);
  });
});

describe('Ship.transition', () => {
  it('prejde celý životný cyklus cez waiting_anchorage a každý prechod začne novú trasu (waypointIndex 0)', () => {
    const s = ship();
    for (const to of ['waiting_anchorage', 'berthing', 'docked', 'undocking', 'outbound', 'despawned'] as const) {
      s.waypointIndex = 3;
      s.transition(to);
      expect(s.state).toBe(to);
      expect(s.waypointIndex).toBe(0);
    }
  });

  it('inbound → berthing priamo (kotvisko voľné na konci seaLane)', () => {
    const s = ship();
    s.transition('berthing');
    expect(s.state).toBe('berthing');
  });

  it.each([
    ['inbound', 'docked'],
    ['docked', 'outbound'],
    ['berthing', 'waiting_anchorage'],
    ['outbound', 'inbound'],
    ['despawned', 'inbound'],
    ['arriving', 'berthing'],
    ['inbound', 'arriving'],
  ] as const)('%s → %s vyhodí ShipError(invalid_transition) a loď sa nezmení', (from, to) => {
    const s = ship({ state: from, waypointIndex: 2, route: ROUTE3 });
    let error: unknown;
    try {
      s.transition(to);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ShipError);
    expect((error as ShipError).code).toBe('invalid_transition');
    expect((error as ShipError).message).toContain(`${from} → ${to}`);
    expect(s.state).toBe(from);
    expect(s.waypointIndex).toBe(2);
  });
});

describe('Ship — konštruktor a toState', () => {
  it('odvodí classId a kategóriu nákladu, berthIds zmrazí', () => {
    const s = ship({ berthIds: [1 as EntityId, 4 as EntityId] });
    expect(s.classId).toBe('feeder');
    expect(s.cargoTypeId).toBe(TEU);
    expect(s.cargoCategory).toBe('container');
    expect(s.berthIds).toEqual([1, 4]);
    expect(Object.isFrozen(s.berthIds)).toBe(true);
    expect(s.label).toBe('feeder #7');
  });

  it('toState: presne kľúče SERIALIZED_SHIP_KEYS v poradí, čistý JSON', () => {
    const s = ship({ state: 'waiting_anchorage', x: 44.5, y: 7.25, heading: 270, anchorageIndex: 1, waypointIndex: 1, route: ROUTE3 });
    const state = s.toState();
    expect(Object.keys(state)).toEqual([...SERIALIZED_SHIP_KEYS]);
    expect(state).toEqual({
      id: 7,
      classId: 'feeder',
      cargoTypeId: TEU,
      state: 'waiting_anchorage',
      x: 44.5,
      y: 7.25,
      heading: 270,
      berthIds: [],
      anchorageIndex: 1,
      waypointIndex: 1,
      route: [
        [48.5, 3.5],
        [48.5, 7.5],
        [44.5, 7.5, 270],
      ],
      lashingTicksLeft: 0,
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('trasa (ADR-029): zmrazená kópia, transition ju nahradí (predvolene prázdnou) a vynuluje waypointIndex; inak sa nemení (replaceRoute zrušené, T5B-04b)', () => {
    const s = ship({ route: ROUTE3, waypointIndex: 1 });
    expect(s.route).toEqual(ROUTE3);
    expect(Object.isFrozen(s.route)).toBe(true);
    expect(Object.isFrozen(s.route[0])).toBe(true);
    s.transition('berthing', [{ x: 43, y: 13, heading: 90 }]);
    expect([s.state, s.waypointIndex, s.route]).toEqual(['berthing', 0, [{ x: 43, y: 13, heading: 90 }]]);
    s.waypointIndex = 1;
    s.transition('docked');
    expect([s.waypointIndex, s.route]).toEqual([0, []]);
    // Trasu mení len prechod stavu: legacy loď bez anchorage (save v5) parser presunie pred vstup, nová trasa bez prechodu nie je.
    expect('replaceRoute' in s).toBe(false);
  });

  it.each<[string, Partial<ShipInit>, RegExp]>([
    ['id 0', { id: 0 as EntityId }, /id musí byť/],
    ['poloha NaN', { x: Number.NaN }, /poloha/],
    ['nekonečná poloha', { y: Number.POSITIVE_INFINITY }, /poloha/],
    ['kurz 45', { heading: 45 as never }, /kurz/],
    ['neznámy stav', { state: 'sinking' as never }, /neznámy stav/],
    ['duplicitné kotvisko', { berthIds: [1 as EntityId, 1 as EntityId] }, /duplicitné kotvisko/],
    ['záporný anchorageIndex', { anchorageIndex: -1 }, /anchorageIndex/],
    ['necelý waypointIndex', { waypointIndex: 1.5 }, /waypointIndex/],
    ['waypointIndex za koncom trasy', { waypointIndex: 4, route: ROUTE3 }, /za koncom trasy/],
    ['bod trasy NaN', { route: [{ x: Number.NaN, y: 1 }] }, /bod trasy/],
    ['bod trasy s kurzom 45', { route: [{ x: 1, y: 1, heading: 45 as never }] }, /bod trasy/],
  ])('%s → ShipError(invalid_input)', (_name, overrides, message) => {
    expect(() => ship(overrides)).toThrow(ShipError);
    expect(() => ship(overrides)).toThrow(message);
  });

  it('náklad mimo kategórií triedy → ShipError(invalid_input)', () => {
    expect(() => ship({ def: SHIP_DEFS.ships.get(BULKER) })).toThrow(/trieda neprevezie/);
    expect(ship({ def: SHIP_DEFS.ships.get(BULKER), cargoType: SHIP_DEFS.cargoTypes.get(GRAIN) }).cargoCategory).toBe('bulk');
  });
});
