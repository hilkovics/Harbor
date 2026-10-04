/**
 * SimBridge — jediný most medzi simuláciou a prezentáciou (ARCHITECTURE §13, CLAUDE.md pravidlo 1 a 5).
 *
 * - Prezentácia sim iba číta: `snapshot()` (plytký read-only pohľad) a `onEvents` (udalosti za frame),
 * - zapisuje výlučne cez `dispatch(command)`; `validate(command)` slúži na živý ghost (nič nemení).
 *
 * `GameLoop` po každom frame zavolá `publish(events)`. Bridge rozošle udalosti poslucháčom `onEvents`
 * (render) a ak sa medzitým zmenil snapshot, notifikuje odberateľov `subscribe` (UI cez `useSimSnapshot`).
 */
import type { CraneVM, ModuleVM, ShipVM, TruckVM, VehicleVM, ViewRotation } from '@render/view-models';
import type { Command, ValidationResult } from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { DefRegistry } from '@sim/defs';
import type { SimEvent, SimEventType } from '@sim/events';
import type { Grid, Parcel } from '@sim/grid';
import type { World } from '@sim/world';
import type { ContractCardData } from '@ui/contracts-panel';
import { contractCards, nextOfferInTicks } from './contract-cards';
import { truckCarriesEmpty } from './cargo-vm';
import { EntitiesVMBuilder, writeTruckPose, type MutableTruckPose, type SimEntitiesVM } from './entities-vm';
import type { FrameEventSink } from './game-loop';
import { LashingTracker, type LashingTotals } from './lashing';
import { StorageOpTracker } from './storage-ops';

/**
 * Udalosti, ktoré menia štruktúru sveta viditeľnú v snapshote (moduly, cesty a z nich pripojenie modulov, lode, žeriavy,
 * vozidlá, joby vrátane zrušených (uvoľnia rezervácie skladu a rampy), poloha nákladu a z nej obsadenie skladov a rámp,
 * prevádzkovosť rámp, kamióny — vznik, zmena stavu (vstup a výstup z fronty brány, príchod do stojiska …), odchod z mapy
 * a chýbajúci bay stojiska) a zvyšujú `revision`. Tabuľka (nie switch): nová udalosť =
 * nový riadok. `MoneyChanged` tu nie je — hotovosť je v snapshote sama. Poloha vozidla a kamióna tu nie je: mení sa
 * každý tick bez udalosti, preto sa vozidlá a kamióny (ako lode a žeriavy) skladajú pri každom novom snapshote.
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
  'VehicleBought',
  'VehicleSold',
  'VehicleStateChanged',
  'JobCreated',
  'JobAssigned',
  'JobDone',
  'JobCancelled',
  'NoStorageAvailable',
  'RampOperationalChanged',
  'TruckSpawned',
  'TruckStateChanged',
  'TruckExited',
  'NoWaitingBay',
  // Kontrakty (F5): karty v snapshote sa skladajú len pri zmene revízie (stav, progres nákladu cez `CargoMoved`,
  // penalizácie, zánik ponuky, koniec hry). Cut-off sa na kartách odpočítava z ticku, preto `CutoffWarning` / `CutoffPassed`
  // revíziu nemenia.
  'ContractOffered',
  'ContractAccepted',
  'ContractStateChanged',
  'ContractCompleted',
  'ContractFailed',
  'ContractExpired',
  'PenaltyApplied',
  'GameOver',
  // Export a booking (F6a, ADR-032): počítadlá bookingu na kartách (dovezené, rolled, zadržané VGM — hold mení len ledger bez
  // `CargoMoved`, naložené, penalizácie bookingu) a lashing / odchod lode s exportom.
  'ExportArrived',
  'UnitRolled',
  'VgmHoldStarted',
  'VgmHoldReleased',
  'UnitLoaded',
  'ShipLashingStarted',
  'ExportShipped',
  'BookingPenaltyApplied',
  // Prázdne kontajnery a prekládka (F6c, ADR-034): inšpektor depa (prázdne podľa linky a stavu) a karty repositioningu / prekládky sa
  // skladajú pri zmene revízie. Zmena stavu jednotky (`CargoLedger.setStatus`: poškodenie, začiatok a koniec opravy) nemá vlastný
  // `CargoMoved`, preto ju nesú práve udalosti `EmptyDamaged` / `EmptyRepairStarted` / `EmptyRepaired`. `EmptyPickupMissed` revíziu
  // nemení (kamión odišiel prázdny, počítadlá kariet sa nehýbu).
  'EmptyReturned',
  'EmptyStored',
  'EmptyDamaged',
  'EmptyRepairStarted',
  'EmptyRepaired',
  'EmptyPickedUp',
  'TranshipMissed',
  'TranshipRescued',
  'TranshipSold',
]);

/**
 * Plytký read-only pohľad na svet pre UI. Objekt je zmrazený a jeho referencia je stabilná, kým sa nezmení
 * `tick`, `speed`, `cashCents` alebo `revision` — vhodné pre `useSyncExternalStore`. `grid` a `parcels` sú živé
 * referencie na štruktúry sveta (žiadne kopírovanie); ich obsah mení `RoadChanged` (→ `revision`), na reakciu
 * v renderi slúži aj `onEvents`.
 *
 * `modules`, `cranes`, `ships`, `vehicles` a `trucks` sú render view-modely (`@render/view-models`); pole modulov má
 * stabilnú referenciu, kým sa nezmení `revision` (žeriavy, lode, vozidlá a kamióny sa skladajú pri každom novom
 * snapshote). Výnimka: VM brány a stojiska kamiónov sa môže zmeniť aj bez udalosti (závora po prestavbe ciest), preto sa
 * pri každom snapshote porovná so živým modulom a pole modulov je nové len pri skutočnej zmene ich hodnôt
 * (`EntitiesVMBuilder`; VM ostatných modulov ostávajú tie isté objekty).
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
  /** Moduly bez žeriavov (kotviská s apronom, sklady, depá, brány, stojiská, rampy …) v poradí umiestnenia; sklady nesú `storage`, moduly s konektormi `connected`, pozemné moduly `gate`/`waitingArea`/`ramp`. */
  readonly modules: readonly ModuleVM[];
  /** Žeriavy v poradí umiestnenia. */
  readonly cranes: readonly CraneVM[];
  /** Lode vzostupne podľa id; `prevX/prevY` = poloha pred posledným tickom. */
  readonly ships: readonly ShipVM[];
  /** Vozidlá vzostupne podľa id; `prevX/prevY/prevHeading` = pózy pred posledným tickom. */
  readonly vehicles: readonly VehicleVM[];
  /**
   * Kamióny vzostupne podľa id; `prevX/prevY/prevHeading` = pózy pred posledným tickom. V stave `waiting` stoja v strede
   * stojiska a v `loading` v strede docku (nie na bunke cesty, kde ich vedie sim); pri skoku do/zo stojiska a docku
   * je `prev = curr`.
   */
  readonly trucks: readonly TruckVM[];
  /**
   * Karty kontraktov (F5; `@ui/contracts-panel`): ponuky, prebiehajúce, splnené a zlyhané (expirované zmiznú). Pole sa
   * prepočíta len pri zmene `revision` (referencia je inak stabilná), čas na kartách sa počíta z `tick`.
   */
  readonly contracts: readonly ContractCardData[];
  /** Za koľko tickov sa obnoví pool ponúk (najbližšia uzávierka dňa). */
  readonly nextOfferInTicks: number;
  /** Ticky za hernú hodinu / deň (mierka času pre panely; z `SimClock`). */
  readonly ticksPerHour: number;
  readonly ticksPerDay: number;
  /** Čistá zmena hotovosti v aktuálnom dni v centoch (`economy.todayDeltaCents()`); HUD ju ukazuje ako `±$/deň`. */
  readonly dailyDeltaCents: number;
  /** Skúsenosti hráča. */
  readonly xp: number;
  /** Úroveň hráča (`⌊splnené / contractsPerTier⌋`). */
  readonly tier: number;
  /** Počet splnených kontraktov. */
  readonly completedContracts: number;
  /** Hra skončila bankrotom (sim netickuje, príkazy vracajú `game_over`). */
  readonly gameOver: boolean;
}

