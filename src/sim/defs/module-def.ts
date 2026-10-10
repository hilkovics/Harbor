/**
 * Pravidlá špecifické pre `modules.json`: typované `params` podľa `kind` (`MODULE_PARAM_SPECS`, tabuľka — nie `switch`),
 * typované gettery `berthParams` / `craneParams` / `storageParams` / `depotParams` / `gateParams` / `preGateParams` / `holdingParams` a kontroly vzťahov medzi poľami modulu (konektor vo footprinte,
 * berth vyžaduje `waterSide`). Nový druh modulu s parametrami = nový typ v `ModuleParamsByKind` + riadok v tabuľke.
 */
import { DefError } from './def-error';
import {
  checkFields,
  describeValue,
  findUnknownKey,
  isPlainObject,
  matchesFields,
  pointerSegment,
  type FieldRecord,
  type Problem,
  type SpecTable,
} from './def-spec';
import {
  CARGO_CATEGORIES,
  GATE_DIRECTIONS,
  HANDOVER_MODES,
  MODULE_KINDS,
  STORAGE_ROLES,
  type BerthParams,
  type CraneParams,
  type DepotParams,
  type GateDirection,
  type GateParams,
  type HoldingParams,
  type PreGateParams,
  type ModuleDef,
  type ModuleKind,
  type ModuleParams,
  type ModuleParamsByKind,
  type StorageParams,
} from './types';

