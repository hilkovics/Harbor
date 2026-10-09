/**
 * Pravidlá umiestnenia a odstránenia modulov (ARCHITECTURE §8 body 1–4, 7, 8; ADR-014, ADR-015) — jediný opis
 * pravidiel, ktorý zdieľajú:
 * - `PlaceModule.validate` / `RemoveModule.validate` — všetky porušenia naraz ako `ValidationReason` (ghost v UI);
 * - `World.create` — starter moduly mapy (rovnaké pravidlá ako `PlaceModule` okrem ceny);
 * - `World.addModule` / `World.removeModule` — poistka konzistencie sveta: prvé štrukturálne porušenie
 *   (`PLACEMENT_RULE_ERROR` ≠ `null`) → `ModuleError` bez zmeny stavu (aj pri obnove zo save).
 *
 * Funkcie sú čisté: svet len čítajú, nič nemenia a nespotrebujú `Rng`. Pravidlo = riadok tabuľky (`PLACEMENT_CHECKS`,
 * `REMOVAL_CHECKS`), nie `switch` podľa druhu modulu; ktoré pravidlá sa modulu týkajú, určuje jeho def
 * (`placement.mustAttachTo`, `placement.waterSide`, `placement.requiresParcelOwnership`).
 *
 * Pravidlá umiestnenia (bunky mimo mapy hlási len `out_of_bounds`, ostatné pravidlá čítajú bunky v mape):
 * - `out_of_bounds` — bunka footprintu mimo mapy;
 * - `terrain` — terén bunky nie je v `placement.requiredTerrain`;
 * - `occupied` — bunku zaberá iný modul (len modul, ktorý si bunky nárokuje; pripájaný modul stojí na hostiteľovi);
 * - `road` — na bunke je cesta alebo koľaj;
 * - `parcel_not_owned` — pri `requiresParcelOwnership` bunka nie je na parcele `owned`/`leased` (ADR-008);
 * - `no_water_side` — kotvisko: bunka hrany pri vode (`waterSide` po rotácii) nesusedí s vodou;
 * - `water_blocked` — kotvisko: pás `frontWaterCells` pred hranou (pre bunky hrany, ktoré s vodou susedia) nie je celý
 *   v mape a vo vode, zasahuje do footprintu modulu, do pásu kotviska s inou `waterSide` (pásy kotvísk s rovnakou
 *   `waterSide` ležia vedľa seba a nekonfliktujú) alebo do obdĺžnika lode v stave s `blocksBerthWater`
 *   (`berthing`/`docked`/`undocking`, ADR-016);
 * - `no_berth` — pripájaný modul (`mustAttachTo`, žeriav): bunky v mape neležia všetky na jednom module
 *   povoleného druhu (berth);
 * - `rotation_mismatch`, `max_cranes`, `crane_overlap` — pripájaný modul na jednom berthe: iná rotácia než berth,
 *   berth má `params.maxCranes` žeriavov, prekryv s iným žeriavom berthu (ADR-014);
 * - `connector_blocked` — §8 bod 5 (ADR-017): modul s konektormi typu `road` (berth, sklad, depo…) musí mať aspoň
 *   jeden, ktorého vonkajšia bunka má cestu alebo je voľná pre cestu (`isOutsideUsable`: v mape, terén unesie cestu,
 *   bez modulu vrátane umiestňovaného, bez koľaje; parcela sa neoveruje). Modul bez cestných konektorov (žeriav) sa
 *   pravidlom neriadi. Pravidlo hráča — obnova save ho neoveruje (okolie sa medzitým mohlo zastavať).
 *
 * Pravidlá odstránenia: `has_cargo` (náklad v module alebo rezervované miesto — slot apronu/skladu, staging dock rampy;
 * `Module.cargoReservations()`, ADR-022),
 * `has_cranes`, `has_vehicles` (depo, ktorému patria vozidlá, ADR-017; kotvisko s jazdným nábrežím pod hákom, na ktorého bunkách stojí vozidlo
 * alebo vedie jeho trasa, F6d), `ship_docked` (kotvisko má loď v
 * `berthing`/`docked` — `dockedShipId`; pri žeriave kotvisko pod ním, inak by loď ostala pri kotvisku naveky
 * s nákladom, T02-14), `busy` (žeriav mimo `idle`/`blocked`).
 */
