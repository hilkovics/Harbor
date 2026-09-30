/**
 * SimBridge — jediný most medzi simuláciou a prezentáciou (ARCHITECTURE §13, CLAUDE.md pravidlo 1 a 5).
 *
 * - Prezentácia sim iba číta: `snapshot()` (plytký read-only pohľad) a `onEvents` (udalosti za frame),
 * - zapisuje výlučne cez `dispatch(command)`; `validate(command)` slúži na živý ghost (nič nemení).
 *
 * `GameLoop` po každom frame zavolá `publish(events)`. Bridge rozošle udalosti poslucháčom `onEvents`
 * (render) a ak sa medzitým zmenil snapshot, notifikuje odberateľov `subscribe` (UI cez `useSimSnapshot`).
 */
import type { CraneVM, EntitiesVM, ModuleVM, ShipVM } from '@render/view-models';
import type { Command, ValidationResult } from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { DefRegistry } from '@sim/defs';
import type { SimEvent, SimEventType } from '@sim/events';
import type { Grid, Parcel } from '@sim/grid';
import type { World } from '@sim/world';
import { EntitiesVMBuilder } from './entities-vm';
import type { FrameEventSink } from './game-loop';

/**
 * Udalosti, ktoré menia štruktúru sveta viditeľnú v snapshote (moduly, cesty, lode, žeriavy, poloha nákladu) a zvyšujú
 * `revision`. Tabuľka (nie switch): nová udalosť = nový riadok. `MoneyChanged` tu nie je — hotovosť je v snapshote sama.
 */
export const REVISION_EVENTS: ReadonlySet<SimEventType> = new Set<SimEventType>([
  'ModulePlaced',
  'ModuleRemoved',
  'RoadChanged',
  'ShipSpawned',
  'ShipDocked',
  'ShipUndocked',
  'ShipDeparted',
  'CraneCycleDone',
  'CraneBlocked',
  'CargoMoved',
]);

/**
 * Plytký read-only pohľad na svet pre UI. Objekt je zmrazený a jeho referencia je stabilná, kým sa nezmení
 * `tick`, `speed`, `cashCents` alebo `revision` — vhodné pre `useSyncExternalStore`. `grid` a `parcels` sú živé
 * referencie na štruktúry sveta (žiadne kopírovanie); ich obsah mení `RoadChanged` (→ `revision`), na reakciu
 * v renderi slúži aj `onEvents`.
 *
 * `modules`, `cranes` a `ships` sú render view-modely (`@render/view-models`); pole modulov má stabilnú referenciu,
 * kým sa nezmení `revision` (žeriavy a lode sa skladajú pri každom novom snapshote).
 */
export interface WorldSnapshot {
  /** Počet dokončených tickov. */
  readonly tick: number;
  /** Rýchlosť hry (0 = pauza). */
  readonly speed: number;
  /** Ponúkané rýchlosti (`time.speeds`) — HUD ich číta odtiaľto, nie zo sveta. */
  readonly speeds: readonly number[];
  /**
   * Počítadlo štrukturálnych zmien: rastie pri každej udalosti z `REVISION_EVENTS` doručenej cez `publish`.
   * Panely ním lacno zistia, že sa zmenil obsah `grid`/modulov, hoci `tick` a hotovosť to nenaznačujú.
   */
  readonly revision: number;
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
  /** Moduly bez žeriavov (kotviská s apronom …) v poradí umiestnenia. */
  readonly modules: readonly ModuleVM[];
  /** Žeriavy v poradí umiestnenia. */
  readonly cranes: readonly CraneVM[];
  /** Lode vzostupne podľa id; `prevX/prevY` = poloha pred posledným tickom. */
  readonly ships: readonly ShipVM[];
}

/** Zmeniteľná predchádzajúca poloha lode (bridge ju prepisuje pred každým tickom bez alokácie). */
interface MutableShipPosition {
  x: number;
  y: number;
}

