/**
 * Pozemný exportný reťazec na cestnej sieti (ARCHITECTURE §7.4, §7.5; rozhodnutia orchestrátora F4 č. 1–3; ADR-022, ADR-024; od R4 ADR-041): strany pruhov brány, okruhy
 * kamiónov za bránou, trasy, predbránové plochy a prevádzkovosť rámp. Čistý výpočet nad cestami a modulmi sveta, zapamätaný do zmeny `roadVersion` alebo `moduleVersion`
 * (lenivo pri prvom dotaze) — nie je stav simulácie a do save nepatrí.
 *
 * Pojmy (bunky sú **prístupové bunky** = vonkajšie bunky cestných konektorov s cestou, `accessCellIndex`; cena cesty z `DistanceMatrix`, „dosiahnuteľná" = konečná cena po
 * cestách so smermi jednosmeriek):
 * - **Portál** = vjazd (`in`/`both`: tu vznikajú kamióny, `trafficShare` = podiel kamiónov z danej strany vnútrozemia) a výjazd (`out`/`both`: tu opúšťajú mapu). Portálov môže
 *   byť viac (ADR-041 bod 3); portál vjazdu je použiteľný, keď z neho vedie cesta k niektorému vstupu brány.
 * - **Pruh brány** (R4, ADR-041 bod 1) je jednosmerný: prvý konektor defu je vonkajšia (vstupná) strana, druhý vnútorná (výstupná). **Platný vstupný pruh** (`direction: 'in'`) má oba
 *   konektory s cestou a jeho vstup je dosiahnuteľný z portálu vjazdu alebo z výjazdu platnej predbránovej plochy; **platný výstupný pruh** (`direction: 'out'`) má oba konektory
 *   s cestou a jeho výstup je z cesty dosiahnuteľný k portálu výjazdu. Strany sa zverejňujú pruhu (`TruckGate.setSides`).
 * - **Predbránová plocha** (`pre_gate`): vjazd = prvý konektor, výjazd = druhý; plocha je platná, keď je jej vjazd dosiahnuteľný z portálu a z výjazdu je dosiahnuteľný aspoň jeden
 *   vstupný pruh (`preGateLanes`, vzostupne podľa id — pruh radu `r` je `lanes[r mod počet]`).
 * - **Priechod stojiskom** z vnútornej strany pruhu `inner` k rampe: dvojica konektorov stojiska (vstup, výstup), kde vstup je z `inner` dosiahnuteľný a z výstupu je dosiahnuteľná
 *   prístupová bunka rampy; vyhráva najnižší súčet cien (pri zhode poradie defu). Najprv sa hľadá skutočný priechod (vstup ≠ výstup), ak nie je, stojisko s jediným použiteľným
 *   konektorom poslúži ako slepé parkovisko (vstup = výstup).
 * - **Cesta späť** z bunky rampy `R`: z `R` je dosiahnuteľný vstup niektorého platného výstupného pruhu priamo, alebo výstup priechodu a zo vstupu priechodu vstup výstupného pruhu
 *   (spätný priechod stojiskom, ADR-024 bod 8).
 * - **Okruh** (`LandsideCircuit`) pruhu, stojiska a rampy = vnútorná strana vstupného pruhu + priechod + bunka rampy. Najprv sa hľadá priechod s bunkou rampy, z ktorej vedie cesta
 *   späť; ak taký nie je, okruh má len cestu tam (`returns: false`) — kamión za bránou tak aspoň naloží a čaká.
 * - **Trasa** rampy = (platný vstupný pruh, stojisko), ktorých okruh má cestu späť; trasy sú v poradí id pruhu, potom id stojiska. Výber pruhu podľa odhadu času (cesta + fronta × čas
 *   obsluhy) robí `trucks/gate-choice.ts`.
 * - **Prevádzková rampa** má aspoň jednu trasu. Inak dôvod (prvý platný): `not_connected` (rampa nemá prístupovú bunku), `no_gate` (žiadny platný vstupný pruh), `no_return_path`
 *   (za platným pruhom vedie okruh k rampe, ale nie späť k výstupnému pruhu), `no_waiting_area` (za žiadnym platným pruhom nie je dosiahnuteľné stojisko), `not_connected`
 *   (stojiská za pruhom sú, ale k rampe z nich cesta nevedie).
 *
 * Výpočet trás sa robí len pri zmene verzií; dotazy (`rampStatus`, `gateSides`, `routes`) sú potom jedno `Map.get` bez alokácie. Okruhy sa dopočítajú lenivo pri prvom dotaze na
 * trojicu modulov a pamätajú sa do zmeny verzií. Bez pruhov, stojísk a rámp nerobí žiadne A*.
 */
