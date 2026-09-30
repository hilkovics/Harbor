/**
 * Riadenie lodnej dopravy bez prekrývania (ARCHITECTURE §7.4; ADR-029; spätná väzba 4 „lode sa plavia cez seba").
 *
 * **Rezervácia trasy.** Loď sa pohne len po trase, ktorú si rezervovala (`Ship.route`), a trasu si rezervuje, len keď
 * bunky, ktoré cestou zaberie (`sweepRoute`), nemajú spoločnú bunku s rezerváciou žiadnej inej lode — rezervácia lode =
 * jej obdĺžnik a bunky zvyšku jej trasy. Trasy sa počas plavby len skracujú, takže rezervovaná trasa ostane voľná až do
 * konca a lode sa nikdy nemusia zastaviť uprostred ani obchádzať (bez fyzikálnych kolízií, §7.6). Výnimky nie sú:
 * ani lode v opačných smeroch na sea lane sa neprekrývajú (na dráhe je naraz najviac jedna loď alebo konvoj trás,
 * ktoré sa nedotýkajú).
 *
 * **Kedy sa rezervuje** (loď inak čaká na mieste, kde nikomu neprekáža):
 * - `arriving` → `inbound` (vstup): celá sea lane + úsek z konca dráhy k cieľu. Cieľ je voľný úsek kotvísk (poradie
 *   `allocateBerths`) alebo — keď kotvisko nie je — **anchorage pridelená ešte pred vstupom**. Bez cieľa s voľnou
 *   trasou loď čaká pred vstupom (mimo mapy, nezaberá bunky).
 * - `inbound` na konci dráhy → `berthing` (kotviská z rezervácie, alebo novo pridelené, ak je trasa voľná) alebo
 *   `waiting_anchorage` (dopláva na svoju anchorage po rezervovanom úseku).
 * - `waiting_anchorage` na anchorage → `berthing`, keď je kotvisko a trasa voľná.
 * - `docked` → `undocking` (vyložená loď): úsek od kotviska na koniec dráhy + sea lane von.
 * Úseky cez prístav hľadá A* po vode (`WaterNavigator`) s prekážkami = obdĺžniky lodí, ktoré stoja alebo na miesto
 * mieria (kotvisko, anchorage). Trasa ku kotvisku končí bodom priblíženia (`approachPoint`) a posunom bokom do polohy
 * pri kotvisku, odchod začína posunom bokom na bod priblíženia.
 *
 * **Bez uviaznutia** (lode, ktoré stoja, neblokujú trasy, ktoré ostatní potrebujú na odchod):
 * - anchorage je použiteľná, len keď obdĺžnik lode na nej nezasahuje do sea lane (so všetkými triedami lodí), pred
 *   žiadne kotvisko (pás vody + miesto na priblíženie) a nezatarasí cestu von žiadnej lodi, ktorá drží kotviská;
 * - kotvisko sa pridelí, len keď z neho vedie cesta späť na koniec dráhy a obdĺžnik lode pri ňom nezatarasí cestu
 *   von žiadnej inej lodi, ktorá drží kotviská;
 * - lode pred vstupom nezaberajú nič, lode na trase trasu dokončia.
 * Predpoklad mapy: anchorage leží na otvorenej vode, kde čakajúca loď nerozdelí prístav (trasu ku kotviskám obíde A*).
 *
 * **Poradie** (FIFO bez head-of-line blokovania): lode sa spracúvajú vzostupne podľa id. Keď loď, ktorá má voľné
 * kotvisko, nemôže vyplávať len preto, že jej trasu drží pohybujúca sa loď, neskoršie lode v tomto ticku nič
 * nerezervujú (okrem odchodu) — kotvisko jej nikto nepredbehne. Loď, pre ktorú kotvisko nie je, nikoho nebrzdí.
 *
 * **Memo** (výkon, nie stav simulácie): kandidáti pokusu a trasy von držiteľov kotvísk sa pamätajú pre „epochu"
 * dopravy a prepočítajú sa až po zmene lodí (prechod, príchod, odchod), kotvísk alebo modulov. Kandidáti závisia len
 * od stavu, ktorý epochu mení (pózy stojacich lodí, konce trás, kotviská, moduly), a voľnosť trasy sa overuje pri
 * každom pokuse nanovo — pokus s rovnakými vstupmi dá rovnaký výsledok, preto memo nemení priebeh (ani po načítaní
 * save, keď je prázdne).
 */
