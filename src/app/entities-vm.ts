/**
 * Plnenie render view-modelov zo simu (ARCHITECTURE §13, docs/tasks/phase-02.md „Render view-modely“).
 *
 * Renderer nikdy nečíta `World`: `SimBridge` z neho každý tick zloží `EntitiesVM` (moduly, žeriavy, lode, vozidlá) a renderer
 * ich synchronizuje podľa `id`. Tu sú čisté funkcie (svet → ploché DTO) a `EntitiesVMBuilder`, ktorý VM modulov
 * cachuje podľa `revision` (moduly sa menia len udalosťami; žeriavy a lode sa menia každý tick, preto sa skladajú vždy).
 *
 * - Moduly: všetko okrem žeriavov (tie idú do `cranes`, `ModuleLayer` ich aj tak preskakuje). Berth nesie apron:
 *   obsadené sloty v poradí FIFO (`apron.units()`) so slotom (`slotOf`) a typom nákladu z ledgera.
 * - Žeriavy: `progress` = `phaseProgress` fázy (0 v `idle`/`blocked`), `holding` = držaná jednotka z ledgera.
 * - Sklady (`StorageModule`): `storage = { capacity, stored, reserved }` z modulu (obsadenie číta modul z ledgera).
 *   Moduly s cestným konektorom nesú `connected = world.isConnected(module)` (odznak „nepripojené“); ostatné (žeriav)
 *   pole nemajú.
 * - Pozemné moduly F4 (T04-08), každý len svoje pole:
 *   - brána (`TruckGate`): `gate = { queueLength, open, entryConnector }`; `open` = brána práve púšťa kamión (závora
 *     hore), `entryConnector` = index konektora v defe, ktorý sedí s `entrySide` (svet ho určuje z ciest; neurčená
 *     strana → 0, prvý konektor);
 *   - stojisko (`WaitingArea`): `waitingArea = { bays, occupied[] }`, `occupied[i]` = bay `i` je obsadený alebo rezervovaný;
 *   - rampa (`LoadingRamp`): `ramp = { docks, staged[], operational }`, `staged[i]` = jednotky na docku `i` (ledger),
 *     `operational` = `World.isRampOperational`.
 *   Fronta brány a obsadenie stojiska sa menia s kamiónmi (`Truck*` udalosti), `open` navyše samo behom prechodu bez
 *   udalosti — preto VM týchto dvoch modulov (`isLiveModule`) `EntitiesVMBuilder` skladá pri každom snapshote,
 *   nie podľa `revision`.
 * - Lode a vozidlá: `prevX/prevY` (a `prevHeading` vozidla) sim nevedie — dodá ich volajúci (`SimBridge` si polohu
 *   pamätá pred každým tickom); nová loď / nové vozidlo bez záznamu má `prev = curr`.
 * - Vozidlá: `loaded` = v ledgeri je aspoň jedna jednotka `in_vehicle` u tohto vozidla.
 *
 * Bez side-effectov a bez závislosti na DOM/Pixi/React.
 */
import type { CraneVM, EntitiesVM, ModuleVM, ShipVM, VehicleVM, ViewRotation } from '@render/view-models';
import type { EntityId } from '@sim/core';
import { BerthModule, CraneModule, LoadingRamp, StorageModule, TruckGate, WaitingArea, type Module, type PlacedConnector } from '@sim/modules';
import type { World } from '@sim/world';

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

/**
 * `EntitiesVM` zo SimBridge: `vehicles` je vždy vyplnené (v `EntitiesVM` ostáva voliteľné kvôli F2 fixtures v
 * `src/render/__demo__`, ktoré ho nemajú — sprísnenie by vyžadovalo zásah mimo `src/app`).
 */
