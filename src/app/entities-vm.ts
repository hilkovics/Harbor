/**
 * Plnenie render view-modelov zo simu (ARCHITECTURE §13, docs/tasks/phase-02.md „Render view-modely“).
 *
 * Renderer nikdy nečíta `World`: `SimBridge` z neho každý tick zloží `EntitiesVM` (moduly, žeriavy, lode, vozidlá,
 * kamióny) a renderer ich synchronizuje podľa `id`. Tu sú čisté funkcie (svet → ploché DTO) a `EntitiesVMBuilder`,
 * ktorý VM modulov cachuje podľa `revision` (moduly sa menia len udalosťami; žeriavy, lode, vozidlá a kamióny sa menia
 * každý tick, preto sa skladajú vždy).
 *
 * - Moduly: všetko okrem žeriavov (tie idú do `cranes`, `ModuleLayer` ich aj tak preskakuje). Berth nesie apron:
 *   obsadené sloty v poradí FIFO (`apron.units()`) so slotom (`slotOf`) a typom nákladu z ledgera; prázdny kontajner (F6c)
 *   navyše `empty` a `lineToken` (farba linky).
 * - Žeriavy: `progress` = `phaseProgress` fázy (0 v `idle`/`blocked`), `holding` = držaná jednotka z ledgera (F6c: `empty` pri
 *   prázdnom kontajneri), `cycle` = smer cyklu (`crane.cycle`: vykládka / nakládka / dual, F6a), `hook` = stred bunky pod hákom,
 *   kde stojí vozidlo pri odovzdaní (F6d, T6D-02; len kotvisko s jazdným nábrežím, režim `apron` ho nemá).
 * - Sklady (`StorageModule`): `storage = { capacity, stored, reserved }` z modulu (obsadenie číta modul z ledgera) a
 *   `lastStorageOp = { slot, tick, kind }` — posledné uloženie / vzatie kontajnera na slote (F5b č. 8, animácia portálového
 *   žeriavu dvora; F6c: `empty` pri prázdnom kontajneri). Sim ju nevedie: skladá ju `SimBridge` z udalostí `CargoMoved`
 *   (`storage-ops.ts`) a podáva builderu. Depo prázdnych (`EmptyDepot`, F6c) nesie `depot = { available, damaged, inRepair,
 *   repairBays }` z `depotCargoSplit` (`cargo-vm.ts`).
 *   Moduly s cestným konektorom nesú `connected = world.isConnected(module)` (odznak „nepripojené“); ostatné (žeriav)
 *   pole nemajú.
 * - Pozemné moduly R4 (TR4-05), každý len svoje pole (živé polia sa menia aj bez udalosti, preto ich `EntitiesVMBuilder` pri každom snapshote
 *   porovnáva so živým modulom, `isLiveModule`):
 *   - pruh brány (`TruckGate`: `gate_in_lane`, `gate_out_lane`): `gateLane = { kind, mode, roofPart, step?, progress? }`; strecha z `adjacentLaneGroups`,
 *     krok z `TruckGate.currentStep()` (bez kroku = voľný pruh);
 *   - blok skladu (`YardBlock`): `tpCells = [{ x, y, busy }]` z `tpCellsOf`; `busy` = kamión s touto bunkou TP je `at_tp` / `at_edge_tp`;
 *   - odstavná plocha (`TruckHolding`): `holdingSlots = [{ x, y, occupied }]` zo `stallCells()` (obsadené kamiónom s `holdingId` a `stall`).
 * - Kamióny (`TruckVM`): `loaded` = aspoň jedna jednotka `in_truck`, `carriesEmpty` (F6c) = je prázdny kontajner. Mimo cesty sa kamión kreslí na
 *   prezentovanej polohe (`truckPose`): v `gate_pass` / `gate_pass_out` (prechod pruhom brány) v strede pruhu, v `pre_gate` na mieste rady predbránovej
 *   plochy (vedľa seba, kabína v smere plochy), v `holding` na státí odstavnej plochy. Pri zmene stavu z/do takého stavu je `prev = curr` (bez interpolácie).
 * - Lode: `cargoSplit` (import / export / `empty` na palube; prekládka do importu na lodi A a do exportu na lodi B, `shipDeckSplit`,
 *   `unitsOnBoard` je ich súčet; `EntitiesVMBuilder` ho cachuje podľa revízie) a v stave `lashing`
 *   `lashing = { ticksLeft, ticksTotal }` (`ticksTotal` z udalosti `ShipLashingStarted`, ktorú si pamätá `LashingTracker`;
 *   bez záznamu vzorec z defu, `lashing.ts`).
 * - Lode, vozidlá a kamióny: `prevX/prevY` (a `prevHeading` vozidla a kamióna) sim nevedie — dodá ich volajúci
 *   (`SimBridge` si polohu pamätá pred každým tickom); nová loď / vozidlo / kamión bez záznamu má `prev = curr`.
 * - Vozidlá: `loaded` = v ledgeri je aspoň jedna jednotka `in_vehicle` u tohto vozidla; `carriesEmpty` (F6c) = je prázdny kontajner.
 *
 * Bez side-effectov a bez závislosti na DOM/Pixi/React.
 */