import type { CargoLedger } from '../cargo/cargo-ledger';
import type { EntityId } from '../core/entity-id';
import { berthParams } from '../defs/module-def';
import type { ModuleDef, Side } from '../defs/types';
import type { CellCoord, Grid } from '../grid/grid';
import type { Parcel } from '../grid/parcel';
import type { Rotation } from '../grid/rotation';
import { isWater } from '../grid/terrain';
import { BerthModule } from '../modules/berth-module';
import { CRANE_STATE_TRAITS, CraneModule } from '../modules/crane-module';
import type { Module } from '../modules/module';
import type { ModuleErrorCode } from '../modules/module-error';
import { SIDE_STEPS, connectorOutside, connectorsOf, edgeCells, footprintOf, waterSideOf } from '../modules/module-geometry';
import { VehicleDepot } from '../modules/vehicle-depot';
import { hasQuayLane } from '../logistics/quay-lanes';
import type { Ship } from '../ships/ship';
import { SHIP_STATE_TRAITS } from '../ships/ship-fsm';
import { shipCells } from '../ships/ship-route';
import { MODULE_CARGO_HOLDER_KINDS } from './cargo-holders';
import { isOutsideUsable } from './connectivity';

/** Porušenie pravidla: kód pravidla + popis prvého výskytu (do `ModuleError`, `MapError` a ladiacich správ). */
export interface RuleViolation<R extends string> {
  readonly rule: R;
  readonly detail: string;
}

// ---------------------------------------------------------------------------------------------------------
// Umiestnenie
// ---------------------------------------------------------------------------------------------------------

/** Pravidlá umiestnenia v poradí vyhodnotenia (= poradie porušení vo výsledku). */
export const PLACEMENT_RULES = [
  'out_of_bounds',
  'terrain',
  'occupied',
  'road',
  'parcel_not_owned',
  'no_water_side',
  'water_blocked',
  'no_berth',
  'rotation_mismatch',
  'max_cranes',
  'crane_overlap',
  'connector_blocked',
] as const;

export type PlacementRule = (typeof PLACEMENT_RULES)[number];

/**
 * Kód `ModuleError`, ktorým `World.addModule` odmietne porušenie (štrukturálna konzistencia sveta); `null` =
 * pravidlo hráča (terén, parcela, voda), ktoré overuje len príkaz a starter moduly, nie obnova zo save.
 */
export const PLACEMENT_RULE_ERROR: { readonly [R in PlacementRule]: ModuleErrorCode | null } = Object.freeze({
  out_of_bounds: 'out_of_bounds',
  terrain: null,
  occupied: 'occupied',
  road: 'road',
  parcel_not_owned: null,
  no_water_side: null,
  water_blocked: null,
  no_berth: 'no_berth',
  rotation_mismatch: 'rotation_mismatch',
  max_cranes: 'max_cranes',
  crane_overlap: 'crane_overlap',
  connector_blocked: null,
});

/** Časť sveta, ktorú pravidlá umiestnenia čítajú (`World` ju spĺňa). */
export interface PlacementWorld {
  readonly grid: Grid;
  readonly parcels: ReadonlyMap<string, Parcel>;
  readonly modules: ReadonlyMap<EntityId, Module>;
  readonly ships: ReadonlyMap<EntityId, Ship>;
}

/** Miesto modulu: ľavý horný roh footprintu po rotácii a rotácia. */
export interface PlacementSpec {
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
}

/** `all` = všetky pravidlá (príkaz, starter moduly); `structural` = len tie s `ModuleError` (`World.addModule`). */
export type PlacementScope = 'all' | 'structural';

/**
 * Modul sa pripája na hostiteľa (žeriav na berth, `placement.mustAttachTo`) a stojí na jeho bunkách, namiesto aby
 * si bunky nárokoval (ADR-014). Jediné miesto tohto rozhodnutia — `World.addModule` sa ním riadi tiež.
 */
export function attachesToHost(def: Readonly<ModuleDef>): boolean {
  return (def.placement.mustAttachTo?.length ?? 0) > 0;
}

