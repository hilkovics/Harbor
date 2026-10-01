/**
 * Jednotka nákladu (ARCHITECTURE §4.1, §5, §7.1): jedna dávka `quantity = unitsPerBatch` jedného typu (ADR-003).
 * Readonly hodnota — `CargoLedger` pri presune (a pri zmene `hold`) vytvorí novú zmrazenú jednotku, takže objekt
 * získaný z `get()` je snímka, ktorá sa už nezmení.
 *
 * Od F6a (ADR-032) nesie jednotka aj **štítky** z jej vzniku (`CargoUnitLabels`: smer, voyage, cieľový prístav,
 * hmotnostná trieda — po vzniku sa nemenia) a **stav držania** `hold` (VGM hold exportu; mení ho len
 * `CargoLedger.setHold`). Import jednotky majú `direction: 'import'`, `destinationPort: null`, `hold: null`
 * a hmotnostnú triedu `DEFAULT_WEIGHT_CLASS` bez `Rng` (ADR-032 odchýlka 1).
 */
import type { ContractId, EntityId, VoyageId } from '../core/entity-id';
import type { CargoLocation } from './cargo-location';

/** Smer toku jednotky (ADR-032): import (loď → vnútrozemie), export (vnútrozemie → loď). F6c pridá tranship/empty. */
export const CARGO_DIRECTIONS = ['import', 'export'] as const;
export type CargoDirection = (typeof CARGO_DIRECTIONS)[number];

/** Hmotnostné triedy kontajnera (stowage plán, ADR-032 bod 8). */
export const WEIGHT_CLASSES = ['light', 'medium', 'heavy'] as const;
export type WeightClass = (typeof WEIGHT_CLASSES)[number];

/**
 * Hmotnostná trieda jednotky, ktorá sa nelosuje — import (na import nemá vplyv, ADR-032 odchýlka 1) a migrácia save
 * v6 → v7 (rozhodnutie 14). Štrukturálna predvolená hodnota (ako `DEFAULT_ROAD_KIND`), nie balans.
 */
export const DEFAULT_WEIGHT_CLASS: WeightClass = 'medium';

/** Dôvody držania jednotky (`CargoHold`); F6a pozná len chýbajúce VGM (rozhodnutie 5). */
export const CARGO_HOLD_REASONS = ['vgm'] as const;
export type CargoHoldReason = (typeof CARGO_HOLD_REASONS)[number];

/** Jednotka je zadržaná (nesmie sa naložiť na loď) do `untilTick` (vrátane: uvoľní ju krok 2 v ticku `≥ untilTick`). */
export interface CargoHold {
  readonly reason: CargoHoldReason;
  readonly untilTick: number;
}

/** Nemenné štítky jednotky z jej vzniku (`CargoLedger.create`). */
export interface CargoUnitLabels {
  /** Import (vzniká na lodi) alebo export (vzniká v kamióne). */
  readonly direction: CargoDirection;
  /** Návšteva lode (voyage) kontraktu jednotky (`Contract.voyageId`); bez kontraktu `null`. */
  readonly voyageId: VoyageId | null;
  /** Cieľový prístav exportu (booking); import `null`. */
  readonly destinationPort: string | null;
  /** Hmotnostná trieda (export: `Rng` pri vzniku podľa `logistics.exportFlow.weightClassShares`). */
  readonly weightClass: WeightClass;
}

/** Štítky import jednotky bez kontraktu (ladiaca loď, scenáre F2–F4) — predvolené v `CargoLedger.create`. */
export const IMPORT_LABELS: CargoUnitLabels = Object.freeze({ direction: 'import', voyageId: null, destinationPort: null, weightClass: DEFAULT_WEIGHT_CLASS });

export interface CargoUnit extends CargoUnitLabels {
  /** Id z `world.ids` (spoločný alokátor všetkých entít). */
  readonly id: EntityId;
  /** Id z `cargo_types.json`. */
  readonly typeId: string;
  /** Kontrakt, ku ktorému jednotka patrí (F5, `ContractId`, ADR-026); `null` = bez kontraktu (napr. ladiaca loď). */
  readonly contractId: ContractId | null;
  /** Zadržanie (VGM hold, ADR-032 bod 5); `null` = jednotka smie na loď. Mení ho len `CargoLedger.setHold`. */
  readonly hold: CargoHold | null;
  /** Množstvo v jednotkách typu (`unitsPerBatch`: 1 TEU, 25 t…). */
  readonly quantity: number;
  /** Jediná poloha jednotky; mení ju výlučne `CargoLedger.move` (pravidlo 2). */
  readonly location: CargoLocation;
}