import type { EntityId } from '../core/entity-id';
import { BerthModule } from '../modules/berth-module';
import { frontBandCells } from '../modules/module-geometry';
import type { World } from '../world/world';
import { allocateBerths } from './berth-allocator';
import type { Ship } from './ship';
import { SHIP_STATE_TRAITS, type ShipState } from './ship-fsm';
import { TrafficArea, areasOverlap, boxHitsArea, boxesOverlap, sweepRoute, type ShipPose } from './ship-footprint';
import {
  DOCKED_HEADING,
  anchoragePoint,
  approachPoint,
  cardinalHeading,
  dockPoint,
  firstBerthOf,
  laneEnd,
  laneRoute,
  segmentHeading,
  shipBox,
  type CellBox,
  type ShipDimensions,
  type ShipPoint,
} from './ship-route';
import { AXIS_OF_HEADING, WaterNavigator } from './water-navigator';

/** Kurz lode na začiatku sea lane, keď dráha nemá dĺžku (sever). */
const DEFAULT_LANE_HEADING = 0;

/**
 * Rezerva za bodom priblíženia v páse, kam kotviaca loď nesmie (bunky): pás vody kotviska + šírka najširšej lode (obdĺžnik
 * v bode priblíženia) + táto rezerva na otočenie a posun v bunke bodu priblíženia. Štrukturálna hodnota geometrie A*
 * (stav lode = stred bunky), nie balans.
 */
const APPROACH_MARGIN_CELLS = 1;

/** Druh pokusu o rezerváciu (kandidáti sa pamätajú podľa lode a druhu). */
type AttemptKind = 'enter' | 'berth' | 'anchor' | 'undock';

/** Kandidát rezervácie: cieľ (kotviská, anchorage alebo nič — odchod), trasa a bunky, ktoré cestou zaberie. */
interface Candidate {
  readonly berths: readonly BerthModule[] | null;
  readonly anchorage: number | null;
  readonly route: readonly ShipPoint[];
  readonly area: TrafficArea;
}

/** Kandidáti posledného pokusu lode. */
interface CachedPlans {
  readonly epoch: number;
  readonly kind: AttemptKind;
  readonly candidates: readonly Candidate[];
}

/** Trasa von z kotviska (bod priblíženia → koniec dráhy) a bunky, ktoré loď cestou od kotviska zaberie. */
interface ExitPlan {
  readonly route: readonly ShipPoint[];
  readonly area: TrafficArea;
  /** Póza na konci dráhy (začiatok úseku sea lane von). */
  readonly end: ShipPose;
}

/** Statické oblasti pre použiteľnosť anchorage (memo podľa verzie modulov). */
interface KeepOut {
  readonly moduleVersion: number;
  readonly area: TrafficArea;
}

export class ShipTraffic {
  private readonly world: World;
  private navigatorInstance: WaterNavigator | undefined;
  private epoch = 0;
  private seenShipVersion = Number.NaN;
  private seenModuleVersion = Number.NaN;
  /** Loď → kandidáti posledného pokusu a epocha, v ktorej vznikli (memo, viď hlavička). */
  private readonly plans = new Map<EntityId, CachedPlans>();
  /** Loď, ktorá drží kotviská → trasa von v epoche `exitsEpoch` (`null` = cesta von nie je). */
  private readonly exits = new Map<EntityId, ExitPlan | null>();
  private exitsEpoch = Number.NaN;
  /** V tomto ticku čaká na kotvisko skoršia loď, ktorej bráni pohybujúca sa loď (FIFO, `attempt`). */
  private heldBack = false;
  private keepOut: KeepOut | undefined;
  private laneEnvelope: TrafficArea | undefined;
  private readonly scratch = new TrafficArea();