/** Zmeniteľná predchádzajúca poloha lode (bridge ju prepisuje pred každým tickom bez alokácie). */
interface MutableShipPosition {
  x: number;
  y: number;
}

/** Zmeniteľná predchádzajúca póza vozidla (poloha + kurz; prepisuje sa pred každým tickom bez alokácie). */
interface MutableVehiclePose {
  x: number;
  y: number;
  heading: ViewRotation;
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
  private currentEntities: SimEntitiesVM | null = null;
  private revisionCounter = 0;
  /** Karty kontraktov a revízia, pre ktorú vznikli (prepočet len pri zmene revízie). */
  private currentContracts: { readonly revision: number; readonly cards: readonly ContractCardData[] } | null = null;
  private readonly entityBuilder = new EntitiesVMBuilder();
  /** Posledné operácie s kontajnerom na slote skladov (animácia žeriavu dvora; sim ich nevedie). */
  private readonly storageOps = new StorageOpTracker();
  /** Celkové doby lashingu lodí z `ShipLashingStarted` (progres lashingu; sim ich vedie len ako zostávajúce ticky). */
  private readonly lashing = new LashingTracker();
  /** Poloha lodí pred posledným tickom (interpolácia); lode bez záznamu majú `prev = curr`. */
  private readonly prevShipPositions = new Map<EntityId, MutableShipPosition>();
  /** Póza vozidiel pred posledným tickom (interpolácia + pruh v zákrute); vozidlá bez záznamu majú `prev = curr`. */
  private readonly prevVehiclePoses = new Map<EntityId, MutableVehiclePose>();
  /** Prezentovaná póza kamiónov (aj stav FSM) pred posledným tickom; kamióny bez záznamu majú `prev = curr`. */
  private readonly prevTruckPoses = new Map<EntityId, MutableTruckPose>();
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

