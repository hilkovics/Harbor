/**
 * Plnenie render view-modelov zo simu (ARCHITECTURE §13, docs/tasks/phase-02.md „Render view-modely“).
 *
 * Renderer nikdy nečíta `World`: `SimBridge` z neho každý tick zloží `EntitiesVM` (moduly, žeriavy, lode, vozidlá,
 * kamióny) a renderer ich synchronizuje podľa `id`. Tu sú čisté funkcie (svet → ploché DTO) a `EntitiesVMBuilder`,
 * ktorý VM modulov cachuje podľa `revision` (moduly sa menia len udalosťami; žeriavy, lode, vozidlá a kamióny sa menia
 * každý tick, preto sa skladajú vždy).
 *
 * - Moduly: všetko okrem žeriavov (tie idú do `cranes`, `ModuleLayer` ich aj tak preskakuje). Berth nesie apron:
 *   obsadené sloty v poradí FIFO (`apron.units()`) so slotom (`slotOf`) a typom nákladu z ledgera.
 * - Žeriavy: `progress` = `phaseProgress` fázy (0 v `idle`/`blocked`), `holding` = držaná jednotka z ledgera.
 * - Sklady (`StorageModule`): `storage = { capacity, stored, reserved }` z modulu (obsadenie číta modul z ledgera) a
 *   `lastStorageOp = { slot, tick, kind }` — posledné uloženie / vzatie kontajnera na slote (F5b č. 8, animácia portálového
 *   žeriavu dvora). Sim ju nevedie: skladá ju `SimBridge` z udalostí `CargoMoved` (`storage-ops.ts`) a podáva builderu.
 *   Moduly s cestným konektorom nesú `connected = world.isConnected(module)` (odznak „nepripojené“); ostatné (žeriav)
 *   pole nemajú.
 * - Pozemné moduly F4 (T04-08), každý len svoje pole:
 *   - brána (`TruckGate`): `gate = { queueLength, open, entryConnector }`; `open` = brána práve púšťa kamión (závora
 *     hore), `entryConnector` = index konektora v defe, ktorý je vstupnou stranou (`entrySide`, určuje ju svet z ciest;
 *     neurčená strana → 0, prvý konektor);
 *   - stojisko (`WaitingArea`): `waitingArea = { bays, occupied[] }`, `occupied[i]` = bay `i` je obsadený alebo rezervovaný;
 *   - rampa (`LoadingRamp`): `ramp = { docks, staged[], operational }`, `staged[i]` = jednotky na docku `i` (ledger),
 *     `operational` = `World.isRampOperational`.
 *   Fronta brány a obsadenie stojiska sprevádzajú `Truck*` udalosti, ale nie všetky zmeny: `open` sa po prechode, ktorému
 *   zanikla výstupná strana (prestavba ciest za behu), vypne bez udalosti. Preto VM týchto dvoch modulov (`isLiveModule`)
 *   `EntitiesVMBuilder` porovnáva so živým modulom pri každom snapshote (plytko) a pole modulov je nové len pri skutočnej
 *   zmene hodnôt.
 * - Lode, vozidlá a kamióny: `prevX/prevY` (a `prevHeading` vozidla a kamióna) sim nevedie — dodá ich volajúci
 *   (`SimBridge` si polohu pamätá pred každým tickom); nová loď / vozidlo / kamión bez záznamu má `prev = curr`.
 * - Vozidlá: `loaded` = v ledgeri je aspoň jedna jednotka `in_vehicle` u tohto vozidla.
 * - Kamióny (`TruckVM`): `loaded` = aspoň jedna jednotka `in_truck`. Sim vedie kamión vždy na bunke cesty (v `waiting`
 *   na vstupnej bunke stojiska, v `loading` na vonkajšej bunke konektora docku); prezentovaná poloha (`truckPose`) je však
 *   v `waiting` stred stojiska `stalls[truck.bay]` (kurz podľa rotácie modulu) a v `loading` stred docku `docks[truck.dock]`
 *   z manifestu s kabínou von z rampy (kamión do docku cúva, F5b č. 11; `dockHeading`). V `loading` nesie VM aj `approach` — sim
 *   polohu (vonkajšia bunka konektora) a kurz príjazdu, z ktorých renderer kamión plynule vedie do docku (`dock-maneuver.ts`),
 *   a `prevState` (stav pred posledným tickom), z ktorého pozná práve dokončený príjazd (`to_dock` → `loading`). Pri zmene
 *   stavu z/do `waiting` / `loading` (skok do stojiska / z docku) je `prev = curr`, aby sa kamión neinterpoloval naprieč mapou;
 *   výjazd z docku (`loading` → `to_gate_out`) vedie renderer časom, nie interpoláciou ticku.
 *
 * Bez side-effectov a bez závislosti na DOM/Pixi/React.
 */
