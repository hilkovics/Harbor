/**
 * Zaručené miesto v sklade pre kamión s dovozom (F6d, ADR-035): kamión `delivery` (export, návrat prázdneho) dostane vjazd z vnútrozemia len
 * vtedy, keď jeho kontajner bude mať kde skončiť. Inak by ho vyložil na dock rampy a ten by ostal obsadený (vozidlo nemá do čoho uložiť), staging by
 * sa zaplnil a kamióny nemohli ani vykladať, ani odvážať import.
 *
 * Miesto = Σ voľné miesta skladov, ktoré smer prijmú (`StorageModule.acceptsDirection`), kategória sedí a sú dosiahnuteľné po ceste z rampy
 * (`freeCount`: kapacita − uložené − rezervované jobmi) mínus **rozbehnuté** jednotky toho smeru — jednotky v kamiónoch `delivery`, ktoré ešte
 * nemajú job, a jednotky na docku rampy bez jobu (čakajú na vozidlo). Jednotka s jobom už drží rezerváciu, je teda vo `freeCount`.
 *
 * Návrat prázdneho ide len do depa prázdnych, keď nejaké vo svete je (M1, ADR-034 dodatok T6C-07b: dvor sa prázdnymi nezapĺňa); bez depa do bežného
 * skladu (fallback). `free` je miesto bez ohľadu na rozbehnuté jednotky — rozlišuje „miesta niet vôbec“ (návrat prázdneho sa zahodí) od „miesto
 * zaberú kamióny na ceste“ (kamión počká vo vnútrozemí).
 */
import type { CargoDirection } from '../cargo/cargo-unit';
import type { CargoCategory } from '../defs/types';
import { depotFreeSlots } from '../logistics/empty-stock';
import { distanceBetweenModules } from '../logistics/module-access';
import type { LoadingRamp } from '../modules/loading-ramp';
import { StorageModule } from '../modules/storage-module';
import type { World } from '../world/world';

/** Miesto v skladoch pre jeden smer: `free` voľné miesta, `awaiting` rozbehnuté jednotky, ktoré ho ešte nemajú rezervované. */
export interface InboundRoom {
  readonly free: number;
  readonly awaiting: number;
}

/**
 * Jednotky smeru `direction`, ktoré ešte nemajú rezervované miesto v sklade: jednotky v kamiónoch `delivery` (`in_truck`) a jednotky na docku
 * rampy čakajúce na vozidlo (`at_ramp` bez jobu a mimo poverenia kamióna `collect`; náklad na odvoz sa nepočíta). Prechod kamiónov a rámp — volá sa
 * len pri rozhodovaní o vjazde, nie v každom ticku.
 */
export function unitsAwaitingStorage(world: World, direction: CargoDirection): number {
  let count = 0;
  for (const truck of world.trucks.values()) {
    if (truck.mission !== 'delivery') continue;
    const aboard = world.cargo.countAt('in_truck', truck.id);
    for (let i = 0; i < aboard; i++) {
      const unitId = world.cargo.unitAtIndex('in_truck', truck.id, i);
      if (unitId !== undefined && world.cargo.get(unitId)?.direction === direction) count += 1;
    }
  }
  for (const ramp of world.landsideModules.ramps) {
    const docked = world.cargo.countAt('at_ramp', ramp.id);
    for (let i = 0; i < docked; i++) {
      const unitId = world.cargo.unitAtIndex('at_ramp', ramp.id, i);
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unit === undefined || unit.direction !== direction || world.isPickupCargo(unit)) continue;
      if (world.jobOfUnit(unit.id) === undefined && world.emptyFlow.errandOfUnit(unit.id) === undefined) count += 1;
    }
  }
  return count;
}

/** Súčet voľných miest skladov kategórie `category`, ktoré prijmú smer `direction` a sú dosiahnuteľné z rampy `ramp`; prázdne neberú depo (rieši `inboundRoom`). */
function storageFree(world: World, ramp: LoadingRamp, category: CargoCategory, direction: CargoDirection): number {
  let free = 0;
  for (const module of world.modules.values()) {
    if (!(module instanceof StorageModule) || module.category !== category || !module.acceptsDirection(direction)) continue;
    if (distanceBetweenModules(world, ramp, module) !== Infinity) free += module.freeCount;
  }
  return free;
}

/** Miesto pre jednotku smeru `direction` kategórie `category` privezenú kamiónom na rampu `ramp` (viď hlavička). */
export function inboundRoom(world: World, ramp: LoadingRamp, category: CargoCategory, direction: CargoDirection): InboundRoom {
  const awaiting = unitsAwaitingStorage(world, direction);
  if (direction === 'empty') {
    const depot = depotFreeSlots(world, ramp, category);
    if (depot !== undefined) return { free: depot, awaiting };
  }
  return { free: storageFree(world, ramp, category, direction), awaiting };
}

/** Má jednotka z kamióna kde skončiť (`free − awaiting ≥ 1`)? */
export function hasInboundRoom(room: InboundRoom): boolean {
  return room.free - room.awaiting > 0;
}
