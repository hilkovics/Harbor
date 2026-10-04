/**
 * Typy dátových definícií (ARCHITECTURE §4). Zrkadlia `data/defs/*.json` a `data/schemas/*.schema.json`
 * 1:1 — nové pole = zmena defu, schémy, tohto typu aj tabuľky polí v `def-registry.ts`.
 */
import type { CargoDirection, WeightClass } from '../cargo/cargo-unit';
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
  /** Urgency odmeny (F5): `1 + urgencyFactor × (1 − slaDays / maxSlaDays)`; 0 = odmena nezávisí od SLA. */
  readonly urgencyFactor: number;
  /** Rozsah `[min, max]` dní od prijatia kontraktu po príchod lode (desatinné dni; losuje sa jediným `Rng`). */
  readonly arrivalDaysRange: readonly [number, number];
  /** Rozsah `[min, max]` násobku `capacityHint` pri losovaní objemu ponuky (pool, F5). */
  readonly volumeScaleRange: readonly [number, number];
  /** Spodná hranica `capacityHint` (jednotky), aby prvá ponuka na prázdnom prístave nemala objem 0. */
  readonly minCapacityHint: number;
  /** Počet splnených kontraktov na jeden tier: `tier = floor(completed / contractsPerTier)`. */
  readonly contractsPerTier: number;
  /** Globálny násobiteľ XP odmeny kontraktu (`volumeUnits × xpPerUnit × xpMultiplier`). */
  readonly xpMultiplier: number;
  /** Násobok XP pri splnení po SLA termíne (`0 ≤ lateXpFactor ≤ 1`). */
  readonly lateXpFactor: number;
  /** Koľko posledných `LedgerEntry` sa drží v pamäti a ukladá do savu (staršie sú len v denných súhrnoch). */
  readonly ledgerEntriesKept: number;
  /**
   * Cieľový počet booking ponúk (skupín voyage s exportom: šablóny `export` a `roundtrip`), ktoré pool dopĺňa pri
   * DayClosed po import ponukách (F6a, ADR-032 bod 1); 0 = pool booking neponúka.
   */
  readonly bookingOffersPerDay: number;
  /**
   * Rozsah `[min, max]` dní od prijatia po príchod lode voyage s exportom (desatinné dni, jeden ťah `Rng`); `min × 24`
   * hodín musí presiahnuť `cutoffHours`, aby cut-off ležal po prijatí (`DefRegistry`).
   */
  readonly exportArrivalDaysRange: readonly [number, number];
  /** Cut-off exportu: hodiny pred príchodom lode, po ktorých už brána prijíma len „rolled" jednotky (rozhodnutie 6). */
  readonly cutoffHours: number;
  /** Varovanie pred cut-off (`CutoffWarning`): hodiny pred cut-off; 0 = varovanie v ticku cut-off. */
  readonly cutoffWarningHours: number;
  /** Booking je splnený, keď sa naloží aspoň tento podiel bookovaných TEU (`0 … 1`, `⌈podiel × booked⌉` jednotiek). */
  readonly bookingFulfilmentShare: number;
  /** Penalizácia „last minute" za naloženú jednotku, ktorá prešla bránou po cut-off: podiel odmeny za jednotku. */
  readonly lastMinuteExportRateOfReward: number;
  /** Penalizácia „rolled" za prijatú, ale nenaloženú (vrátenú) jednotku: podiel odmeny za jednotku. */
  readonly rolledExportRateOfReward: number;
  /** Penalizácia za nesplnený booking (naložené < `bookingFulfilmentShare`): podiel odmeny, raz za booking. */
  readonly unfulfilledBookingRateOfReward: number;
  /**
   * Cieľový počet ponúk repositioningu prázdnych (skupiny voyage so šablónou `empty_repositioning`), ktoré pool dopĺňa pri
   * DayClosed (F6c, ADR-034; pool ich ponúka od T6C-03); 0 = pool repositioning neponúka.
   */
  readonly repositioningOffersPerDay: number;
  /** Cieľový počet ponúk prekládky loď → loď (šablóna `tranship`), ktoré pool dopĺňa pri DayClosed (F6c, ADR-034; od T6C-03); 0 = neponúka. */
  readonly transhipOffersPerDay: number;
  /** Cena opravy jedného poškodeného prázdneho kontajnera v centoch (M&R, ledger kategória `maintenance_repair`); strhne sa pri dokončení opravy. */
  readonly repairCostCents: number;
  /** Rozsah `[min, max]` dní od príchodu lode A (privezie prekládku) po príchod lode B (odvezie ju); desatinné dni > 0, jeden ťah `Rng`. */
  readonly transhipGapDaysRange: readonly [number, number];
  /** Záchrana zmeškanej prekládky: po odchode lode B bez nich čakajú dni na ďalšiu voyage linky; inak odídu kamiónom ako „predané". */
  readonly transhipRescueDays: number;
  /** Penalizácia za zmeškanú prekládku (jednotka nenaložená na loď B): podiel odmeny za jednotku. */
  readonly transhipMissedRateOfReward: number;
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
 * Lodná navigácia (§7.4, ADR-029; T06-07 — predtým konštanty v `ship-traffic.ts`, `ship-footprint.ts`
 * a `water-navigator.ts`): geometria rezervácií trás a lexikografická cena A* po vode. Štrukturálne hodnoty, nie balans.
 */