import { dockHeading, findDockCenter, findStallCenter, type SlotHost } from '@render/module-slots';
import type { CraneVM, EntitiesVM, ModuleVM, ShipVM, TruckVM, VehicleVM, ViewRotation } from '@render/view-models';
import type { EntityId } from '@sim/core';
import { BerthModule, CraneModule, LoadingRamp, StorageModule, TruckGate, WaitingArea, type Module } from '@sim/modules';
import type { Truck } from '@sim/trucks';
import type { World } from '@sim/world';
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
}

/** Predchádzajúce pózy kamiónov podľa `id` kamióna; chýbajúci záznam = nový kamión (`prev = curr`). */
export type TruckPoses = ReadonlyMap<number, TruckPose>;

const NO_TRUCK_POSES: TruckPoses = new Map();

/** Bez zaznamenaných operácií skladov (F2–F5 testy, `moduleVMs(world)`). */
const NO_STORAGE_OPS: StorageOps = new Map();

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

/** Typ jednotky z ledgera; jednotka bez záznamu je porušený invariant (indexy apronu a ledgera sa rozišli). */
function cargoTypeOf(world: World, unitId: EntityId, holder: string): string {
  const unit = world.cargo.get(unitId);
  if (unit === undefined) throw new Error(`entitiesVM: jednotka #${String(unitId)} (${holder}) nie je v ledgeri`);
  return unit.typeId;
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

/** VM stojiska: `occupied[i]` = bay `i` drží kamión (obsadený alebo rezervovaný). */
function waitingAreaVM(area: WaitingArea): NonNullable<ModuleVM['waitingArea']> {
  const occupied: boolean[] = [];
  for (let bay = 0; bay < area.bays; bay++) occupied.push(area.bayHolder(bay) !== null);
  return { bays: area.bays, occupied };
}

/** VM rampy: pripravené jednotky po dockoch a prevádzkovosť. */
function rampVM(world: World, ramp: LoadingRamp): NonNullable<ModuleVM['ramp']> {
  const staged: number[] = [];
  for (let dock = 0; dock < ramp.docks; dock++) staged.push(ramp.stagedAt(dock));
  return { docks: ramp.docks, staged, operational: world.isRampOperational(ramp) };
}

/** Modul, ktorého VM sa môže zmeniť aj bez udalosti v `REVISION_EVENTS` (pozemné moduly s kamiónmi): porovnáva sa so živým modulom pri každom snapshote. */
export function isLiveModule(module: Module): boolean {
  return module instanceof TruckGate || module instanceof WaitingArea;
}

/** VM jedného modulu (mimo žeriavov); `storageOps` dopĺňa `lastStorageOp` skladom (animácia žeriavu dvora). */
function moduleVM(world: World, module: Module, storageOps: StorageOps = NO_STORAGE_OPS): ModuleVM {
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
    const units: { slot: number; unitId: number; typeId: string }[] = [];
    for (const unitId of apron.units()) {
      const slot = apron.slotOf(unitId);
      if (slot === undefined) throw new Error(`entitiesVM: jednotka #${String(unitId)} je vo FIFO apronu ${module.label}, ale nemá slot`);
      units.push({ slot, unitId, typeId: cargoTypeOf(world, unitId, module.label) });
    }
    vm.apron = { capacity: apron.capacity, units };
  }
  if (module instanceof StorageModule) {
    vm.storage = { capacity: module.capacity, stored: module.storedCount, reserved: module.reservedCount };
    const op = storageOps.get(module.id);
    if (op !== undefined) vm.lastStorageOp = { slot: op.slot, tick: op.tick, kind: op.kind };
  }
  if (module instanceof TruckGate) vm.gate = gateVM(module);
  if (module instanceof WaitingArea) vm.waitingArea = waitingAreaVM(module);
  if (module instanceof LoadingRamp) vm.ramp = rampVM(world, module);
  if (hasRoadConnector(module)) vm.connected = world.isConnected(module);
  return vm;
}

