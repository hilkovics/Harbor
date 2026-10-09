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
 * - Pozemné moduly F4 (T04-08), každý len svoje pole:
 *   - brána (`TruckGate`): `gate = { queueLength, open, entryConnector }`; `open` = brána práve púšťa kamión (závora
 *     hore), `entryConnector` = index konektora v defe, ktorý je vstupnou stranou (`entrySide`, určuje ju svet z ciest;
 *     neurčená strana → 0, prvý konektor);
 *   - stojisko (`WaitingArea`): `waitingArea = { bays, occupied[] }`, `occupied[i]` = bay `i` je obsadený alebo rezervovaný;
 *   - rampa (`LoadingRamp`): `ramp = { docks, staged[], operational, stagedEmpty? }`, `staged[i]` = jednotky na docku `i`
 *     (ledger; F6c: vrátane prázdnych kontajnerov, ktoré sim do `stagedAt` nepočíta — `stagedEmpty[i]` ich vyčísľuje),
 *     `operational` = `World.isRampOperational`.
 *   Fronta brány a obsadenie stojiska sprevádzajú `Truck*` udalosti, ale nie všetky zmeny: `open` sa po prechode, ktorému
 *   zanikla výstupná strana (prestavba ciest za behu), vypne bez udalosti. Preto VM týchto dvoch modulov (`isLiveModule`)
 *   `EntitiesVMBuilder` porovnáva so živým modulom pri každom snapshote (plytko) a pole modulov je nové len pri skutočnej
 *   zmene hodnôt.
 * - Lode: `cargoSplit` (import / export / `empty` na palube; prekládka do importu na lodi A a do exportu na lodi B, `shipDeckSplit`,
 *   `unitsOnBoard` je ich súčet; `EntitiesVMBuilder` ho cachuje podľa revízie) a v stave `lashing`
 *   `lashing = { ticksLeft, ticksTotal }` (`ticksTotal` z udalosti `ShipLashingStarted`, ktorú si pamätá `LashingTracker`;
 *   bez záznamu vzorec z defu, `lashing.ts`).
 * - Lode, vozidlá a kamióny: `prevX/prevY` (a `prevHeading` vozidla a kamióna) sim nevedie — dodá ich volajúci
 *   (`SimBridge` si polohu pamätá pred každým tickom); nová loď / vozidlo / kamión bez záznamu má `prev = curr`.
 * - Vozidlá: `loaded` = v ledgeri je aspoň jedna jednotka `in_vehicle` u tohto vozidla; `carriesEmpty` (F6c) = je prázdny kontajner.
 * - Kamióny (`TruckVM`): `loaded` = aspoň jedna jednotka `in_truck`, `carriesEmpty` (F6c) = je prázdny kontajner (návrat prázdnych,
 *   výdaj exportérovi — kamión misie `collect` je pred naložením prázdny a po naložení nesie prázdny kontajner; po vyložení
 *   prázdneho si kamión hodnotu pamätá, `truckCarriesEmpty`). Sim vedie kamión vždy na bunke cesty (v `waiting`
 *   na vstupnej bunke stojiska, v `loading` na vonkajšej bunke konektora docku); prezentovaná poloha (`truckPose`) je však
 *   v `waiting` stred stojiska `stalls[truck.bay]` (kurz podľa rotácie modulu) a v `loading` stred docku `docks[truck.dock]`
 *   z manifestu s kabínou von z rampy (kamión do docku cúva, F5b č. 11; `dockHeading`). Rovnako v `unloading` (F6a: exportný
 *   kamión vykladá na dock rampy). V `loading` / `unloading` nesie VM aj `approach` — sim polohu (vonkajšia bunka konektora)
 *   a kurz príjazdu, z ktorých renderer kamión plynule vedie do docku (`dock-maneuver.ts`), a `prevState` (stav pred
 *   posledným tickom), z ktorého pozná práve dokončený príjazd (`to_dock` → `loading` / `unloading`). Pri zmene stavu
 *   z/do `waiting` / `loading` / `unloading` (skok do stojiska / z docku) je `prev = curr`, aby sa kamión neinterpoloval
 *   naprieč mapou; výjazd z docku (`loading` / `unloading` → `to_gate_out`) vedie renderer časom, nie interpoláciou ticku.
 *
 * Bez side-effectov a bez závislosti na DOM/Pixi/React.
 */
