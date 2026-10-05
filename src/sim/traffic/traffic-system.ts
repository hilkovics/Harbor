/**
 * TrafficSystem — krok 6a ticku (ADR-037, ADR-038; rozhodnutia orchestrátora R1 č. 4–7 a 12): pohyb všetkých nosičov na
 * cestách (vozidlá aj kamióny v jazdných stavoch) pod pruhovými slotmi. Vozidlá ani kamióny cez seba neprechádzajú.
 *
 * - **Poradie:** nosiče v jazdných stavoch (`motion: 'drive'`) sa zoradia podľa `(blockedTicks zostupne, id vzostupne)` a každý
 *   sa pohne raz — existujúcou jazdnou funkciou podľa druhu (`DRIVING`: preplánovanie po zmene ciest + `advanceCarrier`).
 *   Stojace nosiče na ceste (pobyt pri module, pod hákom, fronta brány, `no_path`; `holdsRoad` bez `drive`) sa nehýbu,
 *   len držia sloty — pre jazdiace sú to prekážky bez rekurzie (nehýbu sa, takže čakanie na ne sa rieši preplánovaním).
 * - **Brána úseku** (`AdvanceGate`): nosič vyráža zo stredu bunky, len keď získa slot ďalšej bunky (pri križovatke naraz celú
 *   reťaz križovatiek a prvú bunku za nimi, pri úseku `one_lane` len ak v ňom nikto nejde oproti). Inak stojí v strede bunky
 *   a zvyšok kroku prepadne. Kto sa nepohol, hoci chcel, má `blockedTicks += 1`; kto sa pohol, 0.
 * - **Rekurzia na blokujúceho:** slot drží nosič, ktorý sa v ticku ešte nehýbal, → najprv sa vyrieši on. Ak je blokujúci nosič
 *   na zásobníku, ide o **cyklus čakania**: nosiče cyklu sa zapíšu (kandidáti preplánovania) a čakajúci stojí.
 * - **Vstup do jazdného stavu:** nosič, ktorý ešte nič nedrží, najprv zaberie slot svojej bunky (pruh podľa strany výjazdu);
 *   ak ho nedostane, stojí (`blockedTicks += 1`). Stojaci nosič bez slotov na ceste (kúpené vozidlo, nosič po obnove save)
 *   si slot svojej bunky nárokuje na konci kroku, kým ho nedostane. Výjazdy z modulov a vznik kamióna na portáli
 *   zaberajú slot hlavy samy (nikdy nestoja na ceste bez slotu).
 * - **Preplánovanie pri cykle** (na konci kroku, nosiče vzostupne podľa id): nosič s `blockedTicks ≥ gridlockTicks`, ktorý je
 *   v cykle tohto ticku, alebo s `blockedTicks ≥ stuckTicks`, preplánuje trasu mimo prvej blokovanej bunky (A* s dočasne
 *   zakázanou bunkou, mimo `PathCache`), najviac raz za `rerouteCooldownTicks`. Nosič čakajúci na slot vlastnej bunky
 *   (vstup na cestu) po `stuckTicks` obíde prvú bunku trasy — iná strana výjazdu môže dať voľný druhý pruh.
 *
 * Systém nemá trvalý stav: čakanie, odpočet preplánovania, telo a sloty vpredu sú na nosičoch (a v save); zásobník, cykly
 * a poradie sú pracovné štruktúry jedného ticku.
 */
import type { EntityId } from '../core/entity-id';
import type { AdvanceGate, Carrier, CarrierKind } from '../movement/carrier';
import { routeAnchor, takePath } from '../movement/route-planning';
import { advanceTruck, replanTruck } from '../systems/landside-system';
import { advanceVehicle, replanVehicle } from '../systems/vehicle-system';
import type { Truck } from '../trucks/truck';
import type { Vehicle } from '../vehicles/vehicle';
import type { World } from '../world/world';
import { NO_SIDE, sideBetween } from './cell-lanes';
import { headSlotKey } from './head-slot';
import { endsInQueue, holdsRoad, isDriving, type RoadCarrier } from './holds-road';
import { laneOf } from './lane-for';
import { LANES_PER_CELL, keyCell, slotKey } from './lane-slots';

