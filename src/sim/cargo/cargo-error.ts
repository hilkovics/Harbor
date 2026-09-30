/**
 * Chyby `CargoLedger`. Všetky dedia od `CargoError` s kódom (`code`), takže volajúci rozlíši druh chyby bez
 * parsovania správy. Ledger je fail-fast a atomický: pri akejkoľvek chybe z `create`/`move` sa jeho stav nezmení.
 */
import type { EntityId } from '../core/entity-id';
import { formatLocation, type CargoLocation } from './cargo-location';

export type CargoErrorCode =
  /** Nepovolený prechod medzi druhmi lokácií (§7.1) alebo vznik mimo `CARGO_SPAWN_KINDS`. */
  | 'transition'
  /** Jednotka s daným id v ledgeri nie je (nikdy nebola, alebo už bola exportovaná). */
  | 'unknown_unit'
  /** Typ nákladu nie je v `cargo_types.json`. */
  | 'unknown_cargo_type'
  /** Lokácia alebo iný vstup nemá platný tvar (`normalizeLocation`, `contractId`). */
  | 'invalid_input'
  /** Cieľové miesto s jedinečným slotom (apron, sklad) už obsadila iná jednotka. */
  | 'slot_occupied'
  /** Porušený invariant konzervácie (`assertConservation`). */
  | 'conservation'
  /** Neplatný serializovaný stav ledgera (`CargoLedger.fromState`). */
  | 'state';

export class CargoError extends Error {
  readonly code: CargoErrorCode;

  constructor(code: CargoErrorCode, message: string) {
    super(message);
    this.name = 'CargoError';
    this.code = code;
  }
}

/** Nepovolený prechod `from → to` (§7.1). `from = null` = vznik jednotky (`create`) v nepovolenej lokácii. */
export class CargoTransitionError extends CargoError {
  readonly unitId: EntityId | null;
  readonly from: CargoLocation | null;
  readonly to: CargoLocation;

  constructor(unitId: EntityId | null, from: CargoLocation | null, to: CargoLocation, reason: string) {
    const subject = unitId === null ? 'nová jednotka' : `jednotka #${String(unitId)}`;
    const path = from === null ? `vznik v ${formatLocation(to)}` : `${formatLocation(from)} → ${formatLocation(to)}`;
    super('transition', `CargoLedger: ${subject}: nepovolený prechod ${path} — ${reason}`);
    this.name = 'CargoTransitionError';
    this.unitId = unitId;
    this.from = from;
    this.to = to;
  }
}

/** Porušená konzervácia nákladu (ARCHITECTURE §6 krok 12, §16); správa pomenuje jednotku aj lokácie. */
export class CargoConservationError extends CargoError {
  constructor(violation: string) {
    super('conservation', `CargoLedger: porušená konzervácia nákladu — ${violation}`);
    this.name = 'CargoConservationError';
  }
}

/**
 * Neplatný `CargoLedgerState`. `path` je JSON pointer relatívny ku koreňu stavu ledgera — `WorldState` v2 (T02-03)
 * ho predradí prefixom (`/cargo`) a preloží na `WorldStateError`.
 */
export class CargoStateError extends CargoError {
  readonly path: string;
  readonly problem: string;

  constructor(path: string, problem: string) {
    super('state', `CargoLedgerState${path}: ${problem}`);
    this.name = 'CargoStateError';
    this.path = path;
    this.problem = problem;
  }
}
