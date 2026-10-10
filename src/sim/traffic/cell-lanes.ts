/**
 * Druh bunky z hľadiska pruhových slotov (ADR-037, rozhodnutia orchestrátora R1 č. 1, 2 a 6) a úseky `one_lane`.
 *
 * - **Jazdný sused** bunky: bunka s cestou (`road === 'road'`, ľubovoľný typ), z ktorej alebo do ktorej je krok povolený
 *   (`isRoadStepAllowed`; dve rovnobežné jednosmerky vedľa seba teda nie sú navzájom susedia — ADR-037 dodatok R1, jednosmerný
 *   prístav), alebo bunka jazdného nábrežia kotviska (`QuayLanes`, ADR-033 dodatok). Koľaj nie.
 * - **Druh bunky** (`CellLaneKind`): cestná bunka s ≥ 3 jazdnými susedmi je `junction` (1 slot); inak `two_lane`
 *   (2 sloty, pruh podľa strany vjazdu) pre cestu typu `two_lane`, `single` (1 slot) pre `one_lane` a `one_way`;
 *   bunka nábrežia je `single`; ostatné bunky `none`.
 * - **Konce** `two_lane` bunky: smery (N = 0, E = 1, S = 2, W = 3) k jazdným susedom, `end0 < end1`; slepá bunka má
 *   jediný koniec `end0`, izolovaná žiadny.
 * - **Úsek `one_lane`**: maximálny súvislý reťazec buniek `one_lane` typu `single` (nie križovatiek) usporiadaný od jedného
 *   konca (pozícia 0) k druhému. Nosič ho obsadzuje smerom (`TrafficGate`).
 *
 * `CellLanes` je odvodená cache (nie je v save): prepočíta sa pri najbližšom čítaní po zmene `roadVersion` alebo
 * `moduleVersion` sveta. Čítanie nealokuje.
 */
import type { QuayCells } from '../logistics/pathfinder';
import { DIRECTIONS_4, type Cell } from '../grid/grid';
import { isRoadStepAllowed } from '../grid/road-direction';

export type CellLaneKind = 'two_lane' | 'single' | 'junction' | 'none';

/** Číselné kódy druhov v `Uint8Array` (poradie nie je v save). */
const KIND_CODES = { none: 0, two_lane: 1, single: 2, junction: 3 } as const;
const KIND_BY_CODE: readonly CellLaneKind[] = ['none', 'two_lane', 'single', 'junction'];

/** Strana bunky: smer k susedovi (N = 0, E = 1, S = 2, W = 3); `NO_SIDE` = žiadna. */
export type Side = 0 | 1 | 2 | 3;
export const NO_SIDE = -1;

/** Bez konca / bez suseda v `Int8Array` a poliach reťazcov. */
const NONE = -1;

/** Časť sveta, ktorú `CellLanes` číta (`World` ju spĺňa). */
export interface CellLaneSource {
  readonly grid: { readonly width: number; readonly height: number; readonly cellCount: number; atIndex(index: number): Readonly<Cell> };
  readonly quay: QuayCells;
  readonly roadVersion: number;
  readonly moduleVersion: number;
}

/**
 * Strana bunky `a`, na ktorej leží susedná bunka `b` (N = 0, E = 1, S = 2, W = 3), inak `NO_SIDE`. Susednosť sa posudzuje
 * podľa rozdielu indexov (platná trasa ide vždy po susedných bunkách).
 */
export function sideBetween(width: number, a: number, b: number): number {
  const delta = b - a;
  if (delta === -width) return 0;
  if (delta === 1) return 1;
  if (delta === width) return 2;
  if (delta === -1) return 3;
  return NO_SIDE;
}

export class CellLanes {
  private readonly kinds: Uint8Array;
  private readonly firstEnd: Int8Array;
  private readonly secondEnd: Int8Array;
  private readonly segmentIds: Int32Array;
  private readonly positions: Int32Array;
  private segments: Int32Array[] = [];
  private roadSeen = Number.NaN;
  private moduleSeen = Number.NaN;

