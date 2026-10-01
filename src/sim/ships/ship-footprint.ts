/**
 * Zabraté bunky lodí (ARCHITECTURE §7.4; ADR-029) — geometria pre riadenie lodnej dopravy bez prekrývania: obdĺžnik
 * lode ako obdĺžnik buniek (`shipBox`, tie isté bunky ako `shipCells`), bunky, ktoré loď zaberie cestou po trase
 * (`sweepRoute`), a prekryv dvoch takých oblastí (`areasOverlap`). Výnimky z neprekrývania nie sú — ani lode
 * v opačných smeroch na sea lane sa neprekrývajú (ADR-029).
 *
 * Pohyb po trase je deterministický (ADR-016: úsečky, kurz podľa bodu trasy alebo dominantnej osi, bez trigonometrie),
 * preto sa dá zabratie spočítať vopred: na každom úseku loď najprv natočí kurz (obdĺžnik v začiatku úseku s novým
 * kurzom), potom sa posúva. Osový úsek zaberie presne obal obdĺžnikov v jeho koncoch; šikmý úsek sa vzorkuje po
 * `SWEEP_STEP_CELLS` a pridá sa obal každých dvoch susedných vzoriek — obdĺžnik pri posune medzi vzorkami leží celý
 * v tomto obale (posun je lineárny, kurz sa na úseku nemení), takže výpočet nikdy nepodhodnotí skutočné zabratie.
 *
 * **Bez alokácií** (review T5B-04b, ADR-021): rezervácie ostatných lodí sa prepočítavajú pri každom pokuse o rezerváciu
 * (krok 3, každý tick), preto `TrafficArea` drží obdĺžniky v typovanom poli (znovupoužiteľné, `clear`) a `sweepRoute`
 * počíta hranice v skalároch; trasu číta od indexu (`startIndex`, bez `slice`) a koncovú pózu zapíše do `end`.
 */
import type { Rotation } from '../grid/rotation';
import { segmentHeading, shipExtentX, shipExtentY, type CellBox, type ShipDimensions, type ShipPoint } from './ship-route';

/**
 * Krok vzorkovania šikmého úseku trasy (bunky). Štrukturálna hranica presnosti výpočtu zabratých buniek, nie balans:
 * menší krok = tesnejší (menej konzervatívny) obal za cenu viac obdĺžnikov; výsledok je konzervatívny pri každom kroku.
 */
export const SWEEP_STEP_CELLS = 0.5;

/** Poloha a kurz lode. */
export interface ShipPose {
  readonly x: number;
  readonly y: number;
  readonly heading: Rotation;
}

/** Meniteľná póza — výstup `sweepRoute` bez alokácie (`end`). */
export interface MutableShipPose {
  x: number;
  y: number;
  heading: Rotation;
}

/** Počet čísel na obdĺžnik v úložisku `TrafficArea` (x0, y0, x1, y1). */
const BOX_FIELDS = 4;

/** Počiatočná kapacita `TrafficArea` (obdĺžniky); pole sa zdvojnásobí, keď nestačí. Štrukturálna hodnota, nie balans. */
const INITIAL_BOX_CAPACITY = 16;

/**
 * Oblasť zabratých buniek: zjednotenie obdĺžnikov v typovanom poli `[x0, y0, x1, y1]…` (hranice sú celé čísla buniek,
 * aj záporné — loď na začiatku dráhy môže presahovať okraj mapy). Znovupoužiteľná (`clear`), pridanie obdĺžnika
 * nealokuje (okrem občasného zväčšenia poľa).
 */
export class TrafficArea {
  private data = new Int32Array(INITIAL_BOX_CAPACITY * BOX_FIELDS);
  private count = 0;

