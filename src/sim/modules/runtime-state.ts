/**
 * Dynamický stav modulu v save (`WorldState.modules[i].runtime`, ADR-014) — čistý JSON bez tried. Každá trieda
 * modulu ukladá len to, čo sa nedá odvodiť z iných častí stavu (obsadenie apronu a držaná jednotka žeriavu sú
 * v `CargoLedger`, `cell.moduleId` z footprintov, skupiny kotvísk prepočtom).
 *
 * Pomocné kontroly pre `restoreRuntimeState` sú fail-fast a hlásia `ModuleStateError` s JSON pointerom relatívnym
 * ku koreňu `runtime`.
 */
import { describeValue, isPlainObject, pointerSegment } from '../defs/def-spec';
import { ModuleStateError } from './module-error';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Tvar `runtime` — objekt JSON hodnôt; konkrétne triedy majú vlastný typ (napr. `CraneRuntimeState`). */
export type ModuleRuntimeState = { readonly [key: string]: JsonValue };

/** Objekt s presne danými kľúčmi (chýbajúci aj neznámy kľúč = chyba). */
export function checkRuntimeKeys(value: unknown, keys: readonly string[], path = ''): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw new ModuleStateError(path, `musí byť objekt, dostal ${describeValue(value)}`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new ModuleStateError(`${path}${pointerSegment(key)}`, 'neznámy kľúč');
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new ModuleStateError(`${path}${pointerSegment(key)}`, 'chýba povinný kľúč');
  }
  return value;
}

/** Celé číslo ≥ 0 (počítadlo tickov, slot). */
export function readCount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ModuleStateError(path, `musí byť celé číslo ≥ 0, dostal ${describeValue(value)}`);
  }
  return value;
}

/** `null` alebo celé číslo ≥ 0. */
export function readOptionalCount(value: unknown, path: string): number | null {
  return value === null ? null : readCount(value, path);
}

/** Hodnota z pevnej množiny reťazcov. */
export function readEnum<V extends string>(value: unknown, values: readonly V[], path: string): V {
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new ModuleStateError(path, `musí byť jedno z: ${values.join(', ')}, dostal ${describeValue(value)}`);
  }
  return match;
}