export type Unsubscribe = () => void;
export type SimEventListener = (events: readonly SimEvent[]) => void;

/** Zaregistrovaný poslucháč; obal umožňuje viacnásobnú registráciu tej istej funkcie. */
interface Registration<F> {
  readonly listener: F;
}

export class SimBridge implements FrameEventSink {
  private current: WorldSnapshot | null = null;
  /** `EntitiesVM` aktuálneho snapshotu (rovnaké polia ako v snapshote, ale bez `grid`, serializovateľné). */
  private currentEntities: EntitiesVM | null = null;
  private revisionCounter = 0;
  private readonly entityBuilder = new EntitiesVMBuilder();
  /** Poloha lodí pred posledným tickom (interpolácia); lode bez záznamu majú `prev = curr`. */
  private readonly prevShipPositions = new Map<EntityId, MutableShipPosition>();
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

  /** Defy sveta (statické dáta: katalógy, časy) — UI ich číta odtiaľto, nie cez `world`. */
  get defs(): DefRegistry {
    return this.world.defs;
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
   * Aktuálny snapshot. Volanie je lacné (porovná štyri čísla) a vracia tú istú referenciu, kým sa `tick`, `speed`,
   * `cashCents` a `revision` nezmenia; pri zmene vytvorí nový zmrazený objekt (a s ním nové VM žeriavov a lodí).
   */
  snapshot(): WorldSnapshot {
    const { clock, cashCents } = this.world;
    const cached = this.current;
    if (
      cached !== null &&
      cached.tick === clock.tick &&
      cached.speed === clock.speed &&
      cached.cashCents === cashCents &&
      cached.revision === this.revisionCounter
    ) {
      return cached;
    }
    const entities = this.entityBuilder.build(this.world, this.revisionCounter, this.prevShipPositions);
    const next: WorldSnapshot = Object.freeze({
      tick: clock.tick,
      speed: clock.speed,
      speeds: this.world.defs.time.speeds,
      revision: this.revisionCounter,
      cashCents,
      day: clock.gameDay,
      hour: clock.hourOfDay,
      minute: clock.minuteOfHour,
      grid: this.world.grid,
      parcels: this.world.parcels,
      modules: entities.modules,
      cranes: entities.cranes,
      ships: entities.ships,
    });
    this.current = next;
    this.currentEntities = entities;
    return next;
  }

  /**
   * Entity pre render (`WorldRenderer.syncEntities`) a `window.__sim.entities()`: moduly, žeriavy a lode aktuálneho
   * snapshotu. Referencia je stabilná, kým sa snapshot nezmení. Nezahŕňa `grid`, takže sa dá serializovať.
   */
  entities(): EntitiesVM {
    this.snapshot();
    const entities = this.currentEntities;
    if (entities === null) throw new Error('SimBridge.entities: snapshot nemá entity'); // nedosiahnuteľné: snapshot() ich plní
    return entities;
  }

  /**
   * Volá `GameLoop` tesne pred každým `world.tick()`: zapamätá si polohu lodí, ktorá sa po ticku stane `prevX/prevY`
   * (sim predchádzajúcu polohu nevedie). Zaniknuté lode sa zabudnú; nová loď záznam dostane až pred prvým tickom,
   * dovtedy má `prev = curr`.
   */
  beforeTick(): void {
    const { ships } = this.world;
    for (const id of this.prevShipPositions.keys()) {
      if (!ships.has(id)) this.prevShipPositions.delete(id);
    }
    for (const ship of ships.values()) {
      const known = this.prevShipPositions.get(ship.id);
      if (known === undefined) {
        this.prevShipPositions.set(ship.id, { x: ship.x, y: ship.y });
      } else {
        known.x = ship.x;
        known.y = ship.y;
      }
    }
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
    for (const event of events) {
      if (REVISION_EVENTS.has(event.type)) this.revisionCounter += 1;
    }
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
