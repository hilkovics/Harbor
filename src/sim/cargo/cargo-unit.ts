/**
 * Jednotka nákladu (ARCHITECTURE §4.1, §5, §7.1): jedna dávka `quantity = unitsPerBatch` jedného typu (ADR-003).
 * Readonly hodnota — `CargoLedger` pri presune (a pri zmene `hold`) vytvorí novú zmrazenú jednotku, takže objekt
 * získaný z `get()` je snímka, ktorá sa už nezmení.
 *
 * Od F6a (ADR-032) nesie jednotka aj **štítky** z jej vzniku (`CargoUnitLabels`: smer, voyage, cieľový prístav,
 * hmotnostná trieda — po vzniku sa nemenia) a **stav držania** `hold` (VGM hold exportu; mení ho len
 * `CargoLedger.setHold`). Import jednotky majú `direction: 'import'`, `destinationPort: null`, `hold: null`
 * a hmotnostnú triedu `DEFAULT_WEIGHT_CLASS` bez `Rng` (ADR-032 odchýlka 1).
 *
 * Od F6c (ADR-034) pribudla **linka** (`lineId` — vlastník kontajnera, štítok z vzniku), smery `tranship` (prekládka
 * loď → loď) a `empty` (prázdny kontajner linky) a **stav kvality** `status` + `repairUntilTick` (kontrola a M&R prázdneho
 * v depe; mení ich len `CargoLedger.setStatus`).
 */
import type { ContractId, EntityId, VoyageId } from '../core/entity-id';
import type { CargoLocation } from './cargo-location';

/**
 * Smer toku jednotky: import (loď → vnútrozemie), export (vnútrozemie → loď; ADR-032), `tranship` (loď A → terminál → loď B,
 * nikdy cez bránu; ADR-034) a `empty` (prázdny kontajner linky: vnútrozemie → depo → exportér alebo loď; ADR-034).
 */
export const CARGO_DIRECTIONS = ['import', 'export', 'tranship', 'empty'] as const;
export type CargoDirection = (typeof CARGO_DIRECTIONS)[number];

/**
 * Smery, ktorých jednotka na lodi je **náklad na nakládku** už podľa smeru (export a prázdny repositioningu — `CargoLedger.countExportsAt`).
 * Prekládka (`tranship`) je na lodi A náklad na vykládku a na lodi B naložený náklad — rozlišuje ju kontrakt
 * (`Contract.tranship.outShipId`, `isOutboundOnShip`), nie smer; počíta ju `CargoLedger.countTranshipAt`.
 */
export const OUTBOUND_BY_DIRECTION: { readonly [D in CargoDirection]: boolean } = Object.freeze({ import: false, export: true, tranship: false, empty: true });

/** Hmotnostné triedy kontajnera (stowage plán, ADR-032 bod 8). */
export const WEIGHT_CLASSES = ['light', 'medium', 'heavy'] as const;
export type WeightClass = (typeof WEIGHT_CLASSES)[number];

/**
 * Hmotnostná trieda jednotky, ktorá sa nelosuje — import (na import nemá vplyv, ADR-032 odchýlka 1). Štrukturálna predvolená hodnota (ako `DEFAULT_ROAD_KIND`), nie balans.
 */
export const DEFAULT_WEIGHT_CLASS: WeightClass = 'medium';

/**
 * Hmotnostná trieda prázdneho kontajnera (ADR-034): štítok bez `Rng`. Poradie nakládky prázdnych (po plných) určuje smer
 * `empty` v stowage pláne (`STOWAGE_DIRECTION_RANK`, T6C-03), nie táto trieda.
 */
export const EMPTY_WEIGHT_CLASS: WeightClass = 'light';

/**
 * Stav kvality jednotky (ADR-034): `available` (dostupná — všetky jednotky mimo kontrolovaných prázdnych), `damaged`
 * (kontrola v depe našla poškodenie, čaká na voľné miesto opravy), `in_repair` (oprava beží do `repairUntilTick`).
 * Poškodenú ani opravovanú jednotku nemožno vydať exportérovi ani naložiť; stav mení len prázdny kontajner v depe.
 */
export const CARGO_STATUSES = ['available', 'damaged', 'in_repair'] as const;
export type CargoStatus = (typeof CARGO_STATUSES)[number];