export interface ShipNavigationDef {
  /**
   * Rezerva (bunky, celé ≥ 1) za bodom priblíženia v páse pred kotviskami, kam anchorage nesmie: pás vody kotviska +
   * šírka najširšej lode + táto rezerva na otočenie a posun v bunke bodu priblíženia.
   */
  readonly approachMarginCells: number;
  /**
   * Krok vzorkovania šikmého úseku trasy pri výpočte zabratých buniek (bunky, 0,1…1 — T06-08b); konzervatívny pri
   * každom kroku, hranice držia obal tesný a počet jeho obdĺžnikov malý.
   */
  readonly sweepStepCells: number;
  /** Manévre za otočenie lode na mieste (celé 0…100) — druhá zložka lexikografickej ceny A* po vode. */
  readonly turnManeuvers: number;
  /** Manévre navyše za krok bokom (celé 0…100). */
  readonly sidewaysManeuvers: number;
}

/**
 * Tok exportu po súši (F6a, ADR-032): príchody kamiónov s exportom pred loďou, brána (VGM) a hmotnostné triedy jednotiek.
 * Trvania sú v dňoch a hodinách (prevod na ticky robí sim z `time.json`), pravdepodobnosti v `0 … 1`.
 */
export interface ExportFlowDef {
  /** Okno príchodov exportu pred loďou (dni): kamióny prichádzajú od `príchod lode − okno` po cut-off (rozhodnutie 4). */
  readonly arrivalWindowDays: number;
  /** Pravdepodobnosť, že jednotka pri bráne nemá VGM a ide do hold (rozhodnutie 5). */
  readonly vgmMissingChance: number;
  /** Trvanie VGM hold v hodinách; jednotka sa potom uvoľní sama. */
  readonly vgmHoldHours: number;
  /** Váhy výberu hmotnostnej triedy exportnej jednotky (`Rng.weighted`): hodnoty ≥ 0, súčet > 0. */
  readonly weightClassShares: Readonly<Record<WeightClass, number>>;
}

/**
 * Tok prázdnych kontajnerov (F6c, ADR-034): návrat z vnútrozemia, kontrola a oprava v depe, výdaj prázdneho exportérovi.
 * Trvania sú v dňoch a hodinách (prevod na ticky robí sim z `time.json`), pravdepodobnosti v `0 … 1`.
 */
export interface EmptyFlowDef {
  /** Rozsah `[min, max]` dní od odchodu importu kamiónom po návrat prázdneho kontajnera tej istej linky (jeden ťah `Rng`). */
  readonly hinterlandDaysRange: readonly [number, number];
  /** Pravdepodobnosť, že sa importná jednotka vráti ako prázdna do tohto prístavu (`Rng.chance`). */
  readonly emptyReturnRate: number;
  /** Pravdepodobnosť, že kontrola pri uložení prázdneho do depa nájde poškodenie (`Rng.chance`). */
  readonly damageChance: number;
  /** Trvanie opravy poškodeného prázdneho (hodiny > 0); cena `economy.repairCostCents`. */
  readonly repairHours: number;
  /** Podiel jednotiek export bookingu, pre ktoré exportér najprv vyzdvihne prázdny kontajner linky bookingu (`Rng.chance`). */
  readonly emptyPickupRate: number;
  /** Rozsah `[min, max]` hodín (> 0), o ktoré prázdny kamión po prázdny kontajner predchádza príchod naloženého exportu (jeden ťah `Rng`). */
  readonly emptyPickupLeadHoursRange: readonly [number, number];
  /** Ako dlho (hodiny > 0) čaká kamión po prázdny kontajner, kým linka nemá dostupný prázdny; potom odíde prázdny (`emptyPickupMisses`). */
  readonly emptyPickupMaxWaitHours: number;
}