import type { ContainerVM, CraneVM, CrossingVM, TrainCarVM, TrainVM, EntitiesVM, GateLaneVM, HoldingSlotVM, MachineVM, ModuleVM, ReeferPlugStateVM, ReeferPlugVM, ShipVM, StackVM, TpCellVM, TruckVM, VehicleVM, ViewRotation } from '@render/view-models';
import type { CargoLocation, CargoUnit } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { moduleLanes } from '@sim/logistics';
import { ReachStacker } from '@sim/machines';
import { crossingStates, railPoseAt } from '@sim/rail';
import { BerthModule, CraneModule, RtgBlock, adjacentLaneGroups, craneCargo, craneTrolley, EmptyDepot, StorageModule, PreGateBuffer, TruckGate, TruckHolding, VehicleDepot, YardBlock, type LaneRoofPlacement, type Module } from '@sim/modules';
import { SHIP_STATE_TRAITS, type Ship } from '@sim/ships';
import { tpCellsOf, type Truck } from '@sim/trucks';
import { hookCellOfCrane } from '@sim/vehicles';
import { holdsRoad } from '@sim/traffic';
import type { World } from '@sim/world';
import { depotVM, emptyLook, holderCarriesEmpty, isEmptyUnit, shipDeckSplit, ShipSplitCache, truckCarriesEmpty, type DeckSplit } from './cargo-vm';
import { lashingTicks, type LashingTotals } from './lashing';
import type { StorageOps } from './storage-ops';

/** Poloha stredu lode v bunkách (predchádzajúci tick). */
export interface ShipPosition {
  readonly x: number;
  readonly y: number;
}

/** Predchádzajúce polohy lodí podľa `id` lode; chýbajúci záznam = loď nemá predchodcu (`prev = curr`). */
export type ShipPositions = ReadonlyMap<number, ShipPosition>;

const NO_POSITIONS: ShipPositions = new Map();

/** Poloha a kurz vozidla pred posledným tickom (`prevX/prevY/prevHeading`). */
export interface VehiclePose {
  readonly x: number;
  readonly y: number;
  readonly heading: ViewRotation;
}

/** Predchádzajúce pózy vozidiel podľa `id` vozidla; chýbajúci záznam = nové vozidlo (`prev = curr`). */
export type VehiclePoses = ReadonlyMap<number, VehiclePose>;

const NO_VEHICLE_POSES: VehiclePoses = new Map();

/** Póza kamióna pred posledným tickom: prezentovaná poloha a kurz plus stav FSM (podľa neho sa pozná skok do/zo stojiska a docku). */
export interface TruckPose {
  readonly x: number;
  readonly y: number;
  readonly heading: ViewRotation;
  readonly state: string;
  /** F6c: kamión nesie (alebo naposledy niesol) prázdny kontajner (`truckCarriesEmpty`); chýba = nie. */
  readonly carriesEmpty?: boolean;
}

/** Predchádzajúce pózy kamiónov podľa `id` kamióna; chýbajúci záznam = nový kamión (`prev = curr`). */
export type TruckPoses = ReadonlyMap<number, TruckPose>;

const NO_TRUCK_POSES: TruckPoses = new Map();

/** Bez zaznamenaných operácií skladov (F2–F5 testy, `moduleVMs(world)`). */
const NO_STORAGE_OPS: StorageOps = new Map();

/** Bez zapamätaných dôb lashingu (F2–F6 testy, `shipVMs(world)`). */
const NO_LASHING_TOTALS: LashingTotals = new Map();

/**
 * `EntitiesVM` zo SimBridge: `vehicles` a `trucks` sú vždy vyplnené (v `EntitiesVM` ostávajú voliteľné kvôli F2/F3
 * fixtures v `src/render/__demo__`, ktoré ich nemajú — sprísnenie by vyžadovalo zásah do nich).
 */
export interface SimEntitiesVM extends EntitiesVM {
  readonly vehicles: readonly VehicleVM[];
  readonly trucks: readonly TruckVM[];
  readonly trains: readonly TrainVM[];
  readonly crossings: readonly CrossingVM[];
}

/** Druh modulu, ktorý sa prezentuje samostatne v `EntitiesVM.cranes`. */
const CRANE_KIND = 'crane';

/** Jednotka z ledgera; jednotka bez záznamu je porušený invariant (indexy apronu a ledgera sa rozišli). */
function unitOf(world: World, unitId: EntityId, holder: string): CargoUnit {
  const unit = world.cargo.get(unitId);
  if (unit === undefined) throw new Error(`entitiesVM: jednotka #${String(unitId)} (${holder}) nie je v ledgeri`);
  return unit;
}

/** Modul má cestný konektor → má zmysel hlásiť pripojenie k ceste (žeriav konektory nemá). */
export function hasRoadConnector(module: Module): boolean {
  return module.connectors.some((connector) => connector.type === 'road');
}

/** Strecha pruhov brány podľa modulov (R4, `adjacentLaneGroups`); mení sa len s modulmi, preto ju `EntitiesVMBuilder` cachuje podľa revízie. */
export type LaneRoofs = ReadonlyMap<EntityId, LaneRoofPlacement>;

/** Bez zoskupenia pruhov (každý pruh `single`). */
const NO_ROOFS: LaneRoofs = new Map();

/** Polia VM, ktoré sa menia aj bez udalosti (každý tick): pruh brány, TP bloku a miesta odstavnej plochy. */
interface LiveParts {
  gateLane?: GateLaneVM;
  tpCells?: readonly TpCellVM[];
  holdingSlots?: readonly HoldingSlotVM[];
  plugs?: readonly ReeferPlugVM[];
}

/** Kľúče `LiveParts` (pri obnove VM sa najprv zahodia a potom nahradia čerstvými). */
const LIVE_KEYS: readonly (keyof LiveParts)[] = ['gateLane', 'tpCells', 'holdingSlots', 'plugs'];

/** Pruh brány: smer, režim, strecha a aktuálny krok (`currentStep`). */
function gateLaneVM(gate: TruckGate, roofs: LaneRoofs): GateLaneVM {
  const step = gate.currentStep();
  return {
    kind: gate.direction,
    mode: gate.mode,
    roofPart: roofs.get(gate.id)?.position ?? 'single',
    ...(step === null ? {} : { step: step.id, progress: step.progress }),
  };
}

