/**
 * DefRegistry — typované gettery nad dátovými definíciami (ARCHITECTURE §4), fail-fast pri chybe.
 *
 * Validácia je zámerne ručná a malá (bez ajv, bez `fs`): sim ostáva bez runtime závislostí a prenositeľný
 * do Web Workera. Plnú JSON schému vynucuje `pnpm validate:defs` (tools); táto vrstva overuje to isté
 * minimum, čo potrebuje kód — prítomnosť defu, `schemaVersion`, povinné polia, typy a rozsahy, neznáme kľúče,
 * jedinečnosť `id` v katalógoch a vzťahy medzi poľami (konektor vo footprinte, alias ceny cesty v `infrastructure`). Generický kód je v `def-spec.ts`,
 * pravidlá sú tabuľky nižšie (`FieldTable`, `SpecTable`).
 *
 * Konfiguračné defy (`time`, `economy`, `infrastructure`, `logistics`) sú jeden objekt, katalógové (`cargo_types`,
 * `modules`, `ships`, `vehicles`, `trucks`, `contract_templates`) majú `items: [...]` (ADR-009) a vystavujú sa ako `Catalog`.
 */
import cargoTypesJson from '@data/defs/cargo_types.json';
import containerTypesJson from '@data/defs/container_types.json';
import contractTemplatesJson from '@data/defs/contract_templates.json';
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import linesJson from '@data/defs/lines.json';
import logisticsJson from '@data/defs/logistics.json';
import modulesJson from '@data/defs/modules.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import trucksJson from '@data/defs/trucks.json';
import vehiclesJson from '@data/defs/vehicles.json';
import { CARGO_DIRECTIONS, CONTAINER_SIZES } from '../cargo/cargo-unit';
import { SECONDS_PER_MINUTE } from '../core/sim-clock';
import { DEFAULT_ROAD_KIND } from '../grid/road-kind';
import { TERRAIN_TYPES } from '../grid/terrain';
import { validateCatalog, type Catalog } from './catalog';
import { DefError } from './def-error';
import {
  SNAKE_CASE_ID,
  TOKEN_NAME,
  checkFields,
  describeValue,
  failWith,
  findUnknownKey,
  freezeCopy,
  isPlainObject,
  pointerSegment,
  type FieldRecord,
  type Problem,
  type SpecTable,
  type StringSpec,
} from './def-spec';
import { checkModuleItem, rampParams } from './module-def';
import {
  CARGO_CATEGORIES,
  CONNECTOR_TYPES,
  CONTAINER_STACKING_RULES,
  CONTRACT_TEMPLATE_KINDS,
  DEFAULT_TEMPLATE_KIND,
  MODULE_KINDS,
  SIDES,
  SUPPORTED_SCHEMA_VERSION,
  YARD_PLANNER_MODES,
  type CargoTypeDef,
  type ContainerTypeDef,
  type CongestionDef,
  type TrafficDef,
  type ContractTemplateDef,
  type ContractTemplateKind,
  type DefBase,
  type EconomyDef,
  type EmptyFlowDef,
  type ExportFlowDef,
  type InfrastructureDef,
  type InfrastructureLayerDef,
  type LineDef,
  type LogisticsDef,
  type ModuleDef,
  type RoadKindDef,
  type ShipClassDef,
  type ShipNavigationDef,
  type TimeDef,
  type TruckDef,
  type VehicleDef,
} from './types';

export { DefError };

// ---------------------------------------------------------------------------------------------------------
// Tabuľky polí — jedna na def; jediný kód validácie je generický (`validateDef`, `validateCatalog`).
// ---------------------------------------------------------------------------------------------------------

/** Tabuľka defu: každé pole okrem `schemaVersion`. */
type FieldTable<T extends DefBase> = SpecTable<Omit<T, keyof DefBase>>;

const TIME_FIELDS: FieldTable<TimeDef> = {
  // Tick musí deliť minútu (§3), inak by hranice minúty/hodiny/dňa nepadli na celý tick; rovnaké pravidlo má SimClock.
  tickGameSeconds: { kind: 'integer', min: 1, divisorOf: SECONDS_PER_MINUTE },
  ticksPerRealSecond: { kind: 'integer', min: 1 },
  maxTicksPerFrame: { kind: 'integer', min: 1 },
  speeds: { kind: 'integerArray', minItems: 1, itemMin: 0, unique: true, contains: 0 },
};