import type { EntityId } from '../core/entity-id';
import type { CellCoord, Grid } from '../grid/grid';
import type { DistanceMatrix } from '../logistics/distance-matrix';
import { NO_ACCESS, accessCellIndex } from '../logistics/module-access';
import { RAMP_OPERATIONAL, type LoadingRamp, type RampInoperativeReason, type RampStatus } from '../modules/loading-ramp';
import type { Module } from '../modules/module';
import type { PlacedConnector } from '../modules/module-geometry';
import type { PreGateBuffer } from '../modules/pre-gate-buffer';
import type { TruckGate } from '../modules/truck-gate';
import type { WaitingArea } from '../modules/waiting-area';
import type { LandsideModules } from './landside-roster';

/** Predvolený podiel portálu, keď mapa `trafficShare` neuvádza (rovnaký podiel ako ostatné portály). */
export const DEFAULT_TRAFFIC_SHARE = 1;

/** Časť sveta, z ktorej sa reťazec počíta (`World` ju spĺňa). */
export interface LandsideEnv {
  readonly grid: Grid;
  readonly map: {
    readonly roadPortals: readonly { readonly cell: CellCoord; readonly direction?: 'in' | 'out' | 'both'; readonly trafficShare?: number }[];
  };
  /** Register pozemných modulov (pruhy brán, predbránové plochy, stojiská, rampy vzostupne podľa id). */
  readonly landsideModules: LandsideModules;
  /** Ceny ciest (lenivé — číta sa len pri výpočte s bránami, stojiskami alebo rampami). */
  readonly distances: DistanceMatrix;
  readonly roadVersion: number;
  readonly moduleVersion: number;
}

/**
 * Strany pruhu brány: konektory a ich prístupové bunky (`NO_ACCESS`, keď strana chýba). Prvý konektor defu = `entry` (vonkajšia strana, tu kamión čaká), druhý = `exit`
 * (vnútorná strana, tu kamión po prechode vyjde). Strana bez cesty je `null` / `NO_ACCESS`.
 */
export interface GateSides {
  readonly entry: PlacedConnector | null;
  readonly exit: PlacedConnector | null;
  readonly entryCell: number;
  readonly exitCell: number;
}

/** Portál mapy s cestou: bunka a podiel premávky (`trafficShare`). */
export interface LandsidePortal {
  readonly cell: number;
  readonly share: number;
}

/** Trasa kamióna k rampe: vstupný pruh brány, stojisko a prístupové bunky na ceste (rozhodnutia 2, 3). */
export interface LandsideRoute {
  /** Vstupný pruh brány. */
  readonly gateId: EntityId;
  /** Prístupová bunka vstupnej strany pruhu (fronta pri príchode). */
  readonly gateEntryCell: number;
  /** Prístupová bunka výstupnej strany pruhu (tu sa kamión objaví po prechode dnu). */
  readonly gateExitCell: number;
  readonly waitingAreaId: EntityId;
  /** Prístupová bunka vstupného konektora stojiska. */
  readonly waitingEntryCell: number;
  /** Prístupová bunka výstupného konektora stojiska (rovná vstupnej pri slepom parkovisku). */
  readonly waitingExitCell: number;
  /** Prístupová bunka rampy najlacnejšie dosiahnuteľná z výstupu stojiska (s cestou späť k bráne). */
  readonly rampCell: number;
}

