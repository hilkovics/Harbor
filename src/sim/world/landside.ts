/**
 * Pozemný exportný reťazec na cestnej sieti (ARCHITECTURE §7.4, §7.5; rozhodnutia orchestrátora F4 č. 1–3; ADR-022):
 * strany brán, priechody stojiskami a prevádzkovosť rámp. Čistý výpočet nad cestami a modulmi sveta, zapamätaný do
 * zmeny `roadVersion` alebo `moduleVersion` (lenivo pri prvom dotaze) — nie je stav simulácie a do save nepatrí.
 *
 * Pojmy (bunky sú **prístupové bunky** = vonkajšie bunky cestných konektorov s cestou, `accessCellIndex`; cena cesty
 * z `DistanceMatrix`):
 * - **Portál** = `map.roadPortals[0]` (tam sa spawnujú kamióny, rozhodnutie 5); bez cesty na ňom nevedie odnikiaľ nič.
 * - **Strany brány** (rozhodnutie 2): vstupná = prístupová bunka brány dosiahnuteľná z portálu s najnižšou cenou (pri
 *   zhode prvý konektor v poradí defu). Cesty nevedú telom modulov, takže každá cesta z portálu je „bez prechodu
 *   bránou". Výstupná = prvý ďalší konektor s prístupovou bunkou. **Platná** brána má obe; brány za sebou (brána
 *   dosiahnuteľná len cez inú bránu) platné nie sú.
 * - **Priechod stojiskom** z bunky `from` (výstup brány) k rampe: dvojica konektorov stojiska (vstup, výstup), kde vstup
 *   je z `from` dosiahnuteľný a z výstupu je dosiahnuteľná prístupová bunka rampy; vyhráva najnižší súčet cien (pri
 *   zhode poradie defu: vstup, potom výstup). Najprv sa hľadá skutočný priechod (vstup ≠ výstup), ak nie je, stojisko
 *   s jediným použiteľným konektorom poslúži ako slepé parkovisko (vstup = výstup).
 * - **Trasa** rampy = (platná brána, stojisko s priechodom); trasy sú v poradí id brány, potom id stojiska.
 * - **Prevádzková rampa** má aspoň jednu trasu. Inak dôvod (prvý platný): `not_connected` (rampa nemá prístupovú bunku),
 *   `no_gate` (žiadna platná brána), `no_waiting_area` (za žiadnou platnou bránou nie je dosiahnuteľné stojisko),
 *   `not_connected` (stojiská za bránou sú, ale k rampe z nich cesta nevedie).
 *
 * Výpočet sa robí len pri zmene verzií; dotazy (`rampStatus`, `gateSides`, `routes`) sú potom jedno `Map.get` bez
 * alokácie. Bez brán, stojísk a rámp nerobí žiadne A*.
 */
import type { EntityId } from '../core/entity-id';
import type { CellCoord, Grid } from '../grid/grid';
import type { DistanceMatrix } from '../logistics/distance-matrix';
import { NO_ACCESS, accessCellIndex } from '../logistics/module-access';
import { LoadingRamp, RAMP_OPERATIONAL, type RampInoperativeReason, type RampStatus } from '../modules/loading-ramp';
import type { Module } from '../modules/module';
import type { PlacedConnector } from '../modules/module-geometry';
import { TruckGate } from '../modules/truck-gate';
import { WaitingArea } from '../modules/waiting-area';

/** Časť sveta, z ktorej sa reťazec počíta (`World` ju spĺňa). */
export interface LandsideEnv {
  readonly grid: Grid;
  readonly map: { readonly roadPortals: readonly { readonly cell: CellCoord }[] };
  /** Moduly vzostupne podľa id. */
  readonly modules: ReadonlyMap<EntityId, Module>;
  /** Ceny ciest (lenivé — číta sa len pri výpočte s bránami, stojiskami alebo rampami). */
  readonly distances: DistanceMatrix;
  readonly roadVersion: number;
  readonly moduleVersion: number;
}