/** Jazdné funkcie podľa druhu nosiča: preplánovanie po zmene ciest (`false` = nosič prešiel do `no_path`) a jeden tick jazdy. */
interface Driving {
  readonly replan: (carrier: RoadCarrier, world: World) => boolean;
  readonly advance: (carrier: RoadCarrier, world: World) => void;
}

const DRIVING: { readonly [K in CarrierKind]: Driving } = Object.freeze({
  vehicle: Object.freeze({
    replan: (carrier: RoadCarrier, world: World) => replanVehicle(carrier as Vehicle, world),
    advance: (carrier: RoadCarrier, world: World) => advanceVehicle(carrier as Vehicle, world),
  }),
  truck: Object.freeze({
    replan: (carrier: RoadCarrier, world: World) => replanTruck(carrier as Truck, world),
    advance: (carrier: RoadCarrier, world: World) => advanceTruck(carrier as Truck, world),
  }),
});

const byWaiting = (a: Carrier, b: Carrier): number => b.blockedTicks - a.blockedTicks || a.id - b.id;
const byId = (a: Carrier, b: Carrier): number => a.id - b.id;

export class TrafficSystem implements AdvanceGate {
  private world: World | null = null;
  private readonly order: RoadCarrier[] = [];
  private readonly byIdMap = new Map<number, RoadCarrier>();
  private readonly done = new Set<number>();
  private readonly stack: RoadCarrier[] = [];
  private readonly inCycle = new Set<number>();
  private readonly blockedCell = new Map<number, number>();
  /** Nosiče, ktorým sa v tomto ticku v kroku 6a zmenil stav (`no_path`): FSM krok toho istého ticku ich preskočí (ADR-016). */
  private readonly changed = new Set<number>();
  /** Nosič, ktorý sa práve hýbe (brána úseku koná v jeho mene). */
  private current: RoadCarrier | null = null;
  /** Nosič `current` chcel ísť, ale slot bol obsadený. */
  private blocked = false;
  /** Bunka prvého obsadeného slotu posledného pokusu (`firstBlocker`). */
  private blockerCell = -1;

  /** Krok 6a: jeden pohyb každého nosiča v jazdnom stave (viď hlavička súboru). */
  tick(world: World): void {
    const order = this.order;
    order.length = 0;
    this.changed.clear();
    this.byIdMap.clear();
    this.done.clear();
    this.inCycle.clear();
    this.blockedCell.clear();
    this.stack.length = 0;
    this.current = null;
    this.world = world;
    for (const vehicle of world.vehicles.values()) if (isDriving(vehicle)) order.push(vehicle);
    for (const truck of world.trucks.values()) if (isDriving(truck)) order.push(truck);
    for (const carrier of order) if (carrier.rerouteCooldown > 0) carrier.rerouteCooldown -= 1;
    order.sort(byWaiting);
    for (const carrier of order) this.byIdMap.set(carrier.id, carrier);
    for (const carrier of order) if (!this.done.has(carrier.id)) this.process(carrier);
    this.claimStanding(world);
    this.rerouteStuck(world, order);
    this.current = null;
  }

  /**
   * Stojaci nosič na ceste bez slotov (kúpené vozidlo, nosič po obnove save) zaberie slot svojej bunky; nedostane ho, kým ho drží
   * iný nosič. Po pohybe všetkých jazdiacich — slot, ktorý práve uvoľnili, tak využije stojaci nosič v tom istom ticku.
   */
  private claimStanding(world: World): void {
    for (const vehicle of world.vehicles.values()) if (vehicle.body.length === 0 && holdsRoad(vehicle) && !isDriving(vehicle)) this.claimHead(world, vehicle);
    for (const truck of world.trucks.values()) if (truck.body.length === 0 && holdsRoad(truck) && !isDriving(truck)) this.claimHead(world, truck);
  }

  /**
   * Zmenil sa nosiču v tomto ticku v kroku 6a stav (preplánovanie bez cesty → `no_path`)? Tick vstupu do stavu je jeho nultý
   * tick (ADR-016), preto FSM krok toho istého ticku (6b, krok 8) takého nosiča preskočí — odpočet začne v ďalšom ticku.
   */
  changedState(carrierId: number): boolean {
    return this.changed.has(carrierId);
  }

  // -------------------------------------------------------------------------------------------------------
  // AdvanceGate — brána úseku pre `Carrier.advance`
  // -------------------------------------------------------------------------------------------------------