/**
 * `logistics.json` — logistické konštanty (ARCHITECTURE §4.6, §7.3, §7.4, §7.6; ADR-010). Konfiguračný def (ADR-009);
 * všetky trvania sú v tickoch.
 */
export interface LogisticsDef extends DefBase {
  /** Predvolený vnútorný čas vozidla v module pred load/unload; modul ho prepíše `params.internalTicks`. */
  readonly defaultInternalTicks: number;
  /** Po koľkých tickoch skúša vozidlo bez cesty (`no_path`) hľadať cestu znova. */
  readonly repathIntervalTicks: number;
  readonly congestion: CongestionDef;
  readonly shipNavigation: ShipNavigationDef;
  /** Export po súši: príchody kamiónov, VGM, hmotnostné triedy (F6a, ADR-032). */
  readonly exportFlow: ExportFlowDef;
  /** Tok prázdnych kontajnerov: návrat, kontrola, oprava, výdaj exportérovi (F6c, ADR-034). */
  readonly emptyFlow: EmptyFlowDef;
}

// ---------------------------------------------------------------------------------------------------------
// Katalógové defy (ADR-009): `{ schemaVersion, items: [...] }`, položka má `id` v snake_case.
// ---------------------------------------------------------------------------------------------------------

/** Kategórie nákladu (§4.1) v pevnom poradí; určujú kompatibilitu žeriavov, lodí a vozidiel. */
export const CARGO_CATEGORIES = ['container', 'bulk', 'liquid', 'gas', 'roro'] as const;
export type CargoCategory = (typeof CARGO_CATEGORIES)[number];

/**
 * Druhy šablón kontraktov: F6a (ADR-032 bod 1) import, export booking a roundtrip (import + export jednej voyage); F6c
 * (ADR-034) `empty_repositioning` (linka nalodí N prázdnych) a `tranship` (loď A privezie, loď B odvezie).
 */
export const CONTRACT_TEMPLATE_KINDS = ['import', 'export', 'roundtrip', 'empty_repositioning', 'tranship'] as const;
export type ContractTemplateKind = (typeof CONTRACT_TEMPLATE_KINDS)[number];

/** Druh šablóny bez poľa `kind` (spätná kompatibilita F5). */
export const DEFAULT_TEMPLATE_KIND: ContractTemplateKind = 'import';

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
  /**
   * Odmena za exportovanú jednotku v centoch (booking, F6a, ADR-032 bod 14). Šablóna `export` / `roundtrip` s týmto
   * typom nákladu vyžaduje hodnotu > 0 (`DefRegistry`); import ju nepoužíva.
   */
  readonly exportPricePerUnitCents: number;
  /**
   * Odmena za jednu naloženú prázdnu jednotku repositioningu linky v centoch (kontrakt `empty_repositioning`, F6c, ADR-034).
   * Šablóna `empty_repositioning` s týmto typom nákladu vyžaduje hodnotu > 0 (`DefRegistry`).
   */
  readonly repositioningPricePerUnitCents: number;
  /** Odmena za jednu prekládku loď → loď v centoch (kontrakt `tranship`, F6c, ADR-034); šablóna `tranship` vyžaduje hodnotu > 0. */
  readonly transhipPricePerUnitCents: number;
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
/**
 * Režim odovzdávania žeriav ↔ vozidlo na kotvisku (F6a, ADR-033): `apron` = žeriav kladie jednotky na sloty apronu a vozidlá
 * ich odtiaľ berú (F2–F5); `under_hook` = vozidlo čaká priamo pod hákom žeriava a jednotka prejde `in_crane ↔ in_vehicle`
 * (apron ostáva len ako buffer `craneBufferSlots` na žeriav).
 */
export const HANDOVER_MODES = ['apron', 'under_hook'] as const;
export type HandoverMode = (typeof HANDOVER_MODES)[number];