import type { ContainerVM, CraneVM, EntitiesVM, MachineVM, ModuleVM, ShipVM, StackVM, TruckVM, VehicleVM, ViewRotation } from '@render/view-models';
import type { CargoLocation, CargoUnit } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { moduleLanes } from '@sim/logistics';
import { BerthModule, CraneModule, RtgBlock, craneCargo, craneTrolley, EmptyDepot, StorageModule, TruckGate, VehicleDepot, YardBlock, type Module } from '@sim/modules';
import { SHIP_STATE_TRAITS, type Ship } from '@sim/ships';
import type { Truck } from '@sim/trucks';
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

/**
 * Index vstupného konektora brány v defe (`gate.connectors`, poradie ako `sprites.<defId>.connectors` v manifeste);
 * neurčená strana (svet ju ešte nevyhodnotil) → 0, prvý konektor.
 */
function entryConnectorOf(gate: TruckGate): number {
  const { entrySide } = gate;
  return entrySide === null ? 0 : Math.max(0, gate.connectors.indexOf(entrySide));
}

/** VM brány: fronta, závora a vstupný konektor. */
function gateVM(gate: TruckGate): NonNullable<ModuleVM['gate']> {
  return { queueLength: gate.queueLength, open: gate.isOpen, entryConnector: entryConnectorOf(gate) };
}

/** Zadržané (VGM hold) jednotky jedného modulu: všetky, po dockoch rampy a sloty apronu (utriedené vzostupne). */
interface HeldAt {
  count: number;
  readonly docks: Map<number, number>;
  readonly slots: number[];
}

/** Zadržané jednotky podľa `id` modulu (sklad, rampa, berth); modul bez zadržaných jednotiek záznam nemá. */
export type HeldByModule = ReadonlyMap<number, HeldAt>;

/** Bez zadržaných jednotiek (`holdIndex` je prázdny, F2–F6 testy, `moduleVMs(world)`). */
const NO_HELD: HeldByModule = new Map();

/** Modul, v ktorom jednotka leží, a jej miesto (dock rampy / slot apronu); jednotka mimo skladu, rampy a apronu → `undefined`. */
function heldPlace(location: CargoLocation): { moduleId: EntityId; dock?: number; slot?: number } | undefined {
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
      at = { count: 0, docks: new Map(), slots: [] };
      result.set(place.moduleId, at);
    }
    at.count += 1;
    if (place.dock !== undefined) at.docks.set(place.dock, (at.docks.get(place.dock) ?? 0) + 1);
    if (place.slot !== undefined) at.slots.push(place.slot);
  }
  return result;
}

/** `ModuleVM.held` modulu: rampa dopĺňa `docks[i]`, berth `slots`; sklad nesie len `count`. */
function heldVM(module: Module, at: HeldAt): NonNullable<ModuleVM['held']> {
  if (module instanceof BerthModule) return { count: at.count, slots: [...at.slots].sort((a, b) => a - b) };
  return { count: at.count };
}

/** Modul, ktorého VM sa môže zmeniť aj bez udalosti v `REVISION_EVENTS` (pozemné moduly s kamiónmi): porovnáva sa so živým modulom pri každom snapshote. */
export function isLiveModule(module: Module): boolean {
  return module instanceof TruckGate;
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
          topContainer = { sizeFt: unit.sizeFt as 20 | 40, containerType: unit.containerType, lineId: unit.lineId, direction: unit.direction };
        }
      }
      stacks.push({ bay, row, height, top: topContainer });
    }
  }
  return stacks;
}

/**
 * VM jedného modulu (mimo žeriavov); `storageOps` dopĺňa `lastStorageOp` skladom (animácia žeriavu dvora), `held` odznak
 * VGM hold skladu, rampy a berthu.
 */
function moduleVM(world: World, module: Module, storageOps: StorageOps = NO_STORAGE_OPS, held: HeldByModule = NO_HELD): ModuleVM {
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
  if (module instanceof TruckGate) vm.gate = gateVM(module);
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
  return vm;
}

/** Moduly sveta v poradí umiestnenia, bez žeriavov. */
export function moduleVMs(world: World, storageOps: StorageOps = NO_STORAGE_OPS): ModuleVM[] {
  const held = heldByModule(world);
  const result: ModuleVM[] = [];
  for (const module of world.modules.values()) {
    if (module.kind === CRANE_KIND) continue;
    result.push(moduleVM(world, module, storageOps, held));
  }
  return result;
}

/** VM kontajnera z jednotky ledgera. */
function containerOf(unit: CargoUnit): ContainerVM {
  return { sizeFt: unit.sizeFt as 20 | 40, containerType: unit.containerType, lineId: unit.lineId, direction: unit.direction };
}

