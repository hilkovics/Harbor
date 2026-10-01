/**
 * Chyba a spoločné kontroly tvaru `WorldState` (parsovanie §14 aj migrácie). Fail-fast: prvý problém →
 * `WorldStateError` s JSON pointerom.
 */
import { pointerSegment } from '../grid/map-error';

/** Neplatný `WorldState`. Správa: `WorldState<path>: <problém>`, napr. `WorldState/roads/3/0: bunka je voda`. */
export class WorldStateError extends Error {
  /** JSON pointer (RFC 6901) do `WorldState`; `''` = celý stav. */
  readonly path: string;
  readonly problem: string;

  constructor(path: string, problem: string) {
    super(`WorldState${path}: ${problem}`);
    this.name = 'WorldStateError';
    this.path = path;
    this.problem = problem;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'pole';
  return typeof value === 'object' && value !== null ? 'objekt' : JSON.stringify(value);
}

/** Objekt s presne danými kľúčmi (chýbajúci aj neznámy kľúč = chyba). */
export function checkKeys(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new WorldStateError(path, `musí byť objekt, dostal ${describeValue(value)}`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new WorldStateError(`${path}${pointerSegment(key)}`, 'neznámy kľúč');
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new WorldStateError(`${path}${pointerSegment(key)}`, 'chýba povinný kľúč');
  }
  return value;
}

/** Pole, inak `WorldStateError`. */
export function checkArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new WorldStateError(path, `musí byť pole, dostal ${describeValue(value)}`);
  return value;
}

/** Bezpečné celé číslo ≥ `min`, inak `WorldStateError`. */
export function checkInteger(value: unknown, min: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new WorldStateError(path, `musí byť celé číslo ≥ ${String(min)}, dostal ${describeValue(value)}`);
  }
  return value;
}

export { pointerSegment };
