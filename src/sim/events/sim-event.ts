/**
 * Udalosti simulácie (ARCHITECTURE §12.1, výber pre F1 + `CargoMoved` z F2). Readonly DTO: `World` ich zbiera v `EventBus` a vracia
 * z `tick()` / `applyPending()`; prezentácia ich len číta. Nový typ udalosti = nový člen únie (+ test).
 */
import type { CargoLocation } from '../cargo/cargo-location';
import type { ValidationReason } from '../commands/validation';
import type { EntityId } from '../core/entity-id';
import type { LedgerCategory } from '../economy/ledger-category';
import type { CellCoord } from '../grid/grid';

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

export type SimEvent =
  | TickAdvancedEvent
  | HourClosedEvent
  | DayClosedEvent
  | MonthClosedEvent
  | RoadChangedEvent
  | MoneyChangedEvent
  | GameSpeedChangedEvent
  | CommandRejectedEvent
  | CargoMovedEvent;

/** Názov typu udalosti (`'TickAdvanced' | 'HourClosed' | …`). */
export type SimEventType = SimEvent['type'];

/** Člen únie podľa typu, napr. `SimEventOf<'MoneyChanged'>`. */
export type SimEventOf<T extends SimEventType> = Extract<SimEvent, { readonly type: T }>;