export interface SimEntitiesVM extends EntitiesVM {
  readonly vehicles: readonly VehicleVM[];
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
 * Index konektora modulu (v poradí defu), ktorý sedí s `side`; `side === null` alebo bez zhody → 0 (renderer berie
 * chýbajúci `entryConnector` ako prvý konektor).
 */
function connectorIndexOf(module: Module, side: Pick<PlacedConnector, 'x' | 'y' | 'side'> | null): number {
  if (side === null) return 0;
  const index = module.connectors.findIndex((connector) => connector.x === side.x && connector.y === side.y && connector.side === side.side);
  return index < 0 ? 0 : index;
}

/** VM brány: fronta, závora a vstupný konektor. */
function gateVM(gate: TruckGate): NonNullable<ModuleVM['gate']> {
  return { queueLength: gate.queueLength, open: gate.isOpen, entryConnector: connectorIndexOf(gate, gate.entrySide) };
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

/** Modul, ktorého VM sa mení aj bez udalosti v `REVISION_EVENTS` (pozemné moduly s kamiónmi): skladá sa pri každom snapshote. */
export function isLiveModule(module: Module): boolean {
  return module instanceof TruckGate || module instanceof WaitingArea;
}

/** VM jedného modulu (mimo žeriavov). */
function moduleVM(world: World, module: Module): ModuleVM {
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
  }
  if (module instanceof TruckGate) vm.gate = gateVM(module);
  if (module instanceof WaitingArea) vm.waitingArea = waitingAreaVM(module);
  if (module instanceof LoadingRamp) vm.ramp = rampVM(world, module);
  if (hasRoadConnector(module)) vm.connected = world.isConnected(module);
  return vm;
}

/** Moduly sveta v poradí umiestnenia, bez žeriavov. */
export function moduleVMs(world: World): ModuleVM[] {
  const result: ModuleVM[] = [];
  for (const module of world.modules.values()) {
    if (module.kind === CRANE_KIND) continue;
    result.push(moduleVM(world, module));
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

/** Všetky entity sveta (bez cachovania); `prev` viď `shipVMs` a `vehicleVMs`. */
export function entitiesVM(world: World, prev: ShipPositions = NO_POSITIONS, prevVehicles: VehiclePoses = NO_VEHICLE_POSES): SimEntitiesVM {
  return Object.freeze({
    modules: Object.freeze(moduleVMs(world)),
    cranes: Object.freeze(craneVMs(world)),
    ships: Object.freeze(shipVMs(world, prev)),
    vehicles: Object.freeze(vehicleVMs(world, prevVehicles)),
  });
}

/** Modul s VM, ktorý sa skladá pri každom snapshote (`isLiveModule`), a jeho index v poli `ModuleVM`. */
interface LiveModule {
  readonly index: number;
  readonly module: Module;
}

/**
 * Skladá `EntitiesVM` s cachovaním VM modulov podľa `revision`: pole modulov sa prepočíta len pri zmene revízie
 * (`ModulePlaced/Removed`, `RoadChanged`, `CargoMoved`… — pozri `SimBridge`), inak sa vráti tá istá referencia. Žeriavy,
 * lode, vozidlá a kamióny sa skladajú pri každom volaní (menia sa každý tick, polohu nenesie žiadna udalosť). Výnimka
 * z cache sú pozemné moduly, ktorých stav sa mení aj bez udalosti (`isLiveModule`, napr. závora brány): ak nejaké
 * sú, vráti sa pri každom volaní nové pole, v ktorom sú len ich VM nahradené čerstvými (ostatné ostávajú tie isté
 * objekty). Volajúci musí revíziu zvyšovať pri každej udalosti, ktorá mení ostatné moduly, ich pripojenie, obsah
 * apronov, skladov alebo rámp.
 */
export class EntitiesVMBuilder {
  private modulesRevision: number | null = null;
  private modules: readonly ModuleVM[] = Object.freeze([]);
  private live: readonly LiveModule[] = [];

  build(world: World, revision: number, prev: ShipPositions = NO_POSITIONS, prevVehicles: VehiclePoses = NO_VEHICLE_POSES): SimEntitiesVM {
    if (this.modulesRevision !== revision) {
      const modules: ModuleVM[] = [];
      const live: LiveModule[] = [];
      for (const module of world.modules.values()) {
        if (module.kind === CRANE_KIND) continue;
        if (isLiveModule(module)) live.push({ index: modules.length, module });
        modules.push(moduleVM(world, module));
      }
      this.modules = Object.freeze(modules);
      this.live = live;
      this.modulesRevision = revision;
    }
    return Object.freeze({
      modules: this.live.length === 0 ? this.modules : this.withFreshLiveModules(world),
      cranes: Object.freeze(craneVMs(world)),
      ships: Object.freeze(shipVMs(world, prev)),
      vehicles: Object.freeze(vehicleVMs(world, prevVehicles)),
    });
  }

  /** Kópia cachovaného poľa s čerstvými VM live modulov. */
  private withFreshLiveModules(world: World): readonly ModuleVM[] {
    const modules = [...this.modules];
    for (const { index, module } of this.live) modules[index] = moduleVM(world, module);
    return Object.freeze(modules);
  }
}