/** Tvar `params` pre každý druh modulu; kompilátor ohlási druh bez riadku aj riadok s nesprávnymi poľami. */
export const MODULE_PARAM_SPECS: { readonly [K in ModuleKind]: SpecTable<ModuleParamsByKind[K]> } = {
  berth: {
    depthClass: { kind: 'integer', min: 1, max: 3 },
    apronSlots: { kind: 'integer', min: 1 },
    maxCranes: { kind: 'integer', min: 1 },
    frontWaterCells: { kind: 'integer', min: 1 },
    // Rezerva apronu pre opačný smer (F6a, ADR-032 bod 10); horná hranica `⌊apronSlots / 2⌋` je vzťah polí (`checkBerthParams`).
    apronReserveSlots: { kind: 'integer', min: 0 },
    // Odovzdávanie žeriav ↔ vozidlo (F6a, ADR-033): režim a buffer apronu na žeriav (vzťah `craneBufferSlots × maxCranes ≤ apronSlots` je v `checkBerthParams`).
    handoverMode: { kind: 'enum', values: HANDOVER_MODES },
    craneBufferSlots: { kind: 'integer', min: 0, max: 1 },
  },
  crane: {
    // Cyklus sa delí na dve fázy (grabbing ⌊c/2⌋, placing c − ⌊c/2⌋, §7.2), každá musí mať aspoň jeden tick.
    cycleTicks: { kind: 'integer', min: 2 },
    category: { kind: 'enum', values: CARGO_CATEGORIES },
    // Denná mzda obsluhy (§9.2, F5); strhne sa pri DayClosed spolu s mzdami vozidiel.
    wagePerDayCents: { kind: 'integer', min: 0 },
    // Dual cycling (F6a, ADR-032 bod 11): 1 = dvojcyklus je zadarmo, 2 = žiadny prínos oproti dvom cyklom.
    dualCycleFactor: { kind: 'number', min: 1, max: 2 },
  },
  storage: {
    capacityUnits: { kind: 'integer', min: 1 },
    category: { kind: 'enum', values: CARGO_CATEGORIES },
    // Vnútorný čas vozidla v module (§7.3 bod 4); chýba = `logistics.defaultInternalTicks`.
    internalTicks: { kind: 'integer', min: 0, optional: true },
    // Rola skladu a počet opráv (F6c, ADR-034); vzťah `role` ↔ `repairBays` ↔ kategória je v `checkStorageParams`.
    role: { kind: 'enum', values: STORAGE_ROLES, optional: true },
    repairBays: { kind: 'integer', min: 1, optional: true },
    // Geometria bloku so stohmi (ADR-039); všetky tri naraz alebo žiadne je v `checkStorageParams`.
    bays: { kind: 'integer', min: 1, optional: true },
    rows: { kind: 'integer', min: 1, optional: true },
    maxTier: { kind: 'integer', min: 1, optional: true },
    // RTG blok (R3, ADR-040 bod 2): stĺpec jednosmerného pruhu a rozstup TP; povinné práve pri `role: 'rtg_block'` (`checkStorageParams`).
    laneCol: { kind: 'integer', min: 0, optional: true },
    tpSpacingBays: { kind: 'integer', min: 1, optional: true },
    // Zásuvky pre reefery (R5, ADR-042): počet radov od radu 0 so zásuvkou (pri každej vrstve); len RTG blok, najviac `rows` (`checkStorageParams`).
    plugRows: { kind: 'integer', min: 1, optional: true },
    // OOG plocha (R5, ADR-042 TR5-02): blok prijíma len OOG a obsluhuje ho reach stacker; len RTG blok s jednou vrstvou (`checkStorageParams`).
    acceptsOog: { kind: 'boolean', optional: true },
    // Železničný terminál (R6, ADR-043): prvý stĺpec koľají a ich počet; povinné práve pri `role: 'rail_terminal'` (`checkStorageParams`).
    trackCol: { kind: 'integer', min: 0, optional: true },
    tracks: { kind: 'integer', min: 1, optional: true },
  },
  gate: {
    // Pruh brány (R4, ADR-041 bod 1): smer, kroky podľa smeru (vzťah polí v `checkGateParams`), šance cez `Rng`, režim `express`.
    direction: { kind: 'enum', values: GATE_DIRECTIONS },
    ocrTicks: { kind: 'integer', min: 1, optional: true },
    checkTicks: { kind: 'integer', min: 1, optional: true },
    issueTicks: { kind: 'integer', min: 1, optional: true },
    gateIssueChance: { kind: 'number', min: 0, max: 1, optional: true },
    troubleTicks: { kind: 'integer', min: 1, optional: true },
    weighTicks: { kind: 'integer', min: 1, optional: true },
    scanTicks: { kind: 'integer', min: 1, optional: true },
    sealTicks: { kind: 'integer', min: 1, optional: true },
    sealIssueChance: { kind: 'number', min: 0, max: 1, optional: true },
    inspectionTicks: { kind: 'integer', min: 1, optional: true },
    expressTicks: { kind: 'integer', min: 1 },
    wagePerDayCents: { kind: 'integer', min: 0, optional: true },
    internalTicks: { kind: 'integer', min: 0, optional: true },
  },
  pre_gate: {
    rows: { kind: 'integer', min: 1 },
    rowCapacity: { kind: 'integer', min: 1 },
  },
  holding: {
    stalls: { kind: 'integer', min: 1 },
    stallLengthCells: { kind: 'integer', min: 1 },
  },
  depot: {
    capacity: { kind: 'integer', min: 1 },
    internalTicks: { kind: 'integer', min: 0, optional: true },
  },
  rail_station: {},
  pipeline: {},
};

/**
 * Vzťah polí kotviska: rezerva apronu pre opačný smer je najviac polovica slotov (`apronReserveSlots ≤ ⌊apronSlots / 2⌋`,
 * ADR-032 bod 10) — inak by sa dva smery o apron neposkytli rovnako a import s exportom by sa navzájom zablokovali.
 * `params` už prešli tabuľkou polí.
 */