/** Stav jednotky bez kontroly (všetko okrem poškodených prázdnych). */
export const DEFAULT_CARGO_STATUS: CargoStatus = 'available';

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
  /** Import a tranship vznikajú na lodi, export a prázdny v kamióne (`CARGO_SPAWN_KIND_BY_DIRECTION`). */
  readonly direction: CargoDirection;
  /** Návšteva lode (voyage) kontraktu jednotky (`Contract.voyageId`); bez kontraktu (ladiaca loď, prázdny) `null`. */
  readonly voyageId: VoyageId | null;
  /**
   * Linka (vlastník kontajnera; id z `lines.json`, ADR-034): jednotka kontraktu nesie `Contract.lineId` (zhodu overuje obnova
   * save), prázdny kontajner linku, ktorej patrí. `null` len pre jednotku bez kontraktu, ktorá nie je prázdna (ladiaca loď).
   */
  readonly lineId: string | null;
  /** Cieľový prístav exportu (booking); import `null`. */
  readonly destinationPort: string | null;
  /** Hmotnostná trieda (export: `Rng` pri vzniku podľa `logistics.exportFlow.weightClassShares`). */
  readonly weightClass: WeightClass;
}

/** Štítky import jednotky bez kontraktu (ladiaca loď, scenáre F2–F4) — predvolené v `CargoLedger.create`. */
export const IMPORT_LABELS: CargoUnitLabels = Object.freeze({ direction: 'import', voyageId: null, lineId: null, destinationPort: null, weightClass: DEFAULT_WEIGHT_CLASS });

export interface CargoUnit extends CargoUnitLabels {
  /** Id z `world.ids` (spoločný alokátor všetkých entít). */
  readonly id: EntityId;
  /** Id z `cargo_types.json`. */
  readonly typeId: string;
  /** Kontrakt, ku ktorému jednotka patrí (F5, `ContractId`, ADR-026); `null` = bez kontraktu (napr. ladiaca loď). */
  readonly contractId: ContractId | null;
  /** Zadržanie (VGM hold, ADR-032 bod 5); `null` = jednotka smie na loď. Mení ho len `CargoLedger.setHold`. */
  readonly hold: CargoHold | null;
  /** Stav kvality (`CargoStatus`, ADR-034); mimo prázdnych vždy `available`. Mení ho len `CargoLedger.setStatus`. */
  readonly status: CargoStatus;
  /** Tick dokončenia opravy — práve pri `status: 'in_repair'` celé ≥ 0, inak `null` (ADR-034). */
  readonly repairUntilTick: number | null;
  /** Množstvo v jednotkách typu (`unitsPerBatch`: 1 TEU, 25 t…). */
  readonly quantity: number;
  /** Jediná poloha jednotky; mení ju výlučne `CargoLedger.move` (pravidlo 2). */
  readonly location: CargoLocation;
}

/** Je hodnota smer jednotky? */
export function isCargoDirection(value: unknown): value is CargoDirection {
  return (CARGO_DIRECTIONS as readonly unknown[]).includes(value);
}

