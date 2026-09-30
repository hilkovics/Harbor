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

/** Karta T02-05: presne tieto prechody, nič iné. */
const EXPECTED: readonly (readonly [ShipState, ShipState])[] = [
  ['inbound', 'waiting_anchorage'],
  ['inbound', 'berthing'],
  ['waiting_anchorage', 'berthing'],
  ['berthing', 'docked'],
  ['docked', 'undocking'],
  ['undocking', 'outbound'],
  ['outbound', 'despawned'],
];

describe('SHIP_TRANSITIONS', () => {
  it('obsahuje každý stav a presne prechody z karty T02-05; despawned je konečný', () => {
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
  it('kotviská drží loď len v berthing a docked; anchorage len pri čakaní; vodu pred kotviskom blokuje berthing/docked/undocking', () => {
    const where = (key: 'holdsBerths' | 'waitsForBerth' | 'blocksBerthWater' | 'moored'): ShipState[] =>
      SHIP_STATES.filter((state) => SHIP_STATE_TRAITS[state][key]);
    expect(where('holdsBerths')).toEqual(['berthing', 'docked']);
    expect(where('waitsForBerth')).toEqual(['waiting_anchorage']);
    expect(where('blocksBerthWater')).toEqual(['berthing', 'docked', 'undocking']);
    // T02-14: pri kotvisku (dockPoint + DOCKED_HEADING) stojí len dokovaná loď.
    expect(where('moored')).toEqual(['docked']);
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
  ] as const)('%s → %s vyhodí ShipError(invalid_transition) a loď sa nezmení', (from, to) => {
    const s = ship({ state: from, waypointIndex: 2 });
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
    const s = ship({ state: 'waiting_anchorage', x: 44.5, y: 7.25, heading: 270, anchorageIndex: 1, waypointIndex: 1 });
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
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
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
  ])('%s → ShipError(invalid_input)', (_name, overrides, message) => {
    expect(() => ship(overrides)).toThrow(ShipError);
    expect(() => ship(overrides)).toThrow(message);
  });

  it('náklad mimo kategórií triedy → ShipError(invalid_input)', () => {
    expect(() => ship({ def: SHIP_DEFS.ships.get(BULKER) })).toThrow(/trieda neprevezie/);
    expect(ship({ def: SHIP_DEFS.ships.get(BULKER), cargoType: SHIP_DEFS.cargoTypes.get(GRAIN) }).cargoCategory).toBe('bulk');
  });
});