/** Okruh kamióna za bránou: vnútorná strana vstupného pruhu → priechod stojiskom → rampa (a späť, ak `returns`). */
export interface LandsideCircuit {
  /** Prístupová bunka vnútornej (výstupnej) strany vstupného pruhu — tu sa kamión objaví po prechode dnu. */
  readonly gateInnerCell: number;
  readonly waitingEntryCell: number;
  readonly waitingExitCell: number;
  /** Bunka rampy najlacnejšie dosiahnuteľná z výstupu stojiska (pri `returns` len spomedzi buniek s cestou späť). */
  readonly rampCell: number;
  /** Z `rampCell` vedie cesta späť k niektorému výstupnému pruhu (priamo alebo spätným priechodom stojiskom). */
  readonly returns: boolean;
}

/** Pruh bez určených strán. */
export const NO_GATE_SIDES: GateSides = Object.freeze({ entry: null, exit: null, entryCell: NO_ACCESS, exitCell: NO_ACCESS });

const NO_ROUTES: readonly LandsideRoute[] = Object.freeze([]);
const NO_LANES: readonly TruckGate[] = Object.freeze([]);
const NO_PORTALS: readonly LandsidePortal[] = Object.freeze([]);

/** Zmrazený stav pre každý dôvod — výpočet nealokuje nové objekty stavu. */
const INOPERATIVE: { readonly [R in RampInoperativeReason]: RampStatus } = Object.freeze({
  not_connected: Object.freeze({ operational: false, reason: 'not_connected' }),
  no_gate: Object.freeze({ operational: false, reason: 'no_gate' }),
  no_waiting_area: Object.freeze({ operational: false, reason: 'no_waiting_area' }),
  no_return_path: Object.freeze({ operational: false, reason: 'no_return_path' }),
});

interface RampAccess {
  readonly status: RampStatus;
  readonly routes: readonly LandsideRoute[];
}

/** Hodnota pre kľúč z mapy, pri prvom dotaze spočítaná (`compute`) a uložená — aj `null`. */
function memoized<K, V>(map: Map<K, V>, key: K, compute: () => V): V {
  const cached = map.get(key);
  if (cached !== undefined || map.has(key)) return cached as V;
  const value = compute();
  map.set(key, value);
  return value;
}

/** Platný pruh brány so stranami. */
interface ValidLane {
  readonly lane: TruckGate;
  readonly sides: GateSides;
}

interface LandsideState {
  /** Portály vjazdu (vznik kamiónov) s cestou k niektorému vstupu brány, v poradí mapy. */
  readonly inPortals: readonly LandsidePortal[];
  /** Portály výjazdu (kamión tu opúšťa mapu) s cestou, v poradí mapy. */
  readonly outPortals: readonly LandsidePortal[];
  /** Bunky portálov výjazdu ako pole pre kontrolu pohybu (cieľ `to_portal`; znovupoužiteľné, bez alokácie pri dotaze). */
  readonly outPortalCells: Int32Array;
  readonly gates: ReadonlyMap<EntityId, GateSides>;
  /** Platné vstupné pruhy vzostupne podľa id. */
  readonly inLanes: readonly ValidLane[];
  /** Platné výstupné pruhy vzostupne podľa id. */
  readonly outLanes: readonly ValidLane[];
  /** Tie isté pruhy ako `inLanes` a `outLanes` bez strán (znovupoužiteľné pohľady, bez alokácie pri dotaze). */
  readonly inLaneModules: readonly TruckGate[];
  readonly outLaneModules: readonly TruckGate[];
  /** Vstupné bunky platných výstupných pruhov (cieľ cesty späť). */
  readonly outEntryCells: readonly number[];
  /** Predbránová plocha → vstupné pruhy dosiahnuteľné z jej výjazdu (vzostupne podľa id); plocha bez pruhu tu nie je. */
  readonly bufferLanes: ReadonlyMap<EntityId, readonly TruckGate[]>;
  readonly ramps: Map<EntityId, RampAccess>;
  /** Okruhy: pruh → stojisko → rampa → okruh alebo `null` (dopĺňa sa lenivo). */
  readonly circuits: Map<EntityId, Map<EntityId, Map<EntityId, LandsideCircuit | null>>>;
}

