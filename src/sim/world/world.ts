/**
 * World — koreň simulácie (ARCHITECTURE §5, §6). Vlastní hodiny, mriežku, parcely, hotovosť, jediný `Rng`,
 * alokátor ID a zbernicu udalostí; prezentácia ho len číta a mení ho výlučne cez `Command` (pravidlo 5).
 *
 * Tick pipeline vo F1: príkazy z fronty → krok 1 (`clock.advance()` + udalosti hraníc) → krok 13 (`events.flush()`).
 * Kroky 2–12 pribudnú so systémami na označenom mieste v `tick()`; poradie §6 je záväzné a mení sa len cez ADR.
 */
import { EntityIdAllocator } from '../core/entity-id';
import { EventBus } from '../core/event-bus';
import { INITIAL_SPEED, SimClock } from '../core/sim-clock';
import { Rng } from '../core/rng';
import type { Command } from '../commands/command';
import { DefError, type DefRegistry } from '../defs/def-registry';
import type { SimEvent } from '../events/sim-event';
import type { Grid } from '../grid/grid';
import type { LoadedMap } from '../grid/map-loader';
import type { Parcel, ParcelOwnership } from '../grid/parcel';
import { WORLD_STATE_VERSION, parseWorldState, type SerializedRoad, type WorldState } from './world-state';

/** Všetko, z čoho sa svet skladá — spoločné pre `create` aj `deserialize`. */
interface WorldParts {
  readonly defs: DefRegistry;
  readonly map: LoadedMap;
  readonly seed: number;
  readonly clock: SimClock;
  readonly rng: Rng;
  readonly ids: EntityIdAllocator;
  readonly grid: Grid;
  readonly parcels: ReadonlyMap<string, Parcel>;
  readonly cashCents: number;
}

/** Nezávislé kópie parciel mapy (meniteľné `ownership`); geometria je zmrazená, takže `rect` sa môže zdieľať. */
function copyParcels(map: LoadedMap): Map<string, Parcel> {
  return new Map(
    map.parcels.map((parcel): [string, Parcel] => [
      parcel.id,
      { id: parcel.id, rect: parcel.rect, priceCents: parcel.priceCents, leasable: parcel.leasable, ownership: parcel.ownership },
    ]),
  );
}

export class World {
  readonly defs: DefRegistry;
  /** Načítaná mapa — len na čítanie; počiatočný stav mriežky dáva `map.createGrid()`, živá mriežka sveta je `grid`. */
  readonly map: LoadedMap;
  /** Seed novej hry (uint32); ďalší priebeh určuje stav `rng`. */
  readonly seed: number;
  readonly clock: SimClock;
  /** Vlastná mriežka z `map.createGrid()` — menia ju len príkazy a systémy tohto sveta. */
  readonly grid: Grid;
  /** Parcely v poradí mapy; meniteľné je len `ownership` (príkazy kúpy/prenájmu). */
  readonly parcels: ReadonlyMap<string, Parcel>;
  /** Jediný zdroj náhody simulácie (pravidlo 3). */
  readonly rng: Rng;
  readonly ids: EntityIdAllocator;
  /** Udalosti aktuálneho ticku; príkazy a systémy volajú `emit`, `tick()`/`applyPending()` ich vrátia. */
  readonly events = new EventBus<SimEvent>();
  /** Hotovosť v centoch (USD); môže byť záporná (bankrot rieši F5). */
  cashCents: number;

  private readonly pendingCommands: Command[] = [];

  private constructor(parts: WorldParts) {
    this.defs = parts.defs;
    this.map = parts.map;
    this.seed = parts.seed;
    this.clock = parts.clock;
    this.rng = parts.rng;
    this.ids = parts.ids;
    this.grid = parts.grid;
    this.parcels = parts.parcels;
    this.cashCents = parts.cashCents;
  }

  /**
   * Nová hra: tick 0 pri rýchlosti `INITIAL_SPEED`, hotovosť `economy.startingCashCents`, `Rng(seed)`, ID od 1,
   * mriežka = nová `map.createGrid()` (so starter cestami), parcely skopírované (`startOwned` → `owned`).
   * Chyby: seed nie je uint32 → `RangeError`; `INITIAL_SPEED` chýba v `time.speeds` → `DefError`.
   */
  static create(defs: DefRegistry, map: LoadedMap, seed: number): World {
    const rng = new Rng(seed);
    const clock = new SimClock(defs.time);
    if (!defs.time.speeds.includes(clock.speed)) {
      throw new DefError('time', '/speeds', `musí obsahovať počiatočnú rýchlosť ${String(INITIAL_SPEED)} (World.create)`);
    }
    return new World({
      defs,
      map,
      seed,
      clock,
      rng,
      ids: new EntityIdAllocator(),
      grid: map.createGrid(),
      parcels: copyParcels(map),
      cashCents: defs.economy.startingCashCents,
    });
  }

