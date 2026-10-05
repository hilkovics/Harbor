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
 * - `arriving` → `inbound` (vstup, loď má voľné kotvisko): celá sea lane + úsek z konca dráhy ku kotviskám (poradie
 *   `allocateBerths`) — loď ide rovno ku kotvisku.
 * - `arriving` → `waiting_anchorage` (vstup, loď **nemá voľné kotvisko**; T6D-03): **anchorage pridelená pri vstupe**
 *   a loď k nej pláva **priamo** po najkratšej bezpečnej trase po vode (A*) zo vstupu na mapu — bez obchádzky konca
 *   sea lane pri prístave. Na anchorage stojí s jednotným kurzom `map.anchorageHeading` (kurz sa na konci trasy
 *   zafixuje bodom s pevným kurzom). Bez cieľa s voľnou trasou loď čaká pred vstupom (mimo mapy, nezaberá bunky).
 * - `inbound` na konci dráhy → `berthing` (kotviská z rezervácie, po rezervovanom úseku).
 * - `waiting_anchorage` na anchorage → `berthing` (úsek z anchorage ku kotvisku), keď je kotvisko a trasa voľná.
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
 * - cesta von = posun bokom od kotviska na bod priblíženia (obal obdĺžnikov, overí sa voči prekážkam) a A* po vode
 *   z bodu priblíženia (štart A* tiež mimo prekážok) — review T5B-04b: obdĺžnik pri susednom kotvisku vo vnútornom
 *   rohu nábrežia nesmie ležať v posune bokom lode, ktorá kotvisko drží;
 * - loď, ktorá drží kotviská a cestu von nemá už teraz, sa nepreskočí: obdĺžnik sa posúdi s prekážkami, ktoré
 *   neodplávajú samy (lode čakajúce na kotvisko na anchorage), aby sa nestal trvalou prekážkou (ADR-029 addendum);
 * - lode pred vstupom nezaberajú nič, lode na trase trasu dokončia.
 * Predpoklad mapy: anchorage leží na otvorenej vode (rejda — vyhradená zóna mimo dráhy a pásov pred kotviskami),
 * kde čakajúca loď nerozdelí prístav (trasu ku kotviskám obíde A*) a kam sa dá priplávať zo vstupu bez prechodu
 * po sea lane.
 *
 * **Poradie** (FIFO bez head-of-line blokovania): lode sa spracúvajú vzostupne podľa id. Keď loď, ktorá má voľné
 * kotvisko, nemôže vyplávať len preto, že jej trasu drží pohybujúca sa loď, neskoršie lode v tomto ticku nič
 * nerezervujú (okrem odchodu) — kotvisko jej nikto nepredbehne. Loď, pre ktorú kotvisko nie je, nikoho nebrzdí.
 *
 * **Memo** (výkon, nie stav simulácie): kandidáti pokusu (podľa lode a druhu pokusu) a trasy von držiteľov kotvísk
 * sa pamätajú pre „epochu" dopravy a prepočítajú sa až po zmene lodí (prechod, príchod, odchod), kotvísk alebo
 * modulov; statická dosiahnuteľnosť kotvísk (`reachesBerth`) sa pamätá podľa verzie modulov. Kandidáti závisia len od stavu, ktorý epochu mení (pózy stojacich lodí, konce trás, kotviská, moduly),
 * a voľnosť trasy sa overuje pri každom pokuse nanovo — pokus s rovnakými vstupmi dá rovnaký výsledok, preto memo
 * nemení priebeh (ani po načítaní save, keď je prázdne). Overenie voľnosti (`isClear`, každý tick) nealokuje: sea lane
 * dopredu aj odzadu je predpočítaná a rezervácie ostatných lodí sa počítajú do znovupoužiteľnej oblasti.
 */
import type { EntityId } from '../core/entity-id';
import type { ShipNavigationDef } from '../defs/types';
import { BerthModule } from '../modules/berth-module';
import { frontBandCells } from '../modules/module-geometry';
import type { World } from '../world/world';
import { allocateBerths } from './berth-allocator';
import type { Ship } from './ship';
import { SHIP_STATE_TRAITS, type ShipState } from './ship-fsm';
import { TrafficArea, boxesOverlap, spanBox, sweepRoute, type MutableShipPose, type ShipPose } from './ship-footprint';
import {
  DOCKED_HEADING,
  anchoragePoint,
  approachPoint,
  dockPoint,
  firstBerthOf,
  laneEnd,
  laneRoute,
  laneStartHeading,
  segmentHeading,
  shipBox,
  shipExtentX,
  shipExtentY,
  type CellBox,
  type ShipDimensions,
  type ShipPoint,
} from './ship-route';
import { AXIS_OF_HEADING, WaterNavigator } from './water-navigator';