function emptyState(): LandsideState {
  return {
    inPortals: NO_PORTALS,
    outPortals: NO_PORTALS,
    outPortalCells: new Int32Array(0),
    gates: new Map(),
    inLanes: [],
    outLanes: [],
    inLaneModules: NO_LANES,
    outLaneModules: NO_LANES,
    outEntryCells: [],
    bufferLanes: new Map(),
    ramps: new Map(),
    circuits: new Map(),
  };
}

/** Okruh z pamäte stavu (pruh, stojisko, rampa), pri prvom dotaze spočítaný `compute`. */
function cachedCircuit(state: LandsideState, gateId: EntityId, areaId: EntityId, rampId: EntityId, compute: () => LandsideCircuit | null): LandsideCircuit | null {
  const byArea = memoized(state.circuits, gateId, () => new Map<EntityId, Map<EntityId, LandsideCircuit | null>>());
  return memoized(
    memoized(byArea, areaId, () => new Map<EntityId, LandsideCircuit | null>()),
    rampId,
    compute,
  );
}

/** Cestný konektor s prístupovou bunkou. */
interface Access {
  readonly connector: PlacedConnector;
  readonly cell: number;
}

/** Prístupové bunky modulu v poradí defu (len cestné konektory s cestou na vonkajšej bunke). */
function accessesOf(grid: Grid, module: Module): Access[] {
  const accesses: Access[] = [];
  for (const connector of module.connectors) {
    const cell = accessCellIndex(grid, connector);
    if (cell !== NO_ACCESS) accesses.push({ connector, cell });
  }
  return accesses;
}

/** Vedie z `from` do `to` cesta (konečná cena)? */
function reaches(env: LandsideEnv, from: number, to: number): boolean {
  return env.distances.distance(from, to) < Infinity;
}

/** Vedie z `from` cesta k niektorej z buniek `targets`? */
function reachesAny(env: LandsideEnv, from: number, targets: readonly number[]): boolean {
  for (const target of targets) if (reaches(env, from, target)) return true;
  return false;
}

/**
 * Portály, ktoré smú byť vjazdom (`in`, `both`) alebo výjazdom (`out`, `both`; portál bez smeru je `both`) a majú cestu na svojej bunke (ADR-037 dodatok R1: jednosmerný
 * prístav), v poradí mapy, s podielom premávky (`trafficShare`, chýba = `DEFAULT_TRAFFIC_SHARE`).
 */
function portalsOf(env: LandsideEnv, side: 'in' | 'out'): LandsidePortal[] {
  const portals: LandsidePortal[] = [];
  for (const portal of env.map.roadPortals) {
    const direction = portal.direction ?? 'both';
    if (direction !== side && direction !== 'both') continue;
    if (!env.grid.inBounds(portal.cell.x, portal.cell.y)) continue;
    const index = env.grid.index(portal.cell.x, portal.cell.y);
    if (env.grid.atIndex(index).road === 'road') portals.push({ cell: index, share: portal.trafficShare ?? DEFAULT_TRAFFIC_SHARE });
  }
  return portals;
}

/**
 * Strany pruhu brány: prvý konektor = vonkajšia strana, druhý = vnútorná (ADR-041 bod 1); každá strana je nezávislá — chýbajúca cesta na jednej neruší druhú
 * (kamión, ktorý je už za pruhom, dokončí okruh aj po prerušení vstupu; review T04-11, major 2). Pruh bez ciest na oboch stranách → `NO_GATE_SIDES`.
 */
function laneSidesOf(env: LandsideEnv, lane: TruckGate): GateSides {
  const [first, second] = lane.connectors;
  if (first === undefined || second === undefined) return NO_GATE_SIDES;
  const entryCell = accessCellIndex(env.grid, first);
  const exitCell = accessCellIndex(env.grid, second);
  if (entryCell === NO_ACCESS && exitCell === NO_ACCESS) return NO_GATE_SIDES;
  return Object.freeze({
    entry: entryCell === NO_ACCESS ? null : first,
    exit: exitCell === NO_ACCESS ? null : second,
    entryCell,
    exitCell,
  });
}