/** Stroje blokov (R3, RTG): stred rámu v bunkách sveta (s rotáciou bloku), vozík a zdvih 0..1, náklad z `in_handler`. */
export function machineVMs(world: World): MachineVM[] {
  const result: MachineVM[] = [];
  for (const machine of world.machines.values()) {
    const block = world.modules.get(machine.blockId);
    if (!(block instanceof RtgBlock)) continue;
    const pose = machine.poseNow();
    const { w, h } = block.def.footprint;
    const lx = w / 2;
    const ly = pose.gantry + 0.5;
    const local = { 0: { x: lx, y: ly }, 90: { x: h - ly, y: lx }, 180: { x: w - lx, y: h - ly }, 270: { x: ly, y: w - lx } }[block.rotation];
    let cargo: ContainerVM | null = null;
    if (world.cargo.countAt('in_handler', machine.id) > 0) {
      const unitId = world.cargo.unitAtIndex('in_handler', machine.id, 0);
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unit !== undefined) cargo = containerOf(unit);
    }
    const { rows, maxTier } = block.geometry;
    result.push({
      id: machine.id,
      defId: machine.defId,
      blockId: machine.blockId,
      x: block.origin.x + local.x,
      y: block.origin.y + local.y,
      trolley: Math.min(1, Math.max(0, (pose.trolley + 1) / rows)),
      hoist: Math.min(1, Math.max(0, pose.hoist / maxTier)),
      state: machine.state,
      cargo,
    });
  }
  return result;
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
            cargo = { sizeFt: unit.sizeFt as 20 | 40, containerType: unit.containerType, lineId: unit.lineId, direction: unit.direction };
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

/** Stav kamióna, v ktorom sa kreslí v strede brány (`gate_pass` / `gate_pass_out`), nie na bunke cesty. */
const SLOT_STATES: ReadonlySet<string> = new Set<string>(GATE_PASS_STATES);

/** Zmeniteľná póza (bridge ju prepisuje pred každým tickom bez alokácie). */
export interface MutableTruckPose {
  x: number;
  y: number;
  heading: ViewRotation;
  state: string;
  /** Pamäť `truckCarriesEmpty` (zapisuje ju `SimBridge` pred každým tickom, `writeTruckPose` ju nemení). */
  carriesEmpty?: boolean;
}

/**
 * Zapíše prezentovanú pózu kamióna do `out`: v `waiting` stred stojiska `stalls[truck.bay]` čakacej plochy, v `loading`
 * a `unloading` stred docku `docks[truck.dock]` rampy (kurz = rotácia modulu), v `gate_pass` a `gate_pass_out` stred brány;
 * inak (aj keď modul alebo slot v manifeste chýba) poloha a kurz zo simu.
 */
export function writeTruckPose(world: World, truck: Truck, out: MutableTruckPose): void {
  let slot: { x: number; y: number } | undefined;
  let host: Module | undefined;
  if (GATE_PASS_STATES.has(truck.state)) {
    host = world.modules.get(truck.state === 'gate_pass_out' && truck.gateOutId !== null ? truck.gateOutId : truck.gateId);
    if (host instanceof TruckGate) {
      // Stred brány modulu
      slot = { x: host.origin.x + host.size.w / 2, y: host.origin.y + host.size.h / 2 };
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
          cargo = { sizeFt: unit.sizeFt as 20 | 40, containerType: unit.containerType, lineId: unit.lineId, direction: unit.direction };
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
  });
}

/** Živý modul (`isLiveModule`) a index jeho VM v poli `ModuleVM`. */
interface LiveModule {
  readonly index: number;
  readonly module: Module;
}

/** Plytká zhoda VM brány / stojiska so živým modulom (nič nealokuje); iné moduly sa nemenia bez udalosti. */
function liveModuleChanged(vm: ModuleVM, module: Module): boolean {
  if (module instanceof TruckGate) {
    const { gate } = vm;
    return gate === undefined || gate.queueLength !== module.queueLength || gate.open !== module.isOpen || gate.entryConnector !== entryConnectorOf(module);
  }
  return false;
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
      const modules: ModuleVM[] = [];
      const live: LiveModule[] = [];
      for (const module of world.modules.values()) {
        if (module.kind === CRANE_KIND) continue;
        if (isLiveModule(module)) live.push({ index: modules.length, module });
        modules.push(moduleVM(world, module, storageOps, held));
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
    });
  }

  /** Nahradí pole modulov novým, ak sa hodnoty niektorého živého modulu zmenili (inak nechá tú istú referenciu). */
  private refreshLiveModules(world: World): void {
    let next: ModuleVM[] | null = null;
    for (const { index, module } of this.live) {
      if (!liveModuleChanged(this.modules[index], module)) continue;
      next ??= [...this.modules];
      next[index] = moduleVM(world, module);
    }
    if (next !== null) this.modules = Object.freeze(next);
  }
}