  /**
   * Obnoví svet zo `serialize()` (aj po `JSON.parse`). Terén a parcely berie z `map` (musí mať `id === state.mapId`),
   * vrstvu dopravy celú z `state.roads` — starter cesta, ktorú hráč odstránil, sa neobnoví. Neplatný stav →
   * `WorldStateError` (pozri `parseWorldState`). Výsledok nezdieľa meniteľný stav so `state` ani s `map`.
   */
  static deserialize(defs: DefRegistry, map: LoadedMap, state: WorldState): World {
    const grid = map.createGrid();
    const parsed = parseWorldState(state, defs, map, grid);
    for (let i = 0; i < grid.cellCount; i++) grid.atIndex(i).road = 'none';
    for (const [index, layer] of parsed.roads) grid.atIndex(index).road = layer;
    const parcels = copyParcels(map);
    for (const [id, ownership] of parsed.ownership) {
      const parcel = parcels.get(id);
      if (parcel !== undefined) parcel.ownership = ownership;
    }
    return new World({
      defs,
      map,
      seed: parsed.seed,
      clock: parsed.clock,
      rng: parsed.rng,
      ids: parsed.ids,
      grid,
      parcels,
      cashCents: parsed.cashCents,
    });
  }

  /** Počet príkazov čakajúcich vo fronte. */
  get pendingCommandCount(): number {
    return this.pendingCommands.length;
  }

  /** Zaradí príkaz na koniec fronty; aplikuje sa pri najbližšom `applyPending()` alebo `tick()` (pred krokom 1). */
  enqueue(command: Command): void {
    this.pendingCommands.push(command);
  }

  /**
   * Aplikuje príkazy z fronty bez posunu času (stavba počas pauzy) a vráti udalosti, ktoré vznikli.
   * Ekvivalentné príkazovej časti `tick()`: `applyPending(); tick()` dá rovnaký stav ako samotný `tick()`.
   */
  applyPending(): readonly SimEvent[] {
    this.applyQueuedCommands();
    return this.events.flush();
  }

  /**
   * Jeden tick simulácie (§6). Rýchlosť hry tu nehrá rolu — koľko tickov sa vykoná, riadi `GameLoop`.
   * Vráti udalosti ticku v poradí vzniku: udalosti príkazov, `TickAdvanced`, potom `HourClosed`, `DayClosed`,
   * `MonthClosed` (od najmenšej hranice), ak sa uzavreli.
   */
  tick(): readonly SimEvent[] {
    // Príkazy z fronty sa aplikujú pred krokom 1 (§6).
    this.applyQueuedCommands();

    // 1. clock.advance() — tick++, hranice hodiny/dňa/mesiaca.
    this.advanceClock();

    // 2.–12. systémy (contract, ship, crane, dispatcher, vehicle, flow, landside, economy, tech, metrics,
    //        assertConservation) — pribudnú od F2 presne v poradí §6.

    // 13. events.flush() — udalosti ticku pre prezentáciu.
    return this.events.flush();
  }

  /**
   * Čistý JSON stav v1 (§14; tvar pozri `WorldState`). Fronta príkazov sa neukladá, preto musí byť prázdna —
   * inak `Error` (zavolaj najprv `applyPending()` alebo `tick()`).
   */
  serialize(): WorldState {
    if (this.pendingCommands.length > 0) {
      throw new Error(
        `World.serialize: vo fronte je ${String(this.pendingCommands.length)} neaplikovaných príkazov — najprv applyPending() alebo tick()`,
      );
    }
    const roads: SerializedRoad[] = [];
    for (let i = 0; i < this.grid.cellCount; i++) {
      const { road } = this.grid.atIndex(i);
      if (road !== 'none') roads.push([i, road]);
    }
    const parcels: Record<string, ParcelOwnership> = {};
    for (const [id, parcel] of this.parcels) parcels[id] = parcel.ownership;
    return {
      version: WORLD_STATE_VERSION,
      mapId: this.map.id,
      seed: this.seed,
      rng: this.rng.getState(),
      clock: this.clock.getState(),
      ids: this.ids.getState(),
      cashCents: this.cashCents,
      roads,
      parcels,
    };
  }

  /**
   * Príkazy vo fronte v poradí vloženia: `validate` nad aktuálnym stavom (vidí účinok predchádzajúcich príkazov),
   * pri úspechu `apply`, inak `CommandRejected` bez zmeny stavu. Spracujú sa len príkazy zaradené pred začiatkom
   * kola; príkaz zaradený počas `apply` počká na ďalšie kolo.
   */
  private applyQueuedCommands(): void {
    const count = this.pendingCommands.length;
    for (let i = 0; i < count; i++) {
      // `shift` po jednom: ak `apply` vyhodí výnimku, zvyšné príkazy ostanú vo fronte.
      const command = this.pendingCommands.shift() as Command;
      const result = command.validate(this);
      if (result.ok) {
        command.apply(this);
      } else {
        this.events.emit({ type: 'CommandRejected', commandType: command.type, reasons: Object.freeze([...result.reasons]) });
      }
    }
  }

  /** Krok 1: posun hodín a udalosti `TickAdvanced` + uzavreté hranice. */
  private advanceClock(): void {
    const closed = this.clock.advance();
    const tick = this.clock.tick;
    this.events.emit({ type: 'TickAdvanced', tick });
    if (closed.hourClosed) this.events.emit({ type: 'HourClosed', tick });
    if (closed.dayClosed) this.events.emit({ type: 'DayClosed', tick });
    if (closed.monthClosed) this.events.emit({ type: 'MonthClosed', tick });
  }
}