const ECONOMY_FIELDS: FieldTable<EconomyDef> = {
  startingCashCents: { kind: 'integer', min: 0 },
  demurrageRateOfRewardPerHour: { kind: 'number', min: 0, max: 1 },
  latePenaltyRateOfRewardPerDay: { kind: 'number', min: 0, max: 1 },
  failAfterDaysLate: { kind: 'integer', min: 0 },
  leaseMonthlyRateOfPrice: { kind: 'number', min: 0, max: 1 },
  bankruptcyDays: { kind: 'integer', min: 1 },
  offersPerDay: { kind: 'integer', min: 0 },
  offerExpiryDays: { kind: 'integer', min: 1 },
  removalRefundRate: { kind: 'number', min: 0, max: 1 },
  urgencyFactor: { kind: 'number', min: 0 },
  // Rozsah dní príchodu lode: desatinné dni, ale nie záporné; horná hranica > 0, aby loď neprišla v tom istom ticku ako prijatie.
  arrivalDaysRange: { kind: 'range', bound: { kind: 'number', min: 0 } },
  volumeScaleRange: { kind: 'range', bound: { kind: 'number', exclusiveMin: 0 } },
  minCapacityHint: { kind: 'integer', min: 1 },
  contractsPerTier: { kind: 'integer', min: 1 },
  xpMultiplier: { kind: 'number', min: 0 },
  lateXpFactor: { kind: 'number', min: 0, max: 1 },
  ledgerEntriesKept: { kind: 'integer', min: 1 },
  // Export a booking (F6a, ADR-032 bod 1, 6, 14).
  bookingOffersPerDay: { kind: 'integer', min: 0 },
  exportArrivalDaysRange: { kind: 'range', bound: { kind: 'number', min: 0 } },
  cutoffHours: { kind: 'number', exclusiveMin: 0 },
  cutoffWarningHours: { kind: 'number', min: 0 },
  bookingFulfilmentShare: { kind: 'number', min: 0, max: 1 },
  lastMinuteExportRateOfReward: { kind: 'number', min: 0, max: 1 },
  rolledExportRateOfReward: { kind: 'number', min: 0, max: 1 },
  unfulfilledBookingRateOfReward: { kind: 'number', min: 0, max: 1 },
  // Prázdne kontajnery, repositioning a tranship (F6c, ADR-034).
  repositioningOffersPerDay: { kind: 'integer', min: 0 },
  transhipOffersPerDay: { kind: 'integer', min: 0 },
  repairCostCents: { kind: 'integer', min: 0 },
  // Rozstup príchodov lodí A a B: ostro kladný (B nikdy nepríde v ticku príchodu A), min ≤ max hlási `RangeSpec`.
  transhipGapDaysRange: { kind: 'range', bound: { kind: 'number', exclusiveMin: 0 } },
  transhipRescueDays: { kind: 'number', min: 0 },
  transhipMissedRateOfReward: { kind: 'number', min: 0, max: 1 },
};

/** Hodín v dni — prevod `exportArrivalDaysRange` (dni) na hodiny `cutoffHours` (kalendárna konštanta, nie balans). */
const HOURS_PER_DAY = 24;

/**
 * Vzťahy polí `economy.json`: `arrivalDaysRange[1] > 0` (F5), inak by loď kontraktu prišla v ticku prijatia; export
 * (F6a): `exportArrivalDaysRange[0] × 24 > cutoffHours`, inak by cut-off ležal pred prijatím bookingu.
 */
function checkEconomy(def: Readonly<EconomyDef>): Problem | undefined {
  if (!(def.arrivalDaysRange[1] > 0)) {
    return { path: '/arrivalDaysRange/1', message: `musí byť > 0 (loď kontraktu nesmie prísť v ticku prijatia), dostal ${String(def.arrivalDaysRange[1])}` };
  }
  const earliestHours = def.exportArrivalDaysRange[0] * HOURS_PER_DAY;
  if (earliestHours > def.cutoffHours) return undefined;
  return {
    path: '/exportArrivalDaysRange/0',
    message: `min × 24 h (${String(earliestHours)}) musí byť > cutoffHours (${String(def.cutoffHours)}) — cut-off by ležal pred prijatím bookingu, dostal ${String(def.exportArrivalDaysRange[0])}`,
  };
}

/** Cesta aj koľaj majú rovnaké polia (ADR-010), líšia sa iba hodnotami v defe. */
const INFRASTRUCTURE_LAYER_FIELDS: SpecTable<InfrastructureLayerDef> = {
  costPerCellCents: { kind: 'integer', min: 0 },
  maintenancePerDayCents: { kind: 'integer', min: 0 },
};

/** Typ cesty (ADR-020): `speedFactor` v `(0, 1]`, aby cena bunky v A* `1 / speedFactor` bola ≥ 1. */
const ROAD_KIND_FIELDS: SpecTable<RoadKindDef> = {
  costPerCellCents: { kind: 'integer', min: 0 },
  speedFactor: { kind: 'number', exclusiveMin: 0, max: 1 },
};

const INFRASTRUCTURE_FIELDS: FieldTable<InfrastructureDef> = {
  road: { kind: 'object', fields: INFRASTRUCTURE_LAYER_FIELDS },
  rail: { kind: 'object', fields: INFRASTRUCTURE_LAYER_FIELDS },
  roadKinds: {
    kind: 'object',
    fields: {
      two_lane: { kind: 'object', fields: ROAD_KIND_FIELDS },
      one_lane: { kind: 'object', fields: ROAD_KIND_FIELDS },
      one_way: { kind: 'object', fields: ROAD_KIND_FIELDS },
    },
  },
};

/**
 * Vzťah polí `infrastructure.json` (ADR-020): `road.costPerCellCents` je alias ceny predvoleného typu cesty — obe čísla
 * sa musia zhodovať, inak by prezentácia a sim ukazovali rôzne ceny tej istej stavby.
 */
function checkInfrastructure(def: Readonly<InfrastructureDef>): Problem | undefined {
  const aliasCents = def.road.costPerCellCents;
  const kindCents = def.roadKinds[DEFAULT_ROAD_KIND].costPerCellCents;
  if (aliasCents === kindCents) return undefined;
  return {
    path: '/road/costPerCellCents',
    message: `alias ceny roadKinds/${DEFAULT_ROAD_KIND}/costPerCellCents (${String(kindCents)}) sa musí zhodovať, dostal ${String(aliasCents)}`,
  };
}

