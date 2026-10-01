/**
 * Serializovaný stav `CargoLedger` — čistý JSON (`JSON.parse(JSON.stringify(s))` je hlboko rovný `s`). `WorldState` v2
 * ho ukladá ako `cargo` (ADR-014); `parseWorldState` chyby preloží na `WorldStateError` s prefixom `/cargo`.
 *
 * Tvar (v7, ADR-032): `{ createdCount, exportedCount, shippedCount, units }`. `units` sú len živé jednotky (na mape)
 * v kanonickom poradí: druhy lokácií podľa `CARGO_HOLDER_KINDS`, držitelia vzostupne podľa id, v rámci držiteľa poradie
 * jeho indexu (loď vzostupne podľa id, ostatní FIFO). Poradie v rámci FIFO držiteľa je súčasťou stavu — `fromState` ho
 * obnoví. Jednotka nesie aj štítky (`voyageId`, `direction`, `destinationPort`, `weightClass`) a `hold`. Exportované
 * ani odplávané jednotky sa neukladajú, ostávajú len `exportedCount` a `shippedCount`.
 */
import type { ContractId, EntityId, VoyageId } from '../core/entity-id';
import type { Catalog } from '../defs/catalog';
import { describeValue, isPlainObject, pointerSegment } from '../defs/def-spec';
import type { CargoTypeDef } from '../defs/types';
import { CargoStateError } from './cargo-error';
import { formatLocation, holderIdOf, holderSpecOf, isEntityIdValue, normalizeLocation, uniqueSlotOf } from './cargo-location';
import { cargoHoldProblem, cargoLabelsProblem, type CargoDirection, type CargoHold, type CargoUnit, type WeightClass } from './cargo-unit';

export interface CargoLedgerState {
  /** Počet jednotiek vytvorených za celú hru (= živé + exportované). */
  readonly createdCount: number;
  /** Počet jednotiek, ktoré opustili mapu po súši (`exported`). */
  readonly exportedCount: number;
  /** Počet jednotiek, ktoré odplávali na lodi (`shipped`, ADR-032). */
  readonly shippedCount: number;
  readonly units: readonly CargoUnit[];
}

/** Kľúče stavu ledgera v poradí `getState()`. */
export const CARGO_LEDGER_STATE_KEYS: readonly (keyof CargoLedgerState)[] = ['createdCount', 'exportedCount', 'shippedCount', 'units'];
/** Kľúče jednotky v save v poradí `getState()` (v7, ADR-032). */
export const CARGO_UNIT_KEYS: readonly (keyof CargoUnit)[] = ['id', 'typeId', 'contractId', 'voyageId', 'direction', 'destinationPort', 'weightClass', 'hold', 'quantity', 'location'];
const STATE_KEYS = CARGO_LEDGER_STATE_KEYS;
const UNIT_KEYS = CARGO_UNIT_KEYS;

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
  const { voyageId, direction, destinationPort, weightClass, hold } = fields;
  const labelProblem = cargoLabelsProblem({ voyageId, direction, destinationPort, weightClass }, contractId);
  if (labelProblem !== undefined) throw new CargoStateError(`${path}/${labelProblem.field}`, labelProblem.problem);
  const holdProblem = cargoHoldProblem(hold, direction as CargoDirection);
  if (holdProblem !== undefined) throw new CargoStateError(`${path}/hold`, holdProblem);
  const normalized = normalizeLocation(fields['location']);
  if (!normalized.ok) throw new CargoStateError(`${path}/location${normalized.path}`, normalized.problem);
  const { location } = normalized;
  if (holderSpecOf(location.kind) === undefined) {
    throw new CargoStateError(`${path}/location/kind`, `'${location.kind}' sa neukladá — exportované a odplávané jednotky sú len v exportedCount / shippedCount`);
  }
  const frozenHold = hold === null ? null : Object.freeze({ ...(hold as CargoHold) });
  return Object.freeze({
    id,
    typeId,
    contractId: contractId as ContractId | null,
    voyageId: voyageId as VoyageId | null,
    direction: direction as CargoDirection,
    destinationPort: destinationPort as string | null,
    weightClass: weightClass as WeightClass,
    hold: frozenHold,
    quantity,
    location,
  });
}

/**
 * Overí `raw` ako `CargoLedgerState` (fail-fast, `CargoStateError` s JSON pointerom relatívnym ku koreňu stavu):
 * presne kľúče stavu aj jednotiek, počítadlá celé ≥ 0, id jedinečné a menšie ako `nextId`, známy `typeId`,
 * `contractId` null alebo id, `quantity` celé ≥ 1, štítky (`cargoLabelsProblem`) a `hold` (`cargoHoldProblem`) v súlade,
 * platná lokácia na mape (nie `exported` / `shipped`), jedinečné miesto obsadené najviac raz a
 * `createdCount = units.length + exportedCount + shippedCount`. Vstup sa nemení; výsledok sú zmrazené kópie jednotiek
 * v poradí vstupu (= poradie FIFO indexov).
 */
export function parseCargoLedgerState(
  raw: unknown,
  cargoTypes: Catalog<Readonly<CargoTypeDef>>,
  nextId: number,
): CargoLedgerState {
  const state = checkKeys(raw, STATE_KEYS, '');
  const createdCount = checkCount(state['createdCount'], '/createdCount');
  const exportedCount = checkCount(state['exportedCount'], '/exportedCount');
  const shippedCount = checkCount(state['shippedCount'], '/shippedCount');
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

  if (createdCount !== units.length + exportedCount + shippedCount) {
    throw new CargoStateError(
      '/createdCount',
      `${String(createdCount)} ≠ živé ${String(units.length)} + exportedCount ${String(exportedCount)} + shippedCount ${String(shippedCount)} (konzervácia nákladu)`,
    );
  }
  return { createdCount, exportedCount, shippedCount, units: Object.freeze(units) };
}
