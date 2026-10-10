/**
 * Typy dátových definícií (ARCHITECTURE §4). Zrkadlia `data/defs/*.json` a `data/schemas/*.schema.json`
 * 1:1 — nové pole = zmena defu, schémy, tohto typu aj tabuľky polí v `def-registry.ts`.
 */
import type { CargoDirection, ContainerSize, WeightClass } from '../cargo/cargo-unit';
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
  /** Reklamácia za pokazený reefer v centoch (R5, ADR-042): dlho bez napájania, alebo alarm bez zásahu technika; strhne sa ako `penalty`. */
  readonly reeferClaimCents: number;
  /** Cena elektriny za jeden zapojený reefer a hernú hodinu v centoch (R5, ADR-042; ledger kategória `energy`). */
  readonly reeferPowerCentsPerHour: number;
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

/** Heatmapa vyťaženia ciest (§7.6): `cell.traffic` rastie pod nosičmi a s každou hodinou sa tlmí. Spomalenie vozidiel ani cena A* z neho nevychádzajú (ADR-037). */
export interface CongestionDef {
  /** Násobiteľ `cell.traffic` pri každom HourClosed (0 = okamžitý reset, 1 = bez útlmu). */
  readonly trafficDecayPerHour: number;
}

/** Doprava bez prekrývania (ADR-037, ADR-038): čakanie na voľný slot, zápchy a parkovanie; trvania v tickoch. */
export interface TrafficDef {
  /** Po koľkých tickoch čakania nosič v cykle čakania skúsi preplánovať trasu mimo blokovanej bunky. */
  readonly gridlockTicks: number;
  /** Po koľkých tickoch čakania je nosič zaseknutý (vynúti preplánovanie, hlási sa zápcha). */
  readonly stuckTicks: number;
  /** Najkratší odstup medzi dvoma preplánovaniami jedného nosiča kvôli zápche. */
  readonly rerouteCooldownTicks: number;
  /** Po koľkých tickoch nečinnosti vozidlo bez úlohy odíde do depa (TR1-04). */
  readonly idleParkDelayTicks: number;
  /** Odstup ďalšieho pokusu o depo vozidla, ktoré k nemu nemá cestu (stojí `idle` mimo vjazdu modulu, TR5-06b). */
  readonly strandedRetryTicks: number;
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
 * Reefery (R5, ADR-042; docs/TERMINAL_2.md §6.7): časy v tickoch, limity v herných hodinách. Technik sa nekreslí (ADR-036) — je len čas a počet súčasných zásahov.
 */
export interface ReeferDef {
  /** Zapojenie reeferu po uložení do bloku so zásuvkami v tickoch (celé ≥ 1). */
  readonly plugTicks: number;
  /** Odpojenie reeferu pred zdvihom zo skladu v tickoch (celé ≥ 1). */
  readonly unplugTicks: number;
  /** Najdlhší čas bez napájania v herných hodinách (> 0), potom vznikne reklamácia (od zdvihu z lode alebo odpojenia; aj reefer preskočený STS bez voľnej zásuvky). */
  readonly maxUnpluggedHours: number;
  /** Šanca alarmu zapojeného reeferu za herný deň (`0 … 1`; losuje sa raz za hernú hodinu ako `chance(p / 24)`). */
  readonly alarmChancePerDay: number;
  /** Do koľkých hodín od alarmu musí technik začať zásah (> 0), inak reklamácia. */
  readonly alarmResponseHours: number;
  /** Koľko alarmov rieši technik naraz (celé ≥ 1; technik je len čas, nekreslí sa). */
  readonly technicians: number;
  /** Trvanie zásahu technika pri alarme v tickoch (celé ≥ 1). */
  readonly alarmFixTicks: number;
}

/** Nadrozmerný náklad (OOG; R5, ADR-042 — správanie v TR5-02): ticky navyše pri STS (rám) a pri zaistení na kamióne. */
export interface OogDef {
  /** Ticky navyše v cykle STS pri OOG (celé ≥ 0). */
  readonly extraCycleTicks: number;
  /** Trvanie zaistenia OOG na kamióne v tickoch (celé ≥ 0), namiesto `trucks.lashTicks`. */
  readonly lashTicks: number;
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

/** Režimy plánovača skladu (`logistics.yardPlanner`, ADR-039). */
export const YARD_PLANNER_MODES = ['planned', 'random'] as const;
export type YardPlannerMode = (typeof YARD_PLANNER_MODES)[number];

/**
 * `logistics.json` — logistické konštanty (ARCHITECTURE §4.6, §7.3, §7.4, §7.6; ADR-010). Konfiguračný def (ADR-009);
 * všetky trvania sú v tickoch.
 */
export interface LogisticsDef extends DefBase {
  /** Predvolený vnútorný čas vozidla v module pred load/unload; modul ho prepíše `params.internalTicks`. */
  readonly defaultInternalTicks: number;
  /** Po koľkých tickoch skúša vozidlo bez cesty (`no_path`) hľadať cestu znova. */
  readonly repathIntervalTicks: number;
  /** Trvanie jedného rehandle v tickoch (celé ≥ 1): presun kontajnera z vrchu stohu inam v bloku (`in_storage → in_vehicle → in_storage`; ADR-039). */
  readonly rehandleTicks: number;
  /** Trpezlivosť rehandlingu v tickoch (celé ≥ 1): po toľkých tickoch bez úspešného presunu (bez cieľa v bloku) sa job zruší a vozidlo uvoľní; zaokrúhľuje sa nahor na celé cykly `rehandleTicks` (ADR-039 dodatok TR2-06b). */
  readonly rehandleGiveUpTicks: number;
  /** Rezerva buniek navyše (celé ≥ 0) pri priraďovaní vozidla jobu pre zavalenú jednotku (`unitPickable`): príchody ukladané počas cesty vozidla berú miesto pre rehandling (ADR-039 dodatok TR2-06b). */
  readonly rehandleSpareCells: number;
  /** Sloty apronu (celé ≥ 0), ktoré záložná nakládka cez apron (`rerouteLoadViaApron`) nezaberie: musí tam ostať miesto, kam žeriav odloží vykladanú jednotku (inak žeriav drží import, apron je plný exportov čakajúcich na žeriav a nič sa nepohne; ADR-040 dodatok TR3-02b). */
  readonly apronUnloadReserveSlots: number;
  /** Okno dopredného plánovania pod hákom (celé ≥ 1, ADR-040 dodatok TR3-02d): najviac toľko jobov vykládky a toľko jobov nakládky na žeriav je vopred priradených, takže ťahače čakajú v pruhu kotviska pod žeriavom skôr, než ich žeriav potrebuje. */
  readonly hookJobLookahead: number;
  /** Najviac kandidátov na odvoz (celé ≥ 1), ktoré dual transaction kamióna porovná (R4, ADR-041 bod 6). */
  readonly dualCandidateLimit: number;
  /** Najviac jobov nakládky pod hákom v obehu na žeriav (celé ≥ 1), kým má loď aj import na vykládku (ADR-033 bod 4; nahrádza konštantu `PAIRED_HOOK_LOAD_JOBS_PER_CRANE`): export sa páruje s importom v dual cykle a nevyčerpá vozidlá vykládky. */
  readonly hookPairedLoadJobs: number;
  /** Koľko voľných stĺpcov (`maxTier` buniek každý, celé ≥ 0) musí ostať v bloku, aby plánovač smel zavaliť skôr odchádzajúci kontajner (ADR-039). */
  readonly buryReserveColumns: number;
  /** Váha vyťaženia stroja RTG bloku v skóre plánovača (číslo ≥ 0, v bunkách vzdialenosti na jednu položku fronty alebo rozbehnutý cyklus; ADR-040 dodatok TR3-02c); 0 = len vzdialenosť. */
  readonly yardMachineLoadWeight: number;
  /** Odhad doby ležania importu v sklade po vykládke v hodinách (> 0): základ plánovaného času odchodu importu, obmedzený SLA (ADR-039; skutočné termíny odvozu prídu v R4). */
  readonly importDwellEstimateHours: number;
  /** Režim plánovača skladu (ADR-039): `planned` = segregácia podľa času odchodu, `random` = náhodné ukladanie z `Rng` (len pre akceptačný test). */
  readonly yardPlanner: YardPlannerMode;
  readonly congestion: CongestionDef;
  /** Doprava bez prekrývania: zápchy, preplánovanie a parkovanie (ADR-037). */
  readonly traffic: TrafficDef;
  readonly shipNavigation: ShipNavigationDef;
  /** Export po súši: príchody kamiónov, VGM, hmotnostné triedy (F6a, ADR-032). */
  readonly exportFlow: ExportFlowDef;
  /** Tok prázdnych kontajnerov: návrat, kontrola, oprava, výdaj exportérovi (F6c, ADR-034). */
  readonly emptyFlow: EmptyFlowDef;
  /** Reefery: zapojenie, limit bez napájania, alarmy a technici (R5, ADR-042). */
  readonly reefer: ReeferDef;
  /** Nadrozmerný náklad: časy navyše pri STS a zaistení na kamióne (R5, ADR-042; správanie prináša TR5-02). */
  readonly oog: OogDef;
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
  'pre_gate',
  'holding',
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

/**
 * Prístup cez konektor (R4, ADR-041 bod 8): `in` = len vjazd (cieľ jazdy k modulu), `out` = len výjazd (odtiaľ vozidlo odchádza, cieľom jazdy nie je), `both` = oboje
 * (predvolené, jediný konektor modulu na jednosmernej ceste). Jednosmerný modul má vjazd a výjazd na rôznych konektoroch (RTG blok: sever dnu, juh von, bočný druhý výjazd).
 */
export const CONNECTOR_ACCESS = ['in', 'out', 'both'] as const;
export type ConnectorAccess = (typeof CONNECTOR_ACCESS)[number];

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
  /** Prístup (`in`, `out`, `both`); chýba = `both`. */
  readonly access?: ConnectorAccess;
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
 * `craneParams`, `storageParams`, `depotParams`, `gateParams`, `preGateParams` a `holdingParams`.
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
export const STORAGE_ROLES = ['empty_depot', 'rtg_block', 'rail_terminal'] as const;
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
  /**
   * Geometria bloku so stohmi (ADR-039): počet bays pozdĺž bloku (1 bay = 1 bunka = 20′, 40′ zaberie pár bays 2k, 2k+1; celé ≥ 1).
   * `bays`, `rows` a `maxTier` sú buď všetky, alebo žiadne (`checkStorageParams`); fyzická kapacita bloku v TEU je `min(capacityUnits, bays × rows × maxTier)` (od TR2-02,
   * `storageSlotCapacity`); `capacityUnits` ostáva aj hintom pre pool kontraktov (`StorageModule.storageCapacityUnits`).
   */
  readonly bays?: number;
  /** Počet radov naprieč blokom (celé ≥ 1; geometria bloku, ADR-039). */
  readonly rows?: number;
  /** Najvyššia vrstva stohu (celé ≥ 1; straddle blok 3, depo prázdnych 8; geometria bloku, ADR-039). */
  readonly maxTier?: number;
  /**
   * Stĺpec footprintu (pri rotácii 0, od ľavého okraja, celé ≥ 0), v ktorom beží jednosmerný pruh pozdĺž bloku (TR3-01, ADR-040 bod 2); povinné práve pri
   * `role: 'rtg_block'`. Pruh je simulačný údaj: bay `b` leží na bunke pruhu `b` (po dĺžke), vjazd je na začiatku a výjazd na konci pruhu.
   */
  readonly laneCol?: number;
  /** Každý koľký bay má odovzdávacie miesto (TP) v pruhu (celé ≥ 1); povinné práve pri `role: 'rtg_block'`. */
  readonly tpSpacingBays?: number;
  /**
   * Zásuvky pre reefery (R5, ADR-042): počet radov od radu 0 (celé ≥ 1, najviac `rows`), v ktorých má každá vrstva stohu zásuvku; chýba = blok bez zásuvok.
   * Blok so zásuvkami prijíma len jednotky, ktoré zásuvku potrebujú (`needsPlug`), a tie smú stáť len v ňom (`reefer_block_8`: všetky rady).
   */
  readonly plugRows?: number;
  /**
   * OOG plocha (R5, ADR-042 TR5-02): blok prijíma **len** nadrozmerný náklad (OOG) a obsluhuje ho reach stacker (`equipment.json` → `reachStacker`) namiesto RTG; len pri
   * `role: 'rtg_block'` s `maxTier` 1 (OOG sa nestohuje). Chýba = bežný blok.
   */
  readonly acceptsOog?: boolean;
  /**
   * Železničný terminál (R6, ADR-043): stĺpec footprintu (pri rotácii 0), v ktorom beží prvá koľaj pozdĺž bloku; ďalšie koľaje v susedných stĺpcoch (`tracks`). Povinné práve pri
   * `role: 'rail_terminal'`. Koľaj má pre každý bay jednu bunku footprintu (vlak po nej jazdí, bunky nie sú vrstva `rail` mapy).
   */
  readonly trackCol?: number;
  /** Počet koľají železničného terminálu (celé ≥ 1; `trackCol + tracks ≤ šírka footprintu`); povinné práve pri `role: 'rail_terminal'`. */
  readonly tracks?: number;
}

/** `params` depa vozidiel (`kind: 'depot'`). */
export interface DepotParams {
  /** Počet státí (vozidiel) v depe; `stalls` v manifeste. */
  readonly capacity: number;
  /** Vnútorný čas vozidla v module (§7.3 bod 4); chýba = `logistics.defaultInternalTicks`. */
  readonly internalTicks?: number;
}

/** Smer pruhu brány: vstupný (`gate_in_lane`) alebo výstupný (`gate_out_lane`), R4, ADR-041. */
export const GATE_DIRECTIONS = ['in', 'out'] as const;
export type GateDirection = (typeof GATE_DIRECTIONS)[number];

/** Režim pruhu brány (R4, ADR-041 bod 1): `standard`, `express` (skrátený čas, bez náhodného problému), `trouble` (pomalé riešenie problémových kamiónov). */
export const GATE_MODES = ['standard', 'express', 'trouble'] as const;
export type GateMode = (typeof GATE_MODES)[number];

/**
 * `params` pruhu brány kamiónov (`kind: 'gate'`; od R4 `gate_in_lane` a `gate_out_lane`, ADR-041 bod 1). Pruh je jednosmerný (prvý konektor = vonkajšia strana,
 * druhý = vnútorná) a obsluhuje 1 kamión naraz. Kroky vstupného pruhu: OCR → kontrola → lístok; výstupného: váha → sken → plomba.
 * Pole kroku patrí len svojmu smeru (vzťah polí v `checkGateParams`).
 */
export interface GateParams {
  /** Smer pruhu. */
  readonly direction: GateDirection;
  /** Vstupný pruh: čas OCR v tickoch (celé ≥ 1). */
  readonly ocrTicks?: number;
  /** Vstupný pruh: čas kontroly (VGM, booking, termín) v tickoch (celé ≥ 1). */
  readonly checkTicks?: number;
  /** Vstupný pruh: čas vydania lístka a závory v tickoch (celé ≥ 1). */
  readonly issueTicks?: number;
  /** Vstupný pruh: šanca na problém pri kontrole v režime `standard` (0 … 1, `Rng`). */
  readonly gateIssueChance?: number;
  /** Vstupný pruh: čas riešenia problémového kamióna (tickov navyše; v režime `trouble` celý prechod). */
  readonly troubleTicks?: number;
  /** Výstupný pruh: čas váženia v tickoch (celé ≥ 1). */
  readonly weighTicks?: number;
  /** Výstupný pruh: čas skenu v tickoch (celé ≥ 1). */
  readonly scanTicks?: number;
  /** Výstupný pruh: čas plomby a závory v tickoch (celé ≥ 1). */
  readonly sealTicks?: number;
  /** Výstupný pruh: šanca na problém pri plombe v režime `standard` (0 … 1, `Rng`). */
  readonly sealIssueChance?: number;
  /** Výstupný pruh: čas dôkladnej kontroly (tickov navyše; v režime `trouble` celý prechod). */
  readonly inspectionTicks?: number;
  /** Celý prechod v režime `express` v tickoch (celé ≥ 1; odomyká ho tech F8 `gate_fast_lane`, zatiaľ bez podmienky). */
  readonly expressTicks: number;
  /** Vnútorný čas prechodu telom brány (ADR-011): pripočíta sa k trvaniu prechodu; chýba = 0 (ADR-024). */
  readonly internalTicks?: number;
}

/**
 * `params` predbránovej plochy (`kind: 'pre_gate'`, R4, ADR-041 bod 2): jeden vjazd z cesty a `rows` radových pruhov po `rowCapacity` kamiónov; kapacita
 * plochy = `rows × rowCapacity`. Radový pruh `i` obsluhuje i-ty pruh brány dosiahnuteľný z výjazdu plochy (`i mod počet pruhov`).
 */
export interface PreGateParams {
  /** Počet radových pruhov (celé ≥ 1). */
  readonly rows: number;
  /** Kapacita radového pruhu v kamiónoch (celé ≥ 1; podľa ADR-041 2). */
  readonly rowCapacity: number;
}

/**
 * `params` odstavnej plochy kamiónov (`kind: 'holding'`, R4, ADR-041 bod 5): parkovisko so státiami 1 × 3 mimo pruhov. Správanie (volanie k TP) prinesie TR4-02;
 * v TR4-01 je to len def a modul bez dynamiky.
 */
export interface HoldingParams {
  /** Počet státí (celé ≥ 1). */
  readonly stalls: number;
  /** Dĺžka státia v bunkách (celé ≥ 1; ADR-041 bod 5: 1 × 3). */
  readonly stallLengthCells: number;
}

/** Druh bez typovaných parametrov (zatiaľ ostatné kind-y): `params` musí byť `{}`. */
export type NoParams = Readonly<Record<never, never>>;

/** Tvar `params` pre každý druh modulu; kompilátor tak vynúti, že `MODULE_PARAM_SPECS` pokrýva všetky kind-y. */
export interface ModuleParamsByKind {
  readonly berth: BerthParams;
  readonly crane: CraneParams;
  readonly storage: StorageParams;
  readonly gate: GateParams;
  readonly pre_gate: PreGateParams;
  readonly holding: HoldingParams;
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
  /** Dĺžka v bunkách (ADR-037): počet pruhových slotov, ktoré stojace vozidlo drží. */
  readonly lengthCells: number;
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
  /**
   * Vozidlo zdvihne kontajner samo (straddle carrier, empty handler): chýba = áno. Terminálový ťahač (`canLift: false`, ADR-040 bod 1) kontajner nezdvihne —
   * odovzdáva ho žeriav (STS) a stroj bloku (RTG) a vozidlo smie len joby, v ktorých jeho koncové body obsluhuje stroj (`logistics/handling-chains.ts`).
   */
  readonly canLift?: boolean;
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
 * Položka `trucks.json` (§4.2, §7.5; F4, R4): externý kamión. Kamión sa nekupuje a nemá mzdu — vpúšťa ho vnútrozemie / `TruckSpawner`; obsluhuje ho stroj bloku (RTG) alebo straddle carrier na odovzdávacom
 * mieste (TP, ADR-041 bod 4). Časy na TP (bezpečná zóna, lashing) sú v tomto defe. Sprite je `entities.<id>` v manifeste.
 */
export interface TruckDef {
  readonly id: string;
  readonly displayName: string;
  /** Kapacita v CargoUnit (koľko jednotiek vezie naraz). */
  readonly capacityUnits: number;
  /** Dĺžka v bunkách (ADR-037): počet pruhových slotov, ktoré stojaci kamión drží. */
  readonly lengthCells: number;
  /** Rýchlosť jazdy v bunkách za tick. */
  readonly speedCellsPerTick: number;
  readonly cargoCategories: readonly CargoCategory[];
  /** Bezpečná zóna (R4, ADR-041 bod 4): čas, kým šofér pred zdvihom opustí kamión a po zdvihu sa vráti (ticky, celé ≥ 0; osoba sa nekreslí, ADR-036). */
  readonly safeZoneTicks: number;
  /** Lashing (zaistenie twistlockov po naložení importu) na TP, v tickoch (celé ≥ 0). */
  readonly lashTicks: number;
  /** Unlashing (odistenie pred zdvihom exportu a prázdneho) na TP, v tickoch (celé ≥ 0). */
  readonly unlashTicks: number;
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
  /**
   * Podiel 40′ kontajnerov kontraktu (`0 … 1`, ADR-039); chýba = 0 (všetky 20′). `Rng` ho použije pri vzniku ponuky: objem v TEU ostáva,
   * počet kontajnerov je z neho odvodený. Hlavný kontrakt `empty_repositioning` ho ignoruje (prázdne berie depo s veľkosťou, akú má).
   */
  readonly sizeMix?: number;
  /**
   * Zmes typov kontajnerov (R5, ADR-042): podiel každého typu iného než `dry` (`0 … 1`, súčet ≤ 1; zvyšok je `dry`); chýba = všetko `dry` bez spotreby `Rng`.
   * Typ každého kontajnera určí `Rng` pri vzniku ponuky (`drawUnitTypes`); len kategória `container` a druhy `import` / `tranship`. OOG sa zatiaľ nelosuje (TR5-02).
   */
  readonly typeMix?: readonly ContractTypeShare[];
  /**
   * Železničný podiel (R6, ADR-043): rozsah `[min, max]` (`0 … 1`) podielu importu, ktorý odíde vlakom, a exportu, ktorý príde vlakom. `Rng` losuje hodnotu pri vzniku ponuky **len**, keď má prístav
   * železničný terminál napojený na koľajový portál; inak 0 a `Rng` sa nespotrebuje. Len kategória `container` a druhy `import` / `export` / `roundtrip`.
   */
  readonly railShare?: readonly [number, number];
  /** Rozsah `[min, max]` objemu kontraktu v jednotkách typu nákladu (kontajnery: TEU; `min ≤ max`). */
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

/** Podiel typu kontajnera v zmesi šablóny kontraktu (`ContractTemplateDef.typeMix`). */
export interface ContractTypeShare {
  readonly type: string;
  readonly share: number;
}

/** Pravidlá stohovania typu kontajnera (`ContainerTypeDef.stacking`): `normal` = bežné, `top_only` = len navrch alebo na zem (flat rack, R5). */
export const CONTAINER_STACKING_RULES = ['normal', 'top_only'] as const;
export type ContainerStackingRule = (typeof CONTAINER_STACKING_RULES)[number];

/**
 * Typ kontajnera z `container_types.json` (docs/TERMINAL_2.md §3.2, ADR-039). `CargoUnit.containerType` je `id` z katalógu. R2 pozná len `dry`;
 * `needsPower`, `oogChance` a `rateMultiplier` sú zatiaľ len dáta (reefer, nadrozmer a ceny typov prídu v R5).
 */
export interface ContainerTypeDef {
  readonly id: string;
  /** Povolené veľkosti typu v stopách (`20` / `40`, bez opakovania). */
  readonly sizes: readonly ContainerSize[];
  readonly stacking: ContainerStackingRule;
  /** Potrebuje zásuvku (reefer; R5). */
  readonly needsPower: boolean;
  /** Šanca nadrozmerného nákladu pri vzniku jednotky (`0 … 1`; R5). */
  readonly oogChance: number;
  /** Násobiteľ odmeny za TEU oproti základnej cene typu nákladu (> 0; R5). */
  readonly rateMultiplier: number;
}

/** Priority RTG fronty (`equipment.json` → `rtg.priorities`, ADR-040 bod 6): menšie číslo = vyššia priorita; poradie loď > kamión > housekeeping je v dátach. */
export const YARD_PRIORITY_KINDS = ['ship', 'truck', 'housekeeping'] as const;
export type YardPriorityKind = (typeof YARD_PRIORITY_KINDS)[number];

/** Parametre RTG žeriavu (`equipment.json` → `rtg`, docs/TERMINAL_2.md §5.3); časy sú v tickoch, pohyb v bunkách (bays) za tick. */
export interface RtgDef {
  /** Rýchlosť pojazdu žeriavu pozdĺž bloku v bays za tick (spojitá poloha). */
  readonly gantryCellsPerTick: number;
  /** Zdvih / spúšťanie o jednu vrstvu stohu v tickoch. */
  readonly hoistTicksPerTier: number;
  /** Pojazd vozíka o jeden rad naprieč blokom v tickoch. */
  readonly trolleyTicksPerRow: number;
  /** Uchopenie / pustenie kontajnera (twist-lock) v tickoch. */
  readonly lockTicks: number;
  /** Priority fronty stroja podľa druhu úlohy (menšie = skôr). */
  readonly priorities: { readonly [K in YardPriorityKind]: number };
  /** Predzásobenie nakládky: stroj začne `take` pre ťahač, ktorému do TP ostáva najviac toľko buniek trasy (0 = čaká na príchod ťahača). */
  readonly prefetchCells: number;
  /** Po toľkých tickoch čakania stroja so zdvihnutým kontajnerom na ťahač (predzásobenie) stroj kontajner vráti do stohu a cyklus zruší (≥ 1). */
  readonly handoverGiveUpTicks: number;
}

/** Režim prideľovania ťahačov žeriavu STS (ADR-040 bod 7): `pool` = najbližší voľný ťahač zo spoločného bazéna, `gang` = pevná skupina `tractorsPerSts` ťahačov žeriavu. */
export const CRANE_GANG_MODES = ['pool', 'gang'] as const;
export type CraneGangMode = (typeof CRANE_GANG_MODES)[number];

/** Prideľovanie ťahačov (`equipment.json` → `tractors`, TR3-02): východisko a medze príkazu `SetCraneGang`. */
export interface TractorsDef {
  readonly defaultMode: CraneGangMode;
  readonly defaultPerSts: number;
  readonly minPerSts: number;
  readonly maxPerSts: number;
}

/**
 * Priority RMG (`equipment.json` → `rmg.priorities`, ADR-043): vlak > ťahač (loď = ťahač od STS, potom kamión) > housekeeping; menšie číslo = vyššia priorita, hodnoty musia ostro rásť
 * v tomto poradí.
 */
export const RMG_PRIORITY_KINDS = ['train', 'ship', 'truck', 'housekeeping'] as const;
export type RmgPriorityKind = (typeof RMG_PRIORITY_KINDS)[number];

/** RMG železničného terminálu (`equipment.json` → `rmg`, ADR-043 TR6-02): ako RTG (`RtgDef`: časy, predzásobenie ťahača) a navyše priorita práce pre vlak (`priorities.train`). */
export interface RmgDef extends RtgDef {
  /** Priority fronty stroja (menšie = skôr): vlak > ťahač (loď, kamión) > housekeeping. */
  readonly priorities: { readonly [K in RmgPriorityKind]: number };
}

/** `equipment.json` — stroje bloku a ťahače (TERMINAL_2 §10.5, ADR-040): `rtg`, `reachStacker`, `rmg` a `tractors`. */
export interface EquipmentDef extends DefBase {
  readonly rtg: RtgDef;
  /** Reach stacker OOG plochy (R5, TR5-02): rovnaký tvar ako `rtg`; pojazd = ulička plochy, vozík = výložník (rad), zdvih = vrstva. */
  readonly reachStacker: RtgDef;
  /** RMG železničného terminálu (R6, ADR-043). */
  readonly rmg: RmgDef;
  readonly tractors: TractorsDef;
}

/** Cestovný poriadok vlakov (`rail.json` → `timetable`, ADR-043): vlak z koľajového portálu prichádza v pravidelnom intervale a po pobyte v termináli odchádza. */
export interface RailTimetableDef {
  /** Interval medzi plánovanými príchodmi vlakov v herných hodinách (> 0). */
  readonly intervalHours: number;
  /** Hodina hry (od tick 0) prvého plánovaného príchodu (celé ≥ 0). */
  readonly firstArrivalHour: number;
  /** Počet vagónov vlaku okrem lokomotívy (celé ≥ 1). */
  readonly wagonsPerTrain: number;
  /** Plánovaný pobyt vlaku v termináli v herných minútach od zastavenia (celé ≥ 1); vlak odíde skôr, keď je plný. */
  readonly dwellMinutes: number;
}

/** Vlak (`rail.json` → `train`, ADR-043): rýchlosť, dĺžky vozňov a kapacita vagóna. */
export interface RailTrainDef {
  /** Rýchlosť vlaku v tisícinách bunky za tick (celé ≥ 1; 1000 = bunka za tick). */
  readonly speedMilliCellsPerTick: number;
  /** Dĺžka lokomotívy v bunkách (celé ≥ 1; bunka = 6 m). */
  readonly locoLengthCells: number;
  /** Dĺžka vagóna v bunkách (celé ≥ 1; vagón 60′ = 3 bunky). */
  readonly wagonLengthCells: number;
  /** Kapacita vagóna v TEU (celé ≥ 1; `wagon_container_60` = 3 TEU: 40′ + 20′ alebo 3× 20′). */
  readonly wagonTeu: number;
}

/** `rail.json` — železnica (R6, ADR-043): cestovný poriadok a vlak. Konfiguračný def (ADR-009). */
export interface RailDef extends DefBase {
  readonly timetable: RailTimetableDef;
  readonly train: RailTrainDef;
  /** Úrovňové priecestie (TR6-02): vlak rezervuje priecestie pred sebou toľko tickov jazdy vopred (celé ≥ 1); cestné vozidlá do rezervovaného priecestia nevstúpia (závora). */
  readonly crossingClearTicks: number;
}