/** TP bloku (bunky sveta) s príznakom obsadenia: kamión na TP (`at_tp` / `at_edge_tp`) s `tpCell` v tej bunke. */
function tpCellVMs(world: World, block: YardBlock): readonly TpCellVM[] {
  const busy = new Set<number>();
  for (const truck of world.trucks.values()) {
    if (truck.tpCell !== null && (truck.state === 'at_tp' || truck.state === 'at_edge_tp')) busy.add(truck.tpCell);
  }
  const { width } = world.grid;
  return tpCellsOf(world, block).map((cell) => ({ x: cell % width, y: Math.floor(cell / width), busy: busy.has(cell) }));
}

/** Státia odstavnej plochy (bunky sveta) a obsadenie kamiónmi s `holdingId` a `stall`. */
function holdingSlotVMs(world: World, holding: TruckHolding): readonly HoldingSlotVM[] {
  const taken = new Set<number>();
  for (const truck of world.trucks.values()) {
    if (truck.holdingId === holding.id && truck.stall !== null) taken.add(truck.stall);
  }
  return holding.stallCells().map((cell, stall) => ({ x: cell.x, y: cell.y, occupied: taken.has(stall) }));
}

/** Živé polia VM modulu (`isLiveModule`); modul bez nich vráti prázdny objekt. */
function liveParts(world: World, module: Module, roofs: LaneRoofs): LiveParts {
  if (module instanceof TruckGate) return { gateLane: gateLaneVM(module, roofs) };
  if (module instanceof YardBlock) {
    const tpCells = tpCellVMs(world, module);
    const parts: LiveParts = tpCells.length > 0 ? { tpCells } : {};
    if (module.hasSockets) parts.plugs = plugVMs(world, module);
    return parts;
  }
  if (module instanceof TruckHolding) return { holdingSlots: holdingSlotVMs(world, module) };
  return {};
}

/** Zadržané (VGM hold) jednotky jedného modulu: všetky a sloty apronu (utriedené vzostupne). */
interface HeldAt {
  count: number;
  readonly slots: number[];
}

/** Zadržané jednotky podľa `id` modulu (sklad, berth); modul bez zadržaných jednotiek záznam nemá. */
export type HeldByModule = ReadonlyMap<number, HeldAt>;

/** Bez zadržaných jednotiek (`holdIndex` je prázdny, F2–F6 testy, `moduleVMs(world)`). */
const NO_HELD: HeldByModule = new Map();

/** Modul, v ktorom jednotka leží, a jej miesto (slot apronu); jednotka mimo skladu a apronu → `undefined`. */
function heldPlace(location: CargoLocation): { moduleId: EntityId; slot?: number } | undefined {
  if (location.kind === 'in_storage') return { moduleId: location.moduleId };
  if (location.kind === 'on_apron') return { moduleId: location.berthId, slot: location.slot };
  return undefined;
}

/**
 * Zadržané jednotky (VGM hold, ADR-032 bod 7) zoskupené podľa modulu. Číta sa `World.holdIndex` (jeden záznam na
 * zadržanú jednotku, nie sken ledgera), takže bez zadržaných jednotiek je to O(1) bez alokácie.
 */
export function heldByModule(world: World): HeldByModule {
  const { holdIndex, cargo } = world;
  if (holdIndex.size === 0) return NO_HELD;
  const result = new Map<number, HeldAt>();
  for (const { unitId } of holdIndex.all) {
    const unit = cargo.get(unitId);
    const place = unit === undefined ? undefined : heldPlace(unit.location);
    if (place === undefined) continue;
    let at = result.get(place.moduleId);
    if (at === undefined) {
      at = { count: 0, slots: [] };
      result.set(place.moduleId, at);
    }
    at.count += 1;
    if (place.slot !== undefined) at.slots.push(place.slot);
  }
  return result;
}

/** `ModuleVM.held` modulu: berth dopĺňa `slots`; sklad nesie len `count`. */
function heldVM(module: Module, at: HeldAt): NonNullable<ModuleVM['held']> {
  if (module instanceof BerthModule) return { count: at.count, slots: [...at.slots].sort((a, b) => a - b) };
  return { count: at.count };
}

/** Modul, ktorého VM sa môže zmeniť aj bez udalosti v `REVISION_EVENTS` (pozemné moduly s kamiónmi): porovnáva sa so živým modulom pri každom snapshote. */
export function isLiveModule(module: Module): boolean {
  return module instanceof TruckGate || module instanceof YardBlock || module instanceof TruckHolding;
}

/** Stohy bloku skladu (R2): všetky pozície `(bay, row)` s výškou a vrchným kontajnerom. */
function yardBlockStacks(world: World, yard: YardBlock): readonly StackVM[] {
  const stacks: StackVM[] = [];
  const { bays, rows } = yard.geometry;
  for (let row = 0; row < rows; row++) {
    for (let bay = 0; bay < bays; bay++) {
      const height = yard.stackHeight(bay, row);
      const topUnitId = yard.topUnit(bay, row);
      let topContainer: ContainerVM | null = null;
      if (topUnitId !== null) {
        const unit = world.cargo.get(topUnitId);
        if (unit !== undefined) {
          topContainer = containerOf(unit);
        }
      }
      stacks.push({ bay, row, height, top: topContainer });
    }
  }
  return stacks;
}

/**
 * VM jedného modulu (mimo žeriavov); `storageOps` dopĺňa `lastStorageOp` skladom (animácia žeriavu dvora), `held` odznak
 * VGM hold skladu a berthu.
 */
