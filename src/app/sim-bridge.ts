/**
 * SimBridge — jediný most medzi simuláciou a prezentáciou (ARCHITECTURE §13, CLAUDE.md pravidlo 1 a 5).
 *
 * - Prezentácia sim iba číta: `snapshot()` (plytký read-only pohľad) a `onEvents` (udalosti za frame),
 * - zapisuje výlučne cez `dispatch(command)`; `validate(command)` slúži na živý ghost (nič nemení).
 *
 * `GameLoop` po každom frame zavolá `publish(events)`. Bridge rozošle udalosti poslucháčom `onEvents`
 * (render) a ak sa medzitým zmenil snapshot, notifikuje odberateľov `subscribe` (UI cez `useSimSnapshot`).
 */
import type { Command, ValidationResult } from '@sim/commands';
import type { SimEvent } from '@sim/events';
import type { Grid, Parcel } from '@sim/grid';
import type { World } from '@sim/world';
import type { FrameEventSink } from './game-loop';

/**
 * Plytký read-only pohľad na svet pre UI. Objekt je zmrazený a jeho referencia je stabilná, kým sa nezmení
 * `tick`, `speed` alebo `cashCents` — vhodné pre `useSyncExternalStore`. `grid` a `parcels` sú živé referencie
 * na štruktúry sveta (žiadne kopírovanie); zmena ich obsahu sama o sebe referenciu snapshotu nemení, na
 * reakciu na ne slúži `onEvents` (napr. `RoadChanged`).
 */
export interface WorldSnapshot {
  /** Počet dokončených tickov. */
  readonly tick: number;
  /** Rýchlosť hry (0 = pauza). */
  readonly speed: number;
  /** Hotovosť v centoch (USD). */
  readonly cashCents: number;
  /** Herný deň od začiatku hry, 0-based (`formatGameTime` pripočíta 1). */
  readonly day: number;
  /** Hodina dňa, 0–23. */
  readonly hour: number;
  /** Minúta hodiny, 0–59. */
  readonly minute: number;
  readonly grid: Grid;
  readonly parcels: ReadonlyMap<string, Parcel>;
}

export type Unsubscribe = () => void;
export type SimEventListener = (events: readonly SimEvent[]) => void;

/** Zaregistrovaný poslucháč; obal umožňuje viacnásobnú registráciu tej istej funkcie. */
interface Registration<F> {
  readonly listener: F;
}

export class SimBridge implements FrameEventSink {
  private current: WorldSnapshot | null = null;
  /** Posledný snapshot, o ktorom sa odberatelia dozvedeli (alebo počiatočný stav pri vzniku bridge). */
  private notified: WorldSnapshot;
  private readonly changeListeners = new Set<Registration<() => void>>();
  private readonly eventListeners = new Set<Registration<SimEventListener>>();

  /**
   * @param world simulácia, ktorú bridge sprístupňuje. Verejná len na čítanie pre dev hook (`window.__sim`)
   *   a testy; UI ju nemá meniť inak než cez `dispatch`.
   */
  constructor(readonly world: World) {
    this.notified = this.snapshot();
  }

  /** Zaradí príkaz do fronty sveta; aplikuje sa pri najbližšom frame (aj počas pauzy). */
  dispatch(command: Command): void {
    this.world.enqueue(command);
  }

  /** Overí príkaz nad živým stavom bez zmeny sveta (ghost v build móde). */
  validate(command: Command): ValidationResult {
    return command.validate(this.world);
  }

  /**
   * Aktuálny snapshot. Volanie je lacné (porovná tri čísla) a vracia tú istú referenciu, kým sa `tick`, `speed`
   * a `cashCents` nezmenia; pri zmene vytvorí nový zmrazený objekt.
   */
  snapshot(): WorldSnapshot {
    const { clock, cashCents } = this.world;
    const cached = this.current;
    if (cached !== null && cached.tick === clock.tick && cached.speed === clock.speed && cached.cashCents === cashCents) {
      return cached;
    }
    const next: WorldSnapshot = Object.freeze({
      tick: clock.tick,
      speed: clock.speed,
      cashCents,
      day: clock.gameDay,
      hour: clock.hourOfDay,
      minute: clock.minuteOfHour,
      grid: this.world.grid,
      parcels: this.world.parcels,
    });
    this.current = next;
    return next;
  }

  /** Odber zmien snapshotu (pre `useSyncExternalStore`). Poslucháč sa volá bez argumentov po `publish`. */
  subscribe(listener: () => void): Unsubscribe {
    const registration: Registration<() => void> = { listener };
    this.changeListeners.add(registration);
    return () => {
      this.changeListeners.delete(registration);
    };
  }

  /** Odber udalostí simulácie za frame (render: `RoadChanged` …). Volá sa len pre neprázdne polia. */
  onEvents(listener: SimEventListener): Unsubscribe {
    const registration: Registration<SimEventListener> = { listener };
    this.eventListeners.add(registration);
    return () => {
      this.eventListeners.delete(registration);
    };
  }

  /**
   * Volá `GameLoop` po každom frame. Neprázdne `events` rozošle `onEvents` poslucháčom; potom, ak sa snapshot
   * od poslednej notifikácie zmenil (aj zmenou bez udalosti), notifikuje `subscribe` odberateľov.
   */
  publish(events: readonly SimEvent[]): void {
    if (events.length > 0) {
      for (const registration of [...this.eventListeners]) {
        if (this.eventListeners.has(registration)) registration.listener(events);
      }
    }
    const snapshot = this.snapshot();
    if (snapshot === this.notified) return;
    this.notified = snapshot;
    for (const registration of [...this.changeListeners]) {
      if (this.changeListeners.has(registration)) registration.listener();
    }
  }
}