  tryEnter(from: number): boolean {
    const carrier = this.current;
    if (carrier === null || this.world === null) return true;
    // Sloty vpredu (rozbehnutý úsek, reťaz križovatky) nosič už drží — `Carrier` ich zosúladí s trasou pri jej zmene.
    if (carrier.ahead.length > 0) return true;
    const keys = this.entryKeys(this.world, carrier, from);
    if (keys === null || !this.acquire(carrier, keys, from)) {
      this.blocked = true;
      return false;
    }
    for (const key of keys) carrier.reserveAhead(key);
    return true;
  }

  onReach(cell: number): void {
    this.current?.reachCell(cell);
  }

  // -------------------------------------------------------------------------------------------------------
  // Pohyb jedného nosiča
  // -------------------------------------------------------------------------------------------------------

  private process(carrier: RoadCarrier): void {
    const world = this.world;
    if (world === null) return;
    const outerCurrent = this.current;
    const outerBlocked = this.blocked;
    this.current = carrier;
    this.blocked = false;
    this.stack.push(carrier);
    const x = carrier.x;
    const y = carrier.y;
    const state: string = carrier.state;
    try {
      this.step(world, carrier);
    } finally {
      if (carrier.state !== state) this.changed.add(carrier.id);
      this.stack.pop();
      this.done.add(carrier.id);
      const waited = this.blocked;
      this.current = outerCurrent;
      this.blocked = outerBlocked;
      const before = carrier.blockedTicks;
      if (!holdsRoad(carrier)) carrier.blockedTicks = 0;
      else if (waited && carrier.x === x && carrier.y === y) carrier.blockedTicks += 1;
      else carrier.blockedTicks = 0;
      this.reportJam(world, carrier, before);
    }
  }

  /**
   * Hlásenie zápchy (rozhodnutie R1 č. 12): keď `blockedTicks` prvýkrát dosiahne `traffic.stuckTicks`, vznikne `TrafficJam`; po prvom
   * pohybe (alebo opustení cesty) potom `TrafficJamCleared`. Stav hlásenia je v `blockedTicks` (je v save), systém ho nedrží.
   */
  private reportJam(world: World, carrier: RoadCarrier, before: number): void {
    const stuck = world.defs.logistics.traffic.stuckTicks;
    if (carrier.blockedTicks === stuck) {
      const width = world.grid.width;
      const blocked = this.blockedCell.get(carrier.id);
      const at = carrier.cell;
      const blockerIds: EntityId[] = [];
      if (blocked !== undefined) {
        for (let lane = 0; lane < LANES_PER_CELL; lane++) {
          const holder = world.laneSlots.holderOfKey(slotKey(blocked, lane));
          if (holder !== 0 && holder !== carrier.id && !blockerIds.includes(holder as EntityId)) blockerIds.push(holder as EntityId);
        }
        blockerIds.sort((a, b) => a - b);
      }
      world.events.emit({ type: 'TrafficJam', carrierId: carrier.id, carrierKind: carrier.kind, cell: { x: at % width, y: Math.floor(at / width) }, blockerIds });
    } else if (before >= stuck && carrier.blockedTicks === 0) {
      world.events.emit({ type: 'TrafficJamCleared', carrierId: carrier.id, carrierKind: carrier.kind });
    }
  }

  private step(world: World, carrier: RoadCarrier): void {
    const driving = DRIVING[carrier.kind];
    // Najprv preplánovanie (po zmene ciest): slot bunky sa volí podľa strany výjazdu novej trasy a čakajúci nosič nemá zastaranú trasu.
    if (!driving.replan(carrier, world)) return;
    if (carrier.body.length === 0 && !this.claimHead(world, carrier)) {
      this.blocked = true;
      return;
    }
    driving.advance(carrier, world);
  }

  /**
   * Nosič bez slotov na ceste (vstup do jazdného stavu, kúpené vozidlo): zaberie slot svojej bunky (pruh podľa strany výjazdu,
   * `headSlotKey`) a pri rozbehnutom úseku aj slot cieľovej bunky úseku. `false` = niektorý slot drží iný nosič.
   */
  private claimHead(world: World, carrier: RoadCarrier): boolean {
    const lanes = world.cellLanes;
    const { width } = world.grid;
    const cell = carrier.cell;
    const next = carrier.nextCell;
    const head = headSlotKey(world, carrier);
    const keys = [head];
    if (carrier.progress > 0 && next !== undefined) {
      const after = carrier.routeCellAt(2);
      keys.push(slotKey(next, laneOf(lanes, next, sideBetween(width, next, cell), after === undefined ? NO_SIDE : sideBetween(width, next, after))));
    }
    if (!this.acquire(carrier, keys, -1)) return false;
    carrier.reserveHead(head);
    if (keys.length > 1) carrier.reserveAhead(keys[1]);
    return true;
  }