/** Je hodnota stav kvality jednotky? */
export function isCargoStatus(value: unknown): value is CargoStatus {
  return (CARGO_STATUSES as readonly unknown[]).includes(value);
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

/** Požiadavka smeru na štítok: povinný, zakázaný (musí byť `null`), alebo ľubovoľný. */
type LabelPresence = 'required' | 'forbidden' | 'any';

/**
 * Pravidlá štítkov podľa smeru (ADR-032 bod 2, ADR-034; tabuľka, nie switch): `import` nemá cieľový prístav (bez kontraktu
 * je to ladiaca loď); `export` a `tranship` patria bookingu — kontrakt, voyage, linka aj cieľový prístav sú povinné; `empty`
 * je prázdny kontajner linky — bez kontraktu, voyage aj cieľového prístavu, linka je povinná.
 */
const DIRECTION_LABEL_RULES: {
  readonly [D in CargoDirection]: { readonly contract: LabelPresence; readonly voyage: LabelPresence; readonly line: LabelPresence; readonly port: LabelPresence };
} = Object.freeze({
  import: { contract: 'any', voyage: 'any', line: 'any', port: 'forbidden' },
  export: { contract: 'required', voyage: 'required', line: 'required', port: 'required' },
  tranship: { contract: 'required', voyage: 'required', line: 'required', port: 'required' },
  empty: { contract: 'forbidden', voyage: 'forbidden', line: 'required', port: 'forbidden' },
});

function presenceProblem(presence: LabelPresence, isNull: boolean, what: string, direction: CargoDirection): string | undefined {
  if (presence === 'required' && isNull) return `${direction} jednotka musí mať ${what}`;
  if (presence === 'forbidden' && !isNull) return `${direction} jednotka nemá ${what} (null)`;
  return undefined;
}

/**
 * Súlad štítkov jednotky (ADR-032 bod 2, ADR-034) — `undefined` = v poriadku. Spoločné pre `CargoLedger.create` aj obnovu save:
 * známy smer a hmotnostná trieda, `voyageId` `null` alebo celé ≥ 1, `lineId` a `destinationPort` `null` alebo neprázdny reťazec;
 * pravidlá smeru (`DIRECTION_LABEL_RULES`). Zhodu linky jednotky s linkou jej kontraktu overuje obnova save (`checkContracts`),
 * ledger kontrakty nepozná. Vracia `{ field, problem }` s názvom poľa jednotky.
 */
export function cargoLabelsProblem(labels: Readonly<Record<keyof CargoUnitLabels, unknown>>, contractId: unknown): { readonly field: keyof CargoUnitLabels; readonly problem: string } | undefined {
  const { direction, voyageId, lineId, destinationPort, weightClass } = labels;
  if (!isCargoDirection(direction)) return { field: 'direction', problem: `smer musí byť jeden z: ${CARGO_DIRECTIONS.join(', ')}, dostal ${String(direction)}` };
  if (!isWeightClass(weightClass)) return { field: 'weightClass', problem: `hmotnostná trieda musí byť jedna z: ${WEIGHT_CLASSES.join(', ')}, dostal ${String(weightClass)}` };
  if (voyageId !== null && !isIdValue(voyageId)) return { field: 'voyageId', problem: `musí byť null alebo celé číslo ≥ 1, dostal ${String(voyageId)}` };
  if (lineId !== null && (typeof lineId !== 'string' || lineId.length === 0)) {
    return { field: 'lineId', problem: `musí byť null alebo neprázdny reťazec, dostal ${String(lineId)}` };
  }
  if (destinationPort !== null && (typeof destinationPort !== 'string' || destinationPort.length === 0)) {
    return { field: 'destinationPort', problem: `musí byť null alebo neprázdny reťazec, dostal ${String(destinationPort)}` };
  }
  const rule = DIRECTION_LABEL_RULES[direction];
  const contract = presenceProblem(rule.contract, contractId === null, 'kontrakt', direction);
  if (contract !== undefined) return { field: 'direction', problem: contract };
  const voyage = presenceProblem(rule.voyage, voyageId === null, 'voyage', direction);
  if (voyage !== undefined) return { field: 'voyageId', problem: voyage };
  const line = presenceProblem(rule.line, lineId === null, 'linku', direction);
  if (line !== undefined) return { field: 'lineId', problem: line };
  const port = presenceProblem(rule.port, destinationPort === null, 'cieľový prístav', direction);
  if (port !== undefined) return { field: 'destinationPort', problem: port };
  return undefined;
}

/**
 * Súlad stavu kvality s jednotkou (ADR-034) — `undefined` = v poriadku: známy stav, `repairUntilTick` práve pri `in_repair`
 * (celé ≥ 0), inak `null`; stav iný než `available` má len prázdny kontajner.
 */
export function cargoStatusProblem(status: unknown, repairUntilTick: unknown, direction: CargoDirection): string | undefined {
  if (!isCargoStatus(status)) return `stav musí byť jeden z: ${CARGO_STATUSES.join(', ')}, dostal ${String(status)}`;
  if (status === 'in_repair') {
    if (typeof repairUntilTick !== 'number' || !Number.isSafeInteger(repairUntilTick) || repairUntilTick < 0) {
      return `jednotka v oprave má repairUntilTick celé číslo ≥ 0, dostal ${String(repairUntilTick)}`;
    }
  } else if (repairUntilTick !== null) {
    return `repairUntilTick má len jednotka v oprave (stav ${status}), dostal ${String(repairUntilTick)}`;
  }
  if (status !== 'available' && direction !== 'empty') return `stav ${status} má len prázdny kontajner, jednotka je ${direction}`;
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