export interface BerthParams {
  /** Najhlbší ponor, ktorý kotvisko unesie (loď: `draftClass ≤ depthClass`). */
  readonly depthClass: 1 | 2 | 3;
  /** Počet slotov apronu. */
  readonly apronSlots: number;
  /** Najviac žeriavov na kotvisku. */
  readonly maxCranes: number;
  /** Šírka pásu vody pred dlhou hranou, ktorý musí byť voľný. */
  readonly frontWaterCells: number;
  /**
   * Rezerva slotov apronu pre opačný smer (F6a, ADR-032 bod 10): kým má loď import na vykládku aj export na nakládku,
   * každý smer smie obsadiť najviac `apronSlots − apronReserveSlots` slotov. Celé `0 … ⌊apronSlots / 2⌋`.
   */
  readonly apronReserveSlots: number;
  /** Režim odovzdávania žeriav ↔ vozidlo (`HandoverMode`, ADR-033); `apron` = správanie F2–F5. */
  readonly handoverMode: HandoverMode;
  /**
   * Buffer apronu na žeriav v režime `under_hook` (ADR-033): koľko jednotiek môže žeriav (pri vykládke) odložiť na apron,
   * keď pod hákom nečaká vozidlo; 0 = čisté priame odovzdanie (žeriav čaká na vozidlo), 1 = jedna jednotka na žeriav.
   * Celé `0 … 1`, spolu `craneBufferSlots × maxCranes ≤ apronSlots`. V režime `apron` sa nepoužije.
   */
  readonly craneBufferSlots: number;
}

/** `params` žeriava (`kind: 'crane'`). */
export interface CraneParams {
  /** Trvanie celého cyklu (grabbing + placing) v tickoch. */
  readonly cycleTicks: number;
  readonly category: CargoCategory;
  /** Denná mzda obsluhy žeriava v centoch; strhne sa pri DayClosed (§9.2, F5). */
  readonly wagePerDayCents: number;
  /**
   * Dual cycling (F6a, ADR-032 bod 11): násobok jedného cyklu, za ktorý žeriav naloží export a vyloží import
   * (`1 … 2`; 2 = žiadny prínos oproti dvom samostatným cyklom).
   */
  readonly dualCycleFactor: number;
}

/** Roly skladu (F6c, ADR-034): `empty_depot` = depo prázdnych kontajnerov (trieda `EmptyDepot`); chýbajúca rola = bežný sklad kategórie. */
export const STORAGE_ROLES = ['empty_depot'] as const;
export type StorageRole = (typeof STORAGE_ROLES)[number];

/** `params` skladu (`kind: 'storage'`). */
export interface StorageParams {
  /** Kapacita v CargoUnit; pre kontajnerový dvor `slots × layers` v manifeste. */
  readonly capacityUnits: number;
  /** Kategória nákladu, ktorú sklad prijíma. */
  readonly category: CargoCategory;
  /** Vnútorný čas vozidla v module (§7.3 bod 4); chýba = `logistics.defaultInternalTicks`. */
  readonly internalTicks?: number;
  /** Rola skladu (`StorageRole`, F6c, ADR-034); chýba = bežný sklad. `empty_depot` vyžaduje kategóriu `container` a `repairBays`. */
  readonly role?: StorageRole;
  /** Počet súčasných opráv v depe prázdnych (M&R, celé ≥ 1); povinné práve pri `role: 'empty_depot'`. */
  readonly repairBays?: number;
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
  /**
   * Vnútorný čas prechodu telom brány (ADR-011): prechod trvá `processTicks + internalTicks` (`TruckGate.passTicks`).
   * Chýba = 0, nie `logistics.defaultInternalTicks` — priepustnosť brány určuje `processTicks` (ADR-024).
   */
  readonly internalTicks?: number;
}