  constructor(world: World) {
    this.world = world;
  }

  /** A* po vode nad mriežkou sveta (vznikne pri prvom použití; terén je statický). */
  get navigator(): WaterNavigator {
    this.navigatorInstance ??= new WaterNavigator(this.world.grid);
    return this.navigatorInstance;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Epocha (memo)
  // -------------------------------------------------------------------------------------------------------------

  /** Zmena, po ktorej môže uspieť pokus, ktorý predtým neuspel (prechod lode, kotviská, anchorage). */
  bump(): void {
    this.epoch += 1;
  }

  private currentEpoch(): number {
    const { shipVersion, moduleVersion } = this.world;
    if (shipVersion !== this.seenShipVersion || moduleVersion !== this.seenModuleVersion) {
      this.seenShipVersion = shipVersion;
      this.seenModuleVersion = moduleVersion;
      this.epoch += 1;
    }
    return this.epoch;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Geometria: pózy, trasy, rezervácie
  // -------------------------------------------------------------------------------------------------------------

  /** Kurz na začiatku sea lane (smer prvého úseku). */
  laneStartHeading(): ShipPose['heading'] {
    const [first, second] = this.world.map.seaLane;
    if (first === undefined || second === undefined) return DEFAULT_LANE_HEADING;
    return cardinalHeading(second.x - first.x, second.y - first.y) ?? DEFAULT_LANE_HEADING;
  }

  /** Póza lode na konci trasy `route` (od bodu `startIndex`) z pózy `from` (bez zabratia buniek). */
  private endPose(from: ShipPose, route: readonly ShipPoint[], startIndex = 0): ShipPose {
    let pose = from;
    for (let i = startIndex; i < route.length; i++) {
      const point = route[i];
      pose = { x: point.x, y: point.y, heading: segmentHeading(point, point.x - pose.x, point.y - pose.y) ?? pose.heading };
    }
    return pose;
  }

  /** Póza lode na konci sea lane (vstup do prístavu). */
  private hubPose(): ShipPose {
    const lane = laneRoute(this.world);
    const start = lane[0];
    if (start === undefined) return { x: 0, y: 0, heading: DEFAULT_LANE_HEADING };
    return this.endPose({ x: start.x, y: start.y, heading: this.laneStartHeading() }, lane);
  }

  /** Počet bodov sea lane — dĺžka úseku dráhy na začiatku trasy `inbound`. */
  private get laneLength(): number {
    return this.world.map.seaLane.length;
  }

  /** Póza lode pri kotviskách `first` (`dockPoint`, `DOCKED_HEADING`). */
  private dockPose(dims: ShipDimensions, first: BerthModule): ShipPose {
    return { ...dockPoint(first, dims), heading: DOCKED_HEADING[first.waterSide] };
  }

  /**
   * Rezervácia lode (viď hlavička): obdĺžnik a bunky zvyšku trasy; `undocking` navyše celá sea lane von (rezervovaná
   * pri odchode spolu s úsekom ku koncu dráhy); loď pred vstupom nič.
   */
  reservationOf(ship: Ship, out: TrafficArea): void {
    if (!SHIP_STATE_TRAITS[ship.state].onMap) return;
    const end = sweepRoute(out, ship.def, { x: ship.x, y: ship.y, heading: ship.heading }, ship.route.slice(ship.waypointIndex));
    if (ship.state === 'undocking') sweepRoute(out, ship.def, end, [...laneRoute(this.world)].reverse());
  }

  /** Obdĺžnik lode na konci jej trasy (kde bude stáť) — prekážka pre A* ostatných lodí; `undefined` = loď nestojí ani nemieri na miesto. */
  private restBox(ship: Ship): CellBox | undefined {
    const state: ShipState = ship.state;
    if (state !== 'inbound' && state !== 'waiting_anchorage' && state !== 'berthing' && state !== 'docked') return undefined;
    if (state === 'inbound' && ship.berthIds.length === 0 && ship.anchorageIndex === null) return undefined;
    const end = this.endPose({ x: ship.x, y: ship.y, heading: ship.heading }, ship.route, ship.waypointIndex);
    return shipBox(ship.def, end.x, end.y, end.heading);
  }

  /** Prekážky pre A* lode `ship`: miesta, kde stoja alebo budú stáť ostatné lode (plus `extra`). */
  private obstaclesFor(ship: Ship | undefined, extra?: CellBox): CellBox[] {
    const boxes: CellBox[] = [];
    for (const other of this.world.ships.values()) {
      if (other === ship) continue;
      const box = this.restBox(other);
      if (box !== undefined) boxes.push(box);
    }
    if (extra !== undefined) boxes.push(extra);
    return boxes;
  }

  /** Je trasa `area` lode `ship` voľná voči rezerváciám všetkých ostatných lodí? */
  private isClear(ship: Ship, area: TrafficArea): boolean {
    for (const other of this.world.ships.values()) {
      if (other === ship) continue;
      this.scratch.clear();
      this.reservationOf(other, this.scratch);
      if (areasOverlap(area, this.scratch)) return false;
    }
    return true;
  }

  /** Úsek A* po vode z pózy `from` do bunky bodu `goal` (s osou `goalHeading`, ak je daná); `null` = cesta nie je. */
  private waterLeg(dims: ShipDimensions, from: ShipPose, goal: ShipPoint, goalHeading: ShipPose['heading'] | null, obstacles: readonly CellBox[]): ShipPoint[] | null {
    const nav = this.navigator;
    return nav.findRoute(dims, nav.cellOf(from), from.heading, nav.cellOf(goal), goalHeading === null ? null : AXIS_OF_HEADING[goalHeading], obstacles);
  }

  /**
   * Úsek ku kotviskám `first` z pózy `from`: A* po vode do bunky bodu priblíženia (os rovnobežná s hranou), bod
   * priblíženia a posun bokom do polohy pri kotvisku (kurz `DOCKED_HEADING`). `null` = cesta nie je.
   */
  berthLeg(dims: ShipDimensions, from: ShipPose, first: BerthModule, obstacles: readonly CellBox[]): ShipPoint[] | null {
    const heading = DOCKED_HEADING[first.waterSide];
    const approach = approachPoint(first, dims, this.world.map);
    const leg = this.waterLeg(dims, from, approach, heading, obstacles);
    if (leg === null) return null;
    return [...leg, { ...approach, heading }, { ...dockPoint(first, dims), heading }];
  }

  /**
   * Úsek od kotvísk `first` na koniec dráhy: posun bokom na bod priblíženia (kurz `DOCKED_HEADING`), potom A* po vode.
   * `null` = cesta nie je.
   */
  exitLeg(dims: ShipDimensions, first: BerthModule, obstacles: readonly CellBox[]): ShipPoint[] | null {
    const heading = DOCKED_HEADING[first.waterSide];
    const approach = { ...approachPoint(first, dims, this.world.map), heading };
    const hub = laneEnd(this.world);
    if (hub === undefined) return [approach];
    const leg = this.waterLeg(dims, approach, hub, null, obstacles);
    if (leg === null) return null;
    const last = leg[leg.length - 1];
    // Koniec A* je stred bunky konca dráhy = koniec dráhy (stred bunky); inak doplň presný bod.
    return last !== undefined && last.x === hub.x && last.y === hub.y ? [approach, ...leg] : [approach, ...leg, hub];
  }

  // -------------------------------------------------------------------------------------------------------------
  // Cesty von z kotvísk (memo na epochu)
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Trasa von lode, ktorá drží kotviská, s prekážkami = miesta ostatných lodí (memo na epochu; `null` = cesta nie je).
   * Začína v polohe pri kotvisku (aj keď loď ešte len pláva ku kotvisku).
   */
  private exitOf(ship: Ship): ExitPlan | null {
    const epoch = this.currentEpoch();
    if (this.exitsEpoch !== epoch) {
      this.exits.clear();
      this.exitsEpoch = epoch;
    }
    const known = this.exits.get(ship.id);
    if (known !== undefined) return known;
    const first = firstBerthOf(ship, this.world);
    const route = this.exitLeg(ship.def, first, this.obstaclesFor(ship));
    let plan: ExitPlan | null = null;
    if (route !== null) {
      const area = new TrafficArea();
      const end = sweepRoute(area, ship.def, this.dockPose(ship.def, first), route);
      plan = { route, area, end };
    }
    this.exits.set(ship.id, plan);
    return plan;
  }

  /**
   * Nezatarasí obdĺžnik `box` (kde bude stáť loď `ship`) cestu von žiadnej inej lodi, ktorá drží kotviská? Trasa von,
   * ktorej sa obdĺžnik nedotkne, platí ďalej; inak sa hľadá nová s obdĺžnikom ako prekážkou. Loď, ktorá cestu von
   * nemá už teraz, sa neposudzuje (obdĺžnik jej ju nevzal). Odchádzajúce lode (`undocking`) majú trasu rezervovanú.
   */
  private keepsExits(ship: Ship, box: CellBox): boolean {
    for (const other of this.world.ships.values()) {
      if (other === ship || other.berthIds.length === 0 || other.state === 'undocking') continue;
      const exit = this.exitOf(other);
      if (exit === null || !boxHitsArea(box, exit.area)) continue;
      if (this.exitLeg(other.def, firstBerthOf(other, this.world), this.obstaclesFor(other, box)) === null) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Použiteľnosť anchorage
  // -------------------------------------------------------------------------------------------------------------

  /** Bunky sea lane, ktoré môže zabrať loď ľubovoľnej triedy (plávajúca po dráhe a otáčajúca sa na jej konci). */
  private lane(): TrafficArea {
    if (this.laneEnvelope !== undefined) return this.laneEnvelope;
    const area = new TrafficArea();
    const lane = laneRoute(this.world);
    const start = lane[0];
    for (const dims of this.world.defs.ships.items) {
      if (start === undefined) break;
      const end = sweepRoute(area, dims, { x: start.x, y: start.y, heading: this.laneStartHeading() }, lane);
      for (const heading of [0, 90] as const) area.add(shipBox(dims, end.x, end.y, heading));
    }
    this.laneEnvelope = area;
    return area;
  }

  /**
   * Bunky pred kotviskami, kam kotviaca loď nesmie: pás vody každého kotviska predĺžený o šírku najširšej lode
   * a `APPROACH_MARGIN_CELLS` (miesto na priblíženie). Memo podľa verzie modulov.
   */
  private berthFronts(): TrafficArea {
    const version = this.world.moduleVersion;
    if (this.keepOut?.moduleVersion === version) return this.keepOut.area;
    let widest = 0;
    for (const dims of this.world.defs.ships.items) widest = Math.max(widest, dims.widthCells);
    const area = new TrafficArea();
    for (const berth of this.berths()) {
      const cells = frontBandCells(berth.origin, berth.size, berth.waterSide, berth.params.frontWaterCells + widest + APPROACH_MARGIN_CELLS);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const cell of cells) {
        x0 = Math.min(x0, cell.x);
        y0 = Math.min(y0, cell.y);
        x1 = Math.max(x1, cell.x + 1);
        y1 = Math.max(y1, cell.y + 1);
      }
      if (cells.length > 0) area.add({ x0, y0, x1, y1 });
    }
    this.keepOut = { moduleVersion: version, area };
    return area;
  }

  /** Kotviská sveta (zo skupín kotvísk, v poradí skupín a po pobreží). */
  private berths(): BerthModule[] {
    const list: BerthModule[] = [];
    for (const group of this.world.berthGroups) {
      for (const berthId of group.berthIds) {
        const berth = this.world.modules.get(berthId);
        if (berth instanceof BerthModule) list.push(berth);
      }
    }
    return list;
  }

  /** Je anchorage `index` voľná (nedrží ju iná loď)? */
  private anchorageFree(ship: Ship, index: number): boolean {
    for (const other of this.world.ships.values()) {
      if (other !== ship && other.anchorageIndex === index) return false;
    }
    return true;
  }

  /**
   * Plán z pózy `from` na anchorage `index` (A* po vode), ak je anchorage voľná a obdĺžnik lode na nej nezasahuje do
   * sea lane ani pred kotviská a nezatarasí cestu von lodiam pri kotviskách; inak `null`.
   */
  private anchoragePlan(ship: Ship, from: ShipPose, index: number, obstacles: readonly CellBox[]): ShipPoint[] | null {
    const point = anchoragePoint(this.world, index);
    if (point === undefined || !this.anchorageFree(ship, index)) return null;
    const leg = this.waterLeg(ship.def, from, point, null, obstacles);
    if (leg === null) return null;
    const route = leg.length > 0 && leg[leg.length - 1].x === point.x && leg[leg.length - 1].y === point.y ? leg : [...leg, point];
    const rest = this.endPose(from, route);
    const box = shipBox(ship.def, rest.x, rest.y, rest.heading);
    if (boxHitsArea(box, this.lane()) || boxHitsArea(box, this.berthFronts()) || !this.keepsExits(ship, box)) return null;
    return route;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Kotviská
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Obmedzenia kotviska proti uviaznutiu (viď hlavička): z kotviska `first` vedie cesta von a obdĺžnik lode pri ňom
   * nezatarasí cestu von žiadnej inej lodi, ktorá drží kotviská.
   */
  private berthKeepsExits(ship: Ship, first: BerthModule): boolean {
    if (this.exitLeg(ship.def, first, this.obstaclesFor(ship)) === null) return false;
    const dock = this.dockPose(ship.def, first);
    return this.keepsExits(ship, shipBox(ship.def, dock.x, dock.y, dock.heading));
  }

  /**
   * Kandidáti na kotviská z pózy `from`: v každej skupine úseky s najmenším počtom kotvísk (poradie `allocateBerths`,
   * §5.4), ku ktorým vedie cesta po vode a ktoré spĺňajú obmedzenia proti uviaznutiu. `prefix` = trasa pred úsekom
   * (pri vstupe sea lane). Voľnosť trasy voči rezerváciám ostatných lodí sa overuje až pri pokuse (`attempt`).
   */
  private berthCandidates(ship: Ship, from: ShipPose, prefix: readonly ShipPoint[], out: Candidate[]): void {
    const obstacles = this.obstaclesFor(ship);
    const start: ShipPose = { x: ship.x, y: ship.y, heading: ship.heading };
    let groupId = Number.NaN;
    let fewest = 0;
    allocateBerths(this.world, ship, (run) => {
      const [first] = run;
      if (first === undefined || (first.groupId === groupId && run.length > fewest)) return false;
      groupId = first.groupId;
      fewest = run.length;
      const leg = this.berthLeg(ship.def, from, first, obstacles);
      if (leg === null || !this.berthKeepsExits(ship, first)) return false;
      const route = [...prefix, ...leg];
      const area = new TrafficArea();
      sweepRoute(area, ship.def, start, route);
      out.push({ berths: run, anchorage: null, route, area });
      return false;
    });
  }

  /** Kandidáti na anchorage (poradie mapy) z pózy `from` s trasou `prefix` pred úsekom (pri vstupe sea lane). */
  private anchorageCandidates(ship: Ship, from: ShipPose, prefix: readonly ShipPoint[], out: Candidate[]): void {
    const obstacles = this.obstaclesFor(ship);
    const start: ShipPose = { x: ship.x, y: ship.y, heading: ship.heading };
    for (let index = 0; index < this.world.map.anchorage.length; index++) {
      const leg = this.anchoragePlan(ship, from, index, obstacles);
      if (leg === null) continue;
      const route = [...prefix, ...leg];
      const area = new TrafficArea();
      sweepRoute(area, ship.def, start, route);
      out.push({ berths: null, anchorage: index, route, area });
    }
  }

  /**
   * Pokus o rezerváciu (viď hlavička „Poradie" a „Memo"): kandidáti sa zostavia raz za epochu (`build`) a pri každom
   * pokuse sa vyberie prvý, ktorého trasa je voľná voči rezerváciám ostatných lodí. `null` = žiadny (loď čaká).
   * Ak loď s kandidátom na kotvisko nemôže vyplávať, neskoršie lode v tomto ticku nič nerezervujú (okrem odchodu).
   */
  private attempt(ship: Ship, kind: AttemptKind, build: (out: Candidate[]) => void): Candidate | null {
    if (this.heldBack && kind !== 'undock') return null;
    const epoch = this.currentEpoch();
    const cached = this.plans.get(ship.id);
    let candidates: readonly Candidate[];
    if (cached !== undefined && cached.epoch === epoch && cached.kind === kind) {
      candidates = cached.candidates;
    } else {
      const built: Candidate[] = [];
      build(built);
      candidates = built;
      this.plans.set(ship.id, { epoch, kind, candidates });
    }
    for (const candidate of candidates) {
      if (this.isClear(ship, candidate.area)) {
        this.plans.delete(ship.id);
        return candidate;
      }
    }
    if (kind !== 'undock' && candidates.some((candidate) => candidate.berths !== null)) this.heldBack = true;
    return null;
  }

  /** Rezervuje kotviská lodi (`dockedShipId`, `berthIds` v poradí po pobreží). */
  private reserveBerths(ship: Ship, berths: readonly BerthModule[]): void {
    for (const berth of berths) berth.dockedShipId = ship.id;
    ship.berthIds = Object.freeze(berths.map((berth) => berth.id));
    this.bump();
  }

  /** Uvoľní kotviská lode (na konci odchodu). */
  releaseBerths(ship: Ship): void {
    for (const berthId of ship.berthIds) {
      const berth = this.world.modules.get(berthId);
      if (berth instanceof BerthModule && berth.dockedShipId === ship.id) berth.dockedShipId = null;
    }
    ship.berthIds = Object.freeze([]);
    this.bump();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Rezervácie podľa stavu
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Vstup lode čakajúcej pred mapou (`arriving` → `inbound`): kotviská alebo anchorage s voľnou trasou po celej sea lane
   * a ďalej k cieľu. `true` = loď vplávala (stav `inbound`, trasa = dráha + úsek k cieľu).
   */
  tryEnter(ship: Ship): boolean {
    if (ship.state !== 'arriving') return false;
    const chosen = this.attempt(ship, 'enter', (out) => {
      const lane = laneRoute(this.world);
      const hub = this.hubPose();
      this.berthCandidates(ship, hub, lane, out);
      this.anchorageCandidates(ship, hub, lane, out);
    });
    if (chosen === null) return false;
    if (chosen.berths !== null) this.reserveBerths(ship, chosen.berths);
    else ship.anchorageIndex = chosen.anchorage;
    ship.transition('inbound', chosen.route);
    this.bump();
    return true;
  }

  /**
   * Vstup hneď pri spawne (`spawnShip`): len keď pred mapou ani na anchorage nečaká iná loď — inak rozhodne poradie
   * v kroku 3 (FIFO podľa id).
   */
  tryEnterOnSpawn(ship: Ship): boolean {
    for (const other of this.world.ships.values()) {
      if (other !== ship && (other.state === 'arriving' || other.state === 'waiting_anchorage')) return false;
    }
    return this.tryEnter(ship);
  }

  /**
   * Loď na konci dráhy (`inbound`) alebo na anchorage (`waiting_anchorage` v pokoji) si pridelí kotviská s voľnou trasou
   * a začne `berthing`; anchorage uvoľní. `false` = kotvisko alebo trasa nie je (loď pokračuje / čaká).
   */
  tryStartBerthing(ship: Ship): boolean {
    const pose: ShipPose = { x: ship.x, y: ship.y, heading: ship.heading };
    const chosen = this.attempt(ship, 'berth', (out) => this.berthCandidates(ship, pose, [], out));
    if (chosen === null || chosen.berths === null) return false;
    this.reserveBerths(ship, chosen.berths);
    ship.anchorageIndex = null;
    ship.transition('berthing', chosen.route);
    this.bump();
    return true;
  }

  /**
   * Loď v `waiting_anchorage` bez anchorage (save spred ADR-029 — čaká na konci dráhy) si pridelí použiteľnú anchorage
   * s voľnou trasou a začne k nej plávať (stav ostáva, mení sa len trasa).
   */
  tryClaimAnchorage(ship: Ship): boolean {
    if (ship.anchorageIndex !== null) return false;
    const pose: ShipPose = { x: ship.x, y: ship.y, heading: ship.heading };
    const chosen = this.attempt(ship, 'anchor', (out) => this.anchorageCandidates(ship, pose, [], out));
    if (chosen === null || chosen.anchorage === null) return false;
    ship.anchorageIndex = chosen.anchorage;
    ship.replaceRoute(chosen.route);
    this.bump();
    return true;
  }

  /**
   * Vyložená loď pri kotvisku odpláva (`docked` → `undocking`), keď je voľná trasa od kotviska na koniec dráhy a po
   * sea lane von. Kotviská drží ďalej, uvoľní ich na konci dráhy (`releaseBerths`).
   */
  tryUndock(ship: Ship): boolean {
    const chosen = this.attempt(ship, 'undock', (out) => {
      const exit = this.exitOf(ship);
      if (exit === null) return;
      const area = new TrafficArea();
      for (const box of exit.area.boxes) area.add(box);
      sweepRoute(area, ship.def, exit.end, [...laneRoute(this.world)].reverse());
      out.push({ berths: null, anchorage: null, route: exit.route, area });
    });
    if (chosen === null) return false;
    ship.transition('undocking', chosen.route);
    this.bump();
    return true;
  }

  /** Začiatok kroku 3: poradie FIFO sa rieši znova (viď `attempt`). */
  beginTick(): void {
    this.heldBack = false;
  }

  /** Koniec kroku 3: mimo neho (spawn) sa nič nezdržiava. */
  endTick(): void {
    this.heldBack = false;
  }

  /** Zvyšok trasy `inbound` za koncom dráhy (úsek k cieľu rezervovaný pri vstupe). */
  legAfterLane(ship: Ship): readonly ShipPoint[] {
    return ship.route.slice(this.laneEndIndex(ship));
  }

  /** Index za posledným bodom sea lane v trase `inbound` (loď na ňom dorazila na koniec dráhy). */
  laneEndIndex(ship: Ship): number {
    return Math.min(this.laneLength, ship.route.length);
  }
}

/**
 * Dve lode na mape zdieľajú bunku (obdĺžniky `shipBox` sa prekrývajú) — invariant kroku 12 a obnovy save (ADR-029),
 * bez výnimiek. Každú dvojicu posúdi raz (vnútorný prechod je nový iterátor mapy); `undefined` = v poriadku.
 */
export function shipOverlapProblem(ships: ReadonlyMap<EntityId, Ship>): string | undefined {
  for (const a of ships.values()) {
    if (!SHIP_STATE_TRAITS[a.state].onMap) continue;
    const boxA = shipBox(a.def, a.x, a.y, a.heading);
    let after = false;
    for (const b of ships.values()) {
      if (!after) {
        after = b === a;
        continue;
      }
      if (!SHIP_STATE_TRAITS[b.state].onMap) continue;
      if (boxesOverlap(boxA, shipBox(b.def, b.x, b.y, b.heading))) {
        return `${a.label} (${a.state}) a ${b.label} (${b.state}) zdieľajú bunky — lode sa nesmú prekrývať (ADR-029)`;
      }
    }
  }
  return undefined;
}