/** Kurz lode na konci dráhy, keď dráha chýba (sever; mapa bez sea lane nemá lode). */
const DEFAULT_LANE_HEADING: ShipPose['heading'] = 0;

/** Druh pokusu o rezerváciu (kandidáti sa pamätajú podľa lode a druhu). */
type AttemptKind = 'enter' | 'berth' | 'undock';

/** Druhy pokusov v poradí memo. */
const ATTEMPT_KINDS: readonly AttemptKind[] = ['enter', 'berth', 'undock'];

/** Kandidát rezervácie: cieľ (kotviská, anchorage alebo nič — odchod), trasa a bunky, ktoré cestou zaberie. */
interface Candidate {
  readonly berths: readonly BerthModule[] | null;
  readonly anchorage: number | null;
  readonly route: readonly ShipPoint[];
  readonly area: TrafficArea;
}

/** Kandidáti posledného pokusu lode daného druhu. */
interface CachedPlans {
  readonly epoch: number;
  readonly candidates: readonly Candidate[];
  /** Niektorý kandidát vedie ku kotviskám (pre FIFO, `heldBack`). */
  readonly hasBerths: boolean;
}

/** Trasa von z kotviska (bod priblíženia → koniec dráhy) a bunky, ktoré loď cestou od kotviska zaberie. */
interface ExitPlan {
  readonly route: readonly ShipPoint[];
  readonly area: TrafficArea;
  /** Póza na konci dráhy (začiatok úseku sea lane von). */
  readonly end: ShipPose;
}

/** Statická dosiahnuteľnosť kotvísk (memo podľa verzie modulov): `L×W#id prvého kotviska` → loď tam dopláva aj odpláva. */
interface BerthReach {
  readonly moduleVersion: number;
  readonly byKey: Map<string, boolean>;
}

/** Statické oblasti pre použiteľnosť anchorage (memo podľa verzie modulov). */
interface KeepOut {
  readonly moduleVersion: number;
  readonly area: TrafficArea;
}

export class ShipTraffic {
  private readonly world: World;
  /** Lodná navigácia z `logistics.json` (rezerva priblíženia, krok vzorkovania, manévre; T06-07). */
  private readonly navigation: Readonly<ShipNavigationDef>;
  private navigatorInstance: WaterNavigator | undefined;
  private epoch = 0;
  private seenShipVersion = Number.NaN;
  private seenModuleVersion = Number.NaN;
  /** Druh pokusu → loď → kandidáti posledného pokusu a epocha, v ktorej vznikli (memo, viď hlavička). */
  private readonly plans: { readonly [K in AttemptKind]: Map<EntityId, CachedPlans> } = { enter: new Map(), berth: new Map(), undock: new Map() };
  /** Zostavenie kandidátov podľa druhu pokusu (tabuľka, nie switch). */
  private readonly builders: { readonly [K in AttemptKind]: (ship: Ship, out: Candidate[]) => void } = {
    enter: (ship, out) => {
      // Voľné kotvisko → rovno ku kotvisku po sea lane; inak (loď kotvisko nemá) priamo na rejdu zo vstupu na mapu.
      this.berthCandidates(ship, this.hubPose(), this.laneIn(), out);
      if (out.length === 0) this.anchorageCandidates(ship, out);
    },
    berth: (ship, out) => this.berthCandidates(ship, { x: ship.x, y: ship.y, heading: ship.heading }, [], out),
    undock: (ship, out) => {
      const exit = this.exitOf(ship);
      if (exit === null) return;
      const area = new TrafficArea();
      area.addArea(exit.area);
      sweepRoute(area, ship.def, this.navigation.sweepStepCells, exit.end, this.laneOutRoute);
      out.push({ berths: null, anchorage: null, route: exit.route, area });
    },
  };
  /** Loď, ktorá drží kotviská → trasa von v epoche `exitsEpoch` (`null` = cesta von nie je). */
  private readonly exits = new Map<EntityId, ExitPlan | null>();
  private exitsEpoch = Number.NaN;
  /** V tomto ticku čaká na kotvisko skoršia loď, ktorej bráni pohybujúca sa loď (FIFO, `attempt`). */
  private heldBack = false;
  /** `heldBack` na konci posledného kroku 3 (diagnostika a testy; nie je stav simulácie, neukladá sa). */
  private lastHeldBack = false;
  private keepOut: KeepOut | undefined;
  private berthReach: BerthReach | undefined;
  private laneEnvelope: TrafficArea | undefined;
  /** Sea lane dopredu a odzadu (stredy buniek; mapa je statická — predpočítané raz). */
  private laneForward: readonly ShipPoint[] | undefined;
  private laneBackward: readonly ShipPoint[] | undefined;
  private readonly scratch = new TrafficArea();
  private readonly scratchEnd: MutableShipPose = { x: 0, y: 0, heading: DEFAULT_LANE_HEADING };