/** Vyhodnotenie jedného umiestnenia; pomocné hodnoty sa počítajú najviac raz. */
interface PlacementContext {
  readonly world: PlacementWorld;
  readonly def: Readonly<ModuleDef>;
  readonly spec: PlacementSpec;
  /** Rozmery footprintu po rotácii. */
  readonly size: { readonly w: number; readonly h: number };
  /** Footprint po rotácii (row-major). */
  readonly cells: readonly CellCoord[];
  /** Bunky footprintu v mape. */
  readonly inside: readonly CellCoord[];
  readonly attaches: boolean;
  /** Strana pri vode po rotácii; `undefined` pre modul bez `placement.waterSide`. */
  readonly waterSide: Side | undefined;
  /** Hostiteľ pripájaného modulu (jediný berth povoleného druhu pod všetkými bunkami v mape) alebo dôvod, prečo nie je. */
  readonly host: BerthModule | string | undefined;
}

type PlacementCheck = (ctx: PlacementContext) => string | undefined;

function cellLabel({ x, y }: CellCoord): string {
  return `(${String(x)}, ${String(y)})`;
}

function ownsParcel(world: PlacementWorld, parcelId: string | null): boolean {
  if (parcelId === null) return false;
  const ownership = world.parcels.get(parcelId)?.ownership ?? 'none';
  return ownership !== 'none';
}

/**
 * Hostiteľ pripájaného modulu: všetky bunky v mape musia patriť jednému modulu druhu z `mustAttachTo`, ktorý je
 * kotviskom (žeriavy eviduje len `BerthModule.craneIds`). Vráti ho, alebo popis porušenia `no_berth`.
 */
function findHost(world: PlacementWorld, def: Readonly<ModuleDef>, inside: readonly CellCoord[]): BerthModule | string | undefined {
  if (inside.length === 0) return undefined;
  const allowed = def.placement.mustAttachTo ?? [];
  let hostId: EntityId | null = null;
  for (const cell of inside) {
    const moduleId = world.grid.at(cell.x, cell.y).moduleId;
    if (moduleId === null) return `bunka ${cellLabel(cell)} nestojí na module druhu [${allowed.join(', ')}]`;
    if (hostId !== null && moduleId !== hostId) return `bunky ležia na rôznych moduloch #${String(hostId)} a #${String(moduleId)}`;
    hostId = moduleId;
  }
  const host = hostId === null ? undefined : world.modules.get(hostId);
  if (!(host instanceof BerthModule) || !allowed.includes(host.kind)) {
    return `modul pod bunkami ${host?.label ?? `#${String(hostId)}`} nie je druhu [${allowed.join(', ')}]`;
  }
  return host;
}

/** Bunky pásov kotvísk s inou `waterSide` než `side` (index bunky → berth); pásy s rovnakou stranou nekonfliktujú. */
function foreignBands(world: PlacementWorld, side: Side): ReadonlyMap<number, BerthModule> {
  const owners = new Map<number, BerthModule>();
  for (const module of world.modules.values()) {
    if (!(module instanceof BerthModule) || module.waterSide === side) continue;
    for (const { x, y } of module.frontWaterBand) {
      if (world.grid.inBounds(x, y) && !owners.has(world.grid.index(x, y))) owners.set(world.grid.index(x, y), module);
    }
  }
  return owners;
}

/** Bunky obdĺžnikov lodí, ktoré blokujú vodu pred kotviskom (`SHIP_STATE_TRAITS.blocksBerthWater`): index bunky → loď. */
function shipWater(world: PlacementWorld): ReadonlyMap<number, Ship> {
  const owners = new Map<number, Ship>();
  for (const ship of world.ships.values()) {
    if (!SHIP_STATE_TRAITS[ship.state].blocksBerthWater) continue;
    for (const { x, y } of shipCells(ship)) {
      if (world.grid.inBounds(x, y) && !owners.has(world.grid.index(x, y))) owners.set(world.grid.index(x, y), ship);
    }
  }
  return owners;
}

/** Bunky hrany pri vode, ktoré sú v mape (hranu mimo mapy hlási `out_of_bounds`). */
function waterEdge(ctx: PlacementContext, side: Side): readonly CellCoord[] {
  return edgeCells({ x: ctx.spec.x, y: ctx.spec.y }, ctx.size, side).filter(({ x, y }) => ctx.world.grid.inBounds(x, y));
}

