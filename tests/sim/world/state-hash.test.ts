/**
 * Odtlačok stavu `stateHash` / `hashWorldState` (T06-01, ADR-030 bod 6; ARCHITECTURE §14, §16): FNV-1a 32-bit nad
 * UTF-8 bajtmi `JSON.stringify(world.serialize())`, 8 malých hex znakov.
 *  - algoritmus: známe testovacie vektory FNV-1a 32 a zhoda s referenciou nad `Buffer.from(text, 'utf8')`,
 *  - stabilita: rovnaký stav → rovnaký hash (dva svety, opakované volanie, JSON text savu, obnovený svet),
 *  - citlivosť: seed, tick, jedna hodnota, poradie kľúčov, stav `Rng` → iný hash,
 *  - hash svet nemení a s neprázdnou frontou príkazov zlyhá ako `serialize()`.
 */
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import { World, fnv1a32Hex, hashWorldState, stateHash, type WorldState } from '@sim/world';
import { DEFS, MAP, SEED, hashState, runTicks } from './world-fixtures';

const HEX8 = /^[0-9a-f]{8}$/;

/** Referenčná FNV-1a 32 nad UTF-8 bajtmi z Node `Buffer` (nezávislá od kódovania v `state-hash.ts`). */
function referenceFnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Svet po `ticks` tickoch od `World.create` (bez príkazov). */
function worldAfter(ticks: number, seed: number = SEED): World {
  const world = World.create(DEFS, MAP, seed);
  runTicks(world, ticks);
  return world;
}

describe('fnv1a32Hex — algoritmus', () => {
  it.each([
    ['', '811c9dc5'],
    ['a', 'e40c292c'],
    ['foobar', 'bf9cf968'],
  ])('známy vektor FNV-1a 32: "%s" → %s', (text, expected) => {
    expect(fnv1a32Hex(text)).toBe(expected);
  });

  it.each(['{"version":6}', 'žeriav Ťažký kontajner', '港口 €', 'loď 🚢 a 𝄞', '\u0000\u007f\u0080߿ࠀ￿'])(
    'zhoda s referenciou nad UTF-8 bajtmi: %j',
    (text) => {
      expect(fnv1a32Hex(text)).toBe(referenceFnv1a(text));
    },
  );

  it('výstup má vždy 8 hex znakov, aj keď hash začína nulou (doplnenie zľava)', () => {
    let withLeadingZero: string | undefined;
    for (let i = 0; withLeadingZero === undefined; i++) {
      const hash = fnv1a32Hex(`x${String(i)}`);
      if (hash.startsWith('0')) withLeadingZero = hash;
    }
    expect(withLeadingZero).toMatch(HEX8);
  });

  it('pre ASCII sa zhoduje s doterajším testovým `hashState` (FNV-1a nad UTF-16 jednotkami)', () => {
    const state = worldAfter(50).serialize();
    expect(hashWorldState(state)).toBe(hashState(state));
  });
});

describe('stateHash — stabilita', () => {
  it('= hashWorldState(serialize()) = hash JSON textu savu po JSON.parse; 8 hex znakov', () => {
    const world = worldAfter(120);
    const hash = stateHash(world);
    expect(hash).toMatch(HEX8);
    expect(hashWorldState(world.serialize())).toBe(hash);
    expect(hashWorldState(JSON.parse(JSON.stringify(world.serialize())) as WorldState)).toBe(hash);
    expect(fnv1a32Hex(JSON.stringify(world.serialize()))).toBe(hash);
  });

  it('opakované volanie dá rovnaký hash a svet nemení (beh pokračuje ako bez hashovania)', () => {
    const hashed = World.create(DEFS, MAP, SEED);
    const control = World.create(DEFS, MAP, SEED);
    for (let i = 0; i < 200; i++) {
      hashed.tick();
      stateHash(hashed);
      control.tick();
    }
    expect(stateHash(hashed)).toBe(stateHash(hashed));
    expect(stateHash(hashed)).toBe(stateHash(control));
  });

  it('dva svety s rovnakým seedom → rovnaký hash v každom kontrolnom bode', () => {
    const a = World.create(DEFS, MAP, SEED);
    const b = World.create(DEFS, MAP, SEED);
    for (const until of [0, 1, 10, 500]) {
      runTicks(a, until - a.clock.tick);
      runTicks(b, until - b.clock.tick);
      expect(stateHash(b), `tick ${String(until)}`).toBe(stateHash(a));
    }
  });

  it('obnovený svet (deserialize JSON textu) má rovnaký hash ako originál', () => {
    const world = worldAfter(300);
    const loaded = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(world.serialize())) as WorldState);
    expect(stateHash(loaded)).toBe(stateHash(world));
  });
});

describe('stateHash — citlivosť (porovnanie hashov niečo hovorí)', () => {
  it('iný seed → iný hash už pri vzniku sveta', () => {
    expect(stateHash(World.create(DEFS, MAP, SEED + 1))).not.toBe(stateHash(World.create(DEFS, MAP, SEED)));
  });

  it('každý tick zmení hash', () => {
    const world = World.create(DEFS, MAP, SEED);
    const seen = new Set([stateHash(world)]);
    for (let i = 0; i < 5; i++) {
      world.tick();
      seen.add(stateHash(world));
    }
    expect(seen.size).toBe(6);
  });

  it('zmena jednej hodnoty v stave (hotovosť o 1 cent) → iný hash', () => {
    const state = worldAfter(10).serialize();
    expect(hashWorldState({ ...state, cashCents: state.cashCents + 1 })).not.toBe(hashWorldState(state));
  });

  it('rovnaké hodnoty v inom poradí kľúčov → iný hash (serialize skladá kľúče vždy rovnako)', () => {
    const state = worldAfter(10).serialize();
    const { version, ...rest } = state;
    const reordered = { ...rest, version } as WorldState;
    expect(reordered).toEqual(state);
    expect(hashWorldState(reordered)).not.toBe(hashWorldState(state));
  });

  it('spotreba Rng bez inej zmeny → iný hash (stav Rng je v save)', () => {
    const world = worldAfter(10);
    const before = stateHash(world);
    world.rng.next();
    expect(stateHash(world)).not.toBe(before);
  });
});

describe('stateHash — fronta príkazov', () => {
  it('neprázdna fronta → chyba ako serialize(); po applyPending() hash funguje', () => {
    const world = World.create(DEFS, MAP, SEED);
    world.enqueue(commandFromJSON({ type: 'SetGameSpeed', speed: 2 }));
    expect(() => stateHash(world)).toThrow(/neaplikovaných príkazov/);
    world.applyPending();
    expect(stateHash(world)).toMatch(HEX8);
  });
});
