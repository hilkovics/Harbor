/**
 * Pozemný reťazec kamiónov na cestnej sieti (ARCHITECTURE §7.4, §7.5; ADR-022, ADR-024, ADR-041): strany pruhov brány, portály, predbránové plochy a dosiahnuteľnosť odovzdávacích miest (TP). Čistý výpočet nad
 * cestami a modulmi sveta, zapamätaný do zmeny `roadVersion` alebo `moduleVersion` (lenivo pri prvom dotaze) — nie je stav simulácie a do save nepatrí.
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
 * - **Obsluhovateľné TP** (`servesTp`): z vnútornej strany niektorého platného vstupného pruhu vedie cesta k bunke TP (alebo k odstavnej ploche) a z TP vedie cesta späť k vstupu niektorého
 *   platného výstupného pruhu (`reachesOut`). Kamión s lístkom na také TP nikdy nezostane bez cesty von.
 *
 * Výpočet sa robí len pri zmene verzií; dotazy sú potom jedno `Map.get` bez alokácie. Bez pruhov a plôch nerobí žiadne A*.
 */
import type { EntityId } from '../core/entity-id';
import type { CellCoord, Grid } from '../grid/grid';
import type { DistanceMatrix } from '../logistics/distance-matrix';
import { NO_ACCESS, accessCellIndex } from '../logistics/module-access';
import type { Module } from '../modules/module';
import type { PlacedConnector } from '../modules/module-geometry';
import type { PreGateBuffer } from '../modules/pre-gate-buffer';
import type { TruckGate } from '../modules/truck-gate';
import type { LandsideModules } from './landside-roster';

/** Predvolený podiel portálu, keď mapa `trafficShare` neuvádza (rovnaký podiel ako ostatné portály). */
export const DEFAULT_TRAFFIC_SHARE = 1;

/** Časť sveta, z ktorej sa reťazec počíta (`World` ju spĺňa). */
export interface LandsideEnv {
  readonly grid: Grid;
  readonly map: {
    readonly roadPortals: readonly { readonly cell: CellCoord; readonly direction?: 'in' | 'out' | 'both'; readonly trafficShare?: number }[];
  };
  /** Register pozemných modulov (pruhy brán, predbránové a odstavné plochy vzostupne podľa id). */
  readonly landsideModules: LandsideModules;
  /** Ceny ciest (lenivé — číta sa len pri výpočte s bránami alebo plochami). */
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

/** Pruh bez určených strán. */
export const NO_GATE_SIDES: GateSides = Object.freeze({ entry: null, exit: null, entryCell: NO_ACCESS, exitCell: NO_ACCESS });

const NO_LANES: readonly TruckGate[] = Object.freeze([]);
const NO_PORTALS: readonly LandsidePortal[] = Object.freeze([]);

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
  };
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

/** Celý výpočet reťazca nad aktuálnymi cestami a modulmi. */
function computeLandside(env: LandsideEnv): LandsideState {
  const { gates: gateModules, preGates } = env.landsideModules;
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
  };
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

  /** Vedie z bunky `cell` cesta k vstupu niektorého platného výstupného pruhu? (TP s cestou von, ADR-041 bod 8.) */
  reachesOut(cell: number): boolean {
    return cell !== NO_ACCESS && reachesAny(this.env, cell, this.current().outEntryCells);
  }

  /**
   * Obslúži vstupný pruh `lane` kamión s lístkom na bunku `cell` (TP, alebo vstup odstavnej plochy)? Z vnútornej strany pruhu vedie cesta k `cell` a z nej späť k niektorému
   * výstupnému pruhu (`reachesOut`).
   */
  servesTp(lane: Module, cell: number): boolean {
    const sides = this.gateSides(lane);
    return sides.exitCell !== NO_ACCESS && cell !== NO_ACCESS && reaches(this.env, sides.exitCell, cell) && this.reachesOut(cell);
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