function checkBerthParams(params: Readonly<Record<string, unknown>>, path: string): Problem | undefined {
  const slots = params['apronSlots'];
  const reserve = params['apronReserveSlots'];
  if (typeof slots === 'number' && typeof reserve === 'number' && reserve > Math.floor(slots / 2)) {
    return { path: `${path}/apronReserveSlots`, message: `musí byť ≤ ⌊apronSlots / 2⌋ (${String(Math.floor(slots / 2))}), dostal ${String(reserve)}` };
  }
  const buffer = params['craneBufferSlots'];
  const cranes = params['maxCranes'];
  if (typeof slots === 'number' && typeof buffer === 'number' && typeof cranes === 'number' && buffer * cranes > slots) {
    return { path: `${path}/craneBufferSlots`, message: `craneBufferSlots × maxCranes (${String(buffer * cranes)}) musí byť ≤ apronSlots (${String(slots)})` };
  }
  return undefined;
}

/** Polia krokov podľa smeru pruhu brány (R4, ADR-041 bod 1): každý smer má presne svoje (tabuľka, nie switch). */
const GATE_DIRECTION_FIELDS: { readonly [D in GateDirection]: readonly string[] } = {
  in: ['ocrTicks', 'checkTicks', 'issueTicks', 'gateIssueChance', 'troubleTicks'],
  out: ['weighTicks', 'scanTicks', 'sealTicks', 'sealIssueChance', 'inspectionTicks'],
};

/** Vzťah polí pruhu brány: polia svojho smeru sú povinné, polia opačného smeru sú chyba. `params` už prešli tabuľkou polí. */
function checkGateParams(params: Readonly<Record<string, unknown>>, path: string): Problem | undefined {
  const direction = params['direction'];
  if (direction !== 'in' && direction !== 'out') return undefined;
  const other: GateDirection = direction === 'in' ? 'out' : 'in';
  const missing = GATE_DIRECTION_FIELDS[direction].find((key) => params[key] === undefined);
  if (missing !== undefined) return { path: `${path}/${missing}`, message: `pruh smeru '${direction}' vyžaduje ${missing}` };
  const foreign = GATE_DIRECTION_FIELDS[other].find((key) => params[key] !== undefined);
  if (foreign !== undefined) return { path: `${path}/${foreign}`, message: `${foreign} patrí pruhu smeru '${other}', nie '${direction}'` };
  return undefined;
}

/** Polia geometrie bloku so stohmi v `params` skladu (ADR-039): buď všetky, alebo žiadne. */
const STORAGE_GEOMETRY_KEYS = ['bays', 'rows', 'maxTier'] as const;

/**
 * Vzťah polí skladu (F6c, ADR-034): depo prázdnych (`role: 'empty_depot'`) je sklad kontajnerov a vyžaduje `repairBays`;
 * `repairBays` bez roly depa nemá zmysel; geometria bloku (ADR-039) je celá alebo žiadna. `params` už prešli tabuľkou polí.
 */