/** Vedie z bunky `cell` cesta späť k vstupu niektorého výstupného pruhu — priamo, alebo spätným priechodom stojiskom? */
function returnsFrom(env: LandsideEnv, cell: number, waitingEntryCell: number, waitingExitCell: number, outCells: readonly number[]): boolean {
  return reachesAny(env, cell, outCells) || (reaches(env, cell, waitingExitCell) && reachesAny(env, waitingEntryCell, outCells));
}

interface Passage {
  readonly entryCell: number;
  readonly exitCell: number;
  readonly rampCell: number;
}

/**
 * Priechod stojiskom z vnútornej strany pruhu `inner` k rampe (viď hlavička); pri `requireReturn` len s bunkou rampy, z ktorej vedie cesta späť (`returnsFrom`). `null`,
 * ak neexistuje.
 */
function waitingPassage(env: LandsideEnv, area: Module, inner: number, rampCells: readonly number[], requireReturn: boolean, outCells: readonly number[]): Passage | null {
  const accesses = accessesOf(env.grid, area);
  for (const distinct of [true, false]) {
    let best: Passage | null = null;
    let bestCost = Infinity;
    for (let i = 0; i < accesses.length; i++) {
      const costIn = env.distances.distance(inner, accesses[i].cell);
      if (costIn === Infinity) continue;
      for (let j = 0; j < accesses.length; j++) {
        if ((i !== j) !== distinct) continue;
        // Najlacnejšia bunka rampy z výstupu (pri zhode prvá v poradí defu), pri `requireReturn` len s cestou späť.
        let rampCell = NO_ACCESS;
        let costOut = Infinity;
        for (const candidate of rampCells) {
          const cost = env.distances.distance(accesses[j].cell, candidate);
          if (cost >= costOut) continue;
          if (requireReturn && !returnsFrom(env, candidate, accesses[i].cell, accesses[j].cell, outCells)) continue;
          rampCell = candidate;
          costOut = cost;
        }
        if (costOut === Infinity || costIn + costOut >= bestCost) continue;
        best = { entryCell: accesses[i].cell, exitCell: accesses[j].cell, rampCell };
        bestCost = costIn + costOut;
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/** Okruh z vnútornej strany pruhu `inner` cez stojisko k rampe s bunkami `rampCells` (viď hlavička), alebo `null`. */
function circuitOf(env: LandsideEnv, area: Module, inner: number, rampCells: readonly number[], outCells: readonly number[]): LandsideCircuit | null {
  if (inner === NO_ACCESS || rampCells.length === 0) return null;
  const full = waitingPassage(env, area, inner, rampCells, true, outCells);
  const passage = full ?? waitingPassage(env, area, inner, rampCells, false, outCells);
  if (passage === null) return null;
  return Object.freeze({
    gateInnerCell: inner,
    waitingEntryCell: passage.entryCell,
    waitingExitCell: passage.exitCell,
    rampCell: passage.rampCell,
    returns: full !== null,
  });
}

/** Je z niektorého platného vstupného pruhu dosiahnuteľná prístupová bunka niektorého stojiska? */
function hasAreaBehindGate(env: LandsideEnv, gates: readonly ValidLane[], areas: readonly WaitingArea[]): boolean {
  for (const { sides } of gates) {
    for (const area of areas) {
      for (const access of accessesOf(env.grid, area)) {
        if (reaches(env, sides.exitCell, access.cell)) return true;
      }
    }
  }
  return false;
}

/** Prístupové bunky rampy v poradí defu. */
function rampCellsOf(env: LandsideEnv, ramp: Module): number[] {
  return accessesOf(env.grid, ramp).map((access) => access.cell);
}

/** Prevádzkovosť a trasy jednej rampy (viď hlavička); okruhy platných pruhov zostanú v pamäti stavu. */
function rampAccessOf(env: LandsideEnv, state: LandsideState, ramp: LoadingRamp, areas: readonly WaitingArea[]): RampAccess {
  const rampCells = rampCellsOf(env, ramp);
  if (rampCells.length === 0) return { status: INOPERATIVE.not_connected, routes: NO_ROUTES };
  if (state.inLanes.length === 0) return { status: INOPERATIVE.no_gate, routes: NO_ROUTES };
  const routes: LandsideRoute[] = [];
  let forward = false;
  for (const { lane, sides } of state.inLanes) {
    for (const area of areas) {
      const circuit = cachedCircuit(state, lane.id, area.id, ramp.id, () => circuitOf(env, area, sides.exitCell, rampCells, state.outEntryCells));
      if (circuit === null) continue;
      forward = true;
      if (!circuit.returns) continue;
      routes.push(
        Object.freeze({
          gateId: lane.id,
          gateEntryCell: sides.entryCell,
          gateExitCell: sides.exitCell,
          waitingAreaId: area.id,
          waitingEntryCell: circuit.waitingEntryCell,
          waitingExitCell: circuit.waitingExitCell,
          rampCell: circuit.rampCell,
        }),
      );
    }
  }
  if (routes.length > 0) return { status: RAMP_OPERATIONAL, routes: Object.freeze(routes) };
  if (forward) return { status: INOPERATIVE.no_return_path, routes: NO_ROUTES };
  return { status: hasAreaBehindGate(env, state.inLanes, areas) ? INOPERATIVE.not_connected : INOPERATIVE.no_waiting_area, routes: NO_ROUTES };
}

/** Celý výpočet reťazca nad aktuálnymi cestami a modulmi. */
function computeLandside(env: LandsideEnv): LandsideState {
  const { gates: gateModules, preGates, waitingAreas: areas, ramps } = env.landsideModules;
  const inPortalsAll = portalsOf(env, 'in');
  const outPortals = portalsOf(env, 'out');
  const outPortalCells = outPortals.map((portal) => portal.cell);
  const inPortalCells = inPortalsAll.map((portal) => portal.cell);
  const gates = new Map<EntityId, GateSides>();
  const candidates: ValidLane[] = [];
  const outLanes: ValidLane[] = [];
  for (const lane of gateModules) {
    const sides = laneSidesOf(env, lane);
    gates.set(lane.id, sides);
    if (sides.entry === null || sides.exit === null) continue;
    if (lane.direction === 'in') candidates.push({ lane, sides });
    else if (reachesAny(env, sides.exitCell, outPortalCells)) outLanes.push({ lane, sides });
  }
  // Predbránové plochy: vjazd z portálu a aspoň jeden vstupný pruh dosiahnuteľný z výjazdu plochy.
  const feeders: { readonly buffer: PreGateBuffer; readonly lanes: ValidLane[] }[] = [];
  for (const buffer of preGates) {
    const [entry, exit] = buffer.connectors;
    if (entry === undefined || exit === undefined) continue;
    const entryCell = accessCellIndex(env.grid, entry);
    const exitCell = accessCellIndex(env.grid, exit);
    if (entryCell === NO_ACCESS || exitCell === NO_ACCESS || !inPortalCells.some((cell) => reaches(env, cell, entryCell))) continue;
    const lanes = candidates.filter((candidate) => reaches(env, exitCell, candidate.sides.entryCell));
    if (lanes.length > 0) feeders.push({ buffer, lanes });
  }
  // Vstupný pruh je platný, keď je jeho vstup dosiahnuteľný z portálu alebo z výjazdu platnej predbránovej plochy.
  const inLanes = candidates.filter(
    (candidate) => inPortalCells.some((cell) => reaches(env, cell, candidate.sides.entryCell)) || feeders.some((feeder) => feeder.lanes.includes(candidate)),
  );
  const bufferLanes = new Map<EntityId, readonly TruckGate[]>();
  for (const feeder of feeders) {
    const lanes = feeder.lanes.filter((candidate) => inLanes.includes(candidate)).map((candidate) => candidate.lane);
    if (lanes.length > 0) bufferLanes.set(feeder.buffer.id, Object.freeze(lanes));
  }
  // Portál vjazdu je použiteľný, keď z neho vedie cesta k vstupu pruhu alebo k vjazdu platnej plochy.
  const gateEntryCells = inLanes.map((candidate) => candidate.sides.entryCell);
  const bufferEntryCells: number[] = [];
  for (const buffer of preGates) {
    if (!bufferLanes.has(buffer.id)) continue;
    const entry = buffer.connectors[0];
    if (entry !== undefined) bufferEntryCells.push(accessCellIndex(env.grid, entry));
  }
  const inPortals = inPortalsAll.filter((portal) => reachesAny(env, portal.cell, gateEntryCells) || reachesAny(env, portal.cell, bufferEntryCells));
  const state: LandsideState = {
    inPortals: inPortals.length === 0 ? NO_PORTALS : Object.freeze(inPortals),
    outPortals: outPortals.length === 0 ? NO_PORTALS : Object.freeze(outPortals),
    outPortalCells: Int32Array.from(outPortalCells),
    gates,
    inLanes: Object.freeze(inLanes),
    outLanes: Object.freeze(outLanes),
    inLaneModules: Object.freeze(inLanes.map((candidate) => candidate.lane)),
    outLaneModules: Object.freeze(outLanes.map((candidate) => candidate.lane)),
    outEntryCells: Object.freeze(outLanes.map((candidate) => candidate.sides.entryCell)),
    bufferLanes,
    ramps: new Map(),
    circuits: new Map(),
  };
  for (const ramp of ramps) state.ramps.set(ramp.id, rampAccessOf(env, state, ramp, areas));
  return state;
}

export class LandsideNetwork {
  private readonly env: LandsideEnv;
  private roadVersion = Number.NaN;
  private moduleVersion = Number.NaN;
  private state: LandsideState = emptyState();
  private computations = 0;

  constructor(env: LandsideEnv) {
    this.env = env;
  }

  /** Portály vjazdu s cestou k niektorému vstupu brány (`in` alebo `both`), v poradí mapy; kamióny tu vznikajú. */
  get inPortals(): readonly LandsidePortal[] {
    return this.current().inPortals;
  }

  /** Portály výjazdu s cestou (`out` alebo `both`), v poradí mapy; kamióny tu opúšťajú mapu. */
  get outPortals(): readonly LandsidePortal[] {
    return this.current().outPortals;
  }

  /** Bunky portálov výjazdu (cieľ jazdy `to_portal` pre kontrolu pohybu). */
  get outPortalCells(): Int32Array {
    return this.current().outPortalCells;
  }

  /** Bunka prvého portálu výjazdu, alebo `NO_ACCESS` (kompatibilný pohľad pre prezentáciu a testy). */
  get exitPortalCell(): number {
    return this.current().outPortals[0]?.cell ?? NO_ACCESS;
  }

  /** Bunka prvého portálu vjazdu, alebo `NO_ACCESS` (kompatibilný pohľad pre prezentáciu a testy). */
  get portalCell(): number {
    return this.current().inPortals[0]?.cell ?? NO_ACCESS;
  }

  /**
   * Portál výjazdu s najnižšou cenou cesty z bunky `from` (pri zhode prvý v poradí mapy); žiadny dosiahnuteľný → `NO_ACCESS`. Kamión po výstupnom pruhu ide na najbližší výjazd
   * (ADR-041 bod 3).
   */
  nearestExitPortal(from: number): number {
    let best = NO_ACCESS;
    let bestCost = Infinity;
    for (const portal of this.current().outPortals) {
      const cost = this.env.distances.distance(from, portal.cell);
      if (cost < bestCost) {
        best = portal.cell;
        bestCost = cost;
      }
    }
    return best;
  }

  /** Koľkokrát sa reťazec prepočítal (diagnostika, testy cache). */
  get computeCount(): number {
    return this.computations;
  }

  /** Strany pruhu brány; modul, ktorý nie je bránou sveta, → `NO_GATE_SIDES`. */
  gateSides(gate: Module): GateSides {
    return this.current().gates.get(gate.id) ?? NO_GATE_SIDES;
  }

  /** Platné vstupné pruhy vzostupne podľa id (každý má cestu na oboch stranách a je dosiahnuteľný z portálu alebo z plochy). */
  get inLanes(): readonly TruckGate[] {
    return this.current().inLaneModules;
  }

  /** Platné výstupné pruhy vzostupne podľa id (výstup má cestu k portálu výjazdu). */
  get outLanes(): readonly TruckGate[] {
    return this.current().outLaneModules;
  }

  /** Vstupné pruhy obsluhované predbránovou plochou `buffer` (vzostupne podľa id; pruh radu `r` je `lanes[r mod počet]`); neplatná plocha → prázdne pole. */
  preGateLanes(buffer: Module): readonly TruckGate[] {
    return this.current().bufferLanes.get(buffer.id) ?? NO_LANES;
  }

  /** Predbránová plocha, ktorá obsluhuje vstupný pruh `lane` (prvá v poradí id); pruh bez plochy → `undefined`. */
  preGateOf(lane: Module, buffers: readonly PreGateBuffer[]): PreGateBuffer | undefined {
    const map = this.current().bufferLanes;
    return buffers.find((buffer) => map.get(buffer.id)?.some((candidate) => candidate.id === lane.id) ?? false);
  }

  /**
   * Okruh kamióna za bránou (viď hlavička) pre vstupný pruh, stojisko a rampu — z vnútornej strany pruhu. `undefined` = okruh nie je (pruh bez strán, stojisko nedosiahnuteľné
   * alebo z neho k rampe nevedie cesta) alebo rampa nie je rampou sveta.
   */
  circuit(gate: Module, area: Module, ramp: Module): LandsideCircuit | undefined {
    const state = this.current();
    if (!state.ramps.has(ramp.id)) return undefined;
    const circuit = cachedCircuit(state, gate.id, area.id, ramp.id, () =>
      circuitOf(this.env, area, (state.gates.get(gate.id) ?? NO_GATE_SIDES).exitCell, rampCellsOf(this.env, ramp), state.outEntryCells),
    );
    return circuit ?? undefined;
  }

  /**
   * Obslúži okruh bunku rampy `cell` rovnako dobre ako jeho `rampCell`? Bunka je dosiahnuteľná z výstupu stojiska a pri okruhu s cestou späť vedie cesta späť aj z nej
   * (dock kamióna, dodatok ADR-024).
   */
  circuitServesCell(circuit: LandsideCircuit, cell: number): boolean {
    if (cell === NO_ACCESS || !reaches(this.env, circuit.waitingExitCell, cell)) return false;
    return !circuit.returns || returnsFrom(this.env, cell, circuit.waitingEntryCell, circuit.waitingExitCell, this.current().outEntryCells);
  }

  /** Aktuálny stav rampy; modul, ktorý nie je rampou sveta, → `undefined`. */
  rampStatus(ramp: Module): RampStatus | undefined {
    return this.current().ramps.get(ramp.id)?.status;
  }

  /** Trasy kamiónov k rampe (poradie id pruhu, potom stojiska); neprevádzková alebo neznáma rampa → `[]`. */
  routes(ramp: Module): readonly LandsideRoute[] {
    return this.current().ramps.get(ramp.id)?.routes ?? NO_ROUTES;
  }

  /** Stav pre aktuálne verzie ciest a modulov (prepočet len pri zmene). */
  private current(): LandsideState {
    const { roadVersion, moduleVersion } = this.env;
    if (roadVersion !== this.roadVersion || moduleVersion !== this.moduleVersion) {
      this.state = computeLandside(this.env);
      this.roadVersion = roadVersion;
      this.moduleVersion = moduleVersion;
      this.computations += 1;
    }
    return this.state;
  }
}
