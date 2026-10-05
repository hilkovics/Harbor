/**
 * Pozemný exportný reťazec na cestnej sieti (ARCHITECTURE §7.4, §7.5; rozhodnutia orchestrátora F4 č. 1–3; ADR-022,
 * ADR-024 a jeho dodatok T04-12): strany brán, okruhy kamiónov za bránou, trasy a prevádzkovosť rámp. Čistý výpočet nad
 * cestami a modulmi sveta, zapamätaný do zmeny `roadVersion` alebo `moduleVersion` (lenivo pri prvom dotaze) — nie je
 * stav simulácie a do save nepatrí.
 *
 * Pojmy (bunky sú **prístupové bunky** = vonkajšie bunky cestných konektorov s cestou, `accessCellIndex`; cena cesty
 * z `DistanceMatrix`, „dosiahnuteľná" = konečná cena po cestách so smermi jednosmeriek):
 * - **Portál** = vjazd (`in`/`both`: tu vznikajú kamióny, rozhodnutie 5) a výjazd (`out`/`both`: tu opúšťajú mapu); bez cesty na ňom nevedie odnikiaľ nič.
 *   Jednosmerný prístav (ADR-037 dodatok R1): vstupná strana brány sa určuje z vjazdu, cesta von (`returnsToPortal`) sa overuje k výjazdu.
 * - **Strany brány** (rozhodnutie 2): vstupná = prístupová bunka brány dosiahnuteľná z portálu s najnižšou cenou (pri
 *   zhode prvý konektor v poradí defu). Cesty nevedú telom modulov, takže každá cesta z portálu je „bez prechodu
 *   bránou". Výstupná = prvý ďalší konektor s prístupovou bunkou. **Platná** brána má obe; brány za sebou (brána
 *   dosiahnuteľná len cez inú bránu) platné nie sú. Tieto strany svet zverejňuje bráne (`TruckGate.setSides`).
 * - **Strany brány pre kamión** (`truckGateSides`, dodatok ADR-024): strany z portálu, ak je vstupná určená; inak (portál
 *   bránu nedosiahne — prerušená cesta pred bránou) vnútorná = prvá prístupová bunka brány v poradí defu, z ktorej je
 *   dosiahnuteľná niektorá prístupová bunka stojiska kamióna, a vonkajšia = prvá ďalšia. Kamión za bránou tak dokončí
 *   svoj okruh a čaká pri bráne, kým sa cesta von neobnoví (review T04-11, major 2).
 * - **Priechod stojiskom** z vnútornej strany brány `inner` k rampe: dvojica konektorov stojiska (vstup, výstup), kde vstup
 *   je z `inner` dosiahnuteľný a z výstupu je dosiahnuteľná prístupová bunka rampy; vyhráva najnižší súčet cien (pri
 *   zhode poradie defu: vstup, potom výstup). Najprv sa hľadá skutočný priechod (vstup ≠ výstup), ak nie je, stojisko
 *   s jediným použiteľným konektorom poslúži ako slepé parkovisko (vstup = výstup).
 * - **Cesta späť** z bunky rampy `R` (review T04-11, major 1): z `R` je dosiahnuteľná vnútorná strana brány priamo, alebo
 *   výstup priechodu a zo vstupu priechodu vnútorná strana (spätný priechod stojiskom, ADR-024 bod 8).
 * - **Okruh** (`LandsideCircuit`) brány, stojiska a rampy = vnútorná strana brány + priechod + bunka rampy. Najprv sa
 *   hľadá priechod s bunkou rampy, z ktorej vedie cesta späť (bunky bez nej sa preskočia); ak taký nie je, okruh má len
 *   cestu tam (`returns: false`) — kamión za bránou tak aspoň naloží a čaká (major 2).
 * - **Trasa** rampy = (platná brána, stojisko), ktorých okruh má cestu späť a zo vstupnej strany brány je dosiahnuteľný
 *   portál; trasy sú v poradí id brány, potom id stojiska.
 * - **Prevádzková rampa** má aspoň jednu trasu. Inak dôvod (prvý platný): `not_connected` (rampa nemá prístupovú bunku),
 *   `no_gate` (žiadna platná brána), `no_return_path` (za platnou bránou vedie okruh k rampe, ale nie späť k bráne alebo
 *   od brány k portálu), `no_waiting_area` (za žiadnou platnou bránou nie je dosiahnuteľné stojisko), `not_connected`
 *   (stojiská za bránou sú, ale k rampe z nich cesta nevedie).
 *
 * Výpočet trás sa robí len pri zmene verzií; dotazy (`rampStatus`, `gateSides`, `routes`) sú potom jedno `Map.get` bez
 * alokácie. Strany pre kamión a okruhy sa dopočítajú lenivo pri prvom dotaze na dvojicu / trojicu modulov a pamätajú sa do
 * zmeny verzií (opakovaný dotaz je niekoľko `Map.get`). Bez brán, stojísk a rámp nerobí žiadne A*.
 */
