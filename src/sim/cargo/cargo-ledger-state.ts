/**
 * Serializovaný stav `CargoLedger` — čistý JSON (`JSON.parse(JSON.stringify(s))` je hlboko rovný `s`). Do `WorldState`
 * ho zaradí v2 (T02-03); dovtedy ho používa len `getState()` / `fromState()`.
 *
 * Tvar: `{ createdCount, exportedCount, units }`. `units` sú len živé jednotky (na mape) v kanonickom poradí:
 * druhy lokácií podľa `CARGO_HOLDER_KINDS`, držitelia vzostupne podľa id, v rámci držiteľa poradie jeho indexu
 * (loď vzostupne podľa id, ostatní FIFO). Poradie v rámci FIFO držiteľa je súčasťou stavu — `fromState` ho obnoví.
 * Exportované jednotky sa neukladajú, ostáva len `exportedCount`.
 */
import type { EntityId } from '../core/entity-id';
import type { Catalog } from '../defs/catalog';
import { describeValue, isPlainObject, pointerSegment } from '../defs/def-spec';
import type { CargoTypeDef } from '../defs/types';
import { CargoStateError } from './cargo-error';
import { formatLocation, holderIdOf, holderSpecOf, isEntityIdValue, normalizeLocation, uniqueSlotOf } from './cargo-location';
import type { CargoUnit } from './cargo-unit';

export interface CargoLedgerState {
  /** Počet jednotiek vytvorených za celú hru (= živé + exportované). */
  readonly createdCount: number;
  /** Počet jednotiek, ktoré opustili mapu (`exported`). */
  readonly exportedCount: number;
  readonly units: readonly CargoUnit[];
}

const STATE_KEYS: readonly (keyof CargoLedgerState)[] = ['createdCount', 'exportedCount', 'units'];
const UNIT_KEYS: readonly (keyof CargoUnit)[] = ['id', 'typeId', 'contractId', 'quantity', 'location'];

/** Objekt s presne danými kľúčmi (chýbajúci aj neznámy kľúč = chyba). */
function checkKeys(value: unknown, keys: readonly string[], path: string): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw new CargoStateError(path, `musí byť objekt, dostal ${describeValue(value)}`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new CargoStateError(`${path}${pointerSegment(key)}`, 'neznámy kľúč');
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new CargoStateError(`${path}${pointerSegment(key)}`, 'chýba povinný kľúč');
  }
  return value;
}

function checkCount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CargoStateError(path, `musí byť celé číslo ≥ 0, dostal ${describeValue(value)}`);
  }
  return value;
}

/** Kľúč jedinečného miesta `druh:držiteľ:miesto` (apron, sklad). */
function slotKeyOf(unit: CargoUnit): string | undefined {
  const slot = uniqueSlotOf(unit.location);
  if (slot === null) return undefined;
  return `${unit.location.kind}:${String(holderIdOf(unit.location))}:${String(slot)}`;
}

interface UnitContext {
  readonly cargoTypes: Catalog<Readonly<CargoTypeDef>>;
  /** `ids.getState().nextId` sveta — uložené id musí byť menšie, inak by ho alokátor pridelil znova. */
  readonly nextId: number;
}

function parseUnit(raw: unknown, path: string, context: UnitContext): CargoUnit {
  const fields = checkKeys(raw, UNIT_KEYS, path);
  const { id, typeId, contractId, quantity } = fields;
  if (!isEntityIdValue(id) || id >= context.nextId) {
    throw new CargoStateError(
      `${path}/id`,
      `id musí byť celé číslo 1…${String(context.nextId - 1)} (menšie ako ids.nextId), dostal ${describeValue(id)}`,
    );
  }
  if (typeof typeId !== 'string' || !context.cargoTypes.has(typeId)) {
    throw new CargoStateError(`${path}/typeId`, `neznámy typ nákladu ${describeValue(typeId)}`);
  }
  if (contractId !== null && !isEntityIdValue(contractId)) {
    throw new CargoStateError(`${path}/contractId`, `musí byť null alebo celé číslo ≥ 1, dostal ${describeValue(contractId)}`);
  }
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) {
    throw new CargoStateError(`${path}/quantity`, `musí byť celé číslo ≥ 1, dostal ${describeValue(quantity)}`);
  }
  const normalized = normalizeLocation(fields['location']);
  if (!normalized.ok) throw new CargoStateError(`${path}/location${normalized.path}`, normalized.problem);
  const { location } = normalized;
  if (holderSpecOf(location.kind) === undefined) {
    throw new CargoStateError(`${path}/location/kind`, `'${location.kind}' sa neukladá — exportované jednotky sú len v exportedCount`);
  }
  return Object.freeze({ id, typeId, contractId, quantity, location });
}

/**
 * Overí `raw` ako `CargoLedgerState` (fail-fast, `CargoStateError` s JSON pointerom relatívnym ku koreňu stavu):
 * presne kľúče stavu aj jednotiek, počítadlá celé ≥ 0, id jedinečné a menšie ako `nextId`, známy `typeId`,
 * `contractId` null alebo id, `quantity` celé ≥ 1, platná lokácia na mape (nie `exported`), jedinečné miesto
 * obsadené najviac raz a `createdCount = units.length + exportedCount`. Vstup sa nemení; výsledok sú zmrazené
 * kópie jednotiek v poradí vstupu (= poradie FIFO indexov).
 */
export function parseCargoLedgerState(
  raw: unknown,
  cargoTypes: Catalog<Readonly<CargoTypeDef>>,
  nextId: number,
): CargoLedgerState {
  const state = checkKeys(raw, STATE_KEYS, '');
  const createdCount = checkCount(state['createdCount'], '/createdCount');
  const exportedCount = checkCount(state['exportedCount'], '/exportedCount');
  const rawUnits = state['units'];
  if (!Array.isArray(rawUnits)) throw new CargoStateError('/units', `musí byť pole, dostal ${describeValue(rawUnits)}`);

  const context: UnitContext = { cargoTypes, nextId };
  const pathById = new Map<EntityId, string>();
  const pathBySlot = new Map<string, string>();
  const units = rawUnits.map((rawUnit: unknown, i): CargoUnit => {
    const path = `/units${pointerSegment(i)}`;
    const unit = parseUnit(rawUnit, path, context);
    const firstPath = pathById.get(unit.id);
    if (firstPath !== undefined) throw new CargoStateError(`${path}/id`, `duplicitné id ${String(unit.id)} (${firstPath})`);
    pathById.set(unit.id, path);
    const slotKey = slotKeyOf(unit);
    if (slotKey !== undefined) {
      const occupiedBy = pathBySlot.get(slotKey);
      if (occupiedBy !== undefined) {
        throw new CargoStateError(`${path}/location`, `miesto ${formatLocation(unit.location)} už obsadila jednotka ${occupiedBy}`);
      }
      pathBySlot.set(slotKey, path);
    }
    return unit;
  });

  if (createdCount !== units.length + exportedCount) {
    throw new CargoStateError(
      '/createdCount',
      `${String(createdCount)} ≠ živé ${String(units.length)} + exportedCount ${String(exportedCount)} (konzervácia nákladu)`,
    );
  }
  return { createdCount, exportedCount, units: Object.freeze(units) };
}
