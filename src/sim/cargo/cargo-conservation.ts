/**
 * Invariant konzervácie nákladu (ARCHITECTURE §6 krok 12, §7.1, §16; pravidlo 2) ako čistá funkcia nad pohľadom
 * na vnútorné štruktúry `CargoLedger`. Ledger ju volá v `assertConservation()` so svojimi štruktúrami; testy ju
 * volajú s ručne poškodenými pohľadmi (vnútro ledgera je privátne a zvonka sa pokaziť nedá).
 *
 * Overuje:
 * 1. každá živá jednotka je v práve jednom indexe držiteľa a ten zodpovedá jej `location` (druh + id držiteľa),
 * 2. index neobsahuje neexistujúcu jednotku ani tú istú jednotku dvakrát, nie je prázdny a má poradie svojho druhu,
 * 3. jedinečné miesto (slot apronu/skladu) nie je obsadené dvakrát a mapa slotov presne zodpovedá jednotkám,
 * 4. počítadlá podľa druhu sedia s indexmi a `createdCount = živé + exported + shipped` (ADR-032),
 * 5. počítadlo jednotiek smeru `export` a `empty` indexu (`CargoBucketView.exports`, `OUTBOUND_BY_DIRECTION`) a smeru `tranship`
 *    (`CargoBucketView.tranships`) sedí s jednotkami v ňom (T6A-09b, T6C-03).
 */
import type { EntityId } from '../core/entity-id';
import { OUTBOUND_BY_DIRECTION, type CargoUnit } from './cargo-unit';
import {
  CARGO_HOLDER_KINDS,
  formatLocation,
  holderIdOf,
  holderSpecOf,
  uniqueSlotOf,
  type AnyCargoHolderSpec,
  type CargoLocationKind,
} from './cargo-location';

/** Index jednotiek jedného držiteľa (loď, žeriav, berth…). */
export interface CargoBucketView {
  /** Id jednotiek v poradí druhu (`order`: vzostupne podľa id alebo FIFO). */
  readonly units: readonly EntityId[];
  /** Miesto → jednotka; len pre druhy s jedinečným miestom (`uniqueSlot`), inak `null`. */
  readonly slots: ReadonlyMap<number, EntityId> | null;
  /** Počet jednotiek smeru `export` a `empty` v indexe (`CargoLedger.countExportsAt`); pohľad bez neho túto kontrolu preskočí. */
  readonly exports?: number;
  /** Počet jednotiek smeru `tranship` v indexe (`CargoLedger.countTranshipAt`); pohľad bez neho túto kontrolu preskočí. */
  readonly tranships?: number;
}

/** Pohľad na vnútorný stav ledgera. */
export interface CargoLedgerView {
  /** Živé jednotky (na mape) podľa id; exportované a odplávané ledger neeviduje. */
  readonly units: ReadonlyMap<EntityId, CargoUnit>;
  /** Druh lokácie s držiteľom → id držiteľa → index. */
  readonly buckets: ReadonlyMap<CargoLocationKind, ReadonlyMap<EntityId, CargoBucketView>>;
  /** Počet jednotiek podľa druhu lokácie; `exported` / `shipped` = počet exportovaných / odplávaných. */
  readonly counts: Readonly<Record<CargoLocationKind, number>>;
  readonly createdCount: number;
}

function indexLabel(kind: CargoLocationKind, spec: AnyCargoHolderSpec, holderId: EntityId): string {
  return `index ${kind}(${spec.holderKey}=${String(holderId)})`;
}

function unitLabel(id: EntityId): string {
  return `#${String(id)}`;
}

/** Spoločný kontext kontroly jedného indexu. */
interface BucketCheck {
  readonly view: CargoLedgerView;
  readonly kind: CargoLocationKind;
  readonly spec: AnyCargoHolderSpec;
  readonly holderId: EntityId;
  readonly bucket: CargoBucketView;
  /** Jednotka → index, v ktorom sa už našla (spoločné pre všetky indexy). */
  readonly seenIn: Map<EntityId, string>;
}

function checkSlots({ kind, spec, bucket }: BucketCheck, label: string, slotOwners: ReadonlyMap<number, EntityId>): string | undefined {
  if (!spec.uniqueSlot) {
    return bucket.slots === null ? undefined : `${label} má mapu miest, hoci druh '${kind}' nemá jedinečné miesta`;
  }
  if (bucket.slots === null) return `${label} nemá mapu miest (${String(spec.slotKey)})`;
  for (const [slot, unitId] of slotOwners) {
    if (bucket.slots.get(slot) !== unitId) {
      return `${label}: mapa miest nemá ${String(spec.slotKey)} ${String(slot)} pre ${unitLabel(unitId)}`;
    }
  }
  for (const [slot, unitId] of bucket.slots) {
    if (slotOwners.get(slot) !== unitId) {
      return `${label}: mapa miest eviduje ${String(spec.slotKey)} ${String(slot)} pre ${unitLabel(unitId)}, ktorá na ňom nie je`;
    }
  }
  return undefined;
}

