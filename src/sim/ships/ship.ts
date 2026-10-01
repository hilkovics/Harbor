/**
 * Loď (ARCHITECTURE §4.3, §5, §7.4; ADR-016, ADR-029) — entita na vode, ktorá nesie náklad jedného typu
 * (`cargoTypeId`). Jednotky nákladu na palube vedie výlučne `CargoLedger` (`on_ship`, pravidlo 2); loď si ich neeviduje.
 *
 * - Poloha `x`, `y` = stred lode v bunkách (float); stred bunky (cx, cy) = (cx + 0.5, cy + 0.5). Loď v `arriving`
 *   stojí na `seaLane[0]`, ale je pred vstupom na mapu (nezaberá bunky).
 * - `heading` = kardinálny kurz (0 = predok na sever, v smere hodinových ručičiek) — nikdy nie uhol z trigonometrie.
 * - `berthIds` = kotviská, ktoré loď drží (v poradí po pobreží): od rezervácie (pri vstupe `inbound`, na konci dráhy
 *   alebo na anchorage) po koniec `undocking` na konci dráhy (`SHIP_STATE_TRAITS.berths`).
 * - `anchorageIndex` = index bunky `map.anchorage`, ktorú loď drží od rezervácie (pri vstupe `inbound`) po odchod
 *   ku kotvisku (`SHIP_STATE_TRAITS.anchorage`; v `waiting_anchorage` vždy — loď bez cieľa zo save v5 presunie parser
 *   pred vstup, ADR-029 addendum).
 * - `route` = trasa aktuálneho stavu (body na vode; ADR-029 — trasa cez prístav vzniká A* po vode pri rezervácii
 *   a ukladá sa, lebo závisí od polohy ostatných lodí v tej chvíli), `waypointIndex` = index nasledujúceho bodu.
 *
 * Stav mení len `transition(to, route)` podľa `SHIP_TRANSITIONS`; pohyb a alokáciu kotvísk robí `ShipSystem` (krok 3).
 */
import type { EntityId } from '../core/entity-id';
import type { CargoCategory, CargoTypeDef, ShipClassDef } from '../defs/types';
import { isRotation, type Rotation } from '../grid/rotation';
import { ShipError } from './ship-error';
import { SHIP_TRANSITIONS, isShipTransitionAllowed, type ShipState } from './ship-fsm';
import type { ShipPoint } from './ship-route';

/** Bod trasy v save: `[x, y]` alebo `[x, y, pevný kurz]` (ADR-029). */
export type SerializedShipPoint = readonly [number, number] | readonly [number, number, Rotation];

/** Loď v save (`WorldState.ships[i]`, ADR-016) — čistý JSON; poradie lodí v save = vzostupne podľa id (poradie spawnu). */
export interface SerializedShip {
  readonly id: number;
  readonly classId: string;
  readonly cargoTypeId: string;
  readonly state: ShipState;
  readonly x: number;
  readonly y: number;
  readonly heading: Rotation;
  readonly berthIds: readonly number[];
  readonly anchorageIndex: number | null;
  readonly waypointIndex: number;
  /** Trasa aktuálneho stavu (WorldState v6, ADR-029). */
  readonly route: readonly SerializedShipPoint[];
}

/** Kľúče `SerializedShip` v poradí `toState()`. */
export const SERIALIZED_SHIP_KEYS: readonly (keyof SerializedShip)[] = [
  'id',
  'classId',
  'cargoTypeId',
  'state',
  'x',
  'y',
  'heading',
  'berthIds',
  'anchorageIndex',
  'waypointIndex',
  'route',
];

/** Bod trasy → tvar v save. */
export function serializeShipPoint(point: ShipPoint): SerializedShipPoint {
  return point.heading === undefined ? [point.x, point.y] : [point.x, point.y, point.heading];
}

/** Vstup konštruktora lode (nová loď zo spawnu aj obnova zo save). */
export interface ShipInit {
  readonly id: EntityId;
  readonly def: Readonly<ShipClassDef>;
  readonly cargoType: Readonly<CargoTypeDef>;
  readonly state: ShipState;
  readonly x: number;
  readonly y: number;
  readonly heading: Rotation;
  readonly berthIds?: readonly EntityId[];
  readonly anchorageIndex?: number | null;
  readonly waypointIndex?: number;
  /** Trasa aktuálneho stavu; predvolene prázdna. */
  readonly route?: readonly ShipPoint[];
}

const NO_BERTHS: readonly EntityId[] = Object.freeze([]);
const NO_ROUTE: readonly ShipPoint[] = Object.freeze([]);

