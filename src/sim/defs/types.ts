/**
 * Typy dátových definícií (ARCHITECTURE §4). Zrkadlia `data/defs/*.json` a `data/schemas/*.schema.json`
 * 1:1 — nové pole = zmena defu, schémy, tohto typu aj tabuľky polí v `def-registry.ts`.
 */

/** Jediná podporovaná verzia schémy defov (`schemaVersion` v každom `data/defs/*.json`). */
export const SUPPORTED_SCHEMA_VERSION = 1;

/** Spoločné pole každého defu. */
export interface DefBase {
  readonly schemaVersion: typeof SUPPORTED_SCHEMA_VERSION;
}

/**
 * `time.json` — časový model (ARCHITECTURE §3). Singleton def; všetky trvania v ostatných defoch sú v tickoch.
 * Štrukturálne použiteľný ako `SimClockConfig` (`new SimClock(registry.time)`).
 */
export interface TimeDef extends DefBase {
  /** Koľko herných sekúnd trvá 1 tick. */
  readonly tickGameSeconds: number;
  /** Počet tickov za reálnu sekundu pri rýchlosti 1×. */
  readonly ticksPerRealSecond: number;
  /** Strop tickov simulácie na jeden render frame (ochrana GameLoopu proti špirále smrti, §3). */
  readonly maxTicksPerFrame: number;
  /** Povolené násobky rýchlosti simulácie; 0 = pauza (vždy prítomná). */
  readonly speeds: readonly number[];
}

/** `economy.json` — ekonomické konštanty (ARCHITECTURE §4.6, §9.2). Singleton def; peniaze v centoch (USD). */
export interface EconomyDef extends DefBase {
  /** Počiatočná hotovosť v centoch. */
  readonly startingCashCents: number;
  /** Demurrage: podiel odmeny za každú hodinu státia lode nad povolený limit. */
  readonly demurrageRateOfRewardPerHour: number;
  /** Penalizácia: podiel odmeny za každý deň po SLA termíne. */
  readonly latePenaltyRateOfRewardPerDay: number;
  /** Kontrakt zlyhá, keď meškanie presiahne tento počet dní. */
  readonly failAfterDaysLate: number;
  /** Mesačný nájom parcely ako podiel jej kúpnej ceny. */
  readonly leaseMonthlyRateOfPrice: number;
  /** Počet dní za sebou so zápornou hotovosťou do bankrotu (GameOver). */
  readonly bankruptcyDays: number;
  /** Cieľový počet ponúk kontraktov, ktoré pool dopĺňa pri DayClosed. */
  readonly offersPerDay: number;
  /** Po koľkých dňoch nevybraná ponuka expiruje. */
  readonly offerExpiryDays: number;
  /** Podiel pôvodnej ceny, ktorý sa vráti pri odstránení modulu, cesty alebo koľaje (§8 bod 8). */
  readonly removalRefundRate: number;
}

/** Cena a údržba jednej vrstvy dopravy (cesta alebo koľaj), počítané za bunku; peniaze v centoch. */
export interface InfrastructureLayerDef {
  /** Cena za jednu novú bunku. */
  readonly costPerCellCents: number;
  /** Denná údržba za jednu bunku (v MVP 0). */
  readonly maintenancePerDayCents: number;
}

/**
 * `infrastructure.json` — cesty a koľaje ako vrstva na bunke, nie moduly (ARCHITECTURE §4.6, §5.1; ADR-006, ADR-010).
 * Konfiguračný def (ADR-009).
 */
export interface InfrastructureDef extends DefBase {
  readonly road: InfrastructureLayerDef;
  readonly rail: InfrastructureLayerDef;
}
