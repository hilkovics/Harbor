/**
 * Udalosti simulácie (ARCHITECTURE §12.1, výber pre F1 + F2: `CargoMoved`, moduly, lode, žeriavy; F3: vozidlá, joby,
 * `NoStorageAvailable`; F4: `JobCancelled`, kamióny `TruckSpawned`, `TruckStateChanged`,
 * `TruckExited`; F5: `DayClosedSummary`, `MonthlyReport`, `GameOver`, kontrakty `Contract*` a
 * `PenaltyApplied` — ADR-026; F6a export a booking — ADR-032: `ExportArrived`, `UnitRolled`, `VgmHoldStarted`,
 * `VgmHoldReleased`, `CutoffWarning`, `CutoffPassed`, `UnitLoaded`, `DualCycle`, `ShipLashingStarted`,
 * `ExportShipped`, `TruckUnloaded`, `BookingPenaltyApplied`; T6A-01 ich len deklaruje, emitujú ich T6A-04/05). Readonly DTO:
 * `World` ich zbiera v `EventBus` a vracia z `tick()` / `applyPending()`; prezentácia ich len číta. Nový typ udalosti =
 * nový člen únie (+ test).
 */
import type { CargoLocation } from '../cargo/cargo-location';
import type { ValidationReason } from '../commands/validation';
import type { ContractState } from '../contracts/contract-fsm';
import type { ContractId, EntityId, VoyageId } from '../core/entity-id';
import type { DaySummary, MonthSummary } from '../economy/ledger';
import type { LedgerCategory } from '../economy/ledger-category';
import type { JobCancelReason } from '../logistics/transport-job';
import type { CellCoord } from '../grid/grid';
import type { Rotation } from '../grid/rotation';
import type { TruckState } from '../trucks/truck-fsm';
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

/**
 * `spawnShip` (`SpawnShipDebug`, loď kontraktu; ADR-016, ADR-026) vytvoril loď na `seaLane[0]` s `units` jednotkami
 * nákladu `on_ship` (vznik bez `CargoMoved`). Loď s voľným cieľom hneď vpláva (`inbound`), inak čaká pred vstupom mimo
 * mapy (`arriving`, ADR-029 — prezentácia ju nekreslí, `SHIP_STATE_TRAITS.onMap`).
 */
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

/**
 * Vyložená loď opúšťa kotvisko (`docked → undocking`) po trase, ktorá je voľná až na koniec dráhy. Kotviská drží, kým
 * nedopláva na koniec dráhy (`undocking → outbound`), potom ich uvoľní bez ďalšej udalosti (ADR-029).
 */
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
 * STS preskočil reefer, lebo plánovač nemá pre neho voľnú zásuvku (R5, ADR-042; docs/TERMINAL_2.md §6.7): jednotka čaká na palube, kým sa zásuvka neuvoľní. Emituje sa pri
 * prvom preskočení a potom najviac raz za hernú hodinu (toast pre hráča).
 */
export interface ReeferSkippedEvent {
  readonly type: 'ReeferSkipped';
  readonly unitId: EntityId;
  readonly craneId: EntityId;
  readonly berthId: EntityId;
}

/** Dôvody reklamácie reeferu: `unpowered` (dlho bez napájania), `waiting` (dlho čakal na palube bez zásuvky), `alarm` (technik neprišiel včas). */
export const REEFER_CLAIM_REASONS = ['unpowered', 'waiting', 'alarm'] as const;
export type ReeferClaimReason = (typeof REEFER_CLAIM_REASONS)[number];

/** Reklamácia za reefer (R5, ADR-042): `cents` sa strhli z hotovosti ako `penalty`. */
export interface ReeferClaimEvent {
  readonly type: 'ReeferClaim';
  readonly unitId: EntityId;
  readonly reason: ReeferClaimReason;
  readonly cents: number;
}