/** Heatmapa vyťaženia ciest (§7.6), tabuľka zrkadlí `logistics.schema.json`. */
const CONGESTION_FIELDS: SpecTable<CongestionDef> = {
  trafficDecayPerHour: { kind: 'number', min: 0, max: 1 },
};

/** Doprava bez prekrývania (ADR-037), tabuľka zrkadlí `logistics.schema.json`: všetky trvania sú celé ticky ≥ 1. */
const TRAFFIC_FIELDS: SpecTable<TrafficDef> = {
  gridlockTicks: { kind: 'integer', min: 1 },
  stuckTicks: { kind: 'integer', min: 1 },
  rerouteCooldownTicks: { kind: 'integer', min: 1 },
  idleParkDelayTicks: { kind: 'integer', min: 1 },
};

/**
 * Lodná navigácia (§7.4, ADR-029; T06-07), tabuľka zrkadlí `logistics.schema.json`. Strop manévrov 100 drží
 * lexikografickú cenu A* po vode (pohyby × (stavy × manévre + 1) + manévre) v bezpečných celých číslach aj na veľkých mapách.
 */
const SHIP_NAVIGATION_FIELDS: SpecTable<ShipNavigationDef> = {
  approachMarginCells: { kind: 'integer', min: 1 },
  sweepStepCells: { kind: 'number', min: 0.1, max: 1 },
  turnManeuvers: { kind: 'integer', min: 0, max: 100 },
  sidewaysManeuvers: { kind: 'integer', min: 0, max: 100 },
};

/**
 * Tok exportu po súši (F6a, ADR-032), tabuľka zrkadlí `logistics.schema.json`: okno príchodov v dňoch (> 0), pravdepodobnosť
 * chýbajúceho VGM `0 … 1`, trvanie hold v hodinách (> 0) a váhy hmotnostných tried (≥ 0; súčet > 0 je vzťah polí).
 */
const EXPORT_FLOW_FIELDS: SpecTable<ExportFlowDef> = {
  arrivalWindowDays: { kind: 'number', exclusiveMin: 0 },
  vgmMissingChance: { kind: 'number', min: 0, max: 1 },
  vgmHoldHours: { kind: 'number', exclusiveMin: 0 },
  weightClassShares: {
    kind: 'object',
    fields: {
      light: { kind: 'number', min: 0 },
      medium: { kind: 'number', min: 0 },
      heavy: { kind: 'number', min: 0 },
    },
  },
};

/**
 * Tok prázdnych kontajnerov (F6c, ADR-034), tabuľka zrkadlí `logistics.schema.json`: rozsah dní z vnútrozemia (≥ 0, `min ≤ max`
 * hlási `RangeSpec`), pravdepodobnosti `0 … 1`, hodiny opravy a čakania > 0 a rozsah predstihu prázdneho kamióna (> 0).
 */
const EMPTY_FLOW_FIELDS: SpecTable<EmptyFlowDef> = {
  hinterlandDaysRange: { kind: 'range', bound: { kind: 'number', min: 0 } },
  emptyReturnRate: { kind: 'number', min: 0, max: 1 },
  damageChance: { kind: 'number', min: 0, max: 1 },
  repairHours: { kind: 'number', exclusiveMin: 0 },
  emptyPickupRate: { kind: 'number', min: 0, max: 1 },
  emptyPickupLeadHoursRange: { kind: 'range', bound: { kind: 'number', exclusiveMin: 0 } },
  emptyPickupMaxWaitHours: { kind: 'number', exclusiveMin: 0 },
};

const LOGISTICS_FIELDS: FieldTable<LogisticsDef> = {
  defaultInternalTicks: { kind: 'integer', min: 0 },
  repathIntervalTicks: { kind: 'integer', min: 1 },
  // Sklad so stohmi (R2, ADR-039): trvanie rehandle v tickoch, odhad ležania importu v hodinách, režim plánovača.
  rehandleTicks: { kind: 'integer', min: 1 },
  rehandleGiveUpTicks: { kind: 'integer', min: 1 },
  buryReserveColumns: { kind: 'integer', min: 0 },
  rehandleSpareCells: { kind: 'integer', min: 0 },
  importDwellEstimateHours: { kind: 'number', exclusiveMin: 0 },
  yardPlanner: { kind: 'enum', values: YARD_PLANNER_MODES },
  congestion: { kind: 'object', fields: CONGESTION_FIELDS },
  traffic: { kind: 'object', fields: TRAFFIC_FIELDS },
  shipNavigation: { kind: 'object', fields: SHIP_NAVIGATION_FIELDS },
  exportFlow: { kind: 'object', fields: EXPORT_FLOW_FIELDS },
  emptyFlow: { kind: 'object', fields: EMPTY_FLOW_FIELDS },
};

/** Vzťah polí `logistics.json` (F6a): aspoň jedna hmotnostná trieda má kladnú váhu (inak `Rng.weighted` nemá z čoho vyberať). */
function checkLogistics(def: Readonly<LogisticsDef>): Problem | undefined {
  const { light, medium, heavy } = def.exportFlow.weightClassShares;
  if (light + medium + heavy > 0) return undefined;
  return { path: '/exportFlow/weightClassShares', message: 'súčet váh hmotnostných tried musí byť > 0' };
}

/** Tabuľky konfiguračných defov; kľúč je názov defu (= názov súboru bez `.json`). */
const DEF_FIELDS = {
  time: TIME_FIELDS,
  economy: ECONOMY_FIELDS,
  infrastructure: INFRASTRUCTURE_FIELDS,
  logistics: LOGISTICS_FIELDS,
} as const;

