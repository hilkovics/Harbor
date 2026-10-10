/**
 * Verzia `WorldState` v14 bez migrácií (ADR-036 bod 2, clean break savov; ARCHITECTURE §14): aktuálna verzia je jediná podporovaná,
 * save inej verzie (v1–v11 aj novšej) odmietne `World.deserialize` aj `parseWorldState` chybou `UnsupportedSaveVersionError`
 * s pointerom `/version`, ktorú vie aplikácia rozpoznať. Svet pri odmietnutí ostáva nedotknutý (nevznikne polovičatý svet).
 */
import { describe, expect, it } from 'vitest';
import {
  OLDEST_WORLD_STATE_VERSION,
  UnsupportedSaveVersionError,
  WORLD_STATE_KEYS,
  WORLD_STATE_VERSION,
  World,
  WorldStateError,
  assertSupportedWorldVersion,
  stateHash,
  type WorldState,
} from '@sim/world';
import { DEFS, MAP } from './world-fixtures';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Aktuálny save s upravenou verziou (tvar zostáva v14 — chyba verzie musí prísť pred kontrolou tvaru). */
function withVersion(version: unknown): WorldState {
  return { ...clone(World.create(DEFS, MAP, 4242).serialize()), version } as unknown as WorldState;
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('očakávaná výnimka, nevznikla');
}

describe('verzia WorldState v15 bez migrácií (ADR-036, v15 ADR-043)', () => {
  it('aktuálna aj najstaršia podporovaná verzia je 15; kľúče v15 v poradí serialize()', () => {
    expect(WORLD_STATE_VERSION).toBe(15);
    expect(OLDEST_WORLD_STATE_VERSION).toBe(15);
    const state = World.create(DEFS, MAP, 4242).serialize();
    expect(state.version).toBe(WORLD_STATE_VERSION);
    expect(Object.keys(state)).toEqual([...WORLD_STATE_KEYS]);
  });

  it('aktuálna verzia prejde bez zmeny (tá istá referencia) a svet sa načíta na rovnaký hash', () => {
    const state = clone(World.create(DEFS, MAP, 4242).serialize());
    expect(assertSupportedWorldVersion(state)).toBe(state);
    expect(stateHash(World.deserialize(DEFS, MAP, state))).toBe(stateHash(World.create(DEFS, MAP, 4242)));
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('save v%i → UnsupportedSaveVersionError na /version (starší save)', (version) => {
    const error = thrownBy(() => World.deserialize(DEFS, MAP, withVersion(version)));
    expect(error).toBeInstanceOf(UnsupportedSaveVersionError);
    expect(error).toBeInstanceOf(WorldStateError);
    const unsupported = error as UnsupportedSaveVersionError;
    expect(unsupported.path).toBe('/version');
    expect(unsupported.version).toBe(version);
    expect(unsupported.isOlder).toBe(true);
    expect(unsupported.message).toContain('nepodporovaná verzia');
  });

  it('starý save s tvarom starej verzie (chýbajúce kľúče) dostane chybu verzie, nie chybu tvaru', () => {
    const error = thrownBy(() => World.deserialize(DEFS, MAP, { version: 1, mapId: MAP.id } as unknown as WorldState));
    expect(error).toBeInstanceOf(UnsupportedSaveVersionError);
  });

  it('novšia verzia je UnsupportedSaveVersionError, ale nie je „starší“', () => {
    const error = thrownBy(() => World.deserialize(DEFS, MAP, withVersion(WORLD_STATE_VERSION + 1)));
    expect(error).toBeInstanceOf(UnsupportedSaveVersionError);
    expect((error as UnsupportedSaveVersionError).isOlder).toBe(false);
  });

  it.each([
    ['chýbajúca verzia', undefined],
    ['verzia ako text', '9'],
    ['neceločíselná verzia', 9.5],
    ['verzia null', null],
  ])('%s → obyčajná WorldStateError na /version (nie UnsupportedSaveVersionError)', (_name, version) => {
    const error = thrownBy(() => World.deserialize(DEFS, MAP, withVersion(version)));
    expect(error).toBeInstanceOf(WorldStateError);
    expect(error).not.toBeInstanceOf(UnsupportedSaveVersionError);
    expect((error as WorldStateError).path).toBe('/version');
  });

  it('stav, ktorý nie je objekt → WorldStateError na koreni', () => {
    for (const bad of [null, 5, 'save', [1, 2]]) {
      const error = thrownBy(() => World.deserialize(DEFS, MAP, bad as unknown as WorldState));
      expect(error).toBeInstanceOf(WorldStateError);
      expect((error as WorldStateError).path).toBe('');
    }
  });

  it('odmietnutý starý save vstup nezmení', () => {
    const old = withVersion(9);
    const before = JSON.stringify(old);
    thrownBy(() => World.deserialize(DEFS, MAP, old));
    expect(JSON.stringify(old)).toBe(before);
  });
});