/** Zapojený reefer v sklade ohlásil alarm; technik musí začať zásah do `alarmResponseHours` (R5, ADR-042). */
export interface ReeferAlarmEvent {
  readonly type: 'ReeferAlarm';
  readonly unitId: EntityId;
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
 * Dispatcher (krok 5, ADR-018, ADR-023) vytvoril job `open`: jednotky `unitIds` u modulu `fromModuleId` majú rezervované
 * miesto v module `toModuleId` — inbound z apronu berthu do slotu skladu, outbound zo skladu na staging dock rampy.
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

/**
 * Dispatcher (krok 5, ADR-023) zrušil job bez vozidla (`open → cancelled`), lebo jeho cieľ prestal byť použiteľný
 * (`reason`: rampa neprevádzková alebo zo zdroja nedosiahnuteľná). Rezervácia v cieli sa uvoľnila, jednotky ostali na
 * zdroji a job zmizol z `world.jobs`; dispatcher im v tom istom kroku môže vytvoriť nový job k inej rampe. `rehandle_stalled` (TR2-06b) hlási `VehicleSystem`
 * (krok 6b): vozidlo, ktoré už job malo, pri zdroji nenašlo cieľ rehandlingu a uvoľnilo sa (`picking → cancelled`).
 */
export interface JobCancelledEvent {
  readonly type: 'JobCancelled';
  readonly jobId: EntityId;
  readonly reason: JobCancelReason;
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
 * Kamión `truckId` vznikol na road portáli (krok 8, ADR-024, ADR-041): má lístok na blok `blockId` (cieľ jeho prvej zastávky na TP) s rezerváciou TP alebo státia odstavnej plochy.
 */
export interface TruckSpawnedEvent {
  readonly type: 'TruckSpawned';
  readonly truckId: EntityId;
  readonly blockId: EntityId;
}

/** Kamión zmenil stav FSM (`TRUCK_TRANSITIONS`, ADR-024); jedna udalosť na prechod (aj posledný `to_portal → exited`). */
export interface TruckStateChangedEvent {
  readonly type: 'TruckStateChanged';
  readonly truckId: EntityId;
  readonly from: TruckState;
  readonly to: TruckState;
}

/**
 * Kamión opustil mapu na road portáli: jeho `units` jednotiek prešlo `in_truck → exported` (každá s `CargoMoved`
 * v tom istom ticku) a kamión zmizol z `world.trucks` (ADR-024). `exported` je konečný stav (§7.1).
 */
export interface TruckExitedEvent {
  readonly type: 'TruckExited';
  readonly truckId: EntityId;
  readonly units: number;
}

/** Vlak prišiel z koľajového portálu a vyrazil k termináli (R6, ADR-043): `delayTicks` = oneskorenie oproti cestovnému poriadku, `exportUnits` = jednotky exportu, ktoré privážal. */
export interface TrainArrivedEvent {
  readonly type: 'TrainArrived';
  readonly trainId: EntityId;
  readonly terminalId: EntityId;
  readonly delayTicks: number;
  readonly exportUnits: number;
}

/** Vlak odišiel cez koľajový portál (R6, ADR-043): `units` jednotiek prešlo `in_train → exported`, `turnaroundTicks` = od vzniku vlaku po odchod; `undeliveredUnits` = z `units` nevyložený náklad z príchodu
 * (odchod po rešpitnej lehote `departGraceMinutes`, buffer bol plný; jednotky odišli späť, ledger ich vedie ako `exported`, TR6-02c). */
export interface TrainDepartedEvent {
  readonly type: 'TrainDeparted';
  readonly trainId: EntityId;
  readonly units: number;
  readonly undeliveredUnits: number;
  readonly turnaroundTicks: number;
}

/** Jednotka exportu prišla vlakom (`create` v `in_train` na portáli) a je zaregistrovaná na booking kontraktu (R6, ADR-043; ako `ExportArrived` pri kamióne). */
export interface TrainExportArrivedEvent {
  readonly type: 'TrainExportArrived';
  readonly contractId: ContractId;
  readonly unitId: EntityId;
  readonly trainId: EntityId;
}

/**
 * Zápcha (ADR-037 bod 8, rozhodnutie R1 č. 12): nosič `carrierId` čaká na voľný slot prvýkrát `traffic.stuckTicks` tickov v kuse.
 * `cell` = bunka, na ktorej čaká a `blockerIds` = nosiče, ktoré držia sloty jeho blokovanej bunky (vzostupne podľa id; prázdne pri
 * pravidle bez držiteľa, napr. fronta brány nesmie siahať do križovatky). Najviac raz za jedno čakanie; koniec hlási `TrafficJamCleared`.
 */
export interface TrafficJamEvent {
  readonly type: 'TrafficJam';
  readonly carrierId: EntityId;
  readonly carrierKind: 'vehicle' | 'truck';
  readonly cell: { readonly x: number; readonly y: number };
  readonly blockerIds: readonly EntityId[];
}

/** Nosič, ktorému bola hlásená zápcha (`TrafficJam`), sa pohol (alebo opustil cestu): zápcha sa rozpustila. */
export interface TrafficJamClearedEvent {
  readonly type: 'TrafficJamCleared';
  readonly carrierId: EntityId;
  readonly carrierKind: 'vehicle' | 'truck';
}

/**
 * `economySystem` (krok 9, ADR-025) uzavrel herný deň `day` (0-based = `clock.gameDay − 1`): po strhnutí údržby a miezd
 * vznikol `summary` (príjmy a výdavky dňa podľa kategórie, hotovosť na konci). V ticku za `DayClosed` z kroku 1.
 */
export interface DayClosedSummaryEvent {
  readonly type: 'DayClosedSummary';
  readonly day: number;
  readonly summary: DaySummary;
}

/** `economySystem` uzavrel herný mesiac `month` (0-based) — súčet jeho denných súhrnov (UI modal, §9.2); po `DayClosedSummary`. */
export interface MonthlyReportEvent {
  readonly type: 'MonthlyReport';
  readonly month: number;
  readonly summary: MonthSummary;
}

/** Prečo sa hra skončila; F5 pozná len bankrot (§9.2). */
export type GameOverReason = 'bankruptcy';

/**
 * Hra skončila (ADR-025): hotovosť bola < 0 pri `economy.bankruptcyDays` uzavretiach dňa za sebou; `day` = posledný
 * uzavretý deň. Posledná udalosť kroku 9; od ďalšieho ticku svet netickuje systémy (`World.gameOver`).
 */
export interface GameOverEvent {
  readonly type: 'GameOver';
  readonly reason: GameOverReason;
  readonly day: number;
}

/** Nová ponuka v poole kontraktov (krok 2: štart hry alebo `DayClosed`, ADR-026). */
export interface ContractOfferedEvent {
  readonly type: 'ContractOffered';
  readonly contractId: ContractId;
}

/** `AcceptContract`: ponuka prijatá (po `ContractStateChanged offered → accepted`). */
export interface ContractAcceptedEvent {
  readonly type: 'ContractAccepted';
  readonly contractId: ContractId;
}

/** Každý prechod FSM kontraktu (`CONTRACT_TRANSITIONS`, ADR-026) — vždy pred udalosťou, ktorá prechod dopĺňa. */
export interface ContractStateChangedEvent {
  readonly type: 'ContractStateChanged';
  readonly contractId: ContractId;
  readonly from: ContractState;
  readonly to: ContractState;
}

/**
 * Kontrakt dokončený (`exporting → completed`): `rewardCents` pripísaná (`contract_revenue`), `penaltiesCents` strhnuté
 * (`penalty`, jedna transakcia, ak > 0), `xp` = skutočne pripísané XP, `onTime` = dokončenie najneskôr v `slaDeadlineTick`.
 */
export interface ContractCompletedEvent {
  readonly type: 'ContractCompleted';
  readonly contractId: ContractId;
  readonly rewardCents: number;
  readonly penaltiesCents: number;
  readonly xp: number;
  readonly onTime: boolean;
}

/** Kontrakt zlyhal (meškanie > `failAfterDaysLate` dní): odmena prepadá, `penaltiesCents` strhnuté jednou transakciou. */
export interface ContractFailedEvent {
  readonly type: 'ContractFailed';
  readonly contractId: ContractId;
  readonly penaltiesCents: number;
}

/** Prečo ponuka zanikla: uplynul `offerExpiresTick` alebo ju hráč odmietol (`DeclineContract`). */
export type ContractExpiredReason = 'timeout' | 'declined';

/** Ponuka zanikla (`offered → expired`); kniha kontrakt potom zabudne (ADR-026). */
export interface ContractExpiredEvent {
  readonly type: 'ContractExpired';
  readonly contractId: ContractId;
  readonly reason: ContractExpiredReason;
}

/** Druh penalizácie kontraktu (§9.1). */
export type PenaltyKind = 'demurrage' | 'late';

/**
 * Kontraktu pribudla penalizácia (celá hodina demurrage alebo celý deň po SLA); suma sa len pripočíta do
 * `penaltiesCents` — z hotovosti ide až pri `completed`/`failed` (rozhodnutie 6).
 */
export interface PenaltyAppliedEvent {
  readonly type: 'PenaltyApplied';
  readonly contractId: ContractId;
  readonly kind: PenaltyKind;
  readonly amountCents: number;
}

// ---------------------------------------------------------------------------------------------------------
// F6a — export a booking (ADR-032). Poradie v ticku: krok 2 (`CutoffWarning`, `CutoffPassed`, `VgmHoldReleased`,
// uzavretie bookingu s `BookingPenaltyApplied` pred `ContractCompleted`/`ContractFailed`), krok 3 (`ShipLashingStarted`,
// pri odchode `CargoMoved on_ship → shipped` × n → `ExportShipped` → `ShipDeparted`), krok 4 (`UnitLoaded`, `DualCycle`),
// krok 8 (brána dnu: `ExportArrived` → `UnitRolled`? → `VgmHoldStarted`?; dock: `TruckUnloaded`).
// ---------------------------------------------------------------------------------------------------------

/** Kamión s exportom (misia `delivery`) prešiel bránou dnu — jednotka bookingu je na termináli (krok 8). */
export interface ExportArrivedEvent {
  readonly type: 'ExportArrived';
  readonly contractId: ContractId;
  readonly unitId: EntityId;
  readonly truckId: EntityId;
  readonly gateId: EntityId;
}

/** Jednotka prešla bránou po cut-off (rolled, rozhodnutie 6); hneď po `ExportArrived`. */
export interface UnitRolledEvent {
  readonly type: 'UnitRolled';
  readonly contractId: ContractId;
  readonly unitId: EntityId;
}

/** Brána zistila chýbajúce VGM — jednotka je zadržaná do `untilTick` (`CargoUnit.hold`, rozhodnutie 5). */
export interface VgmHoldStartedEvent {
  readonly type: 'VgmHoldStarted';
  readonly contractId: ContractId;
  readonly unitId: EntityId;
  readonly untilTick: number;
}

/** VGM hold jednotky sa uvoľnil (krok 2 v ticku `≥ untilTick`); jednotka smie na loď. */
export interface VgmHoldReleasedEvent {
  readonly type: 'VgmHoldReleased';
  readonly contractId: ContractId;
  readonly unitId: EntityId;
}

/** Do cut-off bookingu zostáva `economy.cutoffWarningHours` (krok 2, raz — toast „cut-off o N h"). */
export interface CutoffWarningEvent {
  readonly type: 'CutoffWarning';
  readonly contractId: ContractId;
  readonly cutoffTick: number;
}

/** Nastal cut-off bookingu (krok 2, `tick === cutoffTick`); ďalšie príchody sú rolled. */
export interface CutoffPassedEvent {
  readonly type: 'CutoffPassed';
  readonly contractId: ContractId;
  readonly arrivedUnits: number;
  readonly bookedUnits: number;
}

/**
 * Žeriav naložil exportnú jednotku na loď (`in_crane → on_ship`, krok 4). `lastMinute` = rolled jednotka (penalizácia),
 * `outOfOrder` = na termináli ostala skoršia jednotka stowage plánu voyage (metrika `stowageOrderViolations`).
 */
export interface UnitLoadedEvent {
  readonly type: 'UnitLoaded';
  readonly craneId: EntityId;
  readonly shipId: EntityId;
  readonly unitId: EntityId;
  readonly contractId: ContractId;
  readonly lastMinute: boolean;
  readonly outOfOrder: boolean;
}

/** Žeriav dokončil dual cyklus (naložil export a cestou späť vyložil import; krok 4, po `CraneCycleDone`). */
export interface DualCycleEvent {
  readonly type: 'DualCycle';
  readonly craneId: EntityId;
  readonly shipId: EntityId;
  readonly loadedUnitId: EntityId;
  readonly unloadedUnitId: EntityId;
}

/** Loď začala lashing a papiere (`docked → lashing`, krok 3): `ticks = lashingTicksPerUnit × loadedUnits + paperworkTicks`. */
export interface ShipLashingStartedEvent {
  readonly type: 'ShipLashingStarted';
  readonly shipId: EntityId;
  readonly loadedUnits: number;
  readonly ticks: number;
}

/** Loď opustila mapu s exportom: `units` jednotiek `on_ship → shipped` (každá s `CargoMoved`), pred `ShipDeparted`. */
export interface ExportShippedEvent {
  readonly type: 'ExportShipped';
  readonly shipId: EntityId;
  readonly units: number;
}

/**
 * Delivery kamión odovzdal jednotku bloku `blockId` na TP (`in_truck → in_handler / in_vehicle → in_storage`, krok 6c / 8); `dualTransaction` = kamión pokračuje na ďalší TP po import (jeden lístok,
 * misia `pickup`), inak odchádza prázdny (metrika `dualTransactionRate`).
 */
export interface TruckUnloadedEvent {
  readonly type: 'TruckUnloaded';
  readonly truckId: EntityId;
  readonly blockId: EntityId;
  readonly unitId: EntityId;
  readonly dualTransaction: boolean;
}

/** Druh penalizácie bookingu (ADR-032 bod 13): last-minute nakládka, vrátená (rolled) jednotka, nesplnený booking. */
export type BookingPenaltyKind = 'last_minute' | 'rolled' | 'unfulfilled';

/**
 * Penalizácia bookingu pri jeho uzavretí (krok 2): `units` jednotiek × sadzba (pri `unfulfilled` 1); suma sa pripočíta do
 * `penaltiesCents` a z hotovosti ide s uzavretím (ako `PenaltyApplied`, ktorý ostáva pre demurrage a late).
 */
export interface BookingPenaltyAppliedEvent {
  readonly type: 'BookingPenaltyApplied';
  readonly contractId: ContractId;
  readonly kind: BookingPenaltyKind;
  readonly units: number;
  readonly amountCents: number;
}

// ---------------------------------------------------------------------------------------------------------
// F6c — prázdne kontajnery, repositioning a tranship (ADR-034); deklarované v T6C-01, emitujú ich T6C-02 / T6C-03.
// Poradie v ticku: krok 2 (`EmptyDamaged` → `EmptyRepairStarted` / `EmptyRepaired`, `TranshipMissed` → `TranshipRescued` /
// `TranshipSold`), krok 5/6 (`EmptyStored` pri vykládke vozidla do skladu), krok 8 (brána dnu: `EmptyReturned`; výjazd kamióna
// s prázdnym: `EmptyPickedUp`, odchod kamióna bez prázdneho po `emptyPickupMaxWaitHours`: `EmptyPickupMissed`; návrat bez miesta v depe:
// `EmptyReturnDeclined`).
// ---------------------------------------------------------------------------------------------------------

/** Kamión s prázdnym kontajnerom linky (misia `delivery`) prešiel bránou dnu — návrat prázdneho z vnútrozemia (krok 8). */
export interface EmptyReturnedEvent {
  readonly type: 'EmptyReturned';
  readonly unitId: EntityId;
  readonly lineId: string;
  readonly truckId: EntityId;
  readonly gateId: EntityId;
}

/**
 * Prázdny kontajner je uložený (`in_vehicle → in_storage`) a prešiel kontrolou. `fallback` = uložený do bežného dvora, lebo depo
 * prázdnych chýba alebo je plné (metrika `emptyFallbackStored`).
 */
export interface EmptyStoredEvent {
  readonly type: 'EmptyStored';
  readonly unitId: EntityId;
  readonly lineId: string;
  readonly moduleId: EntityId;
  readonly fallback: boolean;
}

/** Kontrola pri uložení našla poškodenie (`damageChance`): jednotka je `damaged` a čaká na voľné miesto opravy. */
export interface EmptyDamagedEvent {
  readonly type: 'EmptyDamaged';
  readonly unitId: EntityId;
  readonly lineId: string;
  readonly moduleId: EntityId;
}

/** Oprava poškodeného prázdneho sa začala (`damaged → in_repair`), skončí v `untilTick` (`repairHours`). */
export interface EmptyRepairStartedEvent {
  readonly type: 'EmptyRepairStarted';
  readonly unitId: EntityId;
  readonly lineId: string;
  readonly moduleId: EntityId;
  readonly untilTick: number;
}

/** Oprava skončila (`in_repair → available`): `costCents` sa strhli z hotovosti (ledger kategória `maintenance_repair`). */
export interface EmptyRepairedEvent {
  readonly type: 'EmptyRepaired';
  readonly unitId: EntityId;
  readonly lineId: string;
  readonly moduleId: EntityId;
  readonly costCents: number;
}

/** Exportér odviezol prázdny kontajner linky svojho bookingu (`in_truck → exported`, kamión misie `pickup`). */
export interface EmptyPickedUpEvent {
  readonly type: 'EmptyPickedUp';
  readonly unitId: EntityId;
  readonly lineId: string;
  readonly contractId: ContractId;
  readonly truckId: EntityId;
}

/**
 * Kamión po prázdny kontajner sa vzdal — linka nemala dostupný prázdny do `emptyPickupMaxWaitHours` (metrika `emptyPickupMisses`). `truckId` = kamión, ktorý
 * odišiel prázdny zo stojiska; `null` = vzdal sa vo vnútrozemí a do prístavu nevošiel (F6d, ADR-035: výdaj sa vpúšťa len s dostupným prázdnym).
 */
export interface EmptyPickupMissedEvent {
  readonly type: 'EmptyPickupMissed';
  readonly lineId: string;
  readonly contractId: ContractId;
  readonly truckId: EntityId | null;
}

/**
 * Návrat prázdneho kontajnera linky sa zahodil bez kamióna — depo prázdnych nemalo voľné miesto (voľné − rozbehnuté návraty), alebo sa k nemu
 * z rampy nedá dôjsť (T6C-07b, ADR-034 dodatok; metrika `emptyReturnsDeclined`). Nič nevznikne, bežný dvor sa prázdnymi nezapĺňa.
 */
export interface EmptyReturnDeclinedEvent {
  readonly type: 'EmptyReturnDeclined';
  readonly lineId: string;
}

/** Loď B prekládky odplávala bez `units` jednotiek kontraktu (penalizácia `transhipMissedRateOfReward`); `outVoyageId` = voyage B. */
export interface TranshipMissedEvent {
  readonly type: 'TranshipMissed';
  readonly contractId: ContractId;
  readonly units: number;
  readonly outVoyageId: VoyageId;
}

/** Zmeškané jednotky prekládky sa preadresovali na ďalšiu voyage linky `outVoyageId` (do `economy.transhipRescueDays`). */
export interface TranshipRescuedEvent {
  readonly type: 'TranshipRescued';
  readonly contractId: ContractId;
  readonly units: number;
  readonly outVoyageId: VoyageId;
}

/** Zmeškané jednotky prekládky bez záchrany odišli kamiónom ako „predané“ (po uzavretí kontraktu, `unitsExported`). */
export interface TranshipSoldEvent {
  readonly type: 'TranshipSold';
  readonly contractId: ContractId;
  readonly units: number;
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
  | ReeferSkippedEvent
  | ReeferClaimEvent
  | ReeferAlarmEvent
  | VehicleBoughtEvent
  | VehicleSoldEvent
  | JobCreatedEvent
  | JobAssignedEvent
  | JobDoneEvent
  | JobCancelledEvent
  | VehicleStateChangedEvent
  | NoStorageAvailableEvent
  | TruckSpawnedEvent
  | TruckStateChangedEvent
  | TruckExitedEvent
  | TrainArrivedEvent
  | TrainDepartedEvent
  | TrainExportArrivedEvent
  | TrafficJamEvent
  | TrafficJamClearedEvent
  | DayClosedSummaryEvent
  | MonthlyReportEvent
  | GameOverEvent
  | ContractOfferedEvent
  | ContractAcceptedEvent
  | ContractStateChangedEvent
  | ContractCompletedEvent
  | ContractFailedEvent
  | ContractExpiredEvent
  | PenaltyAppliedEvent
  | ExportArrivedEvent
  | UnitRolledEvent
  | VgmHoldStartedEvent
  | VgmHoldReleasedEvent
  | CutoffWarningEvent
  | CutoffPassedEvent
  | UnitLoadedEvent
  | DualCycleEvent
  | ShipLashingStartedEvent
  | ExportShippedEvent
  | TruckUnloadedEvent
  | BookingPenaltyAppliedEvent
  | EmptyReturnedEvent
  | EmptyStoredEvent
  | EmptyDamagedEvent
  | EmptyRepairStartedEvent
  | EmptyRepairedEvent
  | EmptyPickedUpEvent
  | EmptyPickupMissedEvent
  | EmptyReturnDeclinedEvent
  | TranshipMissedEvent
  | TranshipRescuedEvent
  | TranshipSoldEvent;

/** Názov typu udalosti (`'TickAdvanced' | 'HourClosed' | …`). */
export type SimEventType = SimEvent['type'];

/** Člen únie podľa typu, napr. `SimEventOf<'MoneyChanged'>`. */
export type SimEventOf<T extends SimEventType> = Extract<SimEvent, { readonly type: T }>;
