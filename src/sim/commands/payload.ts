/**
 * Kontrola tvaru serializovaného príkazu (`SerializedCommand` → argumenty konštruktora). Fail-fast `CommandError`
 * s JSON pointerom (RFC 6901), napr. `PlaceRoad/cells/3/x: musí byť celé číslo, dostal 1.5`.
 *
 * Tvar je presný — chýbajúci aj neznámy kľúč je chyba. Vďaka tomu `commandFromJSON(json).toJSON()` vráti
 * hlboko rovný `json` pre každý prijatý vstup (replay, save; ARCHITECTURE §12.2). Rozsahy závislé od sveta
 * (bunka v mape, rýchlosť v `time.speeds`) sem nepatria — tie hlási `validate` ako `ValidationReason`.
 */
import type { CellCoord } from '../grid/grid';
import { pointerSegment } from '../grid/map-error';
import type { SerializedCommand } from './command';
import { CommandError } from './command-error';

/** Kľúče bunky v payloade (`{ x, y }`). */
const CELL_KEYS: readonly string[] = ['x', 'y'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'pole';
  if (typeof value === 'object') return 'objekt';
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** Objekt s presne danými kľúčmi: najprv neznámy kľúč, potom chýbajúci (rovnako ako `DefRegistry`, `parseMapDef`). */
function checkKeys(value: unknown, keys: readonly string[], type: string, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new CommandError(`${type}${path}: musí byť objekt, dostal ${describeValue(value)}`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new CommandError(`${type}${path}${pointerSegment(key)}: neznámy kľúč`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new CommandError(`${type}${path}${pointerSegment(key)}: chýba povinný kľúč`);
  }
  return value;
}

/**
 * Overí, že `json` je príkaz typu `type` s presne kľúčmi `keys` (vrátane `type`), a vráti ho ako záznam.
 * Iný `type` (napr. priame volanie `PlaceRoadCommand.fromJSON` s `RemoveRoad`) → `CommandError`.
 */
export function readPayload(json: SerializedCommand, type: string, keys: readonly string[]): Record<string, unknown> {
  const raw = checkKeys(json, keys, type, '');
  if (raw['type'] !== type) {
    throw new CommandError(`${type}/type: očakávaný typ '${type}', dostal ${describeValue(raw['type'])}`);
  }
  return raw;
}

/** Súradnica bunky musí byť bezpečné celé číslo (aj záporné — mimo mapy je `out_of_bounds` vo `validate`). */
export function checkCoordinate(value: unknown, type: string, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new CommandError(`${type}${path}: súradnica musí byť celé číslo, dostal ${describeValue(value)}`);
  }
  return value;
}

/**
 * Nezávislá zmrazená kópia zoznamu buniek (poradie aj duplicity zachované — `toJSON` ich vráti bez zmeny).
 * Každá bunka musí mať celočíselné `x`, `y`; inak `CommandError` s cestou `<type><path>/<i>/x`.
 * Slúži konštruktorom príkazov (vstup z UI) aj `parseCellList` (vstup z JSON).
 */
export function copyCellList(cells: readonly CellCoord[], type: string, path: string): readonly CellCoord[] {
  if (!Array.isArray(cells)) throw new CommandError(`${type}${path}: musí byť pole buniek, dostal ${describeValue(cells)}`);
  return Object.freeze(
    cells.map((cell: CellCoord, i): CellCoord => {
      const cellPath = `${path}${pointerSegment(i)}`;
      if (!isPlainObject(cell)) throw new CommandError(`${type}${cellPath}: bunka musí byť objekt { x, y }, dostal ${describeValue(cell)}`);
      return Object.freeze({
        x: checkCoordinate(cell.x, type, `${cellPath}/x`),
        y: checkCoordinate(cell.y, type, `${cellPath}/y`),
      });
    }),
  );
}

/** Zoznam buniek z JSON payloadu: pole objektov s presne kľúčmi `x`, `y` (celé čísla). */
export function parseCellList(value: unknown, type: string, path: string): readonly CellCoord[] {
  if (!Array.isArray(value)) throw new CommandError(`${type}${path}: musí byť pole buniek, dostal ${describeValue(value)}`);
  value.forEach((cell: unknown, i) => checkKeys(cell, CELL_KEYS, type, `${path}${pointerSegment(i)}`));
  return copyCellList(value as CellCoord[], type, path);
}

/** Konečné číslo (JSON nepozná `NaN`/`Infinity`, ale konštruktor príkazu ich dostať môže). */
export function checkFiniteNumber(value: unknown, type: string, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CommandError(`${type}${path}: musí byť konečné číslo, dostal ${describeValue(value)}`);
  }
  return value;
}

/** Bezpečné celé číslo (napr. id entity); či entita existuje, hlási až `validate`. */
export function checkInteger(value: unknown, type: string, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new CommandError(`${type}${path}: musí byť celé číslo, dostal ${describeValue(value)}`);
  }
  return value;
}

/** Reťazec (napr. id defu); či def existuje, hlási až `validate`. */
export function checkString(value: unknown, type: string, path: string): string {
  if (typeof value !== 'string') throw new CommandError(`${type}${path}: musí byť reťazec, dostal ${describeValue(value)}`);
  return value;
}