  /**
   * Kľúče slotov pri vstupe zo stredu `from` do ďalšej bunky trasy: bunka; pri križovatke aj všetko, čo treba, aby telo
   * nosiča križovatku **celé opustilo** — `lengthCells` buniek za poslednou križovatkou reťaze (bunky medzi križovatkami
   * patria do reťaze, ďalšia križovatka v dosahu reťaz predĺži). Trasa končiaca skôr: len po jej koniec. Hlava, ktorá by
   * stála o jednu bunku za križovatkou, by v nej totiž ešte držala chvost a dvojica protiidúcich nosičov medzi dvoma
   * križovatkami by sa navzájom zablokovala (cyklus čakania); rozhodnutie orchestrátora R1 č. 5 žiada „prvú bunku za nimi“,
   * čo platí len pre nosič dĺžky 1 — pozri dodatok ADR-037 (TR1-02).
   */
  private entryKeys(world: World, carrier: RoadCarrier, from: number): number[] | null {
    const lanes = world.cellLanes;
    const { width } = world.grid;
    const keys: number[] = [];
    let previous = from;
    let clearance = 0;
    for (let offset = 1; ; offset++) {
      const cell = carrier.routeCellAt(offset);
      if (cell === undefined) {
        // Fronta nesiaha do križovatky: kamión, ktorý by zastal vo fronte brány s telom v križovatke, do nej nevstúpi.
        if (clearance > 0 && endsInQueue(carrier)) return null;
        break;
      }
      const after = carrier.routeCellAt(offset + 1);
      keys.push(slotKey(cell, laneOf(lanes, cell, sideBetween(width, cell, previous), after === undefined ? NO_SIDE : sideBetween(width, cell, after))));
      if (lanes.isJunction(cell)) clearance = carrier.lengthCells;
      else if (clearance > 0) clearance -= 1;
      if (clearance === 0) break;
      previous = cell;
    }
    return keys;
  }

  /**
   * Overí, že všetky sloty `keys` sú voľné (alebo vlastné) a úsek `one_lane` neobsadzuje nosič idúci oproti. Obsadený slot
   * drží nosič, ktorý sa v ticku ešte nehýbal → najprv sa vyrieši on (rekurzia); nosič na zásobníku je cyklus čakania.
   * `from` = bunka, z ktorej nosič vyráža (-1 = vlastná bunka, bez pravidla úseku). `false` = nosič stojí.
   */
  private acquire(carrier: RoadCarrier, keys: readonly number[], from: number): boolean {
    const world = this.world;
    if (world === null) return true;
    for (;;) {
      const holder = this.firstBlocker(world, carrier, keys, from);
      if (holder === 0) return true;
      this.blockedCell.set(carrier.id, this.blockerCell);
      const other = this.byIdMap.get(holder);
      if (other === undefined || this.done.has(holder)) return false;
      if (this.stack.includes(other)) {
        this.markCycle(other);
        return false;
      }
      this.process(other);
    }
  }

  private markCycle(from: RoadCarrier): void {
    for (let i = this.stack.indexOf(from); i >= 0 && i < this.stack.length; i++) this.inCycle.add(this.stack[i].id);
  }

  /** Držiteľ prvého obsadeného slotu z `keys` alebo nosiča idúceho oproti v úseku `one_lane`; 0 = nič nebráni. */
  private firstBlocker(world: World, carrier: RoadCarrier, keys: readonly number[], from: number): number {
    const slots = world.laneSlots;
    for (const key of keys) {
      const holder = slots.holderOfKey(key);
      if (holder !== 0 && holder !== carrier.id) {
        this.blockerCell = keyCell(key);
        return holder;
      }
    }
    if (from < 0) return 0;
    const lanes = world.cellLanes;
    const { width } = world.grid;
    let previous = from;
    for (const key of keys) {
      const cell = keyCell(key);
      const segment = lanes.segmentOf(cell);
      if (segment !== 0) {
        const direction = lanes.entryDirection(width, cell, previous);
        for (const member of lanes.cellsOfSegment(segment)) {
          const holder = slots.holderOfKey(slotKey(member, 0));
          if (holder === 0 || holder === carrier.id) continue;
          const other = world.vehicles.get(holder as EntityId) ?? world.trucks.get(holder as EntityId);
          if (other !== undefined && this.segmentDirection(world, other, segment) !== direction) {
            this.blockerCell = member;
            return holder;
          }
        }
      }
      previous = cell;
    }
    return 0;
  }