// Katalógové defy (ADR-009): tabuľka polí jednej položky; `id` je vždy prvé pole.

const ID_FIELD: StringSpec = { kind: 'string', pattern: SNAKE_CASE_ID, patternName: 'snake_case identifikátor' };
const TEXT_FIELD: StringSpec = { kind: 'string' };

const CARGO_TYPE_FIELDS: SpecTable<CargoTypeDef> = {
  id: ID_FIELD,
  category: { kind: 'enum', values: CARGO_CATEGORIES },
  unitName: TEXT_FIELD,
  unitsPerBatch: { kind: 'integer', min: 1 },
  basePricePerUnitCents: { kind: 'integer', min: 0 },
  exportPricePerUnitCents: { kind: 'integer', min: 0 },
  repositioningPricePerUnitCents: { kind: 'integer', min: 0 },
  transhipPricePerUnitCents: { kind: 'integer', min: 0 },
  xpPerUnit: { kind: 'number', min: 0 },
  colorToken: { kind: 'string', pattern: TOKEN_NAME, patternName: 'názov tokenu (kebab-case, bez `--`)' },
};

/** `params` nie je v tabuľke — jeho tvar závisí od `kind` (`checkModuleItem`, `MODULE_PARAM_SPECS`). */
const MODULE_FIELDS: SpecTable<Omit<ModuleDef, 'params'>> = {
  id: ID_FIELD,
  kind: { kind: 'enum', values: MODULE_KINDS },
  displayName: TEXT_FIELD,
  footprint: { kind: 'object', fields: { w: { kind: 'integer', min: 1 }, h: { kind: 'integer', min: 1 } } },
  placement: {
    kind: 'object',
    fields: {
      requiredTerrain: { kind: 'array', minItems: 1, unique: true, item: { kind: 'enum', values: TERRAIN_TYPES } },
      waterSide: { kind: 'enum', values: ['north'], optional: true },
      requiresParcelOwnership: { kind: 'boolean' },
      mustAttachTo: { kind: 'array', minItems: 1, unique: true, item: { kind: 'enum', values: MODULE_KINDS }, optional: true },
    },
  },
  connectors: {
    kind: 'array',
    minItems: 0,
    unique: false,
    item: {
      kind: 'object',
      fields: {
        x: { kind: 'integer', min: 0 },
        y: { kind: 'integer', min: 0 },
        side: { kind: 'enum', values: SIDES },
        type: { kind: 'enum', values: CONNECTOR_TYPES },
      },
    },
  },
  costCents: { kind: 'integer', min: 0 },
  maintenancePerDayCents: { kind: 'integer', min: 0 },
  techRequired: { kind: 'string', pattern: SNAKE_CASE_ID, patternName: 'snake_case identifikátor', optional: true },
};

/** Linka (F6c, ADR-034): id, zobrazený názov a farebný token (`design/tokens.css` bez `--`). */
const LINE_FIELDS: SpecTable<LineDef> = {
  id: ID_FIELD,
  displayName: TEXT_FIELD,
  colorToken: { kind: 'string', pattern: TOKEN_NAME, patternName: 'názov tokenu (kebab-case, bez `--`)' },
};

const SHIP_CLASS_FIELDS: SpecTable<ShipClassDef> = {
  id: ID_FIELD,
  displayName: TEXT_FIELD,
  lengthCells: { kind: 'integer', min: 1 },
  widthCells: { kind: 'integer', min: 1 },
  draftClass: { kind: 'integer', min: 1, max: 3 },
  capacityUnits: { kind: 'integer', min: 1 },
  speedCellsPerTick: { kind: 'number', exclusiveMin: 0 },
  cargoCategories: { kind: 'array', minItems: 1, unique: true, item: { kind: 'enum', values: CARGO_CATEGORIES } },
  berthAllowanceTicks: { kind: 'integer', min: 1 },
  lashingTicksPerUnit: { kind: 'integer', min: 0 },
  paperworkTicks: { kind: 'integer', min: 0 },
  techRequired: { kind: 'string', pattern: SNAKE_CASE_ID, patternName: 'snake_case identifikátor', optional: true },
};

const VEHICLE_FIELDS: SpecTable<VehicleDef> = {
  id: ID_FIELD,
  displayName: TEXT_FIELD,
  capacityUnits: { kind: 'integer', min: 1 },
  lengthCells: { kind: 'integer', min: 1 },
  speedCellsPerTick: { kind: 'number', exclusiveMin: 0 },
  // Load/unload jednej jednotky musí trvať aspoň tick, inak by sekvencia jednotiek (§7.3 bod 4) nemala krok.
  loadTicks: { kind: 'integer', min: 1 },
  unloadTicks: { kind: 'integer', min: 1 },
  cargoCategories: { kind: 'array', minItems: 1, unique: true, item: { kind: 'enum', values: CARGO_CATEGORIES } },
  // Smery nákladu vozidla (F6c, ADR-034): chýba = všetky.
  cargoDirections: { kind: 'array', minItems: 1, unique: true, item: { kind: 'enum', values: CARGO_DIRECTIONS }, optional: true },
  purchaseCents: { kind: 'integer', min: 0 },
  wagePerDayCents: { kind: 'integer', min: 0 },
  techRequired: { kind: 'string', pattern: SNAKE_CASE_ID, patternName: 'snake_case identifikátor', optional: true },
};

