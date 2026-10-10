/**
 * Kĺbový nosič po stope (R1, ADR-037, TERMINAL_2 §7.3 a §7.10): čistá geometria bez Pixi.
 *
 * Sim vedie nosič ako hlavu (`x`, `y`) a stopu `body` (stredy buniek od hlavy k chvostu, bez hlavy). Renderer z toho zloží lomenú
 * čiaru `[hlava, ...body]` (os cesty) a sprite nesie po nej:
 *  - **natočenie** je smer tetivy od bodu vo vzdialenosti `min(lengthCells, dĺžka čiary)` späť po čiare k hlave — v zákrute sa
 *    sprite láme plynulo, ako ho chvost prechádza cez roh;
 *  - **predok** spritu je presne pri hlave a **stred** je o polovicu dĺžky spritu späť v smere natočenia (na rovine je to stred
 *    na lomenej čiare; v zákrute kabína ostáva v pruhu a náves sa stáča k chvostu — stred na čiare by kabínu vytlačil z cesty;
 *    krátka stopa po výjazde z modulu sa tak „rozvinie“ spoza hlavy);
 *  - **zložená stopa** (otočka na slepej ceste): keď čiara zalomí o viac než 120° (`FOLD_DOT`), tetiva ukazuje opačne než ide hlava
 *    (chvost je ešte pred slepou bunkou, hlava už von). Natočenie sa potom z uhla tetivy plynule otočí do kurzu hlavy
 *    (`fallbackAngle`) proti smeru hodinových ručičiek (ľavá otočka: vjazd v pravom pruhu, výjazd v druhom) na dráhe `TURN_CELLS`
 *    od zalomenia;
 *  - **pruh**: stred spritu sa posunie doprava od smeru tetivy o šírku pruhu (`shiftRight`); posun sa pri zmene typu cesty
 *    plynulo mieša (`blendedLaneMagnitude`).
 *
 * `trailAt` doplňa interpoláciu medzi tickmi: hlava ide po ceste `prev → [koleno] → curr`, stredy buniek, ktoré hlava v tomto
 * ticku ešte nedosiahla, sa zo stopy vynechajú (inak by čiara cúvala dopredu).
 *
 * Súradnice sú v bunkách (stred bunky = `x + 0,5`), uhly v stupňoch v smere hodinových ručičiek (0 = sever hore).
 */
import type { Point } from './camera';

/** Tolerancia porovnania súradníc (bunky): stredy buniek sú presné, rezerva pre ručné VM. */
const EPSILON = 1e-6;

/** Tolerancia, s ktorou je stred bunky stopy „na ceste“ hlavy (bunky). */
const ON_PATH_TOLERANCE = 1e-3;

/** Skalárny súčin smerov dvoch za sebou idúcich úsekov čiary, pod ktorým ide o zalomenie vlásenky (> 120°); zákruta o 90° má 0. */
export const FOLD_DOT = -0.5;

/** Dráha od zalomenia vlásenky (bunky), na ktorej sa natočenie sprite otočí z uhla tetivy do kurzu hlavy. */
export const TURN_CELLS = 1;

/** Najkratšia cesta po čiare (bunky), od ktorej má smer tetivy zmysel; kratšia čiara používa `fallbackAngle`. */
const MIN_CHORD_CELLS = 1e-3;

const TO_RADIANS = Math.PI / 180;