  constructor(world: World) {
    this.world = world;
    this.navigation = world.defs.logistics.shipNavigation;
  }

  /** A* po vode nad mriežkou sveta s manévrami z defu (vznikne pri prvom použití; terén je statický). */
  get navigator(): WaterNavigator {
    this.navigatorInstance ??= new WaterNavigator(this.world.grid, this.navigation);
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
    return laneStartHeading(this.world.map);
  }

  /** Sea lane od začiatku po koniec dráhy (predpočítaná, zdieľaná — nemeniť). */
  private laneIn(): readonly ShipPoint[] {
    this.laneForward ??= Object.freeze(laneRoute(this.world));
    return this.laneForward;
  }

  /** Sea lane od konca dráhy po jej začiatok — trasa `outbound` a koniec rezervácie `undocking` (predpočítaná). */
  get laneOutRoute(): readonly ShipPoint[] {
    this.laneBackward ??= Object.freeze([...this.laneIn()].reverse());
    return this.laneBackward;
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
    const lane = this.laneIn();
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
   * pri odchode spolu s úsekom ku koncu dráhy); loď pred vstupom nič. Nealokuje (trasa od indexu, koncová póza do
   * pracovného objektu).
   */
  reservationOf(ship: Ship, out: TrafficArea): void {
    if (!SHIP_STATE_TRAITS[ship.state].onMap) return;
    const end = sweepRoute(out, ship.def, this.navigation.sweepStepCells, ship, ship.route, ship.waypointIndex, this.scratchEnd);
    if (ship.state === 'undocking') sweepRoute(out, ship.def, this.navigation.sweepStepCells, end, this.laneOutRoute, 0, this.scratchEnd);
  }