/** Kamión (F4): bez nákupu a mzdy — spawnuje ho `TruckSpawner`, čas nakládky určuje rampa. */
const TRUCK_FIELDS: SpecTable<TruckDef> = {
  id: ID_FIELD,
  displayName: TEXT_FIELD,
  capacityUnits: { kind: 'integer', min: 1 },
  lengthCells: { kind: 'integer', min: 1 },
  speedCellsPerTick: { kind: 'number', exclusiveMin: 0 },
  cargoCategories: { kind: 'array', minItems: 1, unique: true, item: { kind: 'enum', values: CARGO_CATEGORIES } },
};

/** Typ kontajnera (R2, ADR-039): `sizes` ⊂ {20, 40} bez opakovania je v `checkContainerType`; `oogChance` `0 … 1`, `rateMultiplier` > 0. */
const CONTAINER_TYPE_FIELDS: SpecTable<ContainerTypeDef> = {
  id: ID_FIELD,
  sizes: { kind: 'integerArray', minItems: 1, itemMin: Math.min(...CONTAINER_SIZES), unique: true },
  stacking: { kind: 'enum', values: CONTAINER_STACKING_RULES },
  needsPower: { kind: 'boolean' },
  oogChance: { kind: 'number', min: 0, max: 1 },
  rateMultiplier: { kind: 'number', exclusiveMin: 0 },
};

/** Vzťah polí typu kontajnera: každá veľkosť je jedna z `CONTAINER_SIZES` (20′ / 40′). Schéma to vyjadruje `enum`, tabuľka celých čísel nie. */
function checkContainerType(item: Readonly<Record<string, unknown>>, path: string): Problem | undefined {
  const sizes = item['sizes'] as readonly number[];
  const bad = sizes.findIndex((size) => !(CONTAINER_SIZES as readonly number[]).includes(size));
  if (bad < 0) return undefined;
  return { path: `${path}/sizes/${String(bad)}`, message: `veľkosť musí byť jedna z: ${CONTAINER_SIZES.join(', ')}, dostal ${String(sizes[bad])}` };
}

/** Šablóna kontraktu (F5): rozsahy sú celé jednotky/dni, `min ≤ max` hlási `RangeSpec`; vzťahy na iné katalógy `checkContractTemplates`. */
const CONTRACT_TEMPLATE_FIELDS: SpecTable<ContractTemplateDef> = {
  id: ID_FIELD,
  // Export a booking (F6a, ADR-032 bod 1): chýbajúci `kind` = import (F5); súvisiace polia podľa druhu hlási `checkContractTemplates`.
  kind: { kind: 'enum', values: CONTRACT_TEMPLATE_KINDS, optional: true },
  destinationPorts: { kind: 'array', minItems: 1, unique: true, item: TEXT_FIELD, optional: true },
  exportVolumeUnitsRange: { kind: 'range', bound: { kind: 'integer', min: 1 }, optional: true },
  cargoTypeId: { kind: 'string', pattern: SNAKE_CASE_ID, patternName: 'snake_case identifikátor' },
  // Podiel 40′ kontajnerov (R2, ADR-039); chýba = 0 (všetky 20′).
  sizeMix: { kind: 'number', min: 0, max: 1, optional: true },
  volumeUnitsRange: { kind: 'range', bound: { kind: 'integer', min: 1 } },
  slaDaysRange: { kind: 'range', bound: { kind: 'integer', min: 1 } },
  shipClassIds: { kind: 'array', minItems: 1, unique: true, item: { kind: 'string', pattern: SNAKE_CASE_ID, patternName: 'snake_case identifikátor' } },
  weight: { kind: 'integer', min: 1 },
  minTier: { kind: 'integer', min: 0 },
};

type DefName = keyof typeof DEF_FIELDS | 'cargo_types' | 'container_types' | 'modules' | 'ships' | 'vehicles' | 'trucks' | 'contract_templates' | 'lines';

// ---------------------------------------------------------------------------------------------------------
// Validácia konfiguračného defu
// ---------------------------------------------------------------------------------------------------------

/**
 * Overí surový def voči tabuľke polí a vráti jeho zmrazenú kópiu (vstup sa nemení ani nezmrazuje).
 * Hlási prvý nájdený problém: koreň → neznáme kľúče → `schemaVersion` → polia v poradí tabuľky (vnorené objekty
 * rekurzívne rovnakým poradím, cesta je úplný JSON pointer).
 */
function validateDef<T extends DefBase>(
  defName: string,
  raw: unknown,
  fields: FieldTable<T>,
  check?: (def: Readonly<T>) => Problem | undefined,
): Readonly<T> {
  const fail = (problem: Problem): never => failWith(defName, problem);

  if (raw === undefined) return fail({ path: '', message: 'def chýba' });
  if (!isPlainObject(raw)) return fail({ path: '', message: `očakávaný objekt, dostal ${describeValue(raw)}` });

  const table: FieldRecord = fields;
  const unknownKey = findUnknownKey(raw, new Set(['schemaVersion', ...Object.keys(table)]), '');
  if (unknownKey) fail(unknownKey);

  const versionPath = pointerSegment('schemaVersion');
  if (!Object.hasOwn(raw, 'schemaVersion')) fail({ path: versionPath, message: 'chýba povinné pole' });
  if (raw['schemaVersion'] !== SUPPORTED_SCHEMA_VERSION) {
    fail({
      path: versionPath,
      message: `nepodporovaná verzia schémy, očakávaná ${String(SUPPORTED_SCHEMA_VERSION)}, dostal ${describeValue(raw['schemaVersion'])}`,
    });
  }

  const problem = checkFields(raw, table, '');
  if (problem) fail(problem);
  // Všetky polia tabuľky prešli kontrolou a neznáme kľúče sú vylúčené, takže tvar zodpovedá `T`.
  const def = freezeCopy(raw) as Readonly<T>;
  const relation = check?.(def);
  if (relation) fail(relation);
  return def;
}