/** Moduly sveta v poradí umiestnenia, bez žeriavov. */
export function moduleVMs(world: World, storageOps: StorageOps = NO_STORAGE_OPS): ModuleVM[] {
  const result: ModuleVM[] = [];
  for (const module of world.modules.values()) {
    if (module.kind === CRANE_KIND) continue;
    result.push(moduleVM(world, module, storageOps));
  }
  return result;
}

/** Žeriavy sveta v poradí umiestnenia. */
export function craneVMs(world: World): CraneVM[] {
  const result: CraneVM[] = [];
  for (const module of world.modules.values()) {
    if (!(module instanceof CraneModule)) continue;
    const held = module.heldUnitId;
    const idlePhase = module.state === 'idle' || module.state === 'blocked';
    result.push({
      id: module.id,
      defId: module.def.id,
      berthId: module.berthId,
      x: module.origin.x,
      y: module.origin.y,
      rotation: module.rotation,
      state: module.state,
      progress: idlePhase ? 0 : Math.min(1, Math.max(0, module.phaseProgress)),
      holding: held === null ? null : { unitId: held, typeId: cargoTypeOf(world, held, module.label) },
    });
  }
  return result;
}

/** Lode sveta v poradí `world.ships` (vzostupne podľa id); `prev` z predchádzajúceho ticku (chýba → `prev = curr`). */
export function shipVMs(world: World, prev: ShipPositions = NO_POSITIONS): ShipVM[] {
  const result: ShipVM[] = [];
  for (const ship of world.ships.values()) {
    const before = prev.get(ship.id);
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
      unitsOnBoard: world.cargo.countAt('on_ship', ship.id),
      capacityUnits: ship.def.capacityUnits,
    });
  }
  return result;
}

/** Vozidlá sveta vzostupne podľa id (`world.vehicles`); `prev` z predchádzajúceho ticku (chýba → `prev = curr`). */
export function vehicleVMs(world: World, prev: VehiclePoses = NO_VEHICLE_POSES): VehicleVM[] {
  const result: VehicleVM[] = [];
  for (const vehicle of world.vehicles.values()) {
    const before = prev.get(vehicle.id);
    result.push({
      id: vehicle.id,
      defId: vehicle.defId,
      x: vehicle.x,
      y: vehicle.y,
      prevX: before?.x ?? vehicle.x,
      prevY: before?.y ?? vehicle.y,
      heading: vehicle.heading,
      prevHeading: before?.heading ?? vehicle.heading,
      loaded: world.cargo.countAt('in_vehicle', vehicle.id) > 0,
      state: vehicle.state,
    });
  }
  return result;
}

/** Modul ako hostiteľ stojísk / dokov: id defu (kľúč v manifeste) a footprint po rotácii. */
function slotHostOf(module: Module): SlotHost {
  return { defId: module.def.id, x: module.origin.x, y: module.origin.y, w: module.size.w, h: module.size.h, rotation: module.rotation };
}

/** Stav kamióna, v ktorom sa kreslí v strede stojiska (`waiting`) alebo docku (`loading`), nie na bunke cesty, kde ho vedie sim. */
const SLOT_STATES: ReadonlySet<string> = new Set<string>(['waiting', 'loading']);

