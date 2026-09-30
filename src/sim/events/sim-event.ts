/**
 * Udalosti simulácie (ARCHITECTURE §12.1, výber pre F1 + F2: `CargoMoved`, moduly, lode, žeriavy; F3: vozidlá, joby,
 * `NoStorageAvailable`; F4: `RampOperationalChanged`). Readonly DTO:
 * `World` ich zbiera v `EventBus` a vracia z `tick()` / `applyPending()`; prezentácia ich len číta. Nový typ udalosti =
 * nový člen únie (+ test).
 */
import type { CargoLocation } from '../cargo/cargo-location';
import type { ValidationReason } from '../commands/validation';
import type { EntityId } from '../core/entity-id';
import type { LedgerCategory } from '../economy/ledger-category';
import type { RampInoperativeReason } from '../modules/loading-ramp';
import type { CellCoord } from '../grid/grid';
import type { Rotation } from '../grid/rotation';
import type { VehicleState } from '../vehicles/vehicle-fsm';

/** Tick sa dokončil; `tick` = nová hodnota `clock.tick` (po kroku 1). */
export interface TickAdvancedEvent {
  readonly type: 'TickAdvanced';
  readonly tick: number;
}

/** Uzavrela sa herná hodina; `tick` = tick, ktorým hodina skončila (násobok `ticksPerHour`). */
export interface HourClosedEvent {
  readonly type: 'HourClosed';
  readonly tick: number;
}

/** Uzavrel sa herný deň (vždy spolu s `HourClosed` v tom istom ticku). */
export interface DayClosedEvent {
  readonly type: 'DayClosed';
  readonly tick: number;
}

/** Uzavrel sa herný mesiac (vždy spolu s `DayClosed` a `HourClosed`). */
export interface MonthClosedEvent {
  readonly type: 'MonthClosed';
  readonly tick: number;
}

/** Zmenila sa vrstva dopravy (`Cell.road`) na bunkách — render prekreslí ich a susedov, cache ciest sa zneplatní. */
export interface RoadChangedEvent {
  readonly type: 'RoadChanged';
  readonly cells: readonly CellCoord[];
}

/** Zmenila sa hotovosť; `cashCents` = nový stav, `deltaCents` = zmena (záporná = výdavok). */
export interface MoneyChangedEvent {
  readonly type: 'MoneyChanged';
  readonly cashCents: number;
  readonly deltaCents: number;
  readonly reason: LedgerCategory;
}

/** Zmenila sa rýchlosť hry (0 = pauza). */
export interface GameSpeedChangedEvent {
  readonly type: 'GameSpeedChanged';
  readonly speed: number;
}

/** Príkaz z fronty neprešiel validáciou pri aplikácii; stav sveta ostal nezmenený. */
export interface CommandRejectedEvent {
  readonly type: 'CommandRejected';
  readonly commandType: string;
  readonly reasons: readonly ValidationReason[];
}

/**
 * Jednotka nákladu zmenila polohu (§7.1) — emituje výlučne `CargoLedger.move`, jedna udalosť na presun.
 * `from`/`to` sú zmrazené lokácie ledgera; `tick` = `clock.tick` v okamihu presunu (počas príkazov pred krokom 1
 * je to ešte predchádzajúci tick). Vznik jednotky (`create`) udalosť nemá — ohlási ho udalosť zdroja (`ShipSpawned`).
 */
export interface CargoMovedEvent {
  readonly type: 'CargoMoved';
  readonly unitId: EntityId;
  readonly from: CargoLocation;
  readonly to: CargoLocation;
  readonly tick: number;
}

/**
 * Hráč postavil modul (`PlaceModule`, ADR-015). `x`, `y` = ľavý horný roh footprintu po rotácii, `cells` = footprint
 * row-major (pri žeriave bunky berthu, na ktorých stojí). Starter moduly mapy (`World.create`) udalosť nemajú —
 * prezentácia ich načíta zo snapshotu.
 */
export interface ModulePlacedEvent {
  readonly type: 'ModulePlaced';
  readonly moduleId: EntityId;
  readonly defId: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
  readonly cells: readonly CellCoord[];
}

/** Hráč odstránil modul (`RemoveModule`, ADR-015); `cells` = jeho footprint (bunky sú odteraz voľné, pri žeriave ostávajú berthu). */
export interface ModuleRemovedEvent {
  readonly type: 'ModuleRemoved';
  readonly moduleId: EntityId;
  readonly defId: string;
  readonly cells: readonly CellCoord[];
}

/** `SpawnShipDebug` (ADR-016) vytvoril loď na `seaLane[0]` s `units` jednotkami nákladu `on_ship` (vznik bez `CargoMoved`). */
export interface ShipSpawnedEvent {
  readonly type: 'ShipSpawned';
  readonly shipId: EntityId;
  readonly classId: string;
  readonly cargoTypeId: string;
  readonly units: number;
}

/** Loď dorazila k pridelenému kotvisku (`berthing → docked`); `berthIds` v poradí po pobreží. */
export interface ShipDockedEvent {
  readonly type: 'ShipDocked';
  readonly shipId: EntityId;
  readonly berthIds: readonly EntityId[];
}

/** Vyložená loď opúšťa kotvisko (`docked → undocking`); jej kotviská sú odteraz voľné. */
export interface ShipUndockedEvent {
  readonly type: 'ShipUndocked';
  readonly shipId: EntityId;
}

/** Loď opustila mapu (`outbound → despawned`) a bola odstránená z `world.ships`. */
export interface ShipDepartedEvent {
  readonly type: 'ShipDeparted';
  readonly shipId: EntityId;
}

