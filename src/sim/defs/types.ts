/**
 * Typy dátových definícií (ARCHITECTURE §4). Zrkadlia `data/defs/*.json` a `data/schemas/*.schema.json`
 * 1:1 — nové pole = zmena defu, schémy, tohto typu aj tabuľky polí v `def-registry.ts`.
 */
import type { RoadKind } from '../grid/road-kind';
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

/** Laditeľné parametre typu cesty (ADR-020); pevné vlastnosti typu sú v `ROAD_KIND_TRAITS` (grid/road-kind.ts). */
export interface RoadKindDef {
  /** Cena za jednu novú alebo prestavanú bunku v centoch (refundácia pri odstránení/prestavbe z nej, ADR-012). */
  readonly costPerCellCents: number;
  /**
   * Násobok `speedCellsPerTick` vozidla na úseku, ktorý do bunky tohto typu vchádza; `0 < speedFactor ≤ 1`, takže cena
   * bunky v A* `1 / speedFactor` je ≥ `BASE_CELL_COST` a heuristika ostáva prípustná.
   */
  readonly speedFactor: number;
}

/**
 * `infrastructure.json` — cesty a koľaje ako vrstva na bunke, nie moduly (ARCHITECTURE §4.6, §5.1; ADR-006, ADR-010).
 * Konfiguračný def (ADR-009).
 */
export interface InfrastructureDef extends DefBase {
  /**
   * Cesta: `maintenancePerDayCents` za bunku. `costPerCellCents` je alias ceny `roadKinds.two_lane` (spätná
   * kompatibilita prezentácie; `DefRegistry` vyžaduje zhodu) — sim cenu cesty číta len z `roadKinds` (ADR-020).
   */
  readonly road: InfrastructureLayerDef;
  readonly rail: InfrastructureLayerDef;
  /** Typy ciest (ADR-020): cena za bunku a rýchlostný faktor pre každý `RoadKind`. */
  readonly roadKinds: Readonly<Record<RoadKind, Readonly<RoadKindDef>>>;
}

/** Konštanty kongescie (§7.6): cena bunky v A* a spomalenie vozidiel rastú s `cell.traffic` (použité od F11). */
export interface CongestionDef {
  /** Násobiteľ `cell.traffic` pri každom HourClosed (0 = okamžitý reset, 1 = bez útlmu). */
  readonly trafficDecayPerHour: number;
  /** Spomalenie vozidla za každé ďalšie vozidlo na bunke. */
  readonly slowdownPerExtraVehicle: number;
  /** Delenie `cell.traffic` pri výpočte penalizácie ceny bunky v A*. */
  readonly penaltyTrafficDivisor: number;
  /** Strop penalizácie ceny bunky v A*. */
  readonly penaltyMax: number;
}

/**
 * `logistics.json` — logistické konštanty (ARCHITECTURE §4.6, §7.3, §7.6; ADR-010). Konfiguračný def (ADR-009);
 * všetky trvania sú v tickoch.
 */