/** Susedná bunka `cell` o `distance` krokov cez stranu `side`. */
function stepFrom(cell: CellCoord, side: Side, distance: number): CellCoord {
  const { dx, dy } = SIDE_STEPS[side];
  return { x: cell.x + distance * dx, y: cell.y + distance * dy };
}

function isWaterCell(grid: Grid, cell: CellCoord): boolean {
  return grid.inBounds(cell.x, cell.y) && isWater(grid.at(cell.x, cell.y).terrain);
}

const checkWaterBand: PlacementCheck = (ctx) => {
  const side = ctx.waterSide;
  if (side === undefined) return undefined;
  const { grid } = ctx.world;
  const depth = berthParams(ctx.def).frontWaterCells;
  let owners: ReadonlyMap<number, BerthModule> | undefined;
  let ships: ReadonlyMap<number, Ship> | undefined;
  for (const edge of waterEdge(ctx, side)) {
    // Hrana bez vody je `no_water_side`; jej pás sa nehodnotí, aby sa jedna chyba nehlásila dvakrát.
    if (!isWaterCell(grid, stepFrom(edge, side, 1))) continue;
    for (let d = 1; d <= depth; d++) {
      const cell = stepFrom(edge, side, d);
      if (!grid.inBounds(cell.x, cell.y)) return `pás vody pred kotviskom: bunka ${cellLabel(cell)} je mimo mapy`;
      const target = grid.at(cell.x, cell.y);
      if (!isWater(target.terrain)) return `pás vody pred kotviskom: bunka ${cellLabel(cell)} nie je voda ('${target.terrain}')`;
      if (target.moduleId !== null) return `pás vody pred kotviskom: bunku ${cellLabel(cell)} zaberá modul #${String(target.moduleId)}`;
      owners ??= foreignBands(ctx.world, side);
      const other = owners.get(grid.index(cell.x, cell.y));
      if (other !== undefined) return `pás vody pred kotviskom: bunka ${cellLabel(cell)} leží v páse ${other.label} (strana '${other.waterSide}')`;
      ships ??= shipWater(ctx.world);
      const ship = ships.get(grid.index(cell.x, cell.y));
      if (ship !== undefined) return `pás vody pred kotviskom: bunku ${cellLabel(cell)} zaberá loď ${ship.label} (${ship.state})`;
    }
  }
  return undefined;
};

/**
 * §8 bod 5 (ADR-017): aspoň jeden konektor typu `road` má vonkajšiu bunku s cestou alebo voľnú pre cestu. Modul bez
 * cestných konektorov (žeriav) pravidlo nemá; konektory na bunkách mimo mapy sa nehodnotia (hlási ich `out_of_bounds`).
 */
const checkConnectors: PlacementCheck = (ctx) => {
  const { grid } = ctx.world;
  const roadConnectors = connectorsOf(ctx.def, ctx.spec.x, ctx.spec.y, ctx.spec.rotation).filter(
    (connector) => connector.type === 'road' && grid.inBounds(connector.x, connector.y),
  );
  if (roadConnectors.length === 0) return undefined;
  const { x, y } = ctx.spec;
  const { w, h } = ctx.size;
  const ownFootprint = (cx: number, cy: number): boolean => cx >= x && cy >= y && cx < x + w && cy < y + h;
  const outside = roadConnectors.map(connectorOutside);
  if (outside.some((cell) => isOutsideUsable(grid, cell, ownFootprint))) return undefined;
  return `žiadny cestný konektor nemá vonkajšiu bunku s cestou ani voľnú pre cestu (${outside.map(cellLabel).join(', ')})`;
};