import type { EntityId } from '../core/entity-id';
import type { CellCoord, Grid } from '../grid/grid';
import type { DistanceMatrix } from '../logistics/distance-matrix';
import { NO_ACCESS, accessCellIndex } from '../logistics/module-access';
import { RAMP_OPERATIONAL, type LoadingRamp, type RampInoperativeReason, type RampStatus } from '../modules/loading-ramp';
import type { Module } from '../modules/module';
import type { PlacedConnector } from '../modules/module-geometry';
import type { TruckGate } from '../modules/truck-gate';
import type { WaitingArea } from '../modules/waiting-area';
import type { LandsideModules } from './landside-roster';

/** Časť sveta, z ktorej sa reťazec počíta (`World` ju spĺňa). */
export interface LandsideEnv {
  readonly grid: Grid;
  readonly map: { readonly roadPortals: readonly { readonly cell: CellCoord; readonly direction?: 'in' | 'out' | 'both' }[] };
  /** Register pozemných modulov (brány, stojiská, rampy vzostupne podľa id). */
  readonly landsideModules: LandsideModules;
  /** Ceny ciest (lenivé — číta sa len pri výpočte s bránami, stojiskami alebo rampami). */
  readonly distances: DistanceMatrix;
  readonly roadVersion: number;
  readonly moduleVersion: number;
}

/**
 * Strany brány: konektory a ich prístupové bunky (`NO_ACCESS`, keď strana chýba). Strany z portálu majú výstup len
 * so vstupom; strany pre kamión bez vstupu z portálu (`truckGateSides`) môžu mať len výstup (vnútornú stranu).
 */
export interface GateSides {
  readonly entry: PlacedConnector | null;
  readonly exit: PlacedConnector | null;
  readonly entryCell: number;
  readonly exitCell: number;
}

/** Trasa kamióna k rampe: brána, stojisko a prístupové bunky na ceste (rozhodnutia 2, 3). */
export interface LandsideRoute {
  readonly gateId: EntityId;
  /** Prístupová bunka vstupnej strany brány (fronta pri príchode). */
  readonly gateEntryCell: number;
  /** Prístupová bunka výstupnej strany brány (tu sa kamión objaví po prechode dnu; fronta pri odchode). */
  readonly gateExitCell: number;
  readonly waitingAreaId: EntityId;
  /** Prístupová bunka vstupného konektora stojiska. */
  readonly waitingEntryCell: number;
  /** Prístupová bunka výstupného konektora stojiska (rovná vstupnej pri slepom parkovisku). */
  readonly waitingExitCell: number;
  /** Prístupová bunka rampy najlacnejšie dosiahnuteľná z výstupu stojiska (s cestou späť k bráne). */
  readonly rampCell: number;
}

/** Okruh kamióna za bránou: vnútorná strana brány → priechod stojiskom → rampa (a späť, ak `returns`). */
export interface LandsideCircuit {
  /** Prístupová bunka vnútornej (výstupnej) strany brány — tu sa kamión objaví po prechode dnu a čaká na cestu von. */
  readonly gateInnerCell: number;
  readonly waitingEntryCell: number;
  readonly waitingExitCell: number;
  /** Bunka rampy najlacnejšie dosiahnuteľná z výstupu stojiska (pri `returns` len spomedzi buniek s cestou späť). */
  readonly rampCell: number;
  /** Z `rampCell` vedie cesta späť k vnútornej strane brány (priamo alebo spätným priechodom stojiskom). */
  readonly returns: boolean;
}