/** Uhol normalizovaný do [0, 360). */
function normalize(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** Jednotkový vektor „dopredu“ pre uhol (0 = sever = (0; −1), 90 = východ = (1; 0)). */
export function forwardOfAngle(angle: number): Point {
  const radians = angle * TO_RADIANS;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

/** Uhol smeru `(dx, dy)` (y smeruje nadol): sever 0, východ 90, juh 180, západ 270. */
export function angleOfDirection(dx: number, dy: number): number {
  return normalize(Math.atan2(dx, -dy) / TO_RADIANS);
}

/** Dĺžka lomenej čiary (bunky). */
export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

/**
 * Bod vo vzdialenosti `distance` od začiatku lomenej čiary. Pred začiatkom (`distance` ≤ 0) je to prvý bod; za koncom čiara
 * pokračuje v smere `beyond` (jednotkový vektor), takže sprite dlhší než stopa nie je zalomený do hlavy.
 */
export function pointAlong(points: readonly Point[], distance: number, beyond: Point): Point {
  if (points.length === 0) throw new RangeError('pointAlong: prázdna lomená čiara');
  if (distance <= 0) return points[0];
  let rest = distance;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (rest <= length && length > EPSILON) {
      const share = rest / length;
      return { x: a.x + (b.x - a.x) * share, y: a.y + (b.y - a.y) * share };
    }
    rest -= length;
  }
  const last = points[points.length - 1];
  return { x: last.x + beyond.x * rest, y: last.y + beyond.y * rest };
}

/** Póza v bunkách: stred spritu na osi cesty (bez posunu pruhu) a natočenie. */
export interface ArticulatedPose {
  readonly x: number;
  readonly y: number;
  /** Uhol v stupňoch v smere hodinových ručičiek (0 = predok na sever), [0, 360). */
  readonly angle: number;
  /** Stopa je zložená (vlásenka): natočenie sa otáča z tetivy do `fallbackAngle`; inak je z tetivy (alebo z `fallbackAngle` pri krátkej stope). */
  readonly folded: boolean;
}

/** Vzdialenosť od hlavy po prvé zalomenie vlásenky (viď `FOLD_DOT`), alebo `null`, ak čiara nezalamuje. Nulové úseky sa preskakujú. */
function foldDistance(line: readonly Point[]): number | null {
  let done = 0;
  let previous: Point | null = null;
  for (let i = 1; i < line.length; i++) {
    const dx = line[i].x - line[i - 1].x;
    const dy = line[i].y - line[i - 1].y;
    const length = Math.hypot(dx, dy);
    if (length < EPSILON) continue;
    const direction = { x: dx / length, y: dy / length };
    if (previous !== null && previous.x * direction.x + previous.y * direction.y < FOLD_DOT) return done;
    previous = direction;
    done += length;
  }
  return null;
}

/**
 * Póza kĺbového nosiča (viď hlavička): `head` = poloha hlavy, `body` = stredy buniek stopy od hlavy k chvostu, `lengthCells` =
 * dĺžka nosiča v bunkách, `spriteLengthCells` = dĺžka spritu v bunkách, `fallbackAngle` = kurz hlavy (pre prázdnu alebo zloženú stopu).
 */
export function articulatedPose(
  head: Point,
  body: readonly Point[],
  lengthCells: number,
  spriteLengthCells: number,
  fallbackAngle: number,
): ArticulatedPose {
  const line = [head, ...body];
  const total = polylineLength(line);
  const chordCells = Math.min(Math.max(lengthCells, 0), total);
  const heading = normalize(fallbackAngle);
  let angle = heading;
  if (chordCells >= MIN_CHORD_CELLS) {
    const tail = pointAlong(line, chordCells, forwardOfAngle(heading + 180));
    const dx = head.x - tail.x;
    const dy = head.y - tail.y;
    if (Math.hypot(dx, dy) >= EPSILON) angle = angleOfDirection(dx, dy);
  }
  const fold = foldDistance(line);
  if (fold !== null) angle = normalize(angle - Math.min(1, fold / TURN_CELLS) * normalize(angle - heading));
  const back = forwardOfAngle(angle + 180);
  const center = { x: head.x + back.x * (spriteLengthCells / 2), y: head.y + back.y * (spriteLengthCells / 2) };
  return { x: center.x, y: center.y, angle, folded: fold !== null };
}

/** Bod posunutý doprava od smeru `angle` o `magnitude` bunky (pravý pruh; 0 = os cesty). */
export function shiftRight(point: Point, angle: number, magnitude: number): Point {
  if (magnitude === 0) return point;
  const radians = angle * TO_RADIANS;
  return { x: point.x + Math.cos(radians) * magnitude, y: point.y + Math.sin(radians) * magnitude };
}

/** Posun pruhu v bunkách pre bunku (x, y) — typ cesty pod ňou (`laneMagnitude(roadKindAt(x, y))`). */
export type LaneMagnitudeAt = (cellX: number, cellY: number) => number;

/**
 * Posun pruhu v bode `point` pre nosič idúci smerom `angle`: v strede bunky je to posun jej typu cesty, k hranici s ďalšou
 * (alebo predchádzajúcou) bunkou sa lineárne približuje k priemeru oboch — na hranici nie je skok pri zmene typu cesty
 * (dvojpruhová ↔ jednopruhová). Smer sa zaokrúhľuje na hlavnú os.
 */
export function blendedLaneMagnitude(point: Point, angle: number, magnitudeAt: LaneMagnitudeAt): number {
  const forward = forwardOfAngle(angle);
  const horizontal = Math.abs(forward.x) >= Math.abs(forward.y);
  const sign = (horizontal ? forward.x : forward.y) >= 0 ? 1 : -1;
  const cellX = Math.floor(point.x);
  const cellY = Math.floor(point.y);
  const along = ((horizontal ? point.x - (cellX + 0.5) : point.y - (cellY + 0.5)) * sign);
  const here = magnitudeAt(cellX, cellY);
  const step = along >= 0 ? sign : -sign;
  const other = horizontal ? magnitudeAt(cellX + step, cellY) : magnitudeAt(cellX, cellY + step);
  return here + (other - here) * Math.abs(along);
}

/** Hlava a stopa po interpolácii medzi tickmi: stopa bez stredov buniek, ktoré hlava ešte nedosiahla. */
export interface InterpolatedTrail {
  readonly head: Point;
  readonly body: readonly Point[];
}

/** Cesta hlavy v ticku: `prev → curr`, alebo `prev → koleno → curr`, keď sa menia obe súradnice (hlava prešla stredom zákruty). */
function tickPath(prev: Point, curr: Point, body: readonly Point[], prevVertical: boolean): readonly Point[] {
  if (Math.abs(curr.x - prev.x) < EPSILON || Math.abs(curr.y - prev.y) < EPSILON) return [prev, curr];
  const verticalFirst: Point = { x: prev.x, y: curr.y };
  const horizontalFirst: Point = { x: curr.x, y: prev.y };
  const inBody = (cell: Point): boolean => body.slice(0, 2).some((b) => Math.hypot(b.x - cell.x, b.y - cell.y) < ON_PATH_TOLERANCE);
  let knee: Point;
  if (inBody(verticalFirst) !== inBody(horizontalFirst)) knee = inBody(verticalFirst) ? verticalFirst : horizontalFirst;
  else knee = prevVertical ? verticalFirst : horizontalFirst;
  return [prev, knee, curr];
}

/** Vzdialenosť bodu od začiatku cesty, ak na nej leží (v tolerancii), inak `null`. */
function distanceAlong(path: readonly Point[], point: Point): number | null {
  let done = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < EPSILON) {
      if (Math.hypot(point.x - a.x, point.y - a.y) < ON_PATH_TOLERANCE) return done;
    } else {
      const share = ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / (length * length);
      const onX = a.x + (b.x - a.x) * share;
      const onY = a.y + (b.y - a.y) * share;
      const within = share >= -ON_PATH_TOLERANCE / length && share <= 1 + ON_PATH_TOLERANCE / length;
      if (within && Math.hypot(point.x - onX, point.y - onY) < ON_PATH_TOLERANCE) return done + Math.min(Math.max(share, 0), 1) * length;
    }
    done += length;
  }
  return null;
}

/**
 * Hlava v čase `alpha` (0…1) medzi tickmi `prev` a `curr` a stopa `body` z aktuálneho ticku. Hlava ide po ceste ticku (rovno, alebo
 * cez koleno zákruty, ktoré určí stopa, inak `prevVertical`); stredy buniek stopy, ktoré hlava v čase `alpha` ešte nedosiahla,
 * sa vynechajú.
 */
export function trailAt(prev: Point, curr: Point, body: readonly Point[], alpha: number, prevVertical = false): InterpolatedTrail {
  const path = tickPath(prev, curr, body, prevVertical);
  const distance = Math.min(1, Math.max(0, alpha)) * polylineLength(path);
  const head = pointAlong(path, distance, { x: 0, y: 0 });
  let skip = 0;
  while (skip < body.length) {
    const at = distanceAlong(path, body[skip]);
    if (at === null || at <= distance + ON_PATH_TOLERANCE) break;
    skip++;
  }
  return { head, body: skip === 0 ? body : body.slice(skip) };
}