/** Pravidlo → kontrola; vráti popis prvého porušenia alebo `undefined`. */
const PLACEMENT_CHECKS: { readonly [R in PlacementRule]: PlacementCheck } = {
  out_of_bounds: (ctx) => {
    const outside = ctx.cells.find(({ x, y }) => !ctx.world.grid.inBounds(x, y));
    if (outside === undefined) return undefined;
    return `bunka ${cellLabel(outside)} je mimo mapy ${String(ctx.world.grid.width)}×${String(ctx.world.grid.height)}`;
  },
  terrain: (ctx) => {
    const allowed = ctx.def.placement.requiredTerrain;
    const cell = ctx.inside.find(({ x, y }) => !allowed.includes(ctx.world.grid.at(x, y).terrain));
    if (cell !== undefined) return `bunka ${cellLabel(cell)} má terén '${ctx.world.grid.at(cell.x, cell.y).terrain}', povolené [${allowed.join(', ')}]`;
    // Kotvisko (TR3-02, ADR-040): riadok pri vode musí byť nábrežie; ostatné riadky (pruhy pod žeriavom, pevninská obchádzka) smú byť aj pevnina.
    if (ctx.waterSide === undefined) return undefined;
    const dry = waterEdge(ctx, ctx.waterSide).find(({ x, y }) => ctx.world.grid.inBounds(x, y) && ctx.world.grid.at(x, y).terrain !== 'quay');
    return dry === undefined ? undefined : `bunka hrany pri vode ${cellLabel(dry)} má terén '${ctx.world.grid.at(dry.x, dry.y).terrain}', musí byť 'quay'`;
  },
  occupied: (ctx) => {
    if (ctx.attaches) return undefined;
    const cell = ctx.inside.find(({ x, y }) => ctx.world.grid.at(x, y).moduleId !== null);
    return cell === undefined ? undefined : `bunka ${cellLabel(cell)} patrí modulu #${String(ctx.world.grid.at(cell.x, cell.y).moduleId)}`;
  },
  road: (ctx) => {
    const cell = ctx.inside.find(({ x, y }) => ctx.world.grid.at(x, y).road !== 'none');
    return cell === undefined ? undefined : `na bunke ${cellLabel(cell)} je '${ctx.world.grid.at(cell.x, cell.y).road}'`;
  },
  parcel_not_owned: (ctx) => {
    if (!ctx.def.placement.requiresParcelOwnership) return undefined;
    const cell = ctx.inside.find(({ x, y }) => !ownsParcel(ctx.world, ctx.world.grid.at(x, y).parcelId));
    return cell === undefined ? undefined : `bunka ${cellLabel(cell)} nie je na vlastnej ani prenajatej parcele`;
  },
  no_water_side: (ctx) => {
    const side = ctx.waterSide;
    if (side === undefined) return undefined;
    const dry = waterEdge(ctx, side).find((edge) => !isWaterCell(ctx.world.grid, stepFrom(edge, side, 1)));
    return dry === undefined ? undefined : `bunka hrany ${cellLabel(dry)} nesusedí na strane '${side}' s vodou`;
  },
  water_blocked: checkWaterBand,
  no_berth: (ctx) => (ctx.attaches && typeof ctx.host === 'string' ? ctx.host : undefined),
  rotation_mismatch: (ctx) => {
    if (!(ctx.host instanceof BerthModule) || ctx.host.rotation === ctx.spec.rotation) return undefined;
    return `rotácia ${String(ctx.spec.rotation)} ≠ rotácia ${ctx.host.label} ${String(ctx.host.rotation)}`;
  },
  max_cranes: (ctx) => {
    if (!(ctx.host instanceof BerthModule) || ctx.host.craneIds.length < ctx.host.params.maxCranes) return undefined;
    return `${ctx.host.label} už má ${String(ctx.host.craneIds.length)} žeriavov (maxCranes ${String(ctx.host.params.maxCranes)})`;
  },
  crane_overlap: (ctx) => {
    const host = ctx.host;
    if (!(host instanceof BerthModule)) return undefined;
    for (const craneId of host.craneIds) {
      const other = ctx.world.modules.get(craneId);
      const cell = other === undefined ? undefined : ctx.inside.find(({ x, y }) => other.containsCell(x, y));
      if (other !== undefined && cell !== undefined) return `prekryv s ${other.label} na ${cellLabel(cell)}`;
    }
    return undefined;
  },
  connector_blocked: checkConnectors,
};

/**
 * Porušenia pravidiel umiestnenia modulu `def` na `spec` v poradí `PLACEMENT_RULES` (každé pravidlo najviac raz,
 * s popisom prvého výskytu). Prázdny výsledok = modul sa dá postaviť (cenu a existenciu defu rieši volajúci).
 * `scope: 'structural'` vyhodnotí len pravidlá s `ModuleError` (`World.addModule`). Svet nemení.
 */
