/**
 * World — koreň simulácie (ARCHITECTURE §5, §6). Vlastní hodiny, mriežku, parcely, hotovosť, jediný `Rng`,
 * alokátor ID, zbernicu udalostí, `CargoLedger`, moduly so skupinami kotvísk a lode; prezentácia ho len číta
 * a mení ho výlučne cez `Command` (pravidlo 5).
 *
 * Tick pipeline: príkazy z fronty → krok 1 (`clock.advance()` + udalosti hraníc) → krok 13 (`events.flush()`).
 * Kroky 2–12 pribúdajú so systémami na označenom mieste v `tick()`; poradie §6 je záväzné a mení sa len cez ADR.
 *
 * Moduly (ADR-014): `addModule`/`removeModule` sú štrukturálne operácie pre príkazy (`PlaceModule`/`RemoveModule`,
 * T02-04) a obnovu zo save — zapisujú `cell.moduleId`, spravujú `craneIds` berthov a prepočítajú `berthGroups`.
 * Pravidlá umiestnenia (§8: terén, parcela, voda, cena) overuje príkaz vopred; tieto metódy strážia len
 * konzistenciu sveta a pri porušení vyhodia `ModuleError` bez zmeny stavu. Udalosti emituje príkaz.
 */
import { CargoLedger } from '../cargo/cargo-ledger';
import type { CargoLedgerState } from '../cargo/cargo-ledger-state';
import { EntityIdAllocator, type EntityId } from '../core/entity-id';
import { EventBus } from '../core/event-bus';
import { INITIAL_SPEED, SimClock } from '../core/sim-clock';
import { Rng } from '../core/rng';
import type { Command } from '../commands/command';
import { DefError, type DefRegistry } from '../defs/def-registry';
import type { SimEvent } from '../events/sim-event';
import type { Grid } from '../grid/grid';
import type { PlacedModuleSpec } from '../grid/map-def';
import { MapError, pointerSegment } from '../grid/map-error';
import type { LoadedMap } from '../grid/map-loader';
import type { Parcel, ParcelOwnership } from '../grid/parcel';
import { BerthModule } from '../modules/berth-module';
import { computeBerthGroups, type BerthGroup } from '../modules/berth-group';
import { CraneModule } from '../modules/crane-module';
import type { Module } from '../modules/module';
import { ModuleError } from '../modules/module-error';
import { moduleRegistry } from '../modules/module-registry';
import type { Ship } from '../ships/ship';
import { StatResolver } from '../tech/stat-resolver';
import { migrateWorldState } from './migrate';
import { PLACEMENT_RULE_ERROR, attachesToHost, findPlacementViolations, findRemovalViolations } from './module-rules';
import { WorldInvariantError, findWorldViolation } from './world-invariants';
import { restoreEntities } from './world-restore';
import {
  WORLD_STATE_VERSION,
  parseWorldState,
  type AnyWorldState,
  type SerializedModule,
  type SerializedRoad,
  type SerializedTraffic,
  type WorldState,
} from './world-state';

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
  /** Uložený stav ledgera (overený `parseWorldState`); `null` = prázdny ledger novej hry. */
  readonly cargo: CargoLedgerState | null;
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