function checkBucket(check: BucketCheck): string | undefined {
  const { view, kind, spec, holderId, bucket, seenIn } = check;
  const label = indexLabel(kind, spec, holderId);
  if (bucket.units.length === 0) return `${label} je prázdny (prázdny index sa má odstrániť)`;

  const slotOwners = new Map<number, EntityId>();
  let previous: EntityId | null = null;
  let exports = 0;
  let tranships = 0;
  for (const unitId of bucket.units) {
    const other = seenIn.get(unitId);
    if (other !== undefined) {
      return other === label
        ? `jednotka ${unitLabel(unitId)} je v ${label} dvakrát`
        : `jednotka ${unitLabel(unitId)} je v dvoch indexoch: ${other} a ${label}`;
    }
    seenIn.set(unitId, label);

    const unit = view.units.get(unitId);
    if (unit === undefined) return `${label} obsahuje jednotku ${unitLabel(unitId)}, ktorá v ledgeri nie je (stratená jednotka)`;
    if (unit.location.kind !== kind || holderIdOf(unit.location) !== holderId) {
      return `jednotka ${unitLabel(unitId)} je v ${label}, ale jej lokácia je ${formatLocation(unit.location)}`;
    }
    if (spec.order === 'id' && previous !== null && previous >= unitId) {
      return `${label} nie je zoradený vzostupne podľa id (${unitLabel(previous)} pred ${unitLabel(unitId)})`;
    }
    previous = unitId;
    if (OUTBOUND_BY_DIRECTION[unit.direction]) exports += 1;
    if (unit.direction === 'tranship') tranships += 1;

    const slot = uniqueSlotOf(unit.location);
    if (slot !== null) {
      const owner = slotOwners.get(slot);
      if (owner !== undefined) {
        return `${String(spec.slotKey)} ${String(slot)} v ${label} obsadený dvakrát: ${unitLabel(owner)} a ${unitLabel(unitId)}`;
      }
      slotOwners.set(slot, unitId);
    }
  }
  if (bucket.exports !== undefined && bucket.exports !== exports) {
    return `${label}: počítadlo exportných jednotiek ${String(bucket.exports)}, v indexe ich je ${String(exports)}`;
  }
  if (bucket.tranships !== undefined && bucket.tranships !== tranships) {
    return `${label}: počítadlo jednotiek prekládky ${String(bucket.tranships)}, v indexe ich je ${String(tranships)}`;
  }
  return checkSlots(check, label, slotOwners);
}

/** Prvé porušenie invariantu ako čitateľná správa (pomenuje jednotku aj lokácie), alebo `undefined`. */
export function findConservationViolation(view: CargoLedgerView): string | undefined {
  for (const kind of view.buckets.keys()) {
    if (holderSpecOf(kind) === undefined) return `index pre druh '${kind}', ktorý nemá držiteľa (jednotky mimo mapy sa neindexujú)`;
  }

  const seenIn = new Map<EntityId, string>();
  for (const kind of CARGO_HOLDER_KINDS) {
    const spec = holderSpecOf(kind);
    const holders = view.buckets.get(kind);
    if (spec === undefined || holders === undefined) return `chýba index druhu '${kind}'`;
    let total = 0;
    for (const [holderId, bucket] of holders) {
      const violation = checkBucket({ view, kind, spec, holderId, bucket, seenIn });
      if (violation !== undefined) return violation;
      total += bucket.units.length;
    }
    if (view.counts[kind] !== total) {
      return `počítadlo '${kind}' = ${String(view.counts[kind])}, v indexoch je ${String(total)} jednotiek`;
    }
  }

  for (const [id, unit] of view.units) {
    if (unit.id !== id) return `jednotka ${unitLabel(unit.id)} je uložená pod id ${unitLabel(id)}`;
    if (holderSpecOf(unit.location.kind) === undefined) {
      return `živá jednotka ${unitLabel(id)} má lokáciu ${formatLocation(unit.location)} (exportované a odplávané sa evidujú len počtom)`;
    }
    if (!seenIn.has(id)) return `jednotka ${unitLabel(id)} (${formatLocation(unit.location)}) nie je v žiadnom indexe`;
  }

  const live = view.units.size;
  const exported = view.counts.exported;
  const shipped = view.counts.shipped;
  if (view.createdCount !== live + exported + shipped) {
    return (
      `createdCount ${String(view.createdCount)} ≠ živé ${String(live)} + exported ${String(exported)} + shipped ${String(shipped)} ` +
      `(rozdiel ${String(view.createdCount - live - exported - shipped)})`
    );
  }
  return undefined;
}