export function findPlacementViolations(
  world: PlacementWorld,
  def: Readonly<ModuleDef>,
  spec: PlacementSpec,
  scope: PlacementScope = 'all',
): readonly RuleViolation<PlacementRule>[] {
  const { size, cells } = footprintOf(def, spec.x, spec.y, spec.rotation);
  const inside = cells.filter(({ x, y }) => world.grid.inBounds(x, y));
  const attaches = attachesToHost(def);
  const ctx: PlacementContext = {
    world,
    def,
    spec,
    size,
    cells,
    inside,
    attaches,
    waterSide: waterSideOf(def, spec.rotation),
    host: attaches ? findHost(world, def, inside) : undefined,
  };
  const violations: RuleViolation<PlacementRule>[] = [];
  for (const rule of PLACEMENT_RULES) {
    if (scope === 'structural' && PLACEMENT_RULE_ERROR[rule] === null) continue;
    const detail = PLACEMENT_CHECKS[rule](ctx);
    if (detail !== undefined) violations.push(Object.freeze({ rule, detail }));
  }
  return Object.freeze(violations);
}

// ---------------------------------------------------------------------------------------------------------
// Odstránenie
// ---------------------------------------------------------------------------------------------------------

/** Pravidlá odstránenia v poradí vyhodnotenia; kód pravidla je zároveň `ModuleErrorCode` aj `ValidationReason`. */
export const REMOVAL_RULES = ['has_cargo', 'has_cranes', 'has_vehicles', 'has_trucks', 'ship_docked', 'busy'] as const;

export type RemovalRule = (typeof REMOVAL_RULES)[number];

/** Väzby kamióna na moduly, ktoré pravidlo `has_trucks` číta (`Truck` ich spĺňa). */
export interface TruckModuleRefs {
  readonly id: EntityId;
  readonly gateId: EntityId;
  readonly gateOutId: EntityId | null;
  readonly preGateId: EntityId | null;
  readonly holdingId: EntityId | null;
  readonly blockId: EntityId;
}

/** Trasa vozidla, ktorú pravidlo `has_vehicles` číta (`Vehicle` ju spĺňa): bunka vozidla a zvyšok trasy (`routeCellAt(0)` = `cell`). */
export interface VehicleRouteRefs {
  readonly id: EntityId;
  readonly cellsAhead: number;
  routeCellAt(offset: number): number | undefined;
}

/** Časť sveta, ktorú pravidlá odstránenia čítajú (`World` ju spĺňa). */
export interface RemovalWorld {
  readonly cargo: Pick<CargoLedger, 'countAt'>;
  readonly modules: ReadonlyMap<EntityId, Module>;
  readonly trucks: ReadonlyMap<EntityId, TruckModuleRefs>;
  readonly vehicles: ReadonlyMap<EntityId, VehicleRouteRefs>;
  /** Stroje blokov (R3, ADR-040): blok so strojom v cykle alebo s frontou sa neodstráni. */
  readonly machines: ReadonlyMap<EntityId, { readonly blockId: EntityId; readonly state: string; readonly queue: readonly unknown[] }>;
  readonly grid: Pick<Grid, 'index'>;
}

/** Vozidlá, ktorých bunka alebo zvyšok trasy leží vo footprinte kotviska `berth` (nábrežie pod hákom, F6d), vzostupne podľa id. */
function vehiclesOnQuay(world: RemovalWorld, berth: BerthModule): EntityId[] {
  const cells = new Set<number>(berth.cells.map(({ x, y }) => world.grid.index(x, y)));
  const found: EntityId[] = [];
  for (const vehicle of world.vehicles.values()) {
    for (let offset = 0; offset <= vehicle.cellsAhead; offset++) {
      const cell = vehicle.routeCellAt(offset);
      if (cell === undefined || !cells.has(cell)) continue;
      found.push(vehicle.id);
      break;
    }
  }
  return found;
}

/**
 * Kotvisko, ktorého loď by odstránenie modulu zasiahlo: berth sám, pri žeriave berth pod ním (`berthId`, ADR-014);
 * iný modul žiadne. Loď na kotvisku bez žeriavu svojej kategórie by sa nikdy nevyložila (soft-lock, T02-14).
 */