function moduleVM(world: World, module: Module, storageOps: StorageOps = NO_STORAGE_OPS, held: HeldByModule = NO_HELD, roofs: LaneRoofs = NO_ROOFS): ModuleVM {
  const vm: ModuleVM = {
    id: module.id,
    defId: module.def.id,
    kind: module.kind,
    x: module.origin.x,
    y: module.origin.y,
    rotation: module.rotation,
    w: module.size.w,
    h: module.size.h,
  };
  if (module instanceof BerthModule) {
    const { apron } = module;
    const units: NonNullable<ModuleVM['apron']>['units'] = [];
    for (const unitId of apron.units()) {
      const slot = apron.slotOf(unitId);
      if (slot === undefined) throw new Error(`entitiesVM: jednotka #${String(unitId)} je vo FIFO apronu ${module.label}, ale nemá slot`);
      const unit = unitOf(world, unitId, module.label);
      units.push({ slot, unitId, typeId: unit.typeId, ...emptyLook(world, unit) });
    }
    vm.apron = { capacity: apron.capacity, units };
  }
  if (module instanceof StorageModule) {
    vm.storage = { capacity: module.capacity, stored: module.storedCount, reserved: module.reservedCount };
    const op = storageOps.get(module.id);
    if (op !== undefined) vm.lastStorageOp = { slot: op.slot, tick: op.tick, kind: op.kind, ...(op.empty === true ? { empty: true } : {}) };
    if (module instanceof EmptyDepot) vm.depot = depotVM(world, module);
  }
  if (module instanceof VehicleDepot) {
    // Depo vozidiel (R1, ADR-037 bod 11): parked vehicles vzostupne podľa id
    const parkedVehicles: { id: number; defId: string }[] = [];
    for (const vehicleId of module.vehicleIds) {
      const vehicle = world.vehicles.get(vehicleId);
      if (vehicle !== undefined && vehicle.state === 'parked') {
        parkedVehicles.push({ id: vehicleId, defId: vehicle.defId });
      }
    }
    if (parkedVehicles.length > 0) vm.parkedVehicles = parkedVehicles;
  }
  if (module instanceof YardBlock) {
    // Blok skladu (R2): stohy kontajnerov a geometria
    vm.stacks = yardBlockStacks(world, module);
    vm.stackGeometry = { bays: module.geometry.bays, rows: module.geometry.rows, maxTier: module.geometry.maxTier };
  }
  const lanes = moduleLanes(module);
  if (lanes.length > 0) vm.lanes = lanes.map(({ x, y, dir }) => ({ x, y, dir: dir.toLowerCase() as 'n' | 'e' | 's' | 'w' }));
  if (hasRoadConnector(module)) vm.connected = world.isConnected(module);
  const heldHere = held.get(module.id);
  if (heldHere !== undefined) vm.held = heldVM(module, heldHere);
  Object.assign(vm, liveParts(world, module, roofs));
  return vm;
}

/** Moduly sveta v poradí umiestnenia, bez žeriavov. */
export function moduleVMs(world: World, storageOps: StorageOps = NO_STORAGE_OPS): ModuleVM[] {
  const held = heldByModule(world);
  const roofs = adjacentLaneGroups(world.modules.values());
  const result: ModuleVM[] = [];
  for (const module of world.modules.values()) {
    if (module.kind === CRANE_KIND) continue;
    result.push(moduleVM(world, module, storageOps, held, roofs));
  }
  return result;
}

/** Stav zásuvky reefera jednotky (R5): `alarm` pri aktívnom alarme, `on` zapojený, inak `off`; bez reefera `undefined`. */
export function reeferPlugState(unit: CargoUnit): ReeferPlugStateVM | undefined {
  const reefer = unit.reefer;
  if (reefer === null) return undefined;
  if (reefer.alarmUntilTick !== null) return 'alarm';
  return reefer.plugged ? 'on' : 'off';
}

/** VM kontajnera z jednotky ledgera (R5: s `oog` a `reefer` len ak platia). */
function containerOf(unit: CargoUnit): ContainerVM {
  const vm: ContainerVM = { sizeFt: unit.sizeFt as 20 | 40, containerType: unit.containerType, lineId: unit.lineId, direction: unit.direction };
  if (unit.oog) vm.oog = true;
  const reefer = reeferPlugState(unit);
  if (reefer !== undefined) vm.reefer = reefer;
  return vm;
}

/** Zásuvky bloku so zásuvkami (R5): stred bunky stohu vo svete (s rotáciou bloku) a stav podľa reeferov v stohu (alarm > on > off, bez reeferu `empty`). */
function plugVMs(world: World, yard: YardBlock): readonly ReeferPlugVM[] {
  const { w, h } = yard.def.footprint;
  const plugs: ReeferPlugVM[] = [];
  for (const { bay, row } of yard.plugCells()) {
    const lx = row + 0.5;
    const ly = bay + 0.5;
    const local = { 0: { x: lx, y: ly }, 90: { x: h - ly, y: lx }, 180: { x: w - lx, y: h - ly }, 270: { x: ly, y: w - lx } }[yard.rotation];
    let state: ReeferPlugVM['state'] = 'empty';
    const ids: EntityId[] = [];
    yard.columnUnits(bay, row, ids);
    for (const id of ids) {
      const unit = world.cargo.get(id);
      const found = unit === undefined ? undefined : reeferPlugState(unit);
      if (found === undefined) continue;
      if (found === 'alarm' || state === 'empty' || (state === 'off' && found === 'on')) state = found;
    }
    plugs.push({ x: yard.origin.x + local.x, y: yard.origin.y + local.y, state });
  }
  return plugs;
}