/** Strany brány: konektory a ich prístupové bunky (`NO_ACCESS`, keď strana chýba). */
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
  /** Prístupová bunka rampy najlacnejšie dosiahnuteľná z výstupu stojiska. */
  readonly rampCell: number;
}

/** Brána bez určených strán. */
export const NO_GATE_SIDES: GateSides = Object.freeze({ entry: null, exit: null, entryCell: NO_ACCESS, exitCell: NO_ACCESS });

const NO_ROUTES: readonly LandsideRoute[] = Object.freeze([]);

/** Zmrazený stav pre každý dôvod — výpočet nealokuje nové objekty stavu. */
const INOPERATIVE: { readonly [R in RampInoperativeReason]: RampStatus } = Object.freeze({
  not_connected: Object.freeze({ operational: false, reason: 'not_connected' }),
  no_gate: Object.freeze({ operational: false, reason: 'no_gate' }),
  no_waiting_area: Object.freeze({ operational: false, reason: 'no_waiting_area' }),
});

interface RampAccess {
  readonly status: RampStatus;
  readonly routes: readonly LandsideRoute[];
}

interface LandsideState {
  readonly portalCell: number;
  readonly gates: ReadonlyMap<EntityId, GateSides>;
  readonly ramps: ReadonlyMap<EntityId, RampAccess>;
}

const EMPTY_STATE: LandsideState = Object.freeze({ portalCell: NO_ACCESS, gates: new Map(), ramps: new Map() });

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

/** Bunka portálu `roadPortals[0]`, ak je v mape a má cestu; inak `NO_ACCESS`. */
function portalCellOf(env: LandsideEnv): number {
  const portal = env.map.roadPortals[0];
  if (portal === undefined || !env.grid.inBounds(portal.cell.x, portal.cell.y)) return NO_ACCESS;
  const index = env.grid.index(portal.cell.x, portal.cell.y);
  return env.grid.atIndex(index).road === 'road' ? index : NO_ACCESS;
}

/** Strany brány (rozhodnutie 2). */
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

/** Najlacnejšia prístupová bunka rampy z `from` (pri zhode prvá v poradí defu) a jej cena. */
function nearestRampCell(env: LandsideEnv, from: number, rampCells: readonly number[]): { readonly cell: number; readonly cost: number } {
  let cell = NO_ACCESS;
  let cost = Infinity;
  for (const candidate of rampCells) {
    const candidateCost = env.distances.distance(from, candidate);
    if (candidateCost < cost) {
      cell = candidate;
      cost = candidateCost;
    }
  }
  return { cell, cost };
}

interface Passage {
  readonly entryCell: number;
  readonly exitCell: number;
  readonly rampCell: number;
}

