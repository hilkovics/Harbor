import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import economyJson from '@data/defs/economy.json';
import timeJson from '@data/defs/time.json';
import timeSchema from '@data/schemas/time.schema.json';
import { SimClock } from '@sim/core/sim-clock';
import { DefError, DefRegistry, SUPPORTED_SCHEMA_VERSION, loadBundledDefs } from '@sim/defs';

/** Čerstvá hlboká kópia bundled defov; negatívne testy z nej upravia jedno pole. */
function rawDefs(): { time: Record<string, unknown>; economy: Record<string, unknown> } {
  return { time: structuredClone(timeJson), economy: structuredClone(economyJson) };
}

/** Nastaví hodnotu na JSON pointeri (`/speeds/1`) v klonovanom deffe. */
function setAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.slice(1).split('/');
  const last = segments.pop() as string;
  let target = root;
  for (const segment of segments) target = target[segment] as Record<string, unknown>;
  target[last] = value;
}

/** Overí, že `fn` hodí `DefError` s daným defom a cestou (a správou `<defName><path>: …`). */
function expectDefError(fn: () => unknown, defName: string, path: string): DefError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DefError);
  const error = caught as DefError;
  expect(error).toBeInstanceOf(Error);
  expect(error.defName).toBe(defName);
  expect(error.path).toBe(path);
  expect(error.message.startsWith(`${defName}${path}: `)).toBe(true);
  return error;
}

describe('DefRegistry.fromRaw', () => {
  it('platné defy → register s typovanými getterami', () => {
    const registry = DefRegistry.fromRaw(rawDefs());
    expect(registry.time.tickGameSeconds).toBe(timeJson.tickGameSeconds);
    expect(registry.economy.startingCashCents).toBe(economyJson.startingCashCents);
  });

  describe('chýbajúci def → DefError s názvom defu', () => {
    it.each(['time', 'economy'] as const)('%s', (name) => {
      const raw: Partial<ReturnType<typeof rawDefs>> = rawDefs();
      delete raw[name];
      const error = expectDefError(() => DefRegistry.fromRaw(raw), name, '');
      expect(error.message).toContain(name);
    });

    it('def explicitne undefined alebo null', () => {
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), time: undefined }), 'time', '');
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), economy: null }), 'economy', '');
    });

    it.each([[[]], ['{}'], [42]] as unknown[][])('def nie je objekt (%j)', (value) => {
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), time: value }), 'time', '');
    });
  });

  describe('zlý typ alebo rozsah poľa → DefError s cestou', () => {
    const cases: readonly (readonly [def: 'time' | 'economy', path: string, value: unknown])[] = [
      ['time', '/tickGameSeconds', '10'],
      ['time', '/tickGameSeconds', 10.5],
      ['time', '/tickGameSeconds', 0],
      ['time', '/tickGameSeconds', null],
      ['time', '/tickGameSeconds', 7],
      ['time', '/tickGameSeconds', 120],
      ['time', '/tickGameSeconds', -10],
      ['time', '/ticksPerRealSecond', 0],
      ['time', '/speeds', 8],
      ['time', '/speeds', []],
      ['time', '/speeds', [1, 2, 4]],
      ['time', '/speeds/1', 1.5],
      ['time', '/speeds/2', -1],
      ['time', '/speeds/1', '1'],
      ['time', '/speeds', [0, 1, 1]],
      ['economy', '/startingCashCents', '120000000'],
      ['economy', '/startingCashCents', 1.5],
      ['economy', '/startingCashCents', -1],
      ['economy', '/demurrageRateOfRewardPerHour', 1.5],
      ['economy', '/demurrageRateOfRewardPerHour', -0.1],
      ['economy', '/latePenaltyRateOfRewardPerDay', Number.NaN],
      ['economy', '/failAfterDaysLate', 2.5],
      ['economy', '/leaseMonthlyRateOfPrice', 'x'],
      ['economy', '/bankruptcyDays', 0],
      ['economy', '/offersPerDay', -1],
      ['economy', '/offerExpiryDays', 0],
    ];

    it.each(cases)('%s %s = %j', (def, path, value) => {
      const raw = rawDefs();
      setAtPath(raw[def], path, value);
      expectDefError(() => DefRegistry.fromRaw(raw), def, path);
    });

    it('správa obsahuje názov defu, cestu aj problém', () => {
      const raw = rawDefs();
      raw.time['tickGameSeconds'] = '10';
      const error = expectDefError(() => DefRegistry.fromRaw(raw), 'time', '/tickGameSeconds');
      expect(error.problem).toContain('celé číslo');
      expect(error.message).toBe(`time/tickGameSeconds: ${error.problem}`);
    });

    it('tickGameSeconds, ktoré nedelí 60 → DefError s vysvetlením', () => {
      const raw = rawDefs();
      raw.time['tickGameSeconds'] = 7;
      const error = expectDefError(() => DefRegistry.fromRaw(raw), 'time', '/tickGameSeconds');
      expect(error.problem).toContain('musí deliť 60');
      expect(error.problem).toContain('dostal 7');
    });

    it('chýbajúce povinné pole → cesta poľa', () => {
      const raw = rawDefs();
      delete raw.economy['bankruptcyDays'];
      expectDefError(() => DefRegistry.fromRaw(raw), 'economy', '/bankruptcyDays');
    });
  });

  describe('neznámy kľúč → DefError', () => {
    it.each(['time', 'economy'] as const)('%s', (def) => {
      const raw = rawDefs();
      raw[def]['unexpectedKey'] = 1;
      expectDefError(() => DefRegistry.fromRaw(raw), def, '/unexpectedKey');
    });

    it('preklep v názve poľa sa hlási ako neznámy kľúč', () => {
      const raw = rawDefs();
      raw.time['tickGameSecond'] = raw.time['tickGameSeconds'];
      delete raw.time['tickGameSeconds'];
      expectDefError(() => DefRegistry.fromRaw(raw), 'time', '/tickGameSecond');
    });

    it('špeciálne znaky v kľúči sa escapujú (RFC 6901)', () => {
      const raw = rawDefs();
      raw.time['a/b~c'] = 1;
      expectDefError(() => DefRegistry.fromRaw(raw), 'time', '/a~1b~0c');
    });
  });

  describe('zlá schemaVersion → DefError', () => {
    it.each(['time', 'economy'] as const)('%s: iná verzia', (def) => {
      const raw = rawDefs();
      raw[def]['schemaVersion'] = SUPPORTED_SCHEMA_VERSION + 1;
      expectDefError(() => DefRegistry.fromRaw(raw), def, '/schemaVersion');
    });

    it.each([['1'], [null], [1.5]])('nečíselná/neplatná verzia %j', (value) => {
      const raw = rawDefs();
      raw.economy['schemaVersion'] = value;
      expectDefError(() => DefRegistry.fromRaw(raw), 'economy', '/schemaVersion');
    });

    it('chýbajúca schemaVersion', () => {
      const raw = rawDefs();
      delete raw.time['schemaVersion'];
      expectDefError(() => DefRegistry.fromRaw(raw), 'time', '/schemaVersion');
    });
  });

  describe('nemenný výstup', () => {
    it('objekty aj pole speeds sú zmrazené', () => {
      const registry = DefRegistry.fromRaw(rawDefs());
      expect(Object.isFrozen(registry.time)).toBe(true);
      expect(Object.isFrozen(registry.time.speeds)).toBe(true);
      expect(Object.isFrozen(registry.economy)).toBe(true);
      expect(() => {
        (registry.time as { tickGameSeconds: number }).tickGameSeconds = 1;
      }).toThrow(TypeError);
    });

    it('vstupné objekty sa nemenia ani nezmrazujú', () => {
      const raw = rawDefs();
      const before = structuredClone(raw);
      const registry = DefRegistry.fromRaw(raw);
      expect(raw).toEqual(before);
      expect(Object.isFrozen(raw.time)).toBe(false);
      expect(Object.isFrozen(raw.time['speeds'])).toBe(false);
      expect(registry.time.speeds).not.toBe(raw.time['speeds']);
    });
  });
});

