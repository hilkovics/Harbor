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
 */
import type { Rotation } from '../grid/rotation';
import { segmentHeading, shipBox, type CellBox, type ShipDimensions, type ShipPoint } from './ship-route';

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

/** Oblasť zabratých buniek: zjednotenie obdĺžnikov. Znovupoužiteľná (`clear`). */
export class TrafficArea {
  readonly boxes: CellBox[] = [];

  add(box: CellBox): void {
    this.boxes.push(box);
  }

  clear(): void {
    this.boxes.length = 0;
  }

  get size(): number {
    return this.boxes.length;
  }
}

/** Prekrývajú sa dva obdĺžniky buniek (majú spoločnú bunku)? */
export function boxesOverlap(a: CellBox, b: CellBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Obal dvoch obdĺžnikov. */
function hull(a: CellBox, b: CellBox): CellBox {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/** Prekrýva sa obdĺžnik s niektorým obdĺžnikom oblasti? */
export function boxHitsArea(box: CellBox, area: TrafficArea): boolean {
  for (const other of area.boxes) if (boxesOverlap(box, other)) return true;
  return false;
}

/** Prekrývajú sa dve oblasti (majú spoločnú bunku)? */
export function areasOverlap(a: TrafficArea, b: TrafficArea): boolean {
  for (const box of a.boxes) if (boxHitsArea(box, b)) return true;
  return false;
}

/**
 * Pridá do `area` bunky, ktoré loď s rozmermi `dims` zaberie cestou z pózy `start` po bodoch `points`, a vráti
 * koncovú pózu. Poloha v `start` sa pridá tiež (aj pri prázdnej trase).
 */
export function sweepRoute(area: TrafficArea, dims: ShipDimensions, start: ShipPose, points: readonly ShipPoint[]): ShipPose {
  let pose = start;
  area.add(shipBox(dims, pose.x, pose.y, pose.heading));
  for (const point of points) {
    const dx = point.x - pose.x;
    const dy = point.y - pose.y;
    const heading = segmentHeading(point, dx, dy) ?? pose.heading;
    let previous = shipBox(dims, pose.x, pose.y, heading);
    if (heading !== pose.heading) area.add(previous);
    if (dx === 0 || dy === 0) {
      if (dx !== 0 || dy !== 0) area.add(hull(previous, shipBox(dims, point.x, point.y, heading)));
    } else {
      const steps = Math.ceil(Math.sqrt(dx * dx + dy * dy) / SWEEP_STEP_CELLS);
      for (let k = 1; k <= steps; k++) {
        const current = k === steps ? shipBox(dims, point.x, point.y, heading) : shipBox(dims, pose.x + (dx * k) / steps, pose.y + (dy * k) / steps, heading);
        area.add(hull(previous, current));
        previous = current;
      }
    }
    pose = { x: point.x, y: point.y, heading };
  }
  return pose;
}