  constructor(private readonly source: CellLaneSource) {
    const n = source.grid.cellCount;
    this.kinds = new Uint8Array(n);
    this.firstEnd = new Int8Array(n);
    this.secondEnd = new Int8Array(n);
    this.segmentIds = new Int32Array(n);
    this.positions = new Int32Array(n);
  }

  /** Druh bunky; po zmene siete alebo modulov sa najprv prepočíta. */
  kindOf(cell: number): CellLaneKind {
    this.refresh();
    return KIND_BY_CODE[this.kinds[cell]];
  }

  /** Je bunka križovatka? */
  isJunction(cell: number): boolean {
    this.refresh();
    return this.kinds[cell] === KIND_CODES.junction;
  }

  /** Prvý koniec `two_lane` bunky (menší smer), `NO_SIDE` bez konca. */
  end0(cell: number): number {
    this.refresh();
    return this.firstEnd[cell];
  }

  /** Druhý koniec `two_lane` bunky (väčší smer), `NO_SIDE` pri slepej bunke. */
  end1(cell: number): number {
    this.refresh();
    return this.secondEnd[cell];
  }

  /** Id úseku `one_lane` (od 1), ktorého súčasťou bunka je; 0 = bunka nie je v úseku. */
  segmentOf(cell: number): number {
    this.refresh();
    return this.segmentIds[cell];
  }

  /** Pozícia bunky v úseku (0 … dĺžka − 1); platí len pre bunku v úseku. */
  positionOf(cell: number): number {
    this.refresh();
    return this.positions[cell];
  }

  /** Bunky úseku `segment` (od 1) v poradí od pozície 0. */
  cellsOfSegment(segment: number): Int32Array {
    this.refresh();
    return this.segments[segment - 1];
  }

  /** Počet úsekov `one_lane` (diagnostika, testy). */
  get segmentCount(): number {
    this.refresh();
    return this.segments.length;
  }

  /**
   * Smer jazdy po úseku pri vstupe do bunky `to` z bunky `from`: `+1` (rastúca pozícia) alebo `-1`. Z bunky toho istého
   * úseku podľa rozdielu pozícií; zvonka podľa konca úseku (pozícia 0 → `+1`, posledná → `-1`, jednobunkový úsek podľa
   * strany: koniec `end0` bunky je `+1`).
   */
  entryDirection(width: number, to: number, from: number): 1 | -1 {
    this.refresh();
    const segment = this.segmentIds[to];
    if (segment !== 0 && this.segmentIds[from] === segment) return this.positions[to] > this.positions[from] ? 1 : -1;
    const length = this.segments[segment - 1].length;
    if (length === 1) return sideBetween(width, to, from) === this.firstEnd[to] ? 1 : -1;
    return this.positions[to] === 0 ? 1 : -1;
  }

  /** Prepočíta cache, ak sa od posledného prepočtu zmenila cestná sieť alebo množina modulov. */
  private refresh(): void {
    const { roadVersion, moduleVersion } = this.source;
    if (roadVersion === this.roadSeen && moduleVersion === this.moduleSeen) return;
    this.roadSeen = roadVersion;
    this.moduleSeen = moduleVersion;
    this.rebuildKinds();
    this.rebuildSegments();
  }

  private isDriving(index: number, owners: Readonly<Int32Array>): boolean {
    return this.source.grid.atIndex(index).road === 'road' || owners[index] !== 0;
  }

  /**
   * Je bunka `other` (v smere `d` od bunky `index` s cestou) jazdný sused? Cestná bunka len pri povolenom kroku v niektorom smere
   * (jednosmerky vedľa seba sa nespájajú); bunka jazdného nábrežia vždy.
   */
  private isNeighbor(index: number, other: number, d: number, owners: Readonly<Int32Array>): boolean {
    const { grid } = this.source;
    const to = grid.atIndex(other);
    const { quay } = this.source;
    const opposite = (d + 2) % 4;
    const laneOk = quay.stepAllowed === undefined || quay.stepAllowed(index, other, d) || quay.stepAllowed(other, index, opposite);
    if (to.road !== 'road') return owners[other] !== 0 && laneOk;
    const from = grid.atIndex(index);
    return laneOk && (isRoadStepAllowed(from, to, DIRECTIONS_4[d].name) || isRoadStepAllowed(to, from, DIRECTIONS_4[opposite].name));
  }

