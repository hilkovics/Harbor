/**
 * Typy dátových definícií (ARCHITECTURE §4). Zrkadlia `data/defs/*.json` a `data/schemas/*.schema.json`
 * 1:1 — nové pole = zmena defu, schémy, tohto typu aj tabuľky polí v `def-registry.ts`.
 */
import type { TerrainType } from '../grid/terrain';

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

// ---------------------------------------------------------------------------------------------------------
// Katalógové defy (ADR-009): `{ schemaVersion, items: [...] }`, položka má `id` v snake_case.
// ---------------------------------------------------------------------------------------------------------

/** Kategórie nákladu (§4.1) v pevnom poradí; určujú kompatibilitu žeriavov, lodí a vozidiel. */
export const CARGO_CATEGORIES = ['container', 'bulk', 'liquid', 'gas', 'roro'] as const;
export type CargoCategory = (typeof CARGO_CATEGORIES)[number];

/** Druhy modulov (§4.2) v pevnom poradí. */
export const MODULE_KINDS = [
  'berth',
  'crane',
  'storage',
  'gate',
  'waiting_area',
  'ramp',
  'depot',
  'rail_station',
  'pipeline',
] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

/** Svetové strany v poradí N, E, S, W (rovnako ako `DIRECTIONS_4`). */
export const SIDES = ['n', 'e', 's', 'w'] as const;
export type Side = (typeof SIDES)[number];

/** Druhy konektorov modulu: cesta, koľaj, potrubie. */
export const CONNECTOR_TYPES = ['road', 'rail', 'pipe'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

/** Položka `cargo_types.json` (§4.1). */
export interface CargoTypeDef {
  readonly id: string;
  readonly category: CargoCategory;
  /** Zobrazený názov jednotky (TEU, t, m³, ks). */
  readonly unitName: string;
  /** Koľko jednotiek komodity tvorí jednu `CargoUnit` (jeden úchop žeriava, ADR-003). */
  readonly unitsPerBatch: number;
  /** Referenčná odmena za jednotku v centoch (USD). */
  readonly basePricePerUnitCents: number;
  readonly xpPerUnit: number;
  /** Názov farebného tokenu z `design/tokens.css` bez `--` (napr. `cargo-container`). */
  readonly colorToken: string;
}

/**
 * Konektor modulu (§4.2): jediná bunka, cez ktorú vozidlá vchádzajú do modulu a vychádzajú z neho.
 * `x`, `y` sú lokálne súradnice v footprinte pri rotácii 0° (zdroj: `assets/manifest.json`, `sprites.*.connectors`);
 * `side` je strana bunky, ktorou sa vchádza.
 */
export interface ModuleConnectorDef {
  readonly x: number;
  readonly y: number;
  readonly side: Side;
  readonly type: ConnectorType;
}

/** Pravidlá umiestnenia modulu (§8). */
export interface ModulePlacementDef {
  /** Terény, na ktorých musia stáť všetky bunky footprintu. */
  readonly requiredTerrain: readonly TerrainType[];
  /** Berth: strana dlhej hrany, ktorá musí susediť s vodou (pri rotácii 0° sever). Berth ju vyžaduje. */
  readonly waterSide?: 'north';
  readonly requiresParcelOwnership: boolean;
  /** Modul sa musí prekrývať s modulom jedného z týchto druhov (crane → berth). */
  readonly mustAttachTo?: readonly ModuleKind[];
}

/** Voľné parametre modulu; tvar podľa `kind` overuje `MODULE_PARAM_SPECS`, typované gettery sú `berthParams` a `craneParams`. */
export type ModuleParams = Readonly<Record<string, number | string>>;

/** Položka `modules.json` (§4.2, §5.3). */
export interface ModuleDef {
  readonly id: string;
  readonly kind: ModuleKind;
  readonly displayName: string;
  /** Rozmery v bunkách pri rotácii 0°. */
  readonly footprint: { readonly w: number; readonly h: number };
  readonly placement: ModulePlacementDef;
  readonly connectors: readonly ModuleConnectorDef[];
  readonly costCents: number;
  readonly maintenancePerDayCents: number;
  /** Id uzla tech tree; chýba = dostupný od začiatku. */
  readonly techRequired?: string;
  readonly params: ModuleParams;
}

/** `params` kotviska (`kind: 'berth'`). */
export interface BerthParams {
  /** Najhlbší ponor, ktorý kotvisko unesie (loď: `draftClass ≤ depthClass`). */
  readonly depthClass: 1 | 2 | 3;
  /** Počet slotov apronu. */
  readonly apronSlots: number;
  /** Najviac žeriavov na kotvisku. */
  readonly maxCranes: number;
  /** Šírka pásu vody pred dlhou hranou, ktorý musí byť voľný. */
  readonly frontWaterCells: number;
}

/** `params` žeriava (`kind: 'crane'`). */
export interface CraneParams {
  /** Trvanie celého cyklu (grabbing + placing) v tickoch. */
  readonly cycleTicks: number;
  readonly category: CargoCategory;
}

/** Druh bez typovaných parametrov (zatiaľ ostatné kind-y): `params` musí byť `{}`. */
export type NoParams = Readonly<Record<never, never>>;

/** Tvar `params` pre každý druh modulu; kompilátor tak vynúti, že `MODULE_PARAM_SPECS` pokrýva všetky kind-y. */
export interface ModuleParamsByKind {
  readonly berth: BerthParams;
  readonly crane: CraneParams;
  readonly storage: NoParams;
  readonly gate: NoParams;
  readonly waiting_area: NoParams;
  readonly ramp: NoParams;
  readonly depot: NoParams;
  readonly rail_station: NoParams;
  readonly pipeline: NoParams;
}

/** Položka `ships.json` (§4.3). */
export interface ShipClassDef {
  readonly id: string;
  readonly displayName: string;
  /** Dĺžka (dlhá os) v bunkách; zhodná s `entities.ship_<id>.footprint.h` v manifeste. */
  readonly lengthCells: number;
  /** Šírka v bunkách; zhodná s `entities.ship_<id>.footprint.w` v manifeste. */
  readonly widthCells: number;
  /** Ponor: kotvisko musí mať `depthClass ≥ draftClass`. */
  readonly draftClass: 1 | 2 | 3;
  readonly capacityUnits: number;
  readonly speedCellsPerTick: number;
  readonly cargoCategories: readonly CargoCategory[];
  /** Koľko tickov smie loď stáť pri kotvisku bez demurrage. */
  readonly berthAllowanceTicks: number;
  readonly techRequired?: string;
}