export interface LogisticsDef extends DefBase {
  /** Predvolený vnútorný čas vozidla v module pred load/unload; modul ho prepíše `params.internalTicks`. */
  readonly defaultInternalTicks: number;
  /** Po koľkých tickoch skúša vozidlo bez cesty (`no_path`) hľadať cestu znova. */
  readonly repathIntervalTicks: number;
  readonly congestion: CongestionDef;
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

/**
 * Voľné parametre modulu; tvar podľa `kind` overuje `MODULE_PARAM_SPECS`, typované gettery sú `berthParams`,
 * `craneParams`, `storageParams`, `depotParams`, `gateParams`, `waitingAreaParams` a `rampParams`.
 */
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

/** `params` skladu (`kind: 'storage'`). */
export interface StorageParams {
  /** Kapacita v CargoUnit; pre kontajnerový dvor `slots × layers` v manifeste. */
  readonly capacityUnits: number;
  /** Kategória nákladu, ktorú sklad prijíma. */
  readonly category: CargoCategory;
  /** Vnútorný čas vozidla v module (§7.3 bod 4); chýba = `logistics.defaultInternalTicks`. */
  readonly internalTicks?: number;
}

/** `params` depa vozidiel (`kind: 'depot'`). */
export interface DepotParams {
  /** Počet státí (vozidiel) v depe; `stalls` v manifeste. */
  readonly capacity: number;
  /** Vnútorný čas vozidla v module (§7.3 bod 4); chýba = `logistics.defaultInternalTicks`. */
  readonly internalTicks?: number;
}

/** `params` brány kamiónov (`kind: 'gate'`, F4). */
export interface GateParams {
  /** Priepustnosť: 1 kamión za `processTicks` tickov (spoločná FIFO fronta oboch smerov, tvrdý bottleneck). */
  readonly processTicks: number;
  /** Vnútorný čas prechodu telom brány (ADR-011); chýba = `logistics.defaultInternalTicks`. */
  readonly internalTicks?: number;
}

/** `params` čakacej plochy kamiónov (`kind: 'waiting_area'`, F4). */
export interface WaitingAreaParams {
  /** Počet stojísk (bays) pre kamióny; `stalls` v manifeste. */
  readonly bays: number;
  /** Vnútorný čas prechodu stojiskom (ADR-011); chýba = `logistics.defaultInternalTicks`. */
  readonly internalTicks?: number;
}

/** `params` nakladacej rampy (`kind: 'ramp'`, F4). */
export interface RampParams {
  /** Počet dockov rampy; `docks` v manifeste. */
  readonly docks: number;
  /** Kapacita staging slotov `at_ramp` na jeden dock. */
  readonly stagingPerDock: number;
  /** Trvanie naloženia jednej jednotky na kamión v tickoch. */
  readonly loadTicksPerUnit: number;
  /** Kategória nákladu, ktorú rampa nakladá. */
  readonly category: CargoCategory;
  /** Vnútorný čas vstupu do docku (ADR-011); chýba = `logistics.defaultInternalTicks`. */
  readonly internalTicks?: number;
}

/** Druh bez typovaných parametrov (zatiaľ ostatné kind-y): `params` musí byť `{}`. */
export type NoParams = Readonly<Record<never, never>>;

/** Tvar `params` pre každý druh modulu; kompilátor tak vynúti, že `MODULE_PARAM_SPECS` pokrýva všetky kind-y. */
export interface ModuleParamsByKind {
  readonly berth: BerthParams;
  readonly crane: CraneParams;
  readonly storage: StorageParams;
  readonly gate: GateParams;
  readonly waiting_area: WaitingAreaParams;
  readonly ramp: RampParams;
  readonly depot: DepotParams;
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

/** Položka `vehicles.json` (§4.4): interné vozidlo (straddle carrier, …). Sprite je `entities.<id>` v manifeste. */
export interface VehicleDef {
  readonly id: string;
  readonly displayName: string;
  /** Kapacita v CargoUnit (koľko jednotiek vezie naraz). */
  readonly capacityUnits: number;
  /** Rýchlosť jazdy v bunkách za tick. */
  readonly speedCellsPerTick: number;
  /** Trvanie naloženia jednej jednotky v tickoch (sekvenčne po `internalTicks`, §7.3). */
  readonly loadTicks: number;
  /** Trvanie vyloženia jednej jednotky v tickoch (sekvenčne po `internalTicks`, §7.3). */
  readonly unloadTicks: number;
  readonly cargoCategories: readonly CargoCategory[];
  readonly purchaseCents: number;
  readonly wagePerDayCents: number;
  readonly techRequired?: string;
}

/**
 * Položka `trucks.json` (§4.2, §7.5; F4): kamión, ktorý odváža náklad z rampy mimo mapu. Kamión sa nekupuje a nemá mzdu —
 * spawnuje ho `TruckSpawner`; čas nakládky určuje rampa (`RampParams.loadTicksPerUnit`). Sprite je `entities.<id>` v manifeste.
 */
export interface TruckDef {
  readonly id: string;
  readonly displayName: string;
  /** Kapacita v CargoUnit (koľko jednotiek vezie naraz). */
  readonly capacityUnits: number;
  /** Rýchlosť jazdy v bunkách za tick. */
  readonly speedCellsPerTick: number;
  readonly cargoCategories: readonly CargoCategory[];
}