/** Brána bez určených strán. */
export const NO_GATE_SIDES: GateSides = Object.freeze({ entry: null, exit: null, entryCell: NO_ACCESS, exitCell: NO_ACCESS });

const NO_ROUTES: readonly LandsideRoute[] = Object.freeze([]);

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

interface LandsideState {
  /** Vjazdový portál (vznik kamiónov, strany brán). */
  readonly portalCell: number;
  /** Výjazdový portál (kamión tu opúšťa mapu). */
  readonly exitPortalCell: number;
  readonly gates: ReadonlyMap<EntityId, GateSides>;
  readonly ramps: Map<EntityId, RampAccess>;
  /** Strany brány pre kamióny stojiska: brána → stojisko → strany (dopĺňa sa lenivo). */
  readonly truckSides: Map<EntityId, Map<EntityId, GateSides>>;
  /** Okruhy: brána → stojisko → rampa → okruh alebo `null` (dopĺňa sa lenivo). */
  readonly circuits: Map<EntityId, Map<EntityId, Map<EntityId, LandsideCircuit | null>>>;
}

function emptyState(portalCell: number, exitPortalCell: number, gates: ReadonlyMap<EntityId, GateSides>): LandsideState {
  return { portalCell, exitPortalCell, gates, ramps: new Map(), truckSides: new Map(), circuits: new Map() };
}

/** Okruh z pamäte stavu (brána, stojisko, rampa), pri prvom dotaze spočítaný `compute`. */
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

/**
 * Bunka prvého cestného portálu, ktorý smie byť vjazdom (`in`, `both`) alebo výjazdom (`out`, `both`; portál bez smeru je
 * `both`), ak je v mape a má cestu; inak `NO_ACCESS` (ADR-037 dodatok R1: jednosmerný prístav).
 */
function portalCellOf(env: LandsideEnv, side: 'in' | 'out'): number {
  for (const portal of env.map.roadPortals) {
    const direction = portal.direction ?? 'both';
    if (direction !== side && direction !== 'both') continue;
    if (!env.grid.inBounds(portal.cell.x, portal.cell.y)) continue;
    const index = env.grid.index(portal.cell.x, portal.cell.y);
    if (env.grid.atIndex(index).road === 'road') return index;
  }
  return NO_ACCESS;
}

/** Strany brány z portálu (rozhodnutie 2). */
function gateSidesOf(env: LandsideEnv, gate: TruckGate, portal: number): GateSides {
  if (portal === NO_ACCESS) return NO_GATE_SIDES;
  const accesses = accessesOf(env.grid, gate);
  let entry = -1;
  let bestCost = Infinity;
  for (let i = 0; i < accesses.length; i++) {
    const cost = env.distances.distance(portal, accesses[i].cell);
    if (cost < bestCost) {
      entry = i;
      bestCost = cost;
    }
  }
  if (entry < 0) return NO_GATE_SIDES;
  const exit = accesses.findIndex((_access, i) => i !== entry);
  return Object.freeze({
    entry: accesses[entry].connector,
    exit: exit < 0 ? null : accesses[exit].connector,
    entryCell: accesses[entry].cell,
    exitCell: exit < 0 ? NO_ACCESS : accesses[exit].cell,
  });
}

/**
 * Strany brány bez vstupu z portálu pre kamióny stojiska `area` (viď hlavička): vnútorná = prvá prístupová bunka brány,
 * z ktorej je dosiahnuteľná niektorá prístupová bunka stojiska; vonkajšia = prvá ďalšia. Bez takej bunky `NO_GATE_SIDES`.
 */
function detachedSidesOf(env: LandsideEnv, gate: Module, area: Module): GateSides {
  const accesses = accessesOf(env.grid, gate);
  const areaCells = accessesOf(env.grid, area).map((access) => access.cell);
  const inner = accesses.findIndex((access) => areaCells.some((cell) => reaches(env, access.cell, cell)));
  if (inner < 0) return NO_GATE_SIDES;
  const outer = accesses.findIndex((_access, i) => i !== inner);
  return Object.freeze({
    entry: outer < 0 ? null : accesses[outer].connector,
    exit: accesses[inner].connector,
    entryCell: outer < 0 ? NO_ACCESS : accesses[outer].cell,
    exitCell: accesses[inner].cell,
  });
}