function checkStorageParams(params: Readonly<Record<string, unknown>>, path: string): Problem | undefined {
  const { role, repairBays, category } = params;
  const hasLane = role === 'rtg_block' || role === 'rail_terminal';
  const lane = ['laneCol', 'tpSpacingBays'].find((key) => hasLane !== (params[key] !== undefined));
  if (lane !== undefined) {
    return { path: `${path}/${lane}`, message: hasLane ? `blok s pruhom (role ${String(role)}) vyžaduje ${lane}` : `${lane} má zmysel len pri role rtg_block alebo rail_terminal` };
  }
  const track = ['trackCol', 'tracks'].find((key) => (role === 'rail_terminal') !== (params[key] !== undefined));
  if (track !== undefined) {
    return { path: `${path}/${track}`, message: role === 'rail_terminal' ? `železničný terminál (role rail_terminal) vyžaduje ${track}` : `${track} má zmysel len pri role rail_terminal` };
  }
  if (role === 'rail_terminal' && (params['plugRows'] !== undefined || params['acceptsOog'] !== undefined)) {
    return { path: `${path}/${params['plugRows'] !== undefined ? 'plugRows' : 'acceptsOog'}`, message: 'železničný terminál nemá zásuvky ani OOG plochu' };
  }
  if (params['plugRows'] !== undefined) {
    if (role !== 'rtg_block') return { path: `${path}/plugRows`, message: 'plugRows (zásuvky pre reefery) má zmysel len pri role rtg_block' };
    if (typeof params['rows'] === 'number' && (params['plugRows'] as number) > params['rows']) {
      return { path: `${path}/plugRows`, message: `plugRows (${String(params['plugRows'])}) musí byť ≤ rows (${String(params['rows'])})` };
    }
  }
  if (params['acceptsOog'] !== undefined) {
    if (role !== 'rtg_block') return { path: `${path}/acceptsOog`, message: 'acceptsOog (OOG plocha) má zmysel len pri role rtg_block' };
    if (params['maxTier'] !== 1) return { path: `${path}/maxTier`, message: 'OOG plocha (acceptsOog) je len na zem: maxTier musí byť 1' };
    if (params['plugRows'] !== undefined) return { path: `${path}/plugRows`, message: 'OOG plocha (acceptsOog) nemá zásuvky' };
  }
  const geometry = STORAGE_GEOMETRY_KEYS.filter((key) => params[key] !== undefined);
  if (geometry.length > 0 && geometry.length < STORAGE_GEOMETRY_KEYS.length) {
    const missing = STORAGE_GEOMETRY_KEYS.find((key) => params[key] === undefined) as string;
    return { path: `${path}/${missing}`, message: `geometria bloku (${STORAGE_GEOMETRY_KEYS.join(', ')}) musí byť zadaná celá, chýba ${missing}` };
  }
  if (role === 'rtg_block' || role === 'rail_terminal') {
    if (category !== 'container') return { path: `${path}/category`, message: `RTG blok (role rtg_block) skladuje kontajnery — kategória musí byť 'container', dostal ${describeValue(category)}` };
    if (geometry.length < STORAGE_GEOMETRY_KEYS.length) return { path: `${path}/bays`, message: 'RTG blok (role rtg_block) vyžaduje geometriu bloku (bays, rows, maxTier)' };
    if (repairBays !== undefined) return { path: `${path}/repairBays`, message: 'repairBays má zmysel len pri role empty_depot' };
    return undefined;
  }
  if (role === 'empty_depot') {
    if (category !== 'container') return { path: `${path}/category`, message: `depo prázdnych (role empty_depot) skladuje kontajnery — kategória musí byť 'container', dostal ${describeValue(category)}` };
    if (repairBays === undefined) return { path: `${path}/repairBays`, message: 'depo prázdnych (role empty_depot) vyžaduje repairBays' };
    return undefined;
  }
  if (repairBays !== undefined) return { path: `${path}/repairBays`, message: 'repairBays má zmysel len pri role empty_depot' };
  return undefined;
}

/** `params` zodpovedá tabuľke druhu: presne jej kľúče, správne typy a rozsahy (+ vzťahy polí kotviska a skladu). Prvý problém alebo `undefined`. */
export function checkModuleParams(value: unknown, kind: ModuleKind, path: string): Problem | undefined {
  const table: FieldRecord = MODULE_PARAM_SPECS[kind];
  if (!isPlainObject(value)) return { path, message: `očakávaný objekt, dostal ${describeValue(value)}` };
  const problem = findUnknownKey(value, new Set(Object.keys(table)), path) ?? checkFields(value, table, path);
  if (problem !== undefined) return problem;
  if (kind === 'berth') return checkBerthParams(value, path);
  if (kind === 'gate') return checkGateParams(value, path);
  return kind === 'storage' ? checkStorageParams(value, path) : undefined;
}

/** Číselný rozmer footprintu alebo súradnica konektora z neoverenej položky; inak `undefined`. */
function numberAt(source: unknown, key: string): number | undefined {
  if (!isPlainObject(source)) return undefined;
  const value = source[key];
  return typeof value === 'number' ? value : undefined;
}

