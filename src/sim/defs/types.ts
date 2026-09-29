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
}