/**
 * Krížová kontrola `modules.json` × `trucks.json` (review T04-11 f, dodatok ADR-024): kamión, ktorý spawner pošle na
 * rampu (prvý v poradí `trucks.json`, ktorý vozí jej kategóriu), musí mať `capacityUnits ≤ stagingPerDock` — inak by
 * na docku nikdy nebolo dosť jednotiek, rampa by prijímala outbound joby a nič by z nej neodišlo. Chyba patrí rampe
 * (`modules/items/<i>/params/stagingPerDock`). Rampa bez kamióna svojej kategórie je v registri prípustná (spawner
 * nič nepošle — syntetické defy testov tak izolujú outbound joby); v zabalených dátach ju zakáže `pnpm validate:defs`.
 */
function checkRampTrucks(modules: Catalog<Readonly<ModuleDef>>, trucks: Catalog<Readonly<TruckDef>>): void {
  modules.items.forEach((def, index) => {
    if (def.kind !== 'ramp') return;
    const { category, stagingPerDock } = rampParams(def);
    const truck = trucks.items.find((candidate) => candidate.cargoCategories.includes(category));
    if (truck === undefined || truck.capacityUnits <= stagingPerDock) return;
    failWith('modules', {
      path: `/items/${String(index)}/params/stagingPerDock`,
      message: `kamión '${truck.id}' (kategória '${category}') má capacityUnits ${String(truck.capacityUnits)} > stagingPerDock ${String(stagingPerDock)} rampy '${def.id}' — dock by sa nikdy nenaplnil`,
    });
  });
}

/**
 * Pole šablóny podľa druhu (F6a, ADR-032 bod 1; F6c, ADR-034): `import` nemá `destinationPorts` ani `exportVolumeUnitsRange`,
 * `export` vyžaduje `destinationPorts` a nemá `exportVolumeUnitsRange`, `roundtrip` vyžaduje obe, `empty_repositioning`
 * vyžaduje `destinationPorts` a `exportVolumeUnitsRange` smie (skupina s export bookingom jednej voyage), `tranship` vyžaduje
 * `destinationPorts` a nemá `exportVolumeUnitsRange`. Tabuľka (nie switch) — nový druh = nový riadok. `required` / `forbidden`
 * sú polia šablóny.
 */
const TEMPLATE_KIND_FIELDS: { readonly [K in ContractTemplateKind]: { readonly required: readonly string[]; readonly forbidden: readonly string[] } } = {
  import: { required: [], forbidden: ['destinationPorts', 'exportVolumeUnitsRange'] },
  export: { required: ['destinationPorts'], forbidden: ['exportVolumeUnitsRange'] },
  roundtrip: { required: ['destinationPorts', 'exportVolumeUnitsRange'], forbidden: [] },
  empty_repositioning: { required: ['destinationPorts'], forbidden: [] },
  tranship: { required: ['destinationPorts'], forbidden: ['exportVolumeUnitsRange'] },
};

/**
 * Pole typu nákladu, ktoré cenou odmeny za jednotku určuje druh šablóny (kladné pre každý druh okrem importu, ktorý používa
 * `basePricePerUnitCents` — tú nekontrolujeme, F5). Tabuľka (nie switch).
 */
const TEMPLATE_KIND_PRICE_FIELD: { readonly [K in ContractTemplateKind]: keyof CargoTypeDef | undefined } = {
  import: undefined,
  export: 'exportPricePerUnitCents',
  roundtrip: 'exportPricePerUnitCents',
  empty_repositioning: 'repositioningPricePerUnitCents',
  tranship: 'transhipPricePerUnitCents',
};

/**
 * Krížová kontrola `contract_templates.json` × `cargo_types.json` × `ships.json` (F5, F6a; fail-fast): `cargoTypeId` a
 * `shipClassIds` existujú, každá loď šablóny vozí kategóriu nákladu a `volumeUnitsRange[1]` (pri roundtripe aj
 * `exportVolumeUnitsRange[1]`) sa zmestí do najmenšej lode šablóny (ponuka nikdy nepresiahne kapacitu lode, §9.1);
 * polia podľa druhu šablóny (`TEMPLATE_KIND_FIELDS`) a kladná `exportPricePerUnitCents` nákladu pri exporte a roundtripe.
 * Chyba patrí šablóne (`contract_templates/items/<i>/...`).
 */