  /**
   * Smer, ktorým nosič ide po úseku `one_lane` (`+1` rastúca pozícia, `-1` klesajúca) — čistá funkcia jeho tela, slotov
   * vpredu a polohy v úseku, takže sa po obnove save rovná tomu, čo bolo za behu. Poradie jazdy: chvost → hlava → vpredu.
   * Určuje ho vstup do úseku zvonka (z predchádzajúcej bunky stopy), inak dvojica susedných buniek stopy v úseku, inak
   * koniec úseku, ktorým stopa vychádza.
   */
  private segmentDirection(world: World, carrier: RoadCarrier, segment: number): 1 | -1 {
    const lanes = world.cellLanes;
    const { width } = world.grid;
    const { body, ahead } = carrier;
    const total = body.length + ahead.length;
    const at = (i: number): number => keyCell(i < body.length ? body[body.length - 1 - i] : ahead[i - body.length]);
    let first = 0;
    while (first < total && lanes.segmentOf(at(first)) !== segment) first++;
    if (first >= total) return 1;
    const entry = at(first);
    if (first > 0 && at(first - 1) !== entry) return lanes.entryDirection(width, entry, at(first - 1));
    for (let i = first; i + 1 < total; i++) {
      const a = at(i);
      const b = at(i + 1);
      if (a === b) continue;
      if (lanes.segmentOf(b) === segment) return lanes.positionOf(b) > lanes.positionOf(a) ? 1 : -1;
      return lanes.cellsOfSegment(segment).length === 1
        ? sideBetween(width, a, b) === lanes.end0(a)
          ? -1
          : 1
        : lanes.positionOf(a) === 0
          ? -1
          : 1;
    }
    return 1;
  }

  // -------------------------------------------------------------------------------------------------------
  // Preplánovanie pri zápche
  // -------------------------------------------------------------------------------------------------------

  private rerouteStuck(world: World, order: RoadCarrier[]): void {
    const { gridlockTicks, stuckTicks, rerouteCooldownTicks } = world.defs.logistics.traffic;
    order.sort(byId);
    for (const carrier of order) {
      if (carrier.blockedTicks === 0 || carrier.rerouteCooldown > 0 || !holdsRoad(carrier)) continue;
      const stuck = carrier.blockedTicks >= stuckTicks;
      const gridlocked = carrier.blockedTicks >= gridlockTicks && this.inCycle.has(carrier.id);
      if (!stuck && !gridlocked) continue;
      this.reroute(world, carrier, rerouteCooldownTicks);
    }
  }

  /**
   * Nová trasa k doterajšiemu cieľu mimo prvej blokovanej bunky (`Pathfinder.findPathAvoiding`, mimo `PathCache`). Pokus
   * (aj neúspešný) spustí odpočet `rerouteCooldownTicks`. Čakajúci nosič stojí v strede bunky, takže kotva je jeho bunka.
   */
  private reroute(world: World, carrier: RoadCarrier, cooldownTicks: number): void {
    carrier.rerouteCooldown = cooldownTicks;
    const target = carrier.routeCellAt(carrier.cellsAhead);
    const anchor = routeAnchor(carrier);
    if (carrier.replanPending || target === undefined || anchor === undefined || anchor === target) return;
    // Nosič čakajúci na slot vlastnej bunky (ešte nič nedrží) svoju bunku neobíde; obíde prvú bunku trasy, takže strana
    // výjazdu (a s ňou pruh vlastnej bunky) môže byť iná. Ostatní obídu prvú blokovanú bunku.
    const blocked = carrier.body.length === 0 ? carrier.routeCellAt(1) : this.blockedCell.get(carrier.id);
    if (blocked === undefined || blocked === anchor) return;
    const path = world.pathfinder.findPathAvoiding(anchor, target, blocked);
    if (path !== null) takePath(world, carrier, path);
  }
}