const NO_GROUPS: readonly BerthGroup[] = Object.freeze([]);

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
  /** Jediný zdroj polohy nákladu (§7.1, pravidlo 2): id jednotiek z `ids`, `CargoMoved` do `events` s `clock.tick`. */
  readonly cargo: CargoLedger;
  /** Moduly v poradí umiestnenia (= vzostupne podľa id); meniť len cez `addModule`/`removeModule`. */
  readonly modules: ReadonlyMap<EntityId, Module>;
  /** Lode podľa id — vo F2 (T02-03) vždy prázdne, naplní ShipSystem (T02-05). */
  readonly ships: ReadonlyMap<EntityId, Ship> = new Map<EntityId, Ship>();
  /** Štatistiky entít po modifikátoroch (§10); vo F2 základ z defov. */
  readonly stats: StatResolver;
  /** Hotovosť v centoch (USD); môže byť záporná (bankrot rieši F5). */
  cashCents: number;

  private readonly pendingCommands: Command[] = [];
  private readonly moduleMap = new Map<EntityId, Module>();
  private groups: readonly BerthGroup[] = NO_GROUPS;

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
    const deps = { cargoTypes: parts.defs.cargoTypes, ids: parts.ids, events: this.events, clock: parts.clock };
    this.cargo = parts.cargo === null ? new CargoLedger(deps) : CargoLedger.fromState(parts.cargo, deps);
    this.modules = this.moduleMap;
    this.stats = new StatResolver(parts.defs);
  }

  /**
   * Nová hra: tick 0 pri rýchlosti `INITIAL_SPEED`, hotovosť `economy.startingCashCents`, `Rng(seed)`, ID od 1,
   * mriežka = nová `map.createGrid()` (so starter cestami), parcely skopírované (`startOwned` → `owned`) a starter
   * moduly mapy (Root modul, ADR-015) umiestnené v poradí mapy s `purchaseCostCents 0` — rovnakými pravidlami ako
   * `PlaceModule` okrem ceny, bez udalostí a bez zmeny hotovosti (dostanú id 1, 2, …).
   * Chyby: seed nie je uint32 → `RangeError`; `INITIAL_SPEED` chýba v `time.speeds` → `DefError`; starter modul
   * s neznámym defom alebo porušeným pravidlom umiestnenia → `MapError` s cestou `/starter/modules/<i>`.
   */
  static create(defs: DefRegistry, map: LoadedMap, seed: number): World {
    const rng = new Rng(seed);
    const clock = new SimClock(defs.time);
    if (!defs.time.speeds.includes(clock.speed)) {
      throw new DefError('time', '/speeds', `musí obsahovať počiatočnú rýchlosť ${String(INITIAL_SPEED)} (World.create)`);
    }
    const world = new World({
      defs,
      map,
      seed,
      clock,
      rng,
      ids: new EntityIdAllocator(),
      grid: map.createGrid(),
      parcels: copyParcels(map),
      cashCents: defs.economy.startingCashCents,
      cargo: null,
    });
    world.placeStarterModules();
    return world;
  }

  /**
   * Obnoví svet zo `serialize()` (aj po `JSON.parse`); staršiu verziu najprv prevedie `migrateWorldState` (v1 → v2:
   * bez modulov, lodí a nákladu). Terén a parcely berie z `map` (musí mať `id === state.mapId`), vrstvu dopravy celú
   * z `state.roads` — starter cesta, ktorú hráč odstránil, sa neobnoví; moduly, náklad a odvodený stav obnoví
   * `restoreEntities`. Neplatný stav → `WorldStateError` (pozri `parseWorldState`, `restoreEntities`). Výsledok
   * nezdieľa meniteľný stav so `state` ani s `map`.
   */
  static deserialize(defs: DefRegistry, map: LoadedMap, state: AnyWorldState): World {
    const grid = map.createGrid();
    const parsed = parseWorldState(migrateWorldState(state), defs, map, grid);
    for (let i = 0; i < grid.cellCount; i++) grid.atIndex(i).road = 'none';
    for (const [index, layer] of parsed.roads) grid.atIndex(index).road = layer;
    for (const [index, value] of parsed.traffic) grid.atIndex(index).traffic = value;
    const parcels = copyParcels(map);
    for (const [id, ownership] of parsed.ownership) {
      const parcel = parcels.get(id);
      if (parcel !== undefined) parcel.ownership = ownership;
    }
    const world = new World({
      defs,
      map,
      seed: parsed.seed,
      clock: parsed.clock,
      rng: parsed.rng,
      ids: parsed.ids,
      grid,
      parcels,
      cashCents: parsed.cashCents,
      cargo: parsed.cargo,
    });
    restoreEntities(world, parsed.modules, parsed.cargo.units);
    return world;
  }

  /** Skupiny kotvísk (§5.4) v poradí id; prepočítajú sa pri každom `addModule`/`removeModule`. */
  get berthGroups(): readonly BerthGroup[] {
    return this.groups;
  }

  /** Počet príkazov čakajúcich vo fronte. */
  get pendingCommandCount(): number {
    return this.pendingCommands.length;
  }

  // -------------------------------------------------------------------------------------------------------
  // Moduly (ADR-014)
  // -------------------------------------------------------------------------------------------------------

  /**
   * Postaví modul: nová inštancia z `moduleRegistry` s id z `ids` a zaplatenou cenou, potom `addModule`.
   * Pravidlá umiestnenia (§8) musí volajúci overiť vopred (`PlaceModule.validate`). Chyby: `ModuleError`
   * (svet sa nezmení, id sa môže spotrebovať) alebo `DefError` pre neznámy `defId`.
   */
  placeModule(spec: PlacedModuleSpec, purchaseCostCents: number): Module {
    const def = this.defs.modules.get(spec.defId);
    const module = moduleRegistry.create(def, spec, this.ids.next(), purchaseCostCents, { grid: this.grid });
    this.addModule(module);
    return module;
  }

  /**
   * Pridá hotový modul do sveta: zapíše `cell.moduleId` (pripájaný modul — žeriav — sa pripojí k berthu a bunky
   * ostávajú berthu) a prepočíta `berthGroups`. Štrukturálne chyby (`ModuleError`, svet sa nezmení): id už vo svete
   * alebo nepridelené alokátorom (`duplicate_id`, `invalid_input`) a prvé porušenie štrukturálnych pravidiel
   * umiestnenia z `findPlacementViolations` (rovnaká funkcia ako `PlaceModule.validate`): footprint mimo mapy
   * (`out_of_bounds`), bunka obsadená (`occupied`) alebo s cestou (`road`); žeriav nestojí celý na jednom berthe
   * (`no_berth`), iná rotácia (`rotation_mismatch`), berth má `maxCranes` (`max_cranes`), prekryv s iným žeriavom
   * (`crane_overlap`). Pravidlá hráča (terén, parcela, voda, cena) tu nie sú — tie overuje príkaz vopred.
   */
  addModule(module: Module): void {
    if (this.moduleMap.has(module.id)) throw new ModuleError('duplicate_id', `World.addModule: modul #${String(module.id)} už vo svete je`);
    if (module.id >= this.ids.getState().nextId) {
      throw new ModuleError('invalid_input', `World.addModule: id ${String(module.id)} nepridelil alokátor sveta (nextId ${String(this.ids.getState().nextId)})`);
    }
    const spec = { x: module.origin.x, y: module.origin.y, rotation: module.rotation };
    const [violation] = findPlacementViolations(this, module.def, spec, 'structural');
    const code = violation === undefined ? null : PLACEMENT_RULE_ERROR[violation.rule];
    if (violation !== undefined && code !== null) throw new ModuleError(code, `World.addModule: ${module.label}: ${violation.detail}`);
    if (attachesToHost(module.def)) {
      this.hostOf(module).attachCrane(module.id);
    } else {
      for (const { x, y } of module.cells) this.grid.at(x, y).moduleId = module.id;
    }
    this.moduleMap.set(module.id, module);
    this.refreshBerthGroups();
  }

  /**
   * Odstráni modul a vráti ho: uvoľní bunky (žeriav: odpojí sa od berthu) a prepočíta `berthGroups`. Príkaz
   * (`RemoveModule`) validuje dôvody vopred rovnakou funkciou `findRemovalViolations`; tu je poistka konzistencie
   * (`ModuleError` s kódom prvého porušenia, svet sa nezmení): neznáme id (`unknown_module`), modul s nákladom alebo
   * rezervovaným slotom (`has_cargo`), berth so žeriavmi (`has_cranes`) alebo s loďou (`ship_docked`), žeriav mimo
   * `idle`/`blocked` (`busy`).
   */
  removeModule(moduleId: EntityId): Module {
    const module = this.moduleMap.get(moduleId);
    if (module === undefined) throw new ModuleError('unknown_module', `World.removeModule: modul #${String(moduleId)} neexistuje`);
    const [violation] = findRemovalViolations(this, module);
    if (violation !== undefined) throw new ModuleError(violation.rule, `World.removeModule: ${violation.detail}`);
    if (attachesToHost(module.def)) {
      this.hostOf(module).detachCrane(module.id);
    } else {
      for (const { x, y } of module.cells) this.grid.at(x, y).moduleId = null;
    }
    this.moduleMap.delete(moduleId);
    this.refreshBerthGroups();
    return module;
  }

  /** Modul, ktorý bunku zaberá (pri žeriave jeho berth); mimo mapy alebo prázdna bunka → `undefined`. */
  moduleAt(x: number, y: number): Module | undefined {
    if (!this.grid.inBounds(x, y)) return undefined;
    const id = this.grid.at(x, y).moduleId;
    return id === null ? undefined : this.moduleMap.get(id);
  }

  /** Berth, ktorého footprint bunku zaberá; inak `undefined`. */
  berthOfCell(x: number, y: number): BerthModule | undefined {
    const module = this.moduleAt(x, y);
    return module instanceof BerthModule ? module : undefined;
  }

  /** Žeriav, ktorého footprint leží na bunke (stojí na berthe pod ňou); inak `undefined`. */
  craneAt(x: number, y: number): CraneModule | undefined {
    const berth = this.berthOfCell(x, y);
    if (berth === undefined) return undefined;
    for (const craneId of berth.craneIds) {
      const crane = this.moduleMap.get(craneId);
      if (crane instanceof CraneModule && crane.containsCell(x, y)) return crane;
    }
    return undefined;
  }

  /**
   * Invarianty sveta (§6 krok 12, §16): `cargo.assertConservation()` (→ `CargoConservationError`) a potom moduly,
   * mriežka, žeriavy, aprony a skupiny kotvísk voči sebe aj ledgeru (→ `WorldInvariantError`). Svet nemení.
   */
  assertInvariants(): void {
    this.cargo.assertConservation();
    const violation = findWorldViolation(this);
    if (violation !== undefined) throw new WorldInvariantError(violation);
  }

  // -------------------------------------------------------------------------------------------------------
  // Príkazy a tick
  // -------------------------------------------------------------------------------------------------------

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
   * Čistý JSON stav v2 (§14; tvar pozri `WorldState`): v1 polia + `traffic`, `modules` (poradie umiestnenia),
   * `cargo` (`cargo.getState()`) a `ships`. Fronta príkazov sa neukladá, preto musí byť prázdna — inak `Error`
   * (zavolaj najprv `applyPending()` alebo `tick()`). Záznam lode v2 zatiaľ nemá tvar (doplní ho ShipSystem, T02-05),
   * preto svet s loďou tiež vyhodí `Error` namiesto tichej straty lode.
   */
  serialize(): WorldState {
    if (this.pendingCommands.length > 0) {
      throw new Error(
        `World.serialize: vo fronte je ${String(this.pendingCommands.length)} neaplikovaných príkazov — najprv applyPending() alebo tick()`,
      );
    }
    if (this.ships.size > 0) {
      throw new Error(`World.serialize: WorldState v${String(WORLD_STATE_VERSION)} zatiaľ neukladá lode a svet ich má ${String(this.ships.size)}`);
    }
    const roads: SerializedRoad[] = [];
    const traffic: SerializedTraffic[] = [];
    for (let i = 0; i < this.grid.cellCount; i++) {
      const cell = this.grid.atIndex(i);
      if (cell.road !== 'none') roads.push([i, cell.road]);
      if (cell.traffic !== 0) traffic.push([i, cell.traffic]);
    }
    const parcels: Record<string, ParcelOwnership> = {};
    for (const [id, parcel] of this.parcels) parcels[id] = parcel.ownership;
    const modules = [...this.moduleMap.values()].map(
      (module): SerializedModule => ({
        id: module.id,
        defId: module.def.id,
        x: module.origin.x,
        y: module.origin.y,
        rotation: module.rotation,
        purchaseCostCents: module.purchaseCostCents,
        runtime: module.getRuntimeState(),
      }),
    );
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
      traffic,
      modules,
      cargo: this.cargo.getState(),
      ships: [],
    };
  }

  // -------------------------------------------------------------------------------------------------------
  // Vnútro
  // -------------------------------------------------------------------------------------------------------

  /**
   * Berth, na ktorom stojí pripájaný modul (žeriav, ADR-014): len `CraneModule` s berthom pod ľavým horným rohom.
   * Iný modul s `mustAttachTo` alebo chýbajúci berth → `ModuleError` (`invalid_input` / `no_berth`).
   */
  private hostOf(module: Module): BerthModule {
    if (!(module instanceof CraneModule)) {
      throw new ModuleError('invalid_input', `World: ${module.label} má placement.mustAttachTo, ale nie je žeriav (craneIds eviduje len žeriavy)`);
    }
    const berth = this.moduleMap.get(module.berthId);
    if (!(berth instanceof BerthModule)) {
      throw new ModuleError('no_berth', `World: ${module.label} stojí na #${String(module.berthId)}, ktorý nie je berth`);
    }
    return berth;
  }

  /**
   * Starter moduly mapy v poradí mapy (`World.create`): každý musí mať def v `modules.json` a spĺňať všetky pravidlá
   * umiestnenia (`findPlacementViolations`, ako `PlaceModule` bez ceny); inak `MapError` s indexom modulu.
   */
  private placeStarterModules(): void {
    this.map.starter.modules.forEach((spec, index) => {
      const path = `/starter/modules${pointerSegment(index)}`;
      if (!this.defs.modules.has(spec.defId)) {
        throw new MapError(this.map.id, `${path}/defId`, `starter modul '${spec.defId}' nie je v modules.json`);
      }
      const violations = findPlacementViolations(this, this.defs.modules.get(spec.defId), spec);
      if (violations.length > 0) {
        const at = `(${String(spec.x)}, ${String(spec.y)}) rot ${String(spec.rotation)}`;
        const why = violations.map(({ rule, detail }) => `${rule}: ${detail}`).join('; ');
        throw new MapError(this.map.id, path, `starter modul '${spec.defId}' na ${at} nespĺňa pravidlá umiestnenia (§8) — ${why}`);
      }
      this.placeModule(spec, 0);
    });
  }

  /** Prepočet skupín kotvísk a `groupId` každého berthu. */
  private refreshBerthGroups(): void {
    const berths = [...this.moduleMap.values()].filter((module): module is BerthModule => module instanceof BerthModule);
    this.groups = computeBerthGroups(berths);
    for (const group of this.groups) {
      for (const berthId of group.berthIds) {
        const berth = this.moduleMap.get(berthId);
        if (berth instanceof BerthModule) berth.groupId = group.id;
      }
    }
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