function checkContractTemplates(
  templates: Catalog<Readonly<ContractTemplateDef>>,
  cargoTypes: Catalog<Readonly<CargoTypeDef>>,
  ships: Catalog<Readonly<ShipClassDef>>,
): void {
  const fail = (index: number, field: string, message: string): never =>
    failWith('contract_templates', { path: `/items/${String(index)}/${field}`, message });
  templates.items.forEach((template, index) => {
    const kind = template.kind ?? DEFAULT_TEMPLATE_KIND;
    const fields = TEMPLATE_KIND_FIELDS[kind];
    for (const field of fields.required) {
      if (!Object.hasOwn(template, field)) fail(index, field, `šablóna druhu '${kind}' vyžaduje pole`);
    }
    for (const field of fields.forbidden) {
      if (Object.hasOwn(template, field)) fail(index, field, `šablóna druhu '${kind}' toto pole nemá`);
    }
    if (!cargoTypes.has(template.cargoTypeId)) {
      fail(index, 'cargoTypeId', `neznámy typ nákladu '${template.cargoTypeId}' (známe: ${cargoTypes.items.map((item) => item.id).join(', ')})`);
    }
    const cargoType = cargoTypes.get(template.cargoTypeId);
    const category = cargoType.category;
    if ((template.sizeMix ?? 0) > 0 && category !== 'container') {
      fail(index, 'sizeMix', `zmes veľkostí (40′) má zmysel len pre kategóriu 'container', '${template.cargoTypeId}' je '${category}'`);
    }
    const priceField = TEMPLATE_KIND_PRICE_FIELD[kind];
    if (priceField !== undefined && !((cargoType[priceField] as number) > 0)) {
      fail(index, 'cargoTypeId', `šablóna druhu '${kind}' vyžaduje typ nákladu s ${priceField} > 0, '${cargoType.id}' má ${String(cargoType[priceField])}`);
    }
    let smallestCapacity = Number.POSITIVE_INFINITY;
    template.shipClassIds.forEach((shipClassId, shipIndex) => {
      if (!ships.has(shipClassId)) {
        fail(index, `shipClassIds/${String(shipIndex)}`, `neznáma trieda lode '${shipClassId}' (známe: ${ships.items.map((item) => item.id).join(', ')})`);
      }
      const ship = ships.get(shipClassId);
      if (!ship.cargoCategories.includes(category)) {
        fail(index, `shipClassIds/${String(shipIndex)}`, `loď '${shipClassId}' nevozí kategóriu '${category}' nákladu '${template.cargoTypeId}'`);
      }
      smallestCapacity = Math.min(smallestCapacity, ship.capacityUnits);
    });
    const maxVolume = template.volumeUnitsRange[1];
    if (maxVolume > smallestCapacity) {
      fail(index, 'volumeUnitsRange/1', `musí byť ≤ najmenšia kapacita lodí šablóny (${String(smallestCapacity)}), dostal ${String(maxVolume)}`);
    }
    const maxExport = template.exportVolumeUnitsRange?.[1];
    if (maxExport !== undefined && maxExport > smallestCapacity) {
      fail(index, 'exportVolumeUnitsRange/1', `musí byť ≤ najmenšia kapacita lodí šablóny (${String(smallestCapacity)}), dostal ${String(maxExport)}`);
    }
  });
}

/**
 * Krížová kontrola `economy.json` × `logistics.json` (F6a, ADR-032 bod 6): okno príchodov exportu pred loďou
 * (`exportFlow.arrivalWindowDays` × 24 h) musí presiahnuť `cutoffHours`, inak by okno `[príchod lode − okno, cut-off]`
 * bolo prázdne a plán príchodov by nemal z čoho losovať. Chyba patrí `logistics.json`.
 */
function checkExportWindow(economy: Readonly<EconomyDef>, logistics: Readonly<LogisticsDef>): void {
  const windowHours = logistics.exportFlow.arrivalWindowDays * HOURS_PER_DAY;
  if (windowHours > economy.cutoffHours) return;
  failWith('logistics', {
    path: '/exportFlow/arrivalWindowDays',
    message: `okno príchodov (${String(windowHours)} h) musí byť > economy.cutoffHours (${String(economy.cutoffHours)}) — okno pred cut-off by bolo prázdne, dostal ${String(logistics.exportFlow.arrivalWindowDays)}`,
  });
}

// ---------------------------------------------------------------------------------------------------------
// DefRegistry
// ---------------------------------------------------------------------------------------------------------

/** Surové (nevalidované) defy, napr. rovno z `JSON.parse`/JSON importu. Chýbajúci def → `DefError`. */
export type RawDefs = { readonly [K in DefName]?: unknown };

export class DefRegistry {
  private constructor(
    private readonly timeDef: Readonly<TimeDef>,
    private readonly economyDef: Readonly<EconomyDef>,
    private readonly infrastructureDef: Readonly<InfrastructureDef>,
    private readonly cargoTypesCatalog: Catalog<Readonly<CargoTypeDef>>,
    private readonly modulesCatalog: Catalog<Readonly<ModuleDef>>,
    private readonly shipsCatalog: Catalog<Readonly<ShipClassDef>>,
    private readonly vehiclesCatalog: Catalog<Readonly<VehicleDef>>,
    private readonly trucksCatalog: Catalog<Readonly<TruckDef>>,
    private readonly logisticsDef: Readonly<LogisticsDef>,
    private readonly contractTemplatesCatalog: Catalog<Readonly<ContractTemplateDef>>,
    private readonly linesCatalog: Catalog<Readonly<LineDef>>,
    private readonly containerTypesCatalog: Catalog<Readonly<ContainerTypeDef>>,
  ) {}