  /**
   * Obdĺžnik lode na konci jej trasy (kde bude stáť) — prekážka pre A* ostatných lodí; `undefined` = loď nestojí ani
   * nemieri na miesto. Loď pri kotvisku je prekážkou v každom stave s `moored` (`docked`, `lashing` — ADR-032).
   */
  private restBox(ship: Ship): CellBox | undefined {
    const state: ShipState = ship.state;
    if (state !== 'inbound' && state !== 'waiting_anchorage' && state !== 'berthing' && !SHIP_STATE_TRAITS[state].moored) return undefined;
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

  /**
   * Prekážky, ktoré neodplávajú samy: miesta lodí, ktoré čakajú na kotvisko (držia anchorage), okrem lodí `ship`
   * a `holder`, plus `box`. Lode pri kotviskách a na trase odplávajú bez ohľadu na držiteľa kotviska.
   */
  private lastingObstacles(ship: Ship, holder: Ship, box: CellBox): CellBox[] {
    const boxes: CellBox[] = [];
    for (const other of this.world.ships.values()) {
      if (other === ship || other === holder || other.anchorageIndex === null) continue;
      const rest = this.restBox(other);
      if (rest !== undefined) boxes.push(rest);
    }
    boxes.push(box);
    return boxes;
  }

  /** Je trasa `area` lode `ship` voľná voči rezerváciám všetkých ostatných lodí? (bez alokácií) */
  private isClear(ship: Ship, area: TrafficArea): boolean {
    for (const other of this.world.ships.values()) {
      if (other === ship) continue;
      this.scratch.clear();
      this.reservationOf(other, this.scratch);
      if (area.overlaps(this.scratch)) return false;
    }
    return true;
  }

  /**
   * Prvá dvojica lodí na mape, ktorých rezervácie (obdĺžnik a zvyšok uloženej trasy) majú spoločnú bunku — obnova save
   * (ADR-029 addendum): pri hre sa rezervácie neprekrývajú nikdy (rezervuje sa len voľná trasa a trasy sa len
   * skracujú), takže save s prekryvom by o pár tickov porušil krok 12. `later` = loď s vyšším id. `undefined` = OK.
   */
  reservationConflict(): { readonly earlier: Ship; readonly later: Ship } | undefined {
    const ships = [...this.world.ships.values()].filter((ship) => SHIP_STATE_TRAITS[ship.state].onMap);
    const areas = ships.map((ship) => {
      const area = new TrafficArea();
      this.reservationOf(ship, area);
      return area;
    });
    for (let j = 1; j < ships.length; j++) {
      for (let i = 0; i < j; i++) {
        if (areas[i].overlaps(areas[j])) return { earlier: ships[i], later: ships[j] };
      }
    }
    return undefined;
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
    if (this.sidewaysBlocked(dims, first, approach, heading, obstacles)) return null;
    const leg = this.waterLeg(dims, from, approach, heading, obstacles);
    if (leg === null) return null;
    return [...leg, { ...approach, heading }, { ...dockPoint(first, dims), heading }];
  }

  /**
   * Posun bokom medzi polohou pri kotviskách `first` a bodom priblíženia (osový úsek s kurzom `heading` — obal
   * obdĺžnikov v oboch koncoch) zasiahne niektorú prekážku? A* po vode tento úsek nevidí (začína a končí v bode
   * priblíženia), preto ho treba overiť zvlášť (review T5B-04b, ADR-029 B5).
   */
  private sidewaysBlocked(dims: ShipDimensions, first: BerthModule, approach: ShipPoint, heading: ShipPose['heading'], obstacles: readonly CellBox[]): boolean {
    const dock = dockPoint(first, dims);
    const span = spanBox(dims, heading, dock.x, dock.y, approach.x, approach.y);
    for (const obstacle of obstacles) if (boxesOverlap(span, obstacle)) return true;
    return false;
  }

  /**
   * Úsek od kotvísk `first` na koniec dráhy: posun bokom na bod priblíženia (kurz `DOCKED_HEADING`), potom A* po vode.
   * `null` = cesta nie je (aj keď prekážka leží v posune bokom alebo v štarte A*).
   */
  exitLeg(dims: ShipDimensions, first: BerthModule, obstacles: readonly CellBox[]): ShipPoint[] | null {
    const heading = DOCKED_HEADING[first.waterSide];
    const approach = { ...approachPoint(first, dims, this.world.map), heading };
    if (this.sidewaysBlocked(dims, first, approach, heading, obstacles)) return null;
    const hub = laneEnd(this.world);
    if (hub === undefined) return [approach];
    const leg = this.waterLeg(dims, approach, hub, null, obstacles);
    if (leg === null) return null;
    const last = leg[leg.length - 1];
    // Koniec A* je stred bunky konca dráhy = koniec dráhy (stred bunky); inak doplň presný bod.
    return last !== undefined && last.x === hub.x && last.y === hub.y ? [approach, ...leg] : [approach, ...leg, hub];
  }

  /**
   * Statická dosiahnuteľnosť kotvísk `first` (T06-08b, ADR-031 dodatok): loď rozmerov `dims` dopláva z konca dráhy
   * ku kotviskám (`berthLeg`) a odpláva späť (`exitLeg`) po prázdnej vode — lode sú dočasné prekážky a neposudzujú sa,
   * rozhoduje terén (bod priblíženia na vode, cesta po vode dosť široká) a geometria kotviska. Mapa bez sea lane
   * → `false` (loď nemá odkiaľ prísť). Čistá funkcia statickej mapy, kotviska a rozmerov lode: memo podľa rozmerov
   * a kotviska, zneplatní ho zmena modulov (`moduleVersion`); nie je stav simulácie a priebeh nemení. Používa ju
   * pripravenosť prístavu (`AcceptContract`) aj výber kandidátov na kotviská (`berthCandidates`).
   */
  reachesBerth(dims: ShipDimensions, first: BerthModule): boolean {
    const version = this.world.moduleVersion;
    if (this.berthReach?.moduleVersion !== version) this.berthReach = { moduleVersion: version, byKey: new Map() };
    const key = `${String(dims.lengthCells)}x${String(dims.widthCells)}#${String(first.id)}`;
    let reach = this.berthReach.byKey.get(key);
    if (reach === undefined) {
      reach = laneEnd(this.world) !== undefined && this.berthLeg(dims, this.hubPose(), first, []) !== null && this.exitLeg(dims, first, []) !== null;
      this.berthReach.byKey.set(key, reach);
    }
    return reach;
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
      const end = sweepRoute(area, ship.def, this.navigation.sweepStepCells, this.dockPose(ship.def, first), route);
      plan = { route, area, end };
    }
    this.exits.set(ship.id, plan);
    return plan;
  }