/** RTG blok: pruh leží vo footprinte (`laneCol < w`) a pozdĺž bloku je pre každý bay jedna bunka pruhu (`bays ≤ h`). `params` už prešli tabuľkou polí. */
function checkRtgFootprint(params: unknown, w: number | undefined, h: number | undefined, path: string): Problem | undefined {
  if (!isPlainObject(params) || (params['role'] !== 'rtg_block' && params['role'] !== 'rail_terminal') || w === undefined || h === undefined) return undefined;
  const { laneCol, bays, trackCol, tracks } = params;
  if (typeof trackCol === 'number' && typeof tracks === 'number') {
    if (trackCol + tracks > w) return { path: `${path}/tracks`, message: `koľaje (stĺpce ${String(trackCol)} … ${String(trackCol + tracks - 1)}) ležia mimo footprintu ${String(w)}×${String(h)}` };
    if (typeof laneCol === 'number' && laneCol >= trackCol && laneCol < trackCol + tracks) return { path: `${path}/laneCol`, message: `pruh pre ťahače (stĺpec ${String(laneCol)}) leží na koľaji` };
  }
  if (typeof laneCol === 'number' && laneCol >= w) return { path: `${path}/laneCol`, message: `pruh (stĺpec ${String(laneCol)}) leží mimo footprintu ${String(w)}×${String(h)}` };
  if (typeof bays === 'number' && bays > h) return { path: `${path}/bays`, message: `bays (${String(bays)}) musí byť ≤ dĺžke footprintu (${String(h)}) — každý bay má bunku pruhu` };
  return undefined;
}

/**
 * Vzťahy medzi poľami položky `modules.json`, ktoré už prešla tabuľkou polí (poradie: `placement`, `connectors`, `params`):
 * - berth vyžaduje `placement.waterSide` (bez neho nevie, ktorou hranou sedí na vode);
 * - každý konektor leží vo footprinte (pri rotácii 0°);
 * - `params` zodpovedá `MODULE_PARAM_SPECS[kind]`.
 */
export function checkModuleItem(item: Readonly<Record<string, unknown>>, path: string): Problem | undefined {
  const kind = MODULE_KINDS.find((candidate) => candidate === item['kind']);
  if (kind === undefined) return { path: `${path}/kind`, message: `neznámy druh modulu ${describeValue(item['kind'])}` };

  const placement = item['placement'];
  if (kind === 'berth' && !(isPlainObject(placement) && Object.hasOwn(placement, 'waterSide'))) {
    return { path: `${path}/placement/waterSide`, message: 'berth vyžaduje waterSide (strana dlhej hrany pri vode)' };
  }

  const w = numberAt(item['footprint'], 'w');
  const h = numberAt(item['footprint'], 'h');
  const connectors = item['connectors'];
  if (w !== undefined && h !== undefined && Array.isArray(connectors)) {
    for (const [index, connector] of connectors.entries()) {
      const x = numberAt(connector, 'x');
      const y = numberAt(connector, 'y');
      if (x !== undefined && y !== undefined && (x >= w || y >= h)) {
        return {
          path: `${path}/connectors${pointerSegment(index)}`,
          message: `konektor (${String(x)}, ${String(y)}) leží mimo footprintu ${String(w)}×${String(h)}`,
        };
      }
    }
  }

  const paramsPath = `${path}/params`;
  if (!Object.hasOwn(item, 'params')) return { path: paramsPath, message: 'chýba povinné pole' };
  const problem = checkModuleParams(item['params'], kind, paramsPath);
  return problem ?? checkRtgFootprint(item['params'], w, h, paramsPath);
}

// ---------------------------------------------------------------------------------------------------------
// Typované gettery — sim nečíta `params['x'] as number`.
// ---------------------------------------------------------------------------------------------------------