/** Vedie z bunky `cell` cesta späť k vnútornej strane brány `inner` — priamo, alebo spätným priechodom stojiskom? */
function returnsFrom(env: LandsideEnv, cell: number, waitingEntryCell: number, waitingExitCell: number, inner: number): boolean {
  return reaches(env, cell, inner) || (reaches(env, cell, waitingExitCell) && reaches(env, waitingEntryCell, inner));
}

interface Passage {
  readonly entryCell: number;
  readonly exitCell: number;
  readonly rampCell: number;
}

/**
 * Priechod stojiskom z vnútornej strany brány `inner` k rampe (viď hlavička); pri `requireReturn` len s bunkou rampy,
 * z ktorej vedie cesta späť (`returnsFrom`). `null`, ak neexistuje.
 */
function waitingPassage(env: LandsideEnv, area: Module, inner: number, rampCells: readonly number[], requireReturn: boolean): Passage | null {
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
          if (requireReturn && !returnsFrom(env, candidate, accesses[i].cell, accesses[j].cell, inner)) continue;
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

/** Okruh z vnútornej strany brány `inner` cez stojisko k rampe s bunkami `rampCells` (viď hlavička), alebo `null`. */
function circuitOf(env: LandsideEnv, area: Module, inner: number, rampCells: readonly number[]): LandsideCircuit | null {
  if (inner === NO_ACCESS || rampCells.length === 0) return null;
  const full = waitingPassage(env, area, inner, rampCells, true);
  const passage = full ?? waitingPassage(env, area, inner, rampCells, false);
  if (passage === null) return null;
  return Object.freeze({
    gateInnerCell: inner,
    waitingEntryCell: passage.entryCell,
    waitingExitCell: passage.exitCell,
    rampCell: passage.rampCell,
    returns: full !== null,
  });
}

interface ValidGate {
  readonly gate: TruckGate;
  readonly sides: GateSides;
  /** Zo vstupnej strany brány je dosiahnuteľný portál (cesta von z mapy). */
  readonly returnsToPortal: boolean;
}

/** Je z niektorej platnej brány dosiahnuteľná prístupová bunka niektorého stojiska? */
function hasAreaBehindGate(env: LandsideEnv, gates: readonly ValidGate[], areas: readonly WaitingArea[]): boolean {
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

/** Prevádzkovosť a trasy jednej rampy (viď hlavička); okruhy platných brán zostanú v pamäti stavu. */
function rampAccessOf(env: LandsideEnv, state: LandsideState, ramp: LoadingRamp, gates: readonly ValidGate[], areas: readonly WaitingArea[]): RampAccess {
  const rampCells = rampCellsOf(env, ramp);
  if (rampCells.length === 0) return { status: INOPERATIVE.not_connected, routes: NO_ROUTES };
  if (gates.length === 0) return { status: INOPERATIVE.no_gate, routes: NO_ROUTES };
  const routes: LandsideRoute[] = [];
  let forward = false;
  for (const { gate, sides, returnsToPortal } of gates) {
    for (const area of areas) {
      const circuit = cachedCircuit(state, gate.id, area.id, ramp.id, () => circuitOf(env, area, sides.exitCell, rampCells));
      if (circuit === null) continue;
      forward = true;
      if (!circuit.returns || !returnsToPortal) continue;
      routes.push(
        Object.freeze({
          gateId: gate.id,
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
  return { status: hasAreaBehindGate(env, gates, areas) ? INOPERATIVE.not_connected : INOPERATIVE.no_waiting_area, routes: NO_ROUTES };
}

/** Celý výpočet reťazca nad aktuálnymi cestami a modulmi. */
function computeLandside(env: LandsideEnv): LandsideState {
  const { gates: gateModules, waitingAreas: areas, ramps } = env.landsideModules;
  const portal = portalCellOf(env, 'in');
  const exitPortal = portalCellOf(env, 'out');
  const gates = new Map<EntityId, GateSides>();
  const valid: ValidGate[] = [];
  for (const gate of gateModules) {
    const sides = gateSidesOf(env, gate, portal);
    gates.set(gate.id, sides);
    if (sides.exit !== null) valid.push({ gate, sides, returnsToPortal: exitPortal !== NO_ACCESS && reaches(env, sides.entryCell, exitPortal) });
  }
  const state = emptyState(portal, exitPortal, gates);
  for (const ramp of ramps) state.ramps.set(ramp.id, rampAccessOf(env, state, ramp, valid, areas));
  return state;
}

export class LandsideNetwork {
  private readonly env: LandsideEnv;
  private roadVersion = Number.NaN;
  private moduleVersion = Number.NaN;
  private state: LandsideState = emptyState(NO_ACCESS, NO_ACCESS, new Map());
  private computations = 0;

  constructor(env: LandsideEnv) {
    this.env = env;
  }

  /** Bunka vjazdového road portálu (`in` alebo `both` s cestou), na ktorom vznikajú kamióny, alebo `NO_ACCESS`. */
  get portalCell(): number {
    return this.current().portalCell;
  }

  /** Bunka výjazdového road portálu (`out` alebo `both` s cestou), na ktorom kamióny opúšťajú mapu, alebo `NO_ACCESS`. */
  get exitPortalCell(): number {
    return this.current().exitPortalCell;
  }

  /** Koľkokrát sa reťazec prepočítal (diagnostika, testy cache). */
  get computeCount(): number {
    return this.computations;
  }

  /** Strany brány z portálu; modul, ktorý nie je bránou sveta, → `NO_GATE_SIDES`. */
  gateSides(gate: Module): GateSides {
    return this.current().gates.get(gate.id) ?? NO_GATE_SIDES;
  }

  /**
   * Strany brány pre kamión so stojiskom `area` (viď hlavička): strany z portálu, ak je vstupná určená, inak strany podľa
   * stojiska (vnútorná = prvá prístupová bunka brány, z ktorej je stojisko dosiahnuteľné). Modul, ktorý nie je bránou
   * sveta, → `NO_GATE_SIDES`.
   */
  truckGateSides(gate: Module, area: Module): GateSides {
    const state = this.current();
    const sides = state.gates.get(gate.id);
    if (sides === undefined) return NO_GATE_SIDES;
    if (sides.entry !== null) return sides;
    const byArea = memoized(state.truckSides, gate.id, () => new Map<EntityId, GateSides>());
    return memoized(byArea, area.id, () => detachedSidesOf(this.env, gate, area));
  }

  /**
   * Okruh kamióna za bránou (viď hlavička) pre bránu, stojisko a rampu — z vnútornej strany `truckGateSides`, nezávisle
   * od toho, či je brána dosiahnuteľná z portálu. `undefined` = okruh nie je (brána bez vnútornej strany, stojisko
   * nedosiahnuteľné alebo z neho k rampe nevedie cesta) alebo rampa nie je rampou sveta.
   */
  circuit(gate: Module, area: Module, ramp: Module): LandsideCircuit | undefined {
    const state = this.current();
    if (!state.ramps.has(ramp.id)) return undefined;
    const circuit = cachedCircuit(state, gate.id, area.id, ramp.id, () =>
      circuitOf(this.env, area, this.truckGateSides(gate, area).exitCell, rampCellsOf(this.env, ramp)),
    );
    return circuit ?? undefined;
  }

  /**
   * Obslúži okruh bunku rampy `cell` rovnako dobre ako jeho `rampCell`? Bunka je dosiahnuteľná z výstupu stojiska a pri
   * okruhu s cestou späť vedie cesta späť aj z nej (dock kamióna, dodatok ADR-024).
   */
  circuitServesCell(circuit: LandsideCircuit, cell: number): boolean {
    if (cell === NO_ACCESS || !reaches(this.env, circuit.waitingExitCell, cell)) return false;
    return !circuit.returns || returnsFrom(this.env, cell, circuit.waitingEntryCell, circuit.waitingExitCell, circuit.gateInnerCell);
  }

  /** Aktuálny stav rampy; modul, ktorý nie je rampou sveta, → `undefined`. */
  rampStatus(ramp: Module): RampStatus | undefined {
    return this.current().ramps.get(ramp.id)?.status;
  }

  /** Trasy kamiónov k rampe (poradie id brány, potom stojiska); neprevádzková alebo neznáma rampa → `[]`. */
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