  private rebuildKinds(): void {
    const { grid, quay } = this.source;
    const { width, height, cellCount } = grid;
    const owners = quay.owners();
    for (let i = 0; i < cellCount; i++) {
      this.firstEnd[i] = NONE;
      this.secondEnd[i] = NONE;
      const cell = grid.atIndex(i);
      if (cell.road !== 'road') {
        this.kinds[i] = owners[i] !== 0 ? KIND_CODES.single : KIND_CODES.none;
        continue;
      }
      const x = i % width;
      const y = (i - x) / width;
      let count = 0;
      let first: number = NONE;
      let second: number = NONE;
      for (let d = 0; d < DIRECTIONS_4.length; d++) {
        const nx = x + DIRECTIONS_4[d].dx;
        const ny = y + DIRECTIONS_4[d].dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !this.isNeighbor(i, ny * width + nx, d, owners)) continue;
        if (count === 0) first = d;
        else if (count === 1) second = d;
        count += 1;
      }
      if (count >= 3) {
        this.kinds[i] = KIND_CODES.junction;
      } else if (cell.roadKind === 'two_lane') {
        this.kinds[i] = KIND_CODES.two_lane;
        this.firstEnd[i] = first;
        this.secondEnd[i] = second;
      } else {
        this.kinds[i] = KIND_CODES.single;
      }
    }
  }

  /** Je bunka súčasťou úseku (cesta `one_lane`, nie križovatka)? */
  private isSegmentCell(index: number): boolean {
    const cell = this.source.grid.atIndex(index);
    return cell.road === 'road' && cell.roadKind === 'one_lane' && this.kinds[index] === KIND_CODES.single;
  }

  /** Susedia v reťazci úseku (najviac 2); nepoužité miesto `NONE`. */
  private chainNeighbors(index: number, out: Int32Array): void {
    const { width, height } = this.source.grid;
    const x = index % width;
    const y = (index - x) / width;
    out[0] = NONE;
    out[1] = NONE;
    let n = 0;
    if (y > 0 && this.isSegmentCell(index - width)) out[n++] = index - width;
    if (x + 1 < width && this.isSegmentCell(index + 1) && n < 2) out[n++] = index + 1;
    if (y + 1 < height && this.isSegmentCell(index + width) && n < 2) out[n++] = index + width;
    if (x > 0 && this.isSegmentCell(index - 1) && n < 2) out[n] = index - 1;
  }

  private rebuildSegments(): void {
    const n = this.source.grid.cellCount;
    this.segmentIds.fill(0);
    this.segments = [];
    const neighbors = new Int32Array(2);
    const placed = new Uint8Array(n);
    for (let start = 0; start < n; start++) {
      if (placed[start] !== 0 || !this.isSegmentCell(start)) continue;
      // Najprv nájdi koniec reťazca (alebo uzavretý cyklus): choď jedným smerom, kým sa dá.
      let end = start;
      let previous: number = NONE;
      for (;;) {
        this.chainNeighbors(end, neighbors);
        const next = neighbors[0] !== previous && neighbors[0] !== NONE ? neighbors[0] : neighbors[1] !== previous ? neighbors[1] : NONE;
        if (next === NONE || next === start) break;
        previous = end;
        end = next;
      }
      // Potom prejdi reťazec od konca a očísluj bunky.
      const order: number[] = [];
      let cursor = end;
      previous = NONE;
      while (cursor !== NONE && placed[cursor] === 0) {
        placed[cursor] = 1;
        order.push(cursor);
        this.chainNeighbors(cursor, neighbors);
        const next = neighbors[0] !== previous && neighbors[0] !== NONE ? neighbors[0] : neighbors[1] !== previous ? neighbors[1] : NONE;
        previous = cursor;
        cursor = next;
      }
      const id = this.segments.length + 1;
      order.forEach((cell, position) => {
        this.segmentIds[cell] = id;
        this.positions[cell] = position;
      });
      this.segments.push(Int32Array.from(order));
    }
  }
}