/** Stroje blokov (R3, RTG): stred rámu v bunkách sveta (s rotáciou bloku), vozík a zdvih 0..1, náklad z `in_handler`. */
export function machineVMs(world: World): MachineVM[] {
  const result: MachineVM[] = [];
  for (const machine of world.machines.values()) {
    const block = world.modules.get(machine.blockId);
    if (!(block instanceof RtgBlock)) continue;
    const { w, h } = block.def.footprint;
    const reach = machine instanceof ReachStacker;
    const pose = machine.poseNow();
    // R5: reach stacker jazdí v uličke (stĺpec `laneCol`, pojazd = bay), RTG má rám v strede šírky bloku
    const lx = reach ? block.laneCol + 0.5 : w / 2;
    const ly = (reach ? machine.aislePos() : pose.gantry) + 0.5;
    const local = { 0: { x: lx, y: ly }, 90: { x: h - ly, y: lx }, 180: { x: w - lx, y: h - ly }, 270: { x: ly, y: w - lx } }[block.rotation];
    let cargo: ContainerVM | null = null;
    const unitId = reach ? (machine.cycle?.unitId as EntityId | undefined) : world.cargo.countAt('in_handler', machine.id) > 0 ? world.cargo.unitAtIndex('in_handler', machine.id, 0) : undefined;
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit !== undefined && unit.location.kind === 'in_handler') cargo = containerOf(unit);
    const { rows, maxTier } = block.geometry;
    const vm: MachineVM = {
      id: machine.id,
      defId: machine.defId,
      blockId: machine.blockId,
      x: block.origin.x + local.x,
      y: block.origin.y + local.y,
      trolley: Math.min(1, Math.max(0, (pose.trolley + 1) / rows)),
      hoist: Math.min(1, Math.max(0, pose.hoist / maxTier)),
      state: machine.state,
      cargo,
    };
    if (reach) {
      vm.angle = (270 + block.rotation) % 360; // výložník smeruje k radom (−x pri rotácii 0)
      vm.boom = machine.boom(rows);
    }
    result.push(vm);
  }
  return result;
}

/** Prevod uhla koľaje (0 = +x, v smere hodinových ručičiek na obrazovke) na uhol renderu (0 = hore, v smere hodinových ručičiek). */
const RAIL_ANGLE_TO_RENDER = 90;
const FULL_TURN = 360;

/** Vlaky (R6): vozne od lokomotívy s polohou z `railPoseAt` a nákladom `in_train` zoskupeným podľa vagóna (`⌊slot / wagonTeu⌋`). */
export function trainVMs(world: World): TrainVM[] {
  const result: TrainVM[] = [];
  for (const train of world.rail.trains.values()) {
    const cargoByWagon = new Map<number, { slot: number; vm: ContainerVM }[]>();
    for (const unitId of world.cargo.unitsAt('in_train', train.id)) {
      const unit = unitOf(world, unitId, train.label);
      if (unit.location.kind !== 'in_train') continue;
      const wagon = train.wagonOfSlot(unit.location.slot);
      const list = cargoByWagon.get(wagon) ?? [];
      list.push({ slot: unit.location.slot, vm: containerOf(unit) });
      cargoByWagon.set(wagon, list);
    }
    const cars: TrainCarVM[] = train.cars().map((span) => {
      const pose = railPoseAt(world.grid, train.route, span.centerMilli);
      const cargo = span.kind === 'wagon' ? (cargoByWagon.get(span.wagon) ?? []).sort((a, b) => a.slot - b.slot).map((entry) => entry.vm) : [];
      return { kind: span.kind, x: pose.x, y: pose.y, angle: (((pose.angle + RAIL_ANGLE_TO_RENDER) % FULL_TURN) + FULL_TURN) % FULL_TURN, cargo };
    });
    const vm: TrainVM = { id: train.id, cars, state: train.state };
    if (train.departAtTick !== null) vm.departureTick = train.departAtTick;
    result.push(vm);
  }
  return result;
}

/** Priecestia s aktuálnou závorou (R6). */
export function crossingVMs(world: World): CrossingVM[] {
  return crossingStates(world).map(({ cell, barrier }) => {
    const { x, y } = world.grid.coordOf(cell);
    return { x: x + 0.5, y: y + 0.5, barrier };
  });
}

/** Žeriavy sveta v poradí umiestnenia. */
export function craneVMs(world: World): CraneVM[] {
  const result: CraneVM[] = [];
  for (const module of world.modules.values()) {
    if (!(module instanceof CraneModule)) continue;
    const held = craneCargo(module) as EntityId | null;
    const heldUnit = held === null ? undefined : unitOf(world, held, module.label);
    const idlePhase = module.state === 'idle' || module.state === 'blocked';
    const hook = hookCellOfCrane(world, module.id); // F6d: bunka pod hákom, len pri kotvisku s jazdným nábrežím (under_hook)
    result.push({
      id: module.id,
      defId: module.def.id,
      berthId: module.berthId,
      x: module.origin.x,
      y: module.origin.y,
      rotation: module.rotation,
      state: module.state,
      progress: idlePhase ? 0 : Math.min(1, Math.max(0, module.phaseProgress)),
      holding: heldUnit === undefined ? null : { unitId: heldUnit.id, typeId: heldUnit.typeId, ...(isEmptyUnit(heldUnit) ? { empty: true } : {}) },
      cycle: module.cycle,
      trolleyY: craneTrolley(module),
      cargo: heldUnit === undefined ? null : containerOf(heldUnit),
      ...(hook === undefined ? {} : { hook: { x: (hook % world.grid.width) + 0.5, y: Math.floor(hook / world.grid.width) + 0.5 } }),
    });
  }
  return result;
}

/** Náklad lode pre palubu (`shipDeckSplit`); `EntitiesVMBuilder` dosadí cachovaný výpočet podľa revízie. */
type ShipSplitOf = (world: World, ship: Ship) => DeckSplit;

/**
 * Lode na mape v poradí `world.ships` (vzostupne podľa id); `prev` z predchádzajúceho ticku (chýba → `prev = curr`);
 * `lashingTotals` = celkové doby lashingu zo `SimBridge`. `cargoSplit` je O(jednotky na palube), najviac `capacityUnits` lode
 * (`splitOf` ho môže cachovať). F6c: `cargoSplit` nesie import (aj prekládka na lodi A), export (aj prekládka na lodi B) a `empty`
 * (len keď sú na palube prázdne); `unitsOnBoard` je ich súčet, takže vždy sedí s `cargoSplit`.
 * Loď, ktorá ešte nie je na mape (`arriving` — čaká pred vstupom, ADR-029; `SHIP_STATE_TRAITS.onMap`), sa nekreslí, takže
 * do zoznamu nepatrí; vo chvíli vstupu (`arriving → inbound`) sa objaví na `seaLane[0]` s `prev = curr`.
 */