function dockOf(world: RemovalWorld, module: Module): BerthModule | undefined {
  if (module instanceof BerthModule) return module;
  if (!(module instanceof CraneModule)) return undefined;
  const host = world.modules.get(module.berthId);
  return host instanceof BerthModule ? host : undefined;
}

type RemovalCheck = (world: RemovalWorld, module: Module) => string | undefined;

const REMOVAL_CHECKS: { readonly [R in RemovalRule]: RemovalCheck } = {
  has_cargo: (world, module) => {
    const heldKind = MODULE_CARGO_HOLDER_KINDS.find((kind) => world.cargo.countAt(kind, module.id) > 0);
    if (heldKind !== undefined) return `${module.label} drží náklad (${heldKind})`;
    // Obsadenie slotov a dockov (apron, sklad, rampa) je v ledgeri — pokryté vyššie; modul drží len rezervácie
    // (ADR-017, ADR-022): sloty apronu a skladu, staging miesta dockov rampy.
    const reservations = module.cargoReservations();
    return reservations !== undefined && reservations.count > 0
      ? `${module.label} má rezervované sloty (${reservations.kind}): ${String(reservations.count)}`
      : undefined;
  },
  has_cranes: (_world, module) =>
    module instanceof BerthModule && module.craneIds.length > 0 ? `na ${module.label} stoja žeriavy [${module.craneIds.join(', ')}]` : undefined,
  has_vehicles: (world, module) => {
    if (module instanceof VehicleDepot) return module.vehicleIds.length > 0 ? `${module.label} má vozidlá [${module.vehicleIds.join(', ')}]` : undefined;
    // Kotvisko s jazdným nábrežím (F6d): vozidlo pod žeriavom alebo na ceste k háku by po odstránení stratilo jazdnú bunku.
    const onQuay = module instanceof BerthModule && hasQuayLane(module) ? vehiclesOnQuay(world, module) : [];
    return onQuay.length > 0 ? `na nábreží ${module.label} stoja alebo k nemu mieria vozidlá [${onQuay.join(', ')}]` : undefined;
  },
  // Brána, plocha alebo blok, ktorý používa kamión (T04-04, ADR-024, ADR-041): kamión by stratil trasu, lístok, TP alebo státie.
  has_trucks: (world, module) => {
    const users: EntityId[] = [];
    for (const truck of world.trucks.values()) {
      if (truck.gateId === module.id || truck.gateOutId === module.id || truck.preGateId === module.id || truck.holdingId === module.id || truck.blockId === module.id) users.push(truck.id);
    }
    return users.length > 0 ? `${module.label} používajú kamióny [${users.join(', ')}]` : undefined;
  },
  ship_docked: (world, module) => {
    const berth = dockOf(world, module);
    if (berth === undefined || berth.dockedShipId === null) return undefined;
    const ship = `#${String(berth.dockedShipId)}`;
    return berth === module ? `${berth.label} má loď ${ship}` : `${module.label} stojí na ${berth.label}, ktoré drží loď ${ship}`;
  },
  busy: (world, module) => {
    for (const machine of world.machines.values()) {
      if (machine.blockId === module.id && (machine.state !== 'idle' || machine.queue.length > 0)) return `stroj bloku ${module.label} je uprostred cyklu (${machine.state}) alebo má frontu`;
    }
    if (!(module instanceof CraneModule)) return undefined;
    const { holdsUnit, hasReservation } = CRANE_STATE_TRAITS[module.state];
    const busy = holdsUnit || hasReservation || module.heldUnitId !== null || module.reservedSlot !== null;
    return busy ? `${module.label} je uprostred cyklu (${module.state})` : undefined;
  },
};

/**
 * Porušenia pravidiel odstránenia modulu (existujúceho vo svete) v poradí `REMOVAL_RULES`. Prázdny výsledok =
 * modul ide odstrániť. Svet nemení.
 */
export function findRemovalViolations(world: RemovalWorld, module: Module): readonly RuleViolation<RemovalRule>[] {
  const violations: RuleViolation<RemovalRule>[] = [];
  for (const rule of REMOVAL_RULES) {
    const detail = REMOVAL_CHECKS[rule](world, module);
    if (detail !== undefined) violations.push(Object.freeze({ rule, detail }));
  }
  return Object.freeze(violations);
}