/** Je hodnota smer jednotky? */
export function isCargoDirection(value: unknown): value is CargoDirection {
  return (CARGO_DIRECTIONS as readonly unknown[]).includes(value);
}

/** Je hodnota hmotnostná trieda? */
export function isWeightClass(value: unknown): value is WeightClass {
  return (WEIGHT_CLASSES as readonly unknown[]).includes(value);
}

/** Je hodnota dôvod držania? */
export function isCargoHoldReason(value: unknown): value is CargoHoldReason {
  return (CARGO_HOLD_REASONS as readonly unknown[]).includes(value);
}

function isIdValue(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Súlad štítkov jednotky (ADR-032 bod 2) — `undefined` = v poriadku. Spoločné pre `CargoLedger.create` aj obnovu save:
 * známy smer a hmotnostná trieda, `voyageId` `null` alebo celé ≥ 1, `destinationPort` `null` alebo neprázdny reťazec;
 * import nemá cieľový prístav; export patrí bookingu — má kontrakt, voyage aj cieľový prístav. Vracia
 * `{ field, problem }` s názvom poľa jednotky.
 */
export function cargoLabelsProblem(labels: Readonly<Record<keyof CargoUnitLabels, unknown>>, contractId: unknown): { readonly field: keyof CargoUnitLabels; readonly problem: string } | undefined {
  const { direction, voyageId, destinationPort, weightClass } = labels;
  if (!isCargoDirection(direction)) return { field: 'direction', problem: `smer musí byť jeden z: ${CARGO_DIRECTIONS.join(', ')}, dostal ${String(direction)}` };
  if (!isWeightClass(weightClass)) return { field: 'weightClass', problem: `hmotnostná trieda musí byť jedna z: ${WEIGHT_CLASSES.join(', ')}, dostal ${String(weightClass)}` };
  if (voyageId !== null && !isIdValue(voyageId)) return { field: 'voyageId', problem: `musí byť null alebo celé číslo ≥ 1, dostal ${String(voyageId)}` };
  if (destinationPort !== null && (typeof destinationPort !== 'string' || destinationPort.length === 0)) {
    return { field: 'destinationPort', problem: `musí byť null alebo neprázdny reťazec, dostal ${String(destinationPort)}` };
  }
  if (direction === 'import' && destinationPort !== null) return { field: 'destinationPort', problem: 'import jednotka nemá cieľový prístav (null)' };
  if (direction === 'export' && (contractId === null || voyageId === null || destinationPort === null)) {
    return { field: 'direction', problem: 'export jednotka patrí bookingu — musí mať contractId, voyageId aj destinationPort' };
  }
  return undefined;
}

/**
 * Súlad zadržania s jednotkou — `undefined` = v poriadku: `null`, alebo `{ reason, untilTick }` so známym dôvodom
 * a celým `untilTick ≥ 0`; zadržať sa dá len export (VGM, rozhodnutie 5).
 */
export function cargoHoldProblem(hold: unknown, direction: CargoDirection): string | undefined {
  if (hold === null) return undefined;
  if (typeof hold !== 'object' || Array.isArray(hold)) return `musí byť null alebo { reason, untilTick }, dostal ${String(hold)}`;
  const keys = Object.keys(hold);
  if (keys.length !== 2 || !keys.includes('reason') || !keys.includes('untilTick')) return `musí mať presne kľúče reason, untilTick (má ${keys.join(', ')})`;
  const { reason, untilTick } = hold as Record<string, unknown>;
  if (!isCargoHoldReason(reason)) return `dôvod musí byť jeden z: ${CARGO_HOLD_REASONS.join(', ')}, dostal ${String(reason)}`;
  if (typeof untilTick !== 'number' || !Number.isSafeInteger(untilTick) || untilTick < 0) return `untilTick musí byť celé číslo ≥ 0, dostal ${String(untilTick)}`;
  if (direction !== 'export') return 'zadržať (VGM) sa dá len export jednotka';
  return undefined;
}