/** Žeriav dokončil cyklus: jednotka `unitId` leží na aprone jeho kotviska (`in_crane → on_apron`). */
export interface CraneCycleDoneEvent {
  readonly type: 'CraneCycleDone';
  readonly craneId: EntityId;
  readonly unitId: EntityId;
}

/** Dôvody zablokovania žeriavu (§7.2); vo F2 len plný apron. */
export type CraneBlockedReason = 'apron_full';

/**
 * Žeriav prešiel do `blocked` (loď má náklad, apron nemá voľný nerezervovaný slot). Emituje sa najviac raz za hernú
 * hodinu na žeriav (`CraneModule.lastBlockedHour`, ADR-016).
 */
export interface CraneBlockedEvent {
  readonly type: 'CraneBlocked';
  readonly craneId: EntityId;
  readonly berthId: EntityId;
  readonly reason: CraneBlockedReason;
}

/**
 * `BuyVehicle` (T03-04) kúpil vozidlo: `vehicleId` s defom `defId` stojí `idle` na vonkajšej bunke konektora depa
 * `depotId` a depo ho eviduje vo `vehicleIds`. Cena ide samostatne v `MoneyChanged(vehicle_capex)`.
 */
export interface VehicleBoughtEvent {
  readonly type: 'VehicleBought';
  readonly vehicleId: EntityId;
  readonly defId: string;
  readonly depotId: EntityId;
}

/** `SellVehicle` (T03-04) predal nečinné vozidlo — zmizlo z `world.vehicles` aj z depa; refundácia v `MoneyChanged(vehicle_sale)`. */
export interface VehicleSoldEvent {
  readonly type: 'VehicleSold';
  readonly vehicleId: EntityId;
}

/**
 * Dispatcher (krok 5, ADR-018) vytvoril job `open`: jednotky `unitIds` na aprone berthu `fromModuleId` majú rezervovaný
 * slot v sklade `toModuleId`.
 */
export interface JobCreatedEvent {
  readonly type: 'JobCreated';
  readonly jobId: EntityId;
  readonly unitIds: readonly EntityId[];
  readonly fromModuleId: EntityId;
  readonly toModuleId: EntityId;
}

/** Dispatcher priradil jobu voľné vozidlo (`open → assigned`); vozidlo hneď prejde do `to_pickup` (`VehicleStateChanged`). */
export interface JobAssignedEvent {
  readonly type: 'JobAssigned';
  readonly jobId: EntityId;
  readonly vehicleId: EntityId;
}

/** Vozidlo uložilo poslednú jednotku jobu do cieľa (`dropping → done`); job zmizol z `world.jobs` (ADR-018). */
export interface JobDoneEvent {
  readonly type: 'JobDone';
  readonly jobId: EntityId;
}

/** Vozidlo zmenilo stav FSM (`VEHICLE_TRANSITIONS`, ADR-019); jedna udalosť na prechod. */
export interface VehicleStateChangedEvent {
  readonly type: 'VehicleStateChanged';
  readonly vehicleId: EntityId;
  readonly from: VehicleState;
  readonly to: VehicleState;
}

/**
 * Jednotka na aprone berthu `berthId` nemá kam ísť: žiadny pripojený a dosiahnuteľný sklad jej kategórie s voľnou
 * kapacitou (`stored + reserved < capacity`). Najviac raz za hernú hodinu na berth (`BerthModule.lastNoStorageHour`,
 * ADR-018); `cargoTypeId` = typ prvej takej jednotky vo FIFO.
 */
export interface NoStorageAvailableEvent {
  readonly type: 'NoStorageAvailable';
  readonly berthId: EntityId;
  readonly cargoTypeId: string;
}

/**
 * Zmenil sa prevádzkový stav rampy (ADR-022): prevádzkovosť alebo dôvod neprevádzkovosti — aj pri prvom vyhodnotení
 * novej rampy. Emituje ho svet po príkaze, ktorý zmenil cesty alebo moduly (po udalostiach príkazu); `reason` je `null`
 * práve pri `operational: true`.
 */
export interface RampOperationalChangedEvent {
  readonly type: 'RampOperationalChanged';
  readonly rampId: EntityId;
  readonly operational: boolean;
  readonly reason: RampInoperativeReason | null;
}

export type SimEvent =
  | TickAdvancedEvent
  | HourClosedEvent
  | DayClosedEvent
  | MonthClosedEvent
  | RoadChangedEvent
  | MoneyChangedEvent
  | GameSpeedChangedEvent
  | CommandRejectedEvent
  | CargoMovedEvent
  | ModulePlacedEvent
  | ModuleRemovedEvent
  | ShipSpawnedEvent
  | ShipDockedEvent
  | ShipUndockedEvent
  | ShipDepartedEvent
  | CraneCycleDoneEvent
  | CraneBlockedEvent
  | VehicleBoughtEvent
  | VehicleSoldEvent
  | JobCreatedEvent
  | JobAssignedEvent
  | JobDoneEvent
  | VehicleStateChangedEvent
  | NoStorageAvailableEvent
  | RampOperationalChangedEvent;

/** Názov typu udalosti (`'TickAdvanced' | 'HourClosed' | …`). */
export type SimEventType = SimEvent['type'];

/** Člen únie podľa typu, napr. `SimEventOf<'MoneyChanged'>`. */
export type SimEventOf<T extends SimEventType> = Extract<SimEvent, { readonly type: T }>;