/** Zmeniteľná póza (bridge ju prepisuje pred každým tickom bez alokácie). */
export interface MutableTruckPose {
  x: number;
  y: number;
  heading: ViewRotation;
  state: string;
}

/**
 * Zapíše prezentovanú pózu kamióna do `out`: v `waiting` stred stojiska `stalls[truck.bay]` čakacej plochy, v `loading`
 * stred docku `docks[truck.dock]` rampy (kurz = rotácia modulu); inak (aj keď modul alebo slot v manifeste chýba) poloha
 * a kurz zo simu.
 */
export function writeTruckPose(world: World, truck: Truck, out: MutableTruckPose): void {
  let slot: { x: number; y: number } | undefined;
  let host: Module | undefined;
  if (truck.state === 'waiting' && truck.bay !== null) {
    host = world.modules.get(truck.waitingAreaId);
    slot = host instanceof WaitingArea ? findStallCenter(slotHostOf(host), truck.bay) : undefined;
  } else if (truck.state === 'loading') {
    host = world.modules.get(truck.rampId);
    slot = host instanceof LoadingRamp ? findDockCenter(slotHostOf(host), truck.dock) : undefined;
  }
  out.x = slot?.x ?? truck.x;
  out.y = slot?.y ?? truck.y;
  if (slot === undefined || host === undefined) out.heading = truck.heading;
  else if (truck.state === 'loading') out.heading = dockHeading(truck, slot); // do docku kamión cúva: kabína von z rampy
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
 * stavu z/do `waiting` / `loading` (sim kamión presunul zo stojiska / na výjazd, resp. z cesty do stojiska / docku)
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
    const vm: TruckVM = {
      id: truck.id,
      defId: truck.defId,
      x: pose.x,
      y: pose.y,
      prevX: before.x,
      prevY: before.y,
      heading: pose.heading,
      prevHeading: before.heading,
      loaded: world.cargo.countAt('in_truck', truck.id) > 0,
      state: truck.state,
    };
    if (last !== undefined) vm.prevState = last.state;
    // v doku je cieľová póza v `x`, `y`, `heading`; sim poloha (vonkajšia bunka konektora) je východisko manévru cúvania
    if (truck.state === 'loading' && (pose.x !== truck.x || pose.y !== truck.y)) {
      vm.approach = { x: truck.x, y: truck.y, heading: truck.heading };
    }
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
): SimEntitiesVM {
  return Object.freeze({
    modules: Object.freeze(moduleVMs(world, storageOps)),
    cranes: Object.freeze(craneVMs(world)),
    ships: Object.freeze(shipVMs(world, prev)),
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
  if (module instanceof WaitingArea) {
    const area = vm.waitingArea;
    if (area === undefined || area.bays !== module.bays) return true;
    for (let bay = 0; bay < module.bays; bay++) {
      if (area.occupied[bay] !== (module.bayHolder(bay) !== null)) return true;
    }
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

  build(
    world: World,
    revision: number,
    prev: ShipPositions = NO_POSITIONS,
    prevVehicles: VehiclePoses = NO_VEHICLE_POSES,
    prevTrucks: TruckPoses = NO_TRUCK_POSES,
    storageOps: StorageOps = NO_STORAGE_OPS,
  ): SimEntitiesVM {
    if (this.modulesRevision !== revision) {
      const modules: ModuleVM[] = [];
      const live: LiveModule[] = [];
      for (const module of world.modules.values()) {
        if (module.kind === CRANE_KIND) continue;
        if (isLiveModule(module)) live.push({ index: modules.length, module });
        modules.push(moduleVM(world, module, storageOps));
      }
      this.modules = Object.freeze(modules);
      this.live = live;
      this.modulesRevision = revision;
    } else if (this.live.length > 0) {
      this.refreshLiveModules(world);
    }
    return Object.freeze({
      modules: this.modules,
      cranes: Object.freeze(craneVMs(world)),
      ships: Object.freeze(shipVMs(world, prev)),
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