export function shipVMs(
  world: World,
  prev: ShipPositions = NO_POSITIONS,
  lashingTotals: LashingTotals = NO_LASHING_TOTALS,
  splitOf: ShipSplitOf = shipDeckSplit,
): ShipVM[] {
  const result: ShipVM[] = [];
  for (const ship of world.ships.values()) {
    if (!SHIP_STATE_TRAITS[ship.state].onMap) continue;
    const before = prev.get(ship.id);
    const split = splitOf(world, ship);
    // lashing sa týka odchádzajúcich jednotiek: export (aj prekládka na lodi B) a prázdne na repositioning
    const lashing = lashingTicks(ship, split.export + split.empty, lashingTotals);
    result.push({
      id: ship.id,
      classId: ship.classId,
      cargoCategory: ship.cargoCategory,
      state: ship.state,
      x: ship.x,
      y: ship.y,
      prevX: before?.x ?? ship.x,
      prevY: before?.y ?? ship.y,
      heading: ship.heading,
      lengthCells: ship.def.lengthCells,
      widthCells: ship.def.widthCells,
      unitsOnBoard: split.import + split.export + split.empty,
      capacityUnits: ship.def.capacityUnits,
      cargoSplit: { import: split.import, export: split.export, ...(split.empty > 0 ? { empty: split.empty } : {}) },
      ...(lashing === undefined ? {} : { lashing }),
    });
  }
  return result;
}

/** Vozidlá sveta vzostupne podľa id (`world.vehicles`); `prev` z predchádzajúceho ticku (chýba → `prev = curr`). */
export function vehicleVMs(world: World, prev: VehiclePoses = NO_VEHICLE_POSES): VehicleVM[] {
  const result: VehicleVM[] = [];
  for (const vehicle of world.vehicles.values()) {
    const before = prev.get(vehicle.id);
    const loaded = world.cargo.countAt('in_vehicle', vehicle.id) > 0;
    // Carrier trail (R1, ADR-037 bod 7): body = stredy buniek stopy od hlavy k chvostu (bez hlavy), lengthCells z defu
    const body: { x: number; y: number }[] = [];
    for (const slot of vehicle.body) {
      const cell = slot >> 1; // kľúč slotu je bunka × 2 + pruh
      const cx = cell % world.grid.width;
      const cy = (cell - cx) / world.grid.width;
      body.push({ x: cx + 0.5, y: cy + 0.5 });
    }
    // R2: veziený kontajner podľa veľkosti, typu a linky
    let cargo: ContainerVM | null = null;
    if (loaded) {
      const count = world.cargo.countAt('in_vehicle', vehicle.id);
      if (count > 0) {
        const unitId = world.cargo.unitAtIndex('in_vehicle', vehicle.id, 0);
        if (unitId !== undefined) {
          const unit = world.cargo.get(unitId);
          if (unit !== undefined) {
            cargo = containerOf(unit);
          }
        }
      }
    }
    result.push({
      id: vehicle.id,
      defId: vehicle.defId,
      x: vehicle.x,
      y: vehicle.y,
      prevX: before?.x ?? vehicle.x,
      prevY: before?.y ?? vehicle.y,
      heading: vehicle.heading,
      prevHeading: before?.heading ?? vehicle.heading,
      loaded,
      ...(loaded && holderCarriesEmpty(world, 'in_vehicle', vehicle.id) ? { carriesEmpty: true } : {}),
      ...(cargo !== null ? { cargo } : {}),
      state: vehicle.state,
      // Carrier trail (R1): body, lengthCells, offRoad, blocked, jammed
      ...(body.length > 0 ? { body } : {}),
      lengthCells: vehicle.lengthCells,
      offRoad: !holdsRoad(vehicle),
      blocked: vehicle.blockedTicks > 0,
      jammed: vehicle.blockedTicks >= world.defs.logistics.traffic.stuckTicks,
    });
  }
  return result;
}

/** Stavy brány: `gate_pass` (vjazd) a `gate_pass_out` (výjazd). */
const GATE_PASS_STATES: ReadonlySet<string> = new Set<string>(['gate_pass', 'gate_pass_out']);

/** Stavy kamióna, v ktorých sa kreslí na vyhradenom mieste modulu (pruh brány, rad plochy, státie), nie na bunke cesty. */
const SLOT_STATES: ReadonlySet<string> = new Set<string>([...GATE_PASS_STATES, 'pre_gate', 'holding']);

/** Zmeniteľná póza (bridge ju prepisuje pred každým tickom bez alokácie). */
export interface MutableTruckPose {
  x: number;
  y: number;
  heading: ViewRotation;
  state: string;
  /** Pamäť `truckCarriesEmpty` (zapisuje ju `SimBridge` pred každým tickom, `writeTruckPose` ju nemení). */
  carriesEmpty?: boolean;
}

/** Stred miesta s lokálnymi súradnicami (bunky, rot 0) v module `host` vo svete (po rotácii modulu). */
function moduleLocalCenter(host: Module, lx: number, ly: number): { x: number; y: number } {
  const { w, h } = host.def.footprint;
  const local = { 0: { x: lx, y: ly }, 90: { x: h - ly, y: lx }, 180: { x: w - lx, y: h - ly }, 270: { x: ly, y: w - lx } }[host.rotation];
  return { x: host.origin.x + local.x, y: host.origin.y + local.y };
}