  /**
   * Nezatarasí obdĺžnik `box` (kde bude stáť loď `ship`) cestu von žiadnej inej lodi, ktorá drží kotviská? Trasa von,
   * ktorej sa obdĺžnik nedotkne, platí ďalej; inak sa hľadá nová s obdĺžnikom ako prekážkou. Loď, ktorá cestu von
   * nemá už teraz (prekážka, ktorá odpláva — napr. loď pri susednom kotvisku), sa nepreskočí: cesta von sa posúdi
   * s prekážkami, ktoré ostanú (`lastingObstacles`) — obdĺžnik nesmie byť s nimi trvalou prekážkou (ADR-029
   * addendum). Odchádzajúce lode (`undocking`) majú trasu rezervovanú.
   */
  private keepsExits(ship: Ship, box: CellBox): boolean {
    for (const other of this.world.ships.values()) {
      if (other === ship || other.berthIds.length === 0 || other.state === 'undocking') continue;
      const exit = this.exitOf(other);
      if (exit !== null && !exit.area.hits(box)) continue;
      const obstacles = exit === null ? this.lastingObstacles(ship, other, box) : this.obstaclesFor(other, box);
      if (this.exitLeg(other.def, firstBerthOf(other, this.world), obstacles) === null) return false;
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
    const lane = this.laneIn();
    const start = lane[0];
    for (const dims of this.world.defs.ships.items) {
      if (start === undefined) break;
      const end = sweepRoute(area, dims, this.navigation.sweepStepCells, { x: start.x, y: start.y, heading: this.laneStartHeading() }, lane);
      for (const heading of [0, 90] as const) area.add(shipBox(dims, end.x, end.y, heading));
    }
    this.laneEnvelope = area;
    return area;
  }

  /**
   * Bunky pred kotviskami, kam kotviaca loď nesmie: pás vody každého kotviska predĺžený o šírku najširšej lode
   * a `logistics.shipNavigation.approachMarginCells` (rezerva na otočenie a posun v bunke bodu priblíženia — stav lode
   * je stred bunky; T06-07, predtým konštanta `APPROACH_MARGIN_CELLS` = 1). Memo podľa verzie modulov.
   */
  private berthFronts(): TrafficArea {
    const version = this.world.moduleVersion;
    if (this.keepOut?.moduleVersion === version) return this.keepOut.area;
    let widest = 0;
    for (const dims of this.world.defs.ships.items) widest = Math.max(widest, dims.widthCells);
    const area = new TrafficArea();
    for (const berth of this.berths()) {
      const cells = frontBandCells(berth.origin, berth.size, berth.waterSide, berth.params.frontWaterCells + widest + this.navigation.approachMarginCells);
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
   * Body prvého úseku sea lane (stredy buniek) zoradené podľa Manhattan vzdialenosti k bunke `target` (pri zhode podľa
   * poradia na dráhe) — miesta, kde loď vplávajúca na mapu môže odbočiť zo sea lane smerom na rejdu. Loď plynie po dráhe
   * len po bod odbočky (ostatok trasy je A* po vode z neho), takže na rejdu ide **priamo**, bez prechodu po celej
   * dráhe k prístavu (T6D-03). Úsek, ktorý nie je osový, sa neprechádza po bunkách — kandidátmi sú jeho krajné body.
   */
  private laneTurnPoints(target: ShipPoint): ShipPoint[] {
    const [start, second] = this.laneIn();
    if (start === undefined) return [];
    const candidates: ShipPoint[] = [start];
    if (second !== undefined) {
      const axial = start.x === second.x || start.y === second.y;
      const steps = axial ? Math.max(Math.abs(second.x - start.x), Math.abs(second.y - start.y)) : 1;
      const stepX = axial ? Math.sign(second.x - start.x) : second.x - start.x;
      const stepY = axial ? Math.sign(second.y - start.y) : second.y - start.y;
      for (let k = 1; k <= steps; k++) candidates.push({ x: start.x + stepX * k, y: start.y + stepY * k });
    }
    const distance = (point: ShipPoint): number => Math.abs(point.x - target.x) + Math.abs(point.y - target.y);
    // Array.prototype.sort je stabilná (ES2019) — pri zhode ostáva poradie na dráhe.
    return candidates.sort((a, b) => distance(a) - distance(b));
  }

  /**
   * Trasa zo začiatku sea lane (póza `from`) na anchorage `index` cez bod odbočky `turn` (po prvom úseku sea lane
   * k nemu, odtiaľ A* po vode do bunky anchorage s osou `map.anchorageHeading`; trasa končí bodom s pevným kurzom
   * `anchorageHeading`, keď by loď dorazila opačným smerom) a jej „námaha“: dĺžka a počet buniek posunu bokom.
   * `null` = cesta po vode nie je.
   */
  private anchorageRouteVia(ship: Ship, from: ShipPose, turn: ShipPoint, point: ShipPoint, obstacles: readonly CellBox[]): { route: ShipPoint[]; sideways: number; length: number } | null {
    const heading = this.world.map.anchorageHeading;
    const leg = this.waterLeg(ship.def, { x: turn.x, y: turn.y, heading: this.laneStartHeading() }, point, heading, obstacles);
    if (leg === null) return null;
    const route: ShipPoint[] = turn.x === from.x && turn.y === from.y ? [] : [turn];
    route.push(...leg);
    const last = route[route.length - 1] as ShipPoint | undefined;
    if (last === undefined || last.x !== point.x || last.y !== point.y) route.push(point);
    if (this.endPose(from, route).heading !== heading) route.push({ x: point.x, y: point.y, heading });
    let sideways = 0;
    let length = 0;
    let x = from.x;
    let y = from.y;
    for (const next of route) {
      const segment = Math.abs(next.x - x) + Math.abs(next.y - y);
      length += segment;
      if (next.heading !== undefined) sideways += segment;
      x = next.x;
      y = next.y;
    }
    return { route, sideways, length };
  }

  /**
   * Trasa z pózy `from` (pri vstupe: začiatok sea lane) na anchorage `index`: odbočka zo sea lane čo najbližšie k anchorage
   * (`laneTurnPoints`) a odtiaľ A* po vode; keď trasa vyžaduje posun bokom (obchádzka lode na rejde), skúsia sa aj ďalšie
   * body odbočky a vyberie sa trasa s najmenším posunom bokom, potom najkratšia. `null` = anchorage nie je voľná, cesta
   * nie je alebo obdĺžnik lode na nej (s kurzom `anchorageHeading`) zasahuje do sea lane či pred kotviská alebo zatarasí
   * cestu von lodiam pri kotviskách.
   */
  private anchoragePlan(ship: Ship, from: ShipPose, index: number, obstacles: readonly CellBox[]): ShipPoint[] | null {
    const point = anchoragePoint(this.world, index);
    if (point === undefined || !this.anchorageFree(ship, index)) return null;
    const heading = this.world.map.anchorageHeading;
    const box = shipBox(ship.def, point.x, point.y, heading);
    if (this.lane().hits(box) || this.berthFronts().hits(box)) return null;
    const turns = this.laneTurnPoints(point);
    // Cieľ, ku ktorému nevedie cesta z najbližšieho bodu odbočky, nemá zmysel skúšať z ďalších (bola by to ďalšia plná A*);
    // drahá kontrola ciest von lodí pri kotviskách beží až pre dosiahnuteľnú anchorage.
    let best = turns.length === 0 ? null : this.anchorageRouteVia(ship, from, turns[0], point, obstacles);
    if (best === null || !this.keepsExits(ship, box)) return null;
    for (let i = 1; i < turns.length && best.sideways > 0; i++) {
      const plan = this.anchorageRouteVia(ship, from, turns[i], point, obstacles);
      if (plan !== null && (plan.sideways < best.sideways || (plan.sideways === best.sideways && plan.length < best.length))) best = plan;
    }
    return best.route;
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
   * Kandidáti na kotviská z pózy `from`: v každej skupine úseky s najmenším počtom kotvísk spomedzi staticky
   * dosiahnuteľných (`reachesBerth`; poradie `allocateBerths`, §5.4), ku ktorým vedie cesta po vode a ktoré spĺňajú
   * obmedzenia proti uviaznutiu. Nedosiahnuteľný kratší úsek teda dlhší úsek skupiny nevylúči (T06-08b); úsek, ku
   * ktorému cesta chvíľu nevedie pre iné lode, áno — loď počká na kratší úsek. `prefix` = trasa pred úsekom (pri
   * vstupe sea lane). Voľnosť trasy voči rezerváciám ostatných lodí sa overuje až pri pokuse (`attempt`).
   */
  private berthCandidates(ship: Ship, from: ShipPose, prefix: readonly ShipPoint[], out: Candidate[]): void {
    const obstacles = this.obstaclesFor(ship);
    const start: ShipPose = { x: ship.x, y: ship.y, heading: ship.heading };
    let groupId = Number.NaN;
    let fewest = 0;
    allocateBerths(this.world, ship, (run) => {
      const [first] = run;
      if (first === undefined || (first.groupId === groupId && run.length > fewest)) return false;
      if (!this.reachesBerth(ship.def, first)) return false;
      groupId = first.groupId;
      fewest = run.length;
      const leg = this.berthLeg(ship.def, from, first, obstacles);
      if (leg === null || !this.berthKeepsExits(ship, first)) return false;
      const route = [...prefix, ...leg];
      const area = new TrafficArea();
      sweepRoute(area, ship.def, this.navigation.sweepStepCells, start, route);
      out.push({ berths: run, anchorage: null, route, area });
      return false;
    });
  }

  /**
   * Kandidáti na anchorage (poradie mapy) z aktuálnej pózy lode (pri vstupe: zo začiatku sea lane) — priama trasa
   * zo vstupu na rejdu, bez prechodu po celej sea lane (T6D-03).
   */
  private anchorageCandidates(ship: Ship, out: Candidate[]): void {
    const obstacles = this.obstaclesFor(ship);
    const start: ShipPose = { x: ship.x, y: ship.y, heading: ship.heading };
    for (let index = 0; index < this.world.map.anchorage.length; index++) {
      const route = this.anchoragePlan(ship, start, index, obstacles);
      if (route === null) continue;
      const area = new TrafficArea();
      sweepRoute(area, ship.def, this.navigation.sweepStepCells, start, route);
      out.push({ berths: null, anchorage: index, route, area });
    }
  }

  /**
   * Pokus o rezerváciu (viď hlavička „Poradie" a „Memo"): kandidáti sa zostavia raz za epochu (`builders`, memo podľa
   * lode a druhu pokusu) a pri každom pokuse sa vyberie prvý, ktorého trasa je voľná voči rezerváciám ostatných lodí.
   * `null` = žiadny (loď čaká). Ak loď s kandidátom na kotvisko nemôže vyplávať, neskoršie lode v tomto ticku nič
   * nerezervujú (okrem odchodu).
   */
  private attempt(ship: Ship, kind: AttemptKind): Candidate | null {
    if (this.heldBack && kind !== 'undock') return null;
    const epoch = this.currentEpoch();
    const memo = this.plans[kind];
    let plans = memo.get(ship.id);
    if (plans?.epoch !== epoch) {
      const candidates: Candidate[] = [];
      this.builders[kind](ship, candidates);
      plans = { epoch, candidates, hasBerths: candidates.some((candidate) => candidate.berths !== null) };
      memo.set(ship.id, plans);
    }
    for (const candidate of plans.candidates) {
      if (this.isClear(ship, candidate.area)) {
        for (const other of ATTEMPT_KINDS) this.plans[other].delete(ship.id);
        return candidate;
      }
    }
    if (kind !== 'undock' && plans.hasBerths) this.heldBack = true;
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
   * Vstup lode čakajúcej pred mapou (`arriving`): voľné kotvisko s voľnou trasou po celej sea lane (`inbound`), inak
   * anchorage s voľnou priamou trasou zo vstupu (`waiting_anchorage`, T6D-03). `true` = loď vplávala (stav `inbound`
   * alebo `waiting_anchorage`, trasa = rezervovaná trasa k cieľu).
   */
  tryEnter(ship: Ship): boolean {
    if (ship.state !== 'arriving') return false;
    const chosen = this.attempt(ship, 'enter');
    if (chosen === null) return false;
    if (chosen.berths !== null) {
      this.reserveBerths(ship, chosen.berths);
      ship.transition('inbound', chosen.route);
    } else {
      ship.anchorageIndex = chosen.anchorage;
      ship.transition('waiting_anchorage', chosen.route);
    }
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
   * Loď na anchorage (`waiting_anchorage` v pokoji) si pridelí kotviská s voľnou trasou a začne `berthing`; anchorage
   * uvoľní. `false` = kotvisko alebo trasa nie je (loď čaká).
   */
  tryStartBerthing(ship: Ship): boolean {
    const chosen = this.attempt(ship, 'berth');
    if (chosen === null || chosen.berths === null) return false;
    this.reserveBerths(ship, chosen.berths);
    ship.anchorageIndex = null;
    ship.transition('berthing', chosen.route);
    this.bump();
    return true;
  }

  /**
   * Vyložená loď pri kotvisku odpláva (`docked` → `undocking`), keď je voľná trasa od kotviska na koniec dráhy a po
   * sea lane von. Kotviská drží ďalej, uvoľní ich na konci dráhy (`releaseBerths`).
   */
  tryUndock(ship: Ship): boolean {
    const chosen = this.attempt(ship, 'undock');
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
    this.lastHeldBack = this.heldBack;
    this.heldBack = false;
  }

  /**
   * Zdržala v poslednom kroku 3 niektorá loď s kandidátom na kotvisko neskoršie lode (FIFO)? Diagnostika a testy
   * (ADR-029 B6: zdržať smie len pohybujúca sa loď); nie je stav simulácie, neukladá sa.
   */
  get heldBackLastTick(): boolean {
    return this.lastHeldBack;
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

/** Pracovné polia `shipOverlapProblem` (krok 12 každý tick): obdĺžniky lodí na mape a lode v tom istom poradí. */
const overlapScratch: { boxes: Int32Array; readonly ships: Ship[] } = { boxes: new Int32Array(0), ships: [] };

/** Počet čísel na obdĺžnik v `overlapScratch.boxes` (x0, y0, x1, y1). */
const OVERLAP_BOX_FIELDS = 4;

/**
 * Dve lode na mape zdieľajú bunku (obdĺžniky `shipBox` sa prekrývajú) — invariant kroku 12 a obnovy save (ADR-029),
 * bez výnimiek. Obdĺžniky sa spočítajú raz do znovupoužiteľného poľa (bez alokácií okrem zväčšenia poľa) a každá
 * dvojica sa posúdi raz; `undefined` = v poriadku.
 */
export function shipOverlapProblem(ships: ReadonlyMap<EntityId, Ship>): string | undefined {
  const onMap = overlapScratch.ships;
  onMap.length = 0;
  for (const ship of ships.values()) if (SHIP_STATE_TRAITS[ship.state].onMap) onMap.push(ship);
  if (overlapScratch.boxes.length < onMap.length * OVERLAP_BOX_FIELDS) overlapScratch.boxes = new Int32Array(onMap.length * OVERLAP_BOX_FIELDS * 2);
  const boxes = overlapScratch.boxes;
  for (let i = 0; i < onMap.length; i++) {
    const { def, x, y, heading } = onMap[i];
    const w = shipExtentX(def, heading);
    const h = shipExtentY(def, heading);
    const offset = i * OVERLAP_BOX_FIELDS;
    boxes[offset] = Math.floor(x - w / 2);
    boxes[offset + 1] = Math.floor(y - h / 2);
    boxes[offset + 2] = Math.ceil(x + w / 2);
    boxes[offset + 3] = Math.ceil(y + h / 2);
  }
  let problem: string | undefined;
  for (let i = 0; i < onMap.length && problem === undefined; i++) {
    const a = i * OVERLAP_BOX_FIELDS;
    for (let j = i + 1; j < onMap.length; j++) {
      const b = j * OVERLAP_BOX_FIELDS;
      if (boxes[a] < boxes[b + 2] && boxes[b] < boxes[a + 2] && boxes[a + 1] < boxes[b + 3] && boxes[b + 1] < boxes[a + 3]) {
        problem = `${onMap[i].label} (${onMap[i].state}) a ${onMap[j].label} (${onMap[j].state}) zdieľajú bunky — lode sa nesmú prekrývať (ADR-029)`;
        break;
      }
    }
  }
  onMap.length = 0;
  return problem;
}
