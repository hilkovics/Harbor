/**
 * Pravidlá špecifické pre `modules.json`: typované `params` podľa `kind` (`MODULE_PARAM_SPECS`, tabuľka — nie `switch`),
 * typované gettery `berthParams` / `craneParams` / `storageParams` / `depotParams` a kontroly vzťahov medzi poľami modulu (konektor vo footprinte,
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
  MODULE_KINDS,
  type BerthParams,
  type CraneParams,
  type DepotParams,
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
  },
  crane: {
    // Cyklus sa delí na dve fázy (grabbing ⌊c/2⌋, placing c − ⌊c/2⌋, §7.2), každá musí mať aspoň jeden tick.
    cycleTicks: { kind: 'integer', min: 2 },
    category: { kind: 'enum', values: CARGO_CATEGORIES },
  },
  storage: {
    capacityUnits: { kind: 'integer', min: 1 },
    category: { kind: 'enum', values: CARGO_CATEGORIES },
    // Vnútorný čas vozidla v module (§7.3 bod 4); chýba = `logistics.defaultInternalTicks`.
    internalTicks: { kind: 'integer', min: 0, optional: true },
  },
  gate: {},
  waiting_area: {},
  ramp: {},
  depot: {
    capacity: { kind: 'integer', min: 1 },
    internalTicks: { kind: 'integer', min: 0, optional: true },
  },
  rail_station: {},
  pipeline: {},
};

/** `params` zodpovedá tabuľke druhu: presne jej kľúče, správne typy a rozsahy. Prvý problém alebo `undefined`. */
export function checkModuleParams(value: unknown, kind: ModuleKind, path: string): Problem | undefined {
  const table: FieldRecord = MODULE_PARAM_SPECS[kind];
  if (!isPlainObject(value)) return { path, message: `očakávaný objekt, dostal ${describeValue(value)}` };
  return findUnknownKey(value, new Set(Object.keys(table)), path) ?? checkFields(value, table, path);
}

/** Číselný rozmer footprintu alebo súradnica konektora z neoverenej položky; inak `undefined`. */
function numberAt(source: unknown, key: string): number | undefined {
  if (!isPlainObject(source)) return undefined;
  const value = source[key];
  return typeof value === 'number' ? value : undefined;
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
  return checkModuleParams(item['params'], kind, paramsPath);
}

// ---------------------------------------------------------------------------------------------------------
// Typované gettery — sim nečíta `params['x'] as number`.
// ---------------------------------------------------------------------------------------------------------

const isBerthParams = (value: unknown): value is BerthParams => matchesFields(value, MODULE_PARAM_SPECS.berth);
const isCraneParams = (value: unknown): value is CraneParams => matchesFields(value, MODULE_PARAM_SPECS.crane);
const isStorageParams = (value: unknown): value is StorageParams => matchesFields(value, MODULE_PARAM_SPECS.storage);
const isDepotParams = (value: unknown): value is DepotParams => matchesFields(value, MODULE_PARAM_SPECS.depot);

// Defy sú zmrazené a po validácii nemenné, takže overený výsledok sa dá uložiť podľa identity `params`.
const berthParamsCache = new WeakMap<ModuleParams, BerthParams>();
const craneParamsCache = new WeakMap<ModuleParams, CraneParams>();
const storageParamsCache = new WeakMap<ModuleParams, StorageParams>();
const depotParamsCache = new WeakMap<ModuleParams, DepotParams>();

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