/** Stred miesta `slot` (0 = čelo) v rade `row` predbránovej plochy: miesta po 3 bunky, zvislo vycentrované (ako `pre-gate-decor`). */
function preGateSlotCenter(buffer: PreGateBuffer, row: number, slot: number): { x: number; y: number } {
  const slotCells = 3;
  const top = (buffer.def.footprint.h - buffer.rowCapacity * slotCells) / 2;
  return moduleLocalCenter(buffer, row + 0.5, top + slot * slotCells + slotCells / 2);
}

/**
 * Zapíše prezentovanú pózu kamióna do `out`: v `gate_pass` a `gate_pass_out` stred pruhu brány, v `pre_gate` miesto v rade predbránovej plochy (kabína v smere
 * plochy), v `holding` stred státia odstavnej plochy; inak (aj keď modul chýba) poloha a kurz zo simu. `state` je stav FSM simu.
 */
export function writeTruckPose(world: World, truck: Truck, out: MutableTruckPose): void {
  let slot: { x: number; y: number } | undefined;
  let host: Module | undefined;
  if (GATE_PASS_STATES.has(truck.state)) {
    host = world.modules.get(truck.state === 'gate_pass_out' && truck.gateOutId !== null ? truck.gateOutId : truck.gateId);
    if (host instanceof TruckGate) slot = { x: host.origin.x + host.size.w / 2, y: host.origin.y + host.size.h / 2 };
  } else if (truck.state === 'pre_gate' && truck.preGateId !== null && truck.row !== null) {
    host = world.modules.get(truck.preGateId);
    if (host instanceof PreGateBuffer) {
      const index = host.rowTrucks(truck.row).indexOf(truck.id);
      if (index >= 0) slot = preGateSlotCenter(host, truck.row, index);
    }
  } else if (truck.state === 'holding' && truck.holdingId !== null && truck.stall !== null) {
    host = world.modules.get(truck.holdingId);
    if (host instanceof TruckHolding) {
      const cell = host.stallCell(truck.stall);
      slot = { x: cell.x + 0.5, y: cell.y + 0.5 };
    }
  }
  out.x = slot?.x ?? truck.x;
  out.y = slot?.y ?? truck.y;
  if (slot === undefined || host === undefined) out.heading = truck.heading;
  else out.heading = host.rotation;
  out.state = truck.state;
}

/** Prezentovaná póza kamióna (viď `writeTruckPose`) ako nový objekt. */
export function truckPose(world: World, truck: Truck): TruckPose {
  const pose: MutableTruckPose = { x: 0, y: 0, heading: 0, state: truck.state };
  writeTruckPose(world, truck, pose);
  return pose;
}

/**
 * Predchádzajúca póza pre `TruckVM`: zapamätaná póza pred posledným tickom; bez záznamu (nový kamión) alebo pri zmene
 * stavu z/do `waiting` / `loading` / `unloading` (sim kamión presunul zo stojiska / na výjazd, resp. z cesty do stojiska / docku)
 * je to aktuálna póza, aby sa kamión neinterpoloval naprieč mapou.
 */
function previousTruckPose(before: TruckPose | undefined, current: TruckPose): TruckPose {
  if (before === undefined) return current;
  if (before.state !== current.state && (SLOT_STATES.has(before.state) || SLOT_STATES.has(current.state))) return current;
  return before;
}

/** Kamióny sveta vzostupne podľa id (`world.trucks`); `prev` z predchádzajúceho ticku (chýba → `prev = curr`). */
export function truckVMs(world: World, prev: TruckPoses = NO_TRUCK_POSES): TruckVM[] {
  const result: TruckVM[] = [];
  for (const truck of world.trucks.values()) {
    const pose = truckPose(world, truck);
    const last = prev.get(truck.id);
    const before = previousTruckPose(last, pose);
    // Carrier trail (R1, ADR-037 bod 7): body = stredy buniek stopy od hlavy k chvostu (bez hlavy), lengthCells z defu
    const body: { x: number; y: number }[] = [];
    for (const slot of truck.body) {
      const cell = slot >> 1; // kľúč slotu je bunka × 2 + pruh
      const cx = cell % world.grid.width;
      const cy = (cell - cx) / world.grid.width;
      body.push({ x: cx + 0.5, y: cy + 0.5 });
    }
    // R2: veziený kontajner podľa veľkosti, typu a linky
    const loaded = world.cargo.countAt('in_truck', truck.id) > 0;
    let cargo: ContainerVM | null = null;
    if (loaded) {
      const unitId = world.cargo.unitAtIndex('in_truck', truck.id, 0);
      if (unitId !== undefined) {
        const unit = world.cargo.get(unitId);
        if (unit !== undefined) {
          cargo = containerOf(unit);
        }
      }
    }
    const vm: TruckVM = {
      id: truck.id,
      defId: truck.defId,
      x: pose.x,
      y: pose.y,
      prevX: before.x,
      prevY: before.y,
      heading: pose.heading,
      prevHeading: before.heading,
      loaded,
      ...(cargo !== null ? { cargo } : {}),
      state: truck.state,
      // Carrier trail (R1): body, lengthCells, offRoad, blocked, jammed
      ...(body.length > 0 ? { body } : {}),
      lengthCells: truck.lengthCells,
      offRoad: !holdsRoad(truck),
      blocked: truck.blockedTicks > 0,
      jammed: truck.blockedTicks >= world.defs.logistics.traffic.stuckTicks,
    };
    if (truckCarriesEmpty(world, truck.id, last?.carriesEmpty)) vm.carriesEmpty = true;
    if (last !== undefined) vm.prevState = last.state;
    result.push(vm);
  }
  return result;
}