  /**
   * Zvaliduje surové defy (fail-fast, `DefError`) a zostaví register so zmrazenými objektmi. Po jednotlivých defoch
   * krížové kontroly medzi nimi (`checkRampTrucks`, `checkContractTemplates`).
   */
  static fromRaw(raw: RawDefs): DefRegistry {
    const time = validateDef<TimeDef>('time', raw.time, DEF_FIELDS.time);
    const economy = validateDef<EconomyDef>('economy', raw.economy, DEF_FIELDS.economy, checkEconomy);
    const infrastructure = validateDef<InfrastructureDef>('infrastructure', raw.infrastructure, DEF_FIELDS.infrastructure, checkInfrastructure);
    const cargoTypes = validateCatalog<CargoTypeDef>('cargo_types', raw.cargo_types, { fields: CARGO_TYPE_FIELDS });
    const modules = validateCatalog<ModuleDef>('modules', raw.modules, { fields: MODULE_FIELDS, extraKeys: ['params'], check: checkModuleItem });
    const ships = validateCatalog<ShipClassDef>('ships', raw.ships, { fields: SHIP_CLASS_FIELDS });
    const vehicles = validateCatalog<VehicleDef>('vehicles', raw.vehicles, { fields: VEHICLE_FIELDS });
    const trucks = validateCatalog<TruckDef>('trucks', raw.trucks, { fields: TRUCK_FIELDS });
    const logistics = validateDef<LogisticsDef>('logistics', raw.logistics, DEF_FIELDS.logistics, checkLogistics);
    const contractTemplates = validateCatalog<ContractTemplateDef>('contract_templates', raw.contract_templates, { fields: CONTRACT_TEMPLATE_FIELDS });
    const lines = validateCatalog<LineDef>('lines', raw.lines, { fields: LINE_FIELDS });
    const containerTypes = validateCatalog<ContainerTypeDef>('container_types', raw.container_types, { fields: CONTAINER_TYPE_FIELDS, check: checkContainerType });
    checkExportWindow(economy, logistics);
    checkRampTrucks(modules, trucks);
    checkContractTemplates(contractTemplates, cargoTypes, ships);
    return new DefRegistry(time, economy, infrastructure, cargoTypes, modules, ships, vehicles, trucks, logistics, contractTemplates, lines, containerTypes);
  }

  /** `time.json` (ARCHITECTURE §3); použiteľný priamo ako `SimClockConfig`. */
  get time(): Readonly<TimeDef> {
    return this.timeDef;
  }

  /** `economy.json` (ARCHITECTURE §4.6). */
  get economy(): Readonly<EconomyDef> {
    return this.economyDef;
  }

  /** `infrastructure.json` (ARCHITECTURE §4.6, ADR-010, ADR-020): cena a údržba cesty a koľaje za bunku, typy ciest. */
  get infrastructure(): Readonly<InfrastructureDef> {
    return this.infrastructureDef;
  }

  /** `cargo_types.json` (§4.1): typy nákladu. */
  get cargoTypes(): Catalog<Readonly<CargoTypeDef>> {
    return this.cargoTypesCatalog;
  }

  /**
   * `modules.json` (§4.2, §5.3): moduly; typované parametre cez `berthParams(def)` / `craneParams(def)` /
   * `storageParams(def)` / `depotParams(def)` / `gateParams(def)` / `waitingAreaParams(def)` / `rampParams(def)`.
   */
  get modules(): Catalog<Readonly<ModuleDef>> {
    return this.modulesCatalog;
  }

  /** `ships.json` (§4.3): triedy lodí. */
  get ships(): Catalog<Readonly<ShipClassDef>> {
    return this.shipsCatalog;
  }

  /** `vehicles.json` (§4.4): interné vozidlá (straddle carrier, …). */
  get vehicles(): Catalog<Readonly<VehicleDef>> {
    return this.vehiclesCatalog;
  }

  /** `trucks.json` (§4.2, §7.5; F4): kamióny, ktoré odvážajú náklad z rampy. */
  get trucks(): Catalog<Readonly<TruckDef>> {
    return this.trucksCatalog;
  }

  /** `contract_templates.json` (§4.6, §9.1; F5): šablóny, z ktorých pool generuje ponuky kontraktov. */
  get contractTemplates(): Catalog<Readonly<ContractTemplateDef>> {
    return this.contractTemplatesCatalog;
  }

  /** `lines.json` (§4, F6c, ADR-034): námorné linky — vlastníci kontajnerov a odosielatelia voyage. */
  get lines(): Catalog<Readonly<LineDef>> {
    return this.linesCatalog;
  }

  /** `container_types.json` (docs/TERMINAL_2.md §3, ADR-039): typy kontajnerov (R2 len `dry`); `CargoUnit.containerType` je ich `id`. */
  get containerTypes(): Catalog<Readonly<ContainerTypeDef>> {
    return this.containerTypesCatalog;
  }

  /** `logistics.json` (§4.6, ADR-010): vnútorný čas v moduloch, opakovanie hľadania cesty, konštanty kongescie. */
  get logistics(): Readonly<LogisticsDef> {
    return this.logisticsDef;
  }
}

/** Načíta defy zabalené v `data/defs/` (statické JSON importy, bez `fs`) a zvaliduje ich. */
export function loadBundledDefs(): DefRegistry {
  return DefRegistry.fromRaw({
    time: timeJson,
    economy: economyJson,
    infrastructure: infrastructureJson,
    cargo_types: cargoTypesJson,
    modules: modulesJson,
    ships: shipsJson,
    vehicles: vehiclesJson,
    trucks: trucksJson,
    logistics: logisticsJson,
    contract_templates: contractTemplatesJson,
    lines: linesJson,
    container_types: containerTypesJson,
  });
}