const isBerthParams = (value: unknown): value is BerthParams => matchesFields(value, MODULE_PARAM_SPECS.berth);
const isCraneParams = (value: unknown): value is CraneParams => matchesFields(value, MODULE_PARAM_SPECS.crane);
const isStorageParams = (value: unknown): value is StorageParams => matchesFields(value, MODULE_PARAM_SPECS.storage);
const isDepotParams = (value: unknown): value is DepotParams => matchesFields(value, MODULE_PARAM_SPECS.depot);
const isGateParams = (value: unknown): value is GateParams => matchesFields(value, MODULE_PARAM_SPECS.gate);
const isPreGateParams = (value: unknown): value is PreGateParams => matchesFields(value, MODULE_PARAM_SPECS.pre_gate);
const isHoldingParams = (value: unknown): value is HoldingParams => matchesFields(value, MODULE_PARAM_SPECS.holding);

// Defy sú zmrazené a po validácii nemenné, takže overený výsledok sa dá uložiť podľa identity `params`.
const berthParamsCache = new WeakMap<ModuleParams, BerthParams>();
const craneParamsCache = new WeakMap<ModuleParams, CraneParams>();
const storageParamsCache = new WeakMap<ModuleParams, StorageParams>();
const depotParamsCache = new WeakMap<ModuleParams, DepotParams>();
const gateParamsCache = new WeakMap<ModuleParams, GateParams>();
const preGateParamsCache = new WeakMap<ModuleParams, PreGateParams>();
const holdingParamsCache = new WeakMap<ModuleParams, HoldingParams>();

function typedParams<K extends ModuleKind>(
  def: ModuleDef,
  kind: K,
  isParams: (value: unknown) => value is ModuleParamsByKind[K],
  cache: WeakMap<ModuleParams, ModuleParamsByKind[K]>,
): ModuleParamsByKind[K] {
  if (def.kind !== kind) {
    throw new DefError('modules', '/items', `modul '${def.id}' je druhu '${def.kind}', nie '${kind}' — parametre '${kind}' nemá`);
  }
  const cached = cache.get(def.params);
  if (cached !== undefined) return cached;
  const params: unknown = def.params;
  if (!isParams(params)) {
    throw new DefError('modules', '/items', `modul '${def.id}': params nezodpovedajú druhu '${kind}'`);
  }
  cache.set(def.params, params);
  return params;
}

/** Parametre kotviska; def iného druhu → `DefError`. */
export function berthParams(def: ModuleDef): BerthParams {
  return typedParams(def, 'berth', isBerthParams, berthParamsCache);
}

/** Parametre žeriava; def iného druhu → `DefError`. */
export function craneParams(def: ModuleDef): CraneParams {
  return typedParams(def, 'crane', isCraneParams, craneParamsCache);
}

/** Parametre skladu; def iného druhu → `DefError`. */
export function storageParams(def: ModuleDef): StorageParams {
  return typedParams(def, 'storage', isStorageParams, storageParamsCache);
}

/** Parametre depa vozidiel; def iného druhu → `DefError`. */
export function depotParams(def: ModuleDef): DepotParams {
  return typedParams(def, 'depot', isDepotParams, depotParamsCache);
}

/** Parametre brány kamiónov; def iného druhu → `DefError`. */
export function gateParams(def: ModuleDef): GateParams {
  return typedParams(def, 'gate', isGateParams, gateParamsCache);
}

/** Parametre predbránovej plochy; def iného druhu → `DefError`. */
export function preGateParams(def: ModuleDef): PreGateParams {
  return typedParams(def, 'pre_gate', isPreGateParams, preGateParamsCache);
}

/** Parametre odstavnej plochy kamiónov; def iného druhu → `DefError`. */
export function holdingParams(def: ModuleDef): HoldingParams {
  return typedParams(def, 'holding', isHoldingParams, holdingParamsCache);
}