/** `params` čakacej plochy kamiónov (`kind: 'waiting_area'`, F4). */
export interface WaitingAreaParams {
  /** Počet stojísk (bays) pre kamióny; `stalls` v manifeste. */
  readonly bays: number;
  /** Pobyt kamióna v bayi pred povelom do docku (ADR-011, ADR-024 bod 6); chýba = `logistics.defaultInternalTicks`. */
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
  /**
   * Pobyt **interného vozidla** v docku pred vykládkou (§7.3 bod 4, ADR-011); chýba = `logistics.defaultInternalTicks`.
   * Kamión ho nepoužíva — nakladá `loadTicksPerUnit` na jednotku (ADR-024).
   */
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
  /** Lashing (F6a, ADR-032 bod 12): ticky zabezpečenia nákladu na jednu naloženú exportnú jednotku. */
  readonly lashingTicksPerUnit: number;
  /** Papiere pred odchodom (F6a): pevné ticky po lashingu, pre loď s naloženým exportom. */
  readonly paperworkTicks: number;
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
  /**
   * Smery nákladu, ktoré vozidlo smie viezť (F6c, ADR-034): `empty_handler` len `['empty']`; chýba = každý smer (bežné
   * vozidlá vozia prázdne ako záložná možnosť). Dispatcher ho overuje spolu s kategóriou (`vehicleCarries`).
   */
  readonly cargoDirections?: readonly CargoDirection[];
  readonly purchaseCents: number;
  readonly wagePerDayCents: number;
  readonly techRequired?: string;
}

/**
 * Položka `lines.json` (F6c, ADR-034): námorná linka — vlastník kontajnerov (`CargoUnit.lineId`) a odosielateľ voyage
 * (`Contract.lineId`). Prázdne kontajnery sa vracajú, vydávajú a nalodia len v rámci linky.
 */
export interface LineDef {
  readonly id: string;
  /** Zobrazený názov linky (UI). */
  readonly displayName: string;
  /** Názov farebného tokenu z `design/tokens.css` bez `--` (napr. `line-blue`) — farba linky na odznakoch a v paneloch. */
  readonly colorToken: string;
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

/**
 * Položka `contract_templates.json` (§4.6, §9.1; F5): šablóna, z ktorej pool generuje ponuky kontraktov.
 * Objem ponuky leží v `volumeUnitsRange` a nikdy nepresiahne kapacitu lode šablóny (`DefRegistry` to overuje pre najmenšiu
 * loď zo `shipClassIds`); SLA v dňoch sa losuje zo `slaDaysRange`.
 */
export interface ContractTemplateDef {
  readonly id: string;
  /**
   * Druh šablóny (F6a, ADR-032 bod 1): `import` (F5; chýbajúce pole = `import`), `export` (booking s vlastnou voyage;
   * bookované TEU z `volumeUnitsRange`) alebo `roundtrip` (import z `volumeUnitsRange` aj export z `exportVolumeUnitsRange`
   * na jednej voyage). Export a roundtrip vyžadujú `destinationPorts`, roundtrip aj `exportVolumeUnitsRange`. F6c (ADR-034):
   * `empty_repositioning` (`volumeUnitsRange` = počet prázdnych; vyžaduje `destinationPorts`, voliteľné `exportVolumeUnitsRange` =
   * skupina s export bookingom jednej voyage) a `tranship` (`volumeUnitsRange` = prekládané jednotky; vyžaduje `destinationPorts`).
   */
  readonly kind?: ContractTemplateKind;
  /** Cieľové prístavy exportu, repositioningu a prekládky (pool losuje jeden); `export`, `roundtrip`, `empty_repositioning`, `tranship`. */
  readonly destinationPorts?: readonly string[];
  /** Rozsah `[min, max]` bookovaných TEU exportu roundtripu (`min ≤ max`, max sa zmestí do najmenšej lode); `roundtrip` (povinné), `empty_repositioning` (voliteľné). */
  readonly exportVolumeUnitsRange?: readonly [number, number];
  /** Typ nákladu z `cargo_types.json`. */
  readonly cargoTypeId: string;
  /** Rozsah `[min, max]` objemu kontraktu v jednotkách (`min ≤ max`). */
  readonly volumeUnitsRange: readonly [number, number];
  /** Rozsah `[min, max]` SLA v celých dňoch od príchodu lode (`min ≤ max`). */
  readonly slaDaysRange: readonly [number, number];
  /** Triedy lodí zo `ships.json`, ktoré kontrakt privezú (pool losuje jednu). */
  readonly shipClassIds: readonly string[];
  /** Váha pri váhovom výbere šablóny. */
  readonly weight: number;
  /** Minimálny tier hráča, od ktorého sa šablóna ponúka. */
  readonly minTier: number;
}