describe('loadBundledDefs', () => {
  it('bundled defy sa načítajú s hodnotami z data/defs', () => {
    const registry = loadBundledDefs();
    expect(registry.time).toEqual(timeJson);
    expect(registry.economy).toEqual(economyJson);
    // Kontrolné hodnoty podľa ARCHITECTURE §3 a §4.6.
    expect(registry.time.tickGameSeconds).toBe(10);
    expect(registry.time.speeds).toEqual([0, 1, 2, 4, 8]);
    expect(registry.economy.startingCashCents).toBe(120_000_000);
    expect(registry.economy.offersPerDay).toBe(6);
  });

  it('každé volanie vráti nezávislý register', () => {
    expect(loadBundledDefs()).not.toBe(loadBundledDefs());
  });
});

describe('tickGameSeconds: schéma ⇔ DefRegistry ⇔ SimClock', () => {
  /** Nezávislý oracle: delitele 60 (nie odvodený z kódu ani zo schémy). */
  const DIVISORS_OF_60 = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
  const validateTimeSchema = new Ajv2020({ allErrors: true }).compile(timeSchema);

  const schemaAccepts = (n: number): boolean => validateTimeSchema({ ...timeJson, tickGameSeconds: n });
  const registryAccepts = (n: number): boolean => {
    try {
      DefRegistry.fromRaw({ time: { ...timeJson, tickGameSeconds: n }, economy: economyJson });
      return true;
    } catch (error) {
      if (error instanceof DefError) {
        expect(error.defName).toBe('time');
        expect(error.path).toBe('/tickGameSeconds');
        return false;
      }
      throw error;
    }
  };
  const clockAccepts = (n: number): boolean => {
    try {
      new SimClock({ tickGameSeconds: n });
      return true;
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  };

  it('bundled time.json je platný pre schému aj registry', () => {
    expect(schemaAccepts(timeJson.tickGameSeconds)).toBe(true);
    expect(registryAccepts(timeJson.tickGameSeconds)).toBe(true);
  });

  it.each(Array.from({ length: 120 }, (_, i) => i + 1))('n = %i: schéma, registry a SimClock sa zhodujú', (n) => {
    const expected = DIVISORS_OF_60.includes(n);
    expect({ n, schema: schemaAccepts(n), registry: registryAccepts(n), clock: clockAccepts(n) }).toEqual({
      n,
      schema: expected,
      registry: expected,
      clock: expected,
    });
  });
});

describe('DefRegistry.time ako SimClockConfig', () => {
  it('new SimClock(registry.time) → 6 tickov/min (typovo aj za behu)', () => {
    const clock = new SimClock(loadBundledDefs().time);
    expect(clock.ticksPerMinute).toBe(6);
    expect(clock.ticksPerDay).toBe(8640);
  });
});