/** Zmrazená kópia trasy (body aj pole). */
function frozenRoute(route: readonly ShipPoint[]): readonly ShipPoint[] {
  return route.length === 0 ? NO_ROUTE : Object.freeze(route.map((point) => Object.freeze({ ...point })));
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export class Ship {
  readonly id: EntityId;
  readonly def: Readonly<ShipClassDef>;
  /** Id triedy lode (`def.id`). */
  readonly classId: string;
  readonly cargoTypeId: string;
  /** Kategória nákladu (`cargo_types.json`) — určuje kompatibilné žeriavy. */
  readonly cargoCategory: CargoCategory;
  x: number;
  y: number;
  heading: Rotation;
  /** Obsadené kotviská v poradí po pobreží; mení ich `ShipSystem` spolu s `BerthModule.dockedShipId`. */
  berthIds: readonly EntityId[];
  anchorageIndex: number | null;
  waypointIndex: number;
  private currentRoute: readonly ShipPoint[];
  private current: ShipState;

  /**
   * Chyby (`ShipError('invalid_input')`): id nie je celé ≥ 1, poloha nie je konečné číslo, neplatný kurz alebo stav,
   * kategória nákladu nie je v `def.cargoCategories`, `anchorageIndex`/`waypointIndex` nie sú celé ≥ 0, duplicitné
   * kotvisko. Vzťahy k svetu (kotviská existujú, anchorage je v mape) overuje `ShipSystem` a loader save.
   */
  constructor(init: ShipInit) {
    const { id, def, cargoType, state, x, y, heading } = init;
    const label = `loď '${def.id}' #${String(id)}`;
    if (!Number.isSafeInteger(id) || id < 1) throw new ShipError('invalid_input', `${label}: id musí byť celé číslo ≥ 1`);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ShipError('invalid_input', `${label}: poloha (${String(x)}, ${String(y)}) musí byť konečné čísla`);
    if (!isRotation(heading)) throw new ShipError('invalid_input', `${label}: kurz musí byť 0, 90, 180 alebo 270, dostal ${String(heading)}`);
    if (!SHIP_TRANSITIONS.has(state)) throw new ShipError('invalid_input', `${label}: neznámy stav '${String(state)}'`);
    if (!def.cargoCategories.includes(cargoType.category)) {
      throw new ShipError('invalid_input', `${label}: náklad '${cargoType.id}' (kategória '${cargoType.category}') trieda neprevezie`);
    }
    const berthIds = init.berthIds ?? NO_BERTHS;
    if (new Set(berthIds).size !== berthIds.length) throw new ShipError('invalid_input', `${label}: duplicitné kotvisko v berthIds [${berthIds.join(', ')}]`);
    const anchorageIndex = init.anchorageIndex ?? null;
    if (anchorageIndex !== null && !isNonNegativeInteger(anchorageIndex)) {
      throw new ShipError('invalid_input', `${label}: anchorageIndex musí byť null alebo celé číslo ≥ 0`);
    }
    const waypointIndex = init.waypointIndex ?? 0;
    if (!isNonNegativeInteger(waypointIndex)) throw new ShipError('invalid_input', `${label}: waypointIndex musí byť celé číslo ≥ 0`);
    const route = init.route ?? NO_ROUTE;
    for (const point of route) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || (point.heading !== undefined && !isRotation(point.heading))) {
        throw new ShipError('invalid_input', `${label}: bod trasy (${String(point.x)}, ${String(point.y)}) musí mať konečné súradnice a platný kurz`);
      }
    }
    if (waypointIndex > route.length) throw new ShipError('invalid_input', `${label}: waypointIndex ${String(waypointIndex)} je za koncom trasy (${String(route.length)} bodov)`);

    this.id = id;
    this.def = def;
    this.classId = def.id;
    this.cargoTypeId = cargoType.id;
    this.cargoCategory = cargoType.category;
    this.current = state;
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.berthIds = berthIds.length === 0 ? NO_BERTHS : Object.freeze([...berthIds]);
    this.anchorageIndex = anchorageIndex;
    this.waypointIndex = waypointIndex;
    this.currentRoute = frozenRoute(route);
  }

  /** Trasa aktuálneho stavu (zmrazená); mení ju len `transition`. */
  get route(): readonly ShipPoint[] {
    return this.currentRoute;
  }

  /** Aktuálny stav FSM. */
  get state(): ShipState {
    return this.current;
  }

  /** Popis do chybových správ: `feeder #3`. */
  get label(): string {
    return `${this.classId} #${String(this.id)}`;
  }

  /**
   * Prechod stavu podľa `SHIP_TRANSITIONS` (jediné miesto, kde sa stav mení); začne novú trasu `route`
   * (`waypointIndex = 0`). Nepovolený prechod → `ShipError('invalid_transition')`, loď sa nezmení.
   */
  transition(to: ShipState, route: readonly ShipPoint[] = NO_ROUTE): void {
    if (!isShipTransitionAllowed(this.current, to)) {
      const allowed = SHIP_TRANSITIONS.get(this.current) ?? [];
      throw new ShipError('invalid_transition', `${this.label}: prechod ${this.current} → ${to} nie je povolený (povolené: ${allowed.join(', ') || '–'})`);
    }
    this.current = to;
    this.waypointIndex = 0;
    this.currentRoute = frozenRoute(route);
  }

  /** Čistý JSON stav pre save (nová kópia pri každom volaní). */
  toState(): SerializedShip {
    return {
      id: this.id,
      classId: this.classId,
      cargoTypeId: this.cargoTypeId,
      state: this.current,
      x: this.x,
      y: this.y,
      heading: this.heading,
      berthIds: [...this.berthIds],
      anchorageIndex: this.anchorageIndex,
      waypointIndex: this.waypointIndex,
      route: this.currentRoute.map(serializeShipPoint),
    };
  }
}