  /** Pridá obdĺžnik `[x0, x1) × [y0, y1)`. */
  addBounds(x0: number, y0: number, x1: number, y1: number): void {
    const offset = this.count * BOX_FIELDS;
    if (offset + BOX_FIELDS > this.data.length) {
      const grown = new Int32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[offset] = x0;
    this.data[offset + 1] = y0;
    this.data[offset + 2] = x1;
    this.data[offset + 3] = y1;
    this.count += 1;
  }

  add(box: CellBox): void {
    this.addBounds(box.x0, box.y0, box.x1, box.y1);
  }

  /** Pridá všetky obdĺžniky inej oblasti. */
  addArea(other: TrafficArea): void {
    const { data } = other;
    for (let i = 0; i < other.count * BOX_FIELDS; i += BOX_FIELDS) this.addBounds(data[i], data[i + 1], data[i + 2], data[i + 3]);
  }

  clear(): void {
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  /** Kópia obdĺžnikov (testy, diagnostika — alokuje; simulácia používa `hits`/`overlaps`). */
  get boxes(): CellBox[] {
    const boxes: CellBox[] = [];
    const { data } = this;
    for (let i = 0; i < this.count * BOX_FIELDS; i += BOX_FIELDS) boxes.push({ x0: data[i], y0: data[i + 1], x1: data[i + 2], y1: data[i + 3] });
    return boxes;
  }

  /** Prekrýva sa obdĺžnik `[x0, x1) × [y0, y1)` s niektorým obdĺžnikom oblasti? */
  hitsBounds(x0: number, y0: number, x1: number, y1: number): boolean {
    const { data } = this;
    for (let i = 0; i < this.count * BOX_FIELDS; i += BOX_FIELDS) {
      if (x0 < data[i + 2] && data[i] < x1 && y0 < data[i + 3] && data[i + 1] < y1) return true;
    }
    return false;
  }

  /** Prekrýva sa obdĺžnik s niektorým obdĺžnikom oblasti? */
  hits(box: CellBox): boolean {
    return this.hitsBounds(box.x0, box.y0, box.x1, box.y1);
  }

  /** Majú dve oblasti spoločnú bunku? */
  overlaps(other: TrafficArea): boolean {
    const { data } = this;
    for (let i = 0; i < this.count * BOX_FIELDS; i += BOX_FIELDS) {
      if (other.hitsBounds(data[i], data[i + 1], data[i + 2], data[i + 3])) return true;
    }
    return false;
  }
}

/** Prekrývajú sa dva obdĺžniky buniek (majú spoločnú bunku)? */
export function boxesOverlap(a: CellBox, b: CellBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Prekrýva sa obdĺžnik s niektorým obdĺžnikom oblasti? */
export function boxHitsArea(box: CellBox, area: TrafficArea): boolean {
  return area.hits(box);
}

/** Prekrývajú sa dve oblasti (majú spoločnú bunku)? */
export function areasOverlap(a: TrafficArea, b: TrafficArea): boolean {
  return a.overlaps(b);
}

/**
 * Obal obdĺžnikov lode s kurzom `heading` so stredmi (`ax`, `ay`) a (`bx`, `by`) — bunky, ktoré loď zaberie pri
 * osovom posune medzi nimi (= `hull(shipBox(a), shipBox(b))`, tie isté zaokrúhlenia ako `shipBox`).
 */
export function spanBox(dims: ShipDimensions, heading: Rotation, ax: number, ay: number, bx: number, by: number): CellBox {
  const w = shipExtentX(dims, heading);
  const h = shipExtentY(dims, heading);
  return {
    x0: Math.min(Math.floor(ax - w / 2), Math.floor(bx - w / 2)),
    y0: Math.min(Math.floor(ay - h / 2), Math.floor(by - h / 2)),
    x1: Math.max(Math.ceil(ax + w / 2), Math.ceil(bx + w / 2)),
    y1: Math.max(Math.ceil(ay + h / 2), Math.ceil(by + h / 2)),
  };
}

/** Pridá do oblasti obal obdĺžnikov lode v (`ax`, `ay`) a (`bx`, `by`) s kurzom `heading` (bez alokácie; viď `spanBox`). */
function addSpan(area: TrafficArea, dims: ShipDimensions, heading: Rotation, ax: number, ay: number, bx: number, by: number): void {
  const w = shipExtentX(dims, heading);
  const h = shipExtentY(dims, heading);
  area.addBounds(
    Math.min(Math.floor(ax - w / 2), Math.floor(bx - w / 2)),
    Math.min(Math.floor(ay - h / 2), Math.floor(by - h / 2)),
    Math.max(Math.ceil(ax + w / 2), Math.ceil(bx + w / 2)),
    Math.max(Math.ceil(ay + h / 2), Math.ceil(by + h / 2)),
  );
}

/**
 * Pridá do `area` bunky, ktoré loď s rozmermi `dims` zaberie cestou z pózy `start` po bodoch `points` od indexu
 * `startIndex`, a vráti koncovú pózu zapísanú do `end` (predvolene nový objekt; `end` smie byť ten istý objekt ako
 * `start`). Poloha v `start` sa pridá tiež (aj pri prázdnej trase).
 */
export function sweepRoute(
  area: TrafficArea,
  dims: ShipDimensions,
  start: ShipPose,
  points: readonly ShipPoint[],
  startIndex = 0,
  end: MutableShipPose = { x: start.x, y: start.y, heading: start.heading },
): ShipPose {
  let x = start.x;
  let y = start.y;
  let heading = start.heading;
  addSpan(area, dims, heading, x, y, x, y);
  for (let i = startIndex; i < points.length; i++) {
    const point = points[i];
    const dx = point.x - x;
    const dy = point.y - y;
    const next = segmentHeading(point, dx, dy) ?? heading;
    if (next !== heading) addSpan(area, dims, next, x, y, x, y);
    if (dx === 0 || dy === 0) {
      if (dx !== 0 || dy !== 0) addSpan(area, dims, next, x, y, point.x, point.y);
    } else {
      const steps = Math.ceil(Math.sqrt(dx * dx + dy * dy) / SWEEP_STEP_CELLS);
      let px = x;
      let py = y;
      for (let k = 1; k <= steps; k++) {
        const cx = k === steps ? point.x : x + (dx * k) / steps;
        const cy = k === steps ? point.y : y + (dy * k) / steps;
        addSpan(area, dims, next, px, py, cx, cy);
        px = cx;
        py = cy;
      }
    }
    x = point.x;
    y = point.y;
    heading = next;
  }
  end.x = x;
  end.y = y;
  end.heading = heading;
  return end;
}