  /** Celkové doby lashingu lodí zo `ShipLashingStarted` (inšpektor lode; chýbajúca loď = doba z defu, `lashing.ts`). */
  get lashingTotals(): LashingTotals {
    return this.lashing.view;
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
    const cards = this.contractCardsFor(this.revisionCounter);
    const entities = this.entityBuilder.build(this.world, this.revisionCounter, this.prevShipPositions, this.prevVehiclePoses, this.prevTruckPoses, this.storageOps.view, this.lashing.view);
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
      vehicles: entities.vehicles,
      trucks: entities.trucks,
      contracts: cards,
      nextOfferInTicks: nextOfferInTicks(this.world),
      ticksPerHour: clock.ticksPerHour,
      ticksPerDay: clock.ticksPerDay,
      dailyDeltaCents: this.world.economy.todayDeltaCents(),
      xp: this.world.xp,
      tier: this.world.tier,
      completedContracts: this.world.completedContracts,
      gameOver: this.world.gameOver,
    });
    this.current = next;
    this.currentEntities = entities;
    return next;
  }

  /** Karty kontraktov pre `revision`; prepočítajú sa len pri jej zmene. */
  private contractCardsFor(revision: number): readonly ContractCardData[] {
    const cached = this.currentContracts;
    if (cached !== null && cached.revision === revision) return cached.cards;
    const cards = contractCards(this.world);
    this.currentContracts = { revision, cards };
    return cards;
  }

  /**
   * Entity pre render (`WorldRenderer.syncEntities`) a `window.__sim.entities()`: moduly, žeriavy, lode, vozidlá a kamióny
   * aktuálneho snapshotu. Referencia je stabilná, kým sa snapshot nezmení. Nezahŕňa `grid`, takže sa dá serializovať.
   */
  entities(): SimEntitiesVM {
    this.snapshot();
    const entities = this.currentEntities;
    if (entities === null) throw new Error('SimBridge.entities: snapshot nemá entity'); // nedosiahnuteľné: snapshot() ich plní
    return entities;
  }

  /**
   * Volá `GameLoop` tesne pred každým `world.tick()`: zapamätá si polohu lodí a pózu vozidiel a kamiónov (poloha + kurz),
   * ktorá sa po ticku stane `prevX/prevY` (`prevHeading`) — sim predchádzajúcu polohu nevedie. Zaniknuté lode, predané
   * vozidlá a kamióny, ktoré odišli z mapy, sa zabudnú; nová loď / vozidlo / kamión záznam dostane až pred prvým tickom,
   * dovtedy má `prev = curr`.
   */
  beforeTick(): void {
    this.rememberVehiclePoses();
    this.rememberTruckPoses();
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

  private rememberVehiclePoses(): void {
    const { vehicles } = this.world;
    for (const id of this.prevVehiclePoses.keys()) {
      if (!vehicles.has(id)) this.prevVehiclePoses.delete(id);
    }
    for (const vehicle of vehicles.values()) {
      const known = this.prevVehiclePoses.get(vehicle.id);
      if (known === undefined) {
        this.prevVehiclePoses.set(vehicle.id, { x: vehicle.x, y: vehicle.y, heading: vehicle.heading });
      } else {
        known.x = vehicle.x;
        known.y = vehicle.y;
        known.heading = vehicle.heading;
      }
    }
  }

  /**
   * Pózy kamiónov: prezentovaná poloha (v `waiting` / `loading` stred stojiska / docku) a kurz spolu so stavom FSM —
   * z porovnania stavov pred a po ticku `truckVMs` pozná skok do/zo stojiska a docku (vtedy `prev = curr`). F6c: pamätá si aj
   * `carriesEmpty` (kamión, ktorý prázdny dovezie, ho vyloží v ticku; renderer kontajner z príchodu ešte kreslí pri cúvaní).
   */
  private rememberTruckPoses(): void {
    const { trucks } = this.world;
    for (const id of this.prevTruckPoses.keys()) {
      if (!trucks.has(id)) this.prevTruckPoses.delete(id);
    }
    for (const truck of trucks.values()) {
      let known = this.prevTruckPoses.get(truck.id);
      if (known === undefined) {
        known = { x: 0, y: 0, heading: 0, state: truck.state };
        this.prevTruckPoses.set(truck.id, known);
      }
      writeTruckPose(this.world, truck, known);
      known.carriesEmpty = truckCarriesEmpty(this.world, truck.id, known.carriesEmpty);
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
    this.lashing.record(events);
    // pred výpočtom snapshotu: CargoMoved zvyšuje revíziu, takže VM skladu sa prestavia s novou operáciou; smer jednotky (prázdny
    // kontajner = sivý na spreaderi) berie z ledgera
    this.storageOps.record(events, (unitId) => this.world.cargo.get(unitId)?.direction === 'empty');
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