/** Priechod stojiskom z bunky `from` k rampe (viď hlavička); `null`, ak neexistuje. */
function waitingPassage(env: LandsideEnv, area: WaitingArea, from: number, rampCells: readonly number[]): Passage | null {
  const accesses = accessesOf(env.grid, area);
  for (const distinct of [true, false]) {
    let best: Passage | null = null;
    let bestCost = Infinity;
    for (let i = 0; i < accesses.length; i++) {
      const costIn = env.distances.distance(from, accesses[i].cell);
      if (costIn === Infinity) continue;
      for (let j = 0; j < accesses.length; j++) {
        if ((i !== j) !== distinct) continue;
        const out = nearestRampCell(env, accesses[j].cell, rampCells);
        if (out.cost === Infinity || costIn + out.cost >= bestCost) continue;
        best = { entryCell: accesses[i].cell, exitCell: accesses[j].cell, rampCell: out.cell };
        bestCost = costIn + out.cost;
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/** Je z niektorej platnej brány dosiahnuteľná prístupová bunka niektorého stojiska? */
function hasAreaBehindGate(env: LandsideEnv, gates: readonly GateSides[], areas: readonly WaitingArea[]): boolean {
  for (const sides of gates) {
    for (const area of areas) {
      for (const access of accessesOf(env.grid, area)) {
        if (env.distances.distance(sides.exitCell, access.cell) < Infinity) return true;
      }
    }
  }
  return false;
}

interface ValidGate {
  readonly gate: TruckGate;
  readonly sides: GateSides;
}

/** Prevádzkovosť a trasy jednej rampy (viď hlavička). */
function rampAccessOf(env: LandsideEnv, ramp: LoadingRamp, gates: readonly ValidGate[], areas: readonly WaitingArea[], areaBehindGate: boolean): RampAccess {
  const rampCells = accessesOf(env.grid, ramp).map((access) => access.cell);
  if (rampCells.length === 0) return { status: INOPERATIVE.not_connected, routes: NO_ROUTES };
  if (gates.length === 0) return { status: INOPERATIVE.no_gate, routes: NO_ROUTES };
  const routes: LandsideRoute[] = [];
  for (const { gate, sides } of gates) {
    for (const area of areas) {
      const passage = waitingPassage(env, area, sides.exitCell, rampCells);
      if (passage === null) continue;
      routes.push(
        Object.freeze({
          gateId: gate.id,
          gateEntryCell: sides.entryCell,
          gateExitCell: sides.exitCell,
          waitingAreaId: area.id,
          waitingEntryCell: passage.entryCell,
          waitingExitCell: passage.exitCell,
          rampCell: passage.rampCell,
        }),
      );
    }
  }
  if (routes.length > 0) return { status: RAMP_OPERATIONAL, routes: Object.freeze(routes) };
  return { status: areaBehindGate ? INOPERATIVE.not_connected : INOPERATIVE.no_waiting_area, routes: NO_ROUTES };
}

/** Celý výpočet reťazca nad aktuálnymi cestami a modulmi. */
function computeLandside(env: LandsideEnv): LandsideState {
  const gateModules: TruckGate[] = [];
  const areas: WaitingArea[] = [];
  const ramps: LoadingRamp[] = [];
  for (const module of env.modules.values()) {
    if (module instanceof TruckGate) gateModules.push(module);
    else if (module instanceof WaitingArea) areas.push(module);
    else if (module instanceof LoadingRamp) ramps.push(module);
  }
  const portal = portalCellOf(env);
  const gates = new Map<EntityId, GateSides>();
  const valid: ValidGate[] = [];
  for (const gate of gateModules) {
    const sides = gateSidesOf(env, gate, portal);
    gates.set(gate.id, sides);
    if (sides.exit !== null) valid.push({ gate, sides });
  }
  const rampAccess = new Map<EntityId, RampAccess>();
  if (ramps.length > 0) {
    const areaBehindGate = hasAreaBehindGate(
      env,
      valid.map((entry) => entry.sides),
      areas,
    );
    for (const ramp of ramps) rampAccess.set(ramp.id, rampAccessOf(env, ramp, valid, areas, areaBehindGate));
  }
  return { portalCell: portal, gates, ramps: rampAccess };
}

export class LandsideNetwork {
  private readonly env: LandsideEnv;
  private roadVersion = Number.NaN;
  private moduleVersion = Number.NaN;
  private state: LandsideState = EMPTY_STATE;
  private computations = 0;

  constructor(env: LandsideEnv) {
    this.env = env;
  }

  /** Bunka road portálu, na ktorom vznikajú kamióny (`roadPortals[0]` s cestou), alebo `NO_ACCESS`. */
  get portalCell(): number {
    return this.current().portalCell;
  }

  /** Koľkokrát sa reťazec prepočítal (diagnostika, testy cache). */
  get computeCount(): number {
    return this.computations;
  }

  /** Strany brány; modul, ktorý nie je bránou sveta, → `NO_GATE_SIDES`. */
  gateSides(gate: Module): GateSides {
    return this.current().gates.get(gate.id) ?? NO_GATE_SIDES;
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