/** Všetky entity sveta (bez cachovania); `prev` viď `shipVMs`, `vehicleVMs` a `truckVMs`. */
export function entitiesVM(
  world: World,
  prev: ShipPositions = NO_POSITIONS,
  prevVehicles: VehiclePoses = NO_VEHICLE_POSES,
  prevTrucks: TruckPoses = NO_TRUCK_POSES,
  storageOps: StorageOps = NO_STORAGE_OPS,
  lashingTotals: LashingTotals = NO_LASHING_TOTALS,
): SimEntitiesVM {
  return Object.freeze({
    modules: Object.freeze(moduleVMs(world, storageOps)),
    cranes: Object.freeze(craneVMs(world)),
    machines: Object.freeze(machineVMs(world)),
    ships: Object.freeze(shipVMs(world, prev, lashingTotals)),
    vehicles: Object.freeze(vehicleVMs(world, prevVehicles)),
    trucks: Object.freeze(truckVMs(world, prevTrucks)),
    trains: Object.freeze(trainVMs(world)),
    crossings: Object.freeze(crossingVMs(world)),
  });
}

/** Živý modul (`isLiveModule`) a index jeho VM v poli `ModuleVM`. */
interface LiveModule {
  readonly index: number;
  readonly module: Module;
}

/** Zhoda dvoch polí rovnakých plochých objektov (hodnoty primitívne). */
function sameItems<T extends object>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i] as Record<string, unknown>;
    return Object.entries(item).every(([key, value]) => other[key] === value);
  });
}

/** Zhoda živých polí VM so živým modulom (nič sa nemení bez udalosti, takže väčšinou bez alokácie nového VM). */
function liveModuleChanged(vm: ModuleVM, parts: LiveParts): boolean {
  const { gateLane } = vm;
  const next = parts.gateLane;
  if ((gateLane === undefined) !== (next === undefined)) return true;
  if (gateLane !== undefined && next !== undefined) {
    if (gateLane.kind !== next.kind || gateLane.mode !== next.mode || gateLane.roofPart !== next.roofPart || gateLane.step !== next.step || gateLane.progress !== next.progress) return true;
  }
  return !sameItems(vm.tpCells, parts.tpCells) || !sameItems(vm.holdingSlots, parts.holdingSlots) || !sameItems(vm.plugs, parts.plugs);
}

/**
 * Skladá `EntitiesVM` s cachovaním VM modulov podľa `revision`: pole modulov sa prepočíta len pri zmene revízie
 * (`ModulePlaced/Removed`, `RoadChanged`, `CargoMoved`… — pozri `SimBridge`), inak sa vráti tá istá referencia. Žeriavy,
 * lode, vozidlá a kamióny sa skladajú pri každom volaní (menia sa každý tick, polohu nenesie žiadna udalosť). Výnimka
 * z cache sú pozemné moduly, ktorých stav sa môže zmeniť aj bez udalosti (`isLiveModule`, napr. závora brány po prestavbe
 * ciest): ich VM sa pri každom volaní porovná so živým modulom a len pri skutočnej zmene hodnôt sa pole modulov nahradí
 * novým (s čerstvými VM zmenených modulov, ostatné ostávajú tie isté objekty) — inak ostáva referencia stabilná.
 * Volajúci musí revíziu zvyšovať pri každej udalosti, ktorá mení ostatné moduly, ich pripojenie, obsah apronov, skladov
 * alebo rámp.
 */
export class EntitiesVMBuilder {
  private modulesRevision: number | null = null;
  private modules: readonly ModuleVM[] = Object.freeze([]);
  private live: readonly LiveModule[] = [];
  /** Strecha pruhov brány (R4): prepočíta sa s modulmi pri zmene revízie. */
  private roofs: LaneRoofs = NO_ROOFS;
  /** Náklad lodí pre palubu (F6c): prepočíta sa len pri zmene revízie alebo počtu jednotiek na palube. */
  private readonly shipSplits = new ShipSplitCache();

  build(
    world: World,
    revision: number,
    prev: ShipPositions = NO_POSITIONS,
    prevVehicles: VehiclePoses = NO_VEHICLE_POSES,
    prevTrucks: TruckPoses = NO_TRUCK_POSES,
    storageOps: StorageOps = NO_STORAGE_OPS,
    lashingTotals: LashingTotals = NO_LASHING_TOTALS,
  ): SimEntitiesVM {
    if (this.modulesRevision !== revision) {
      const held = heldByModule(world);
      this.roofs = adjacentLaneGroups(world.modules.values());
      const modules: ModuleVM[] = [];
      const live: LiveModule[] = [];
      for (const module of world.modules.values()) {
        if (module.kind === CRANE_KIND) continue;
        if (isLiveModule(module)) live.push({ index: modules.length, module });
        modules.push(moduleVM(world, module, storageOps, held, this.roofs));
      }
      this.modules = Object.freeze(modules);
      this.live = live;
      this.modulesRevision = revision;
    } else if (this.live.length > 0) {
      this.refreshLiveModules(world);
    }
    this.shipSplits.prune(world);
    return Object.freeze({
      modules: this.modules,
      cranes: Object.freeze(craneVMs(world)),
      machines: Object.freeze(machineVMs(world)),
      ships: Object.freeze(shipVMs(world, prev, lashingTotals, (target, ship) => this.shipSplits.split(target, ship, revision))),
      vehicles: Object.freeze(vehicleVMs(world, prevVehicles)),
      trucks: Object.freeze(truckVMs(world, prevTrucks)),
      trains: Object.freeze(trainVMs(world)),
      crossings: Object.freeze(crossingVMs(world)),
    });
  }

  /** Nahradí pole modulov novým, ak sa hodnoty niektorého živého modulu zmenili (inak nechá tú istú referenciu). */
  private refreshLiveModules(world: World): void {
    let next: ModuleVM[] | null = null;
    for (const { index, module } of this.live) {
      const parts = liveParts(world, module, this.roofs);
      if (!liveModuleChanged(this.modules[index], parts)) continue;
      next ??= [...this.modules];
      const base: ModuleVM = { ...this.modules[index] };
      for (const key of LIVE_KEYS) delete base[key];
      next[index] = Object.assign(base, parts);
    }
    if (next !== null) this.modules = Object.freeze(next);
  }
}
