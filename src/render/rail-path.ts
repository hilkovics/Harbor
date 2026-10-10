/**
 * Hladká os koľají (R6): z buniek koľají (stredy buniek) sa postaví graf, každý 90° roh sa zaoblí veľkým oblúkom
 * `RAIL_CURVE_RADIUS_CELLS` (orezaným podľa voľného rovného úseku na oboch stranách) a výsledok je lomená čiara s kumulatívnou
 * dĺžkou. Z nej sa kreslia koľajnice a pražce a podľa nej sa kladú vozy vlaku. Čistý modul bez Pixi, deterministický.
 *
 * Uzly (bunky so stupňom ≠ 2: koniec, T, kríž; a rohy, kde nie je miesto na oblúk) ostávajú dlaždicami (`rail_*` sprity); cesta
 * pokrýva reťaz buniek medzi dvoma uzlami od hrany jednej uzlovej bunky po hranu druhej (jej vnútorné bunky = `cells`).
 */
import { BOGIE_HALF_CELLS, COUPLER_GAP_CELLS, RAIL_CURVE_RADIUS_CELLS, RAIL_TIGHT_RADIUS_CELLS } from './rail-config';

export interface Pt {
  x: number;
  y: number;
}

export interface RailPath {
  /** Vzorkovaná os (bunky), od začiatku po koniec. */
  readonly points: readonly Pt[];
  /** Kumulatívna dĺžka v bodoch (`cum[0] = 0`). */
  readonly cum: readonly number[];
  readonly length: number;
  /** Vnútorné bunky reťaze (kreslia sa procedurálne, dlaždica sa skryje), kľúče `x,y`. */
  readonly cells: readonly string[];
  /** Polomery zaoblených rohov (testy, ladenie). */
  readonly radii: readonly number[];
}

const EPS = 1e-9;
const DIRS: readonly Pt[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

export const cellKey = (x: number, y: number): string => `${String(x)},${String(y)}`;

/** Počet úsekov oblúka podľa polomeru (hladkosť bez zbytočných bodov). */
const arcSteps = (r: number): number => Math.min(32, Math.max(6, Math.ceil(r * 8)));

function makePath(points: Pt[], cells: string[], radii: number[]): RailPath {
  const pts: Pt[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (last === undefined || Math.hypot(p.x - last.x, p.y - last.y) > EPS) pts.push(p);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  return { points: pts, cum, length: cum[cum.length - 1] ?? 0, cells, radii };
}

interface Chain {
  /** Bunky od uzla po uzol (vrátane oboch uzlov). */
  readonly cells: readonly Pt[];
}

/** Zaoblí lomenú čiaru o rohoch (`vertices`: [začiatok, rohy…, koniec]); `radius` = požadovaný polomer. */
function roundPolyline(vertices: readonly Pt[], radius: number, cornerRoom: (i: number) => number): { points: Pt[]; radii: number[] } {
  const out: Pt[] = [vertices[0]!];
  const radii: number[] = [];
  for (let i = 1; i + 1 < vertices.length; i++) {
    const p = vertices[i - 1]!;
    const v = vertices[i]!;
    const n = vertices[i + 1]!;
    const lin = Math.hypot(v.x - p.x, v.y - p.y);
    const lout = Math.hypot(n.x - v.x, n.y - v.y);
    const t = Math.min(radius, cornerRoom(i), lin, lout);
    const u = { x: (v.x - p.x) / lin, y: (v.y - p.y) / lin };
    const w = { x: (n.x - v.x) / lout, y: (n.y - v.y) / lout };
    const a = { x: v.x - u.x * t, y: v.y - u.y * t };
    const c = { x: a.x + w.x * t, y: a.y + w.y * t };
    const steps = arcSteps(t);
    for (let k = 0; k <= steps; k++) {
      const phi = (Math.PI / 2) * (k / steps);
      out.push({ x: c.x - w.x * t * Math.cos(phi) + u.x * t * Math.sin(phi), y: c.y - w.y * t * Math.cos(phi) + u.y * t * Math.sin(phi) });
    }
    radii.push(t);
  }
  out.push(vertices[vertices.length - 1]!);
  return { points: out, radii };
}

/**
 * Postaví hladké cesty zo zoznamu buniek koľají. Zákruta bez miesta (dotyčnica ≤ tesný sprite) sa stáva uzlom (dlaždica).
 * @param radius požadovaný polomer oblúkov (bunky)
 */
export function buildRailPaths(rails: readonly { x: number; y: number }[], radius: number = RAIL_CURVE_RADIUS_CELLS): RailPath[] {
  const set = new Set(rails.map((c) => cellKey(c.x, c.y)));
  const neighbours = (c: Pt): Pt[] => DIRS.map((d) => ({ x: c.x + d.x, y: c.y + d.y })).filter((n) => set.has(cellKey(n.x, n.y)));
  const nodes = new Set<string>();
  for (const c of rails) if (neighbours(c).length !== 2) nodes.add(cellKey(c.x, c.y));
  const sorted = [...rails].sort((a, b) => a.y - b.y || a.x - b.x);

  for (let guard = 0; guard < 64; guard++) {
    const chains = collectChains(sorted, nodes, neighbours);
    let grew = false;
    for (const chain of chains) {
      const { corners, room } = cornerInfo(chain, radius);
      corners.forEach((cell, i) => {
        if (room[i]! <= RAIL_TIGHT_RADIUS_CELLS + EPS && !nodes.has(cellKey(cell.x, cell.y))) {
          nodes.add(cellKey(cell.x, cell.y));
          grew = true;
        }
      });
    }
    if (grew) continue;
    return chains.filter((chain) => chain.cells.length > 2).map((chain) => pathOfChain(chain, radius));
  }
  return [];
}

function collectChains(sorted: readonly Pt[], nodes: ReadonlySet<string>, neighbours: (c: Pt) => Pt[]): Chain[] {
  const chains: Chain[] = [];
  const used = new Set<string>(); // prvý krok hrany `odkiaľ>kam` už prejdený
  for (const start of sorted) {
    if (!nodes.has(cellKey(start.x, start.y))) continue;
    for (const first of neighbours(start)) {
      const edge = `${cellKey(start.x, start.y)}>${cellKey(first.x, first.y)}`;
      if (used.has(edge)) continue;
      const cells: Pt[] = [start, first];
      let prev = start;
      let cur = first;
      while (!nodes.has(cellKey(cur.x, cur.y))) {
        const next = neighbours(cur).find((n) => n.x !== prev.x || n.y !== prev.y);
        if (next === undefined) break;
        prev = cur;
        cur = next;
        cells.push(cur);
      }
      used.add(edge);
      used.add(`${cellKey(cur.x, cur.y)}>${cellKey(prev.x, prev.y)}`);
      chains.push({ cells });
    }
  }
  return chains;
}

/** Vrcholy lomenej čiary reťaze: hrana začiatočnej uzlovej bunky, rohy (stredy buniek), hrana koncovej uzlovej bunky. */
function chainVertices(chain: Chain): { vertices: Pt[]; corners: Pt[] } {
  const c = chain.cells;
  const first = c[0]!;
  const second = c[1]!;
  const last = c[c.length - 1]!;
  const beforeLast = c[c.length - 2]!;
  const vertices: Pt[] = [{ x: (first.x + second.x) / 2 + 0.5, y: (first.y + second.y) / 2 + 0.5 }];
  const corners: Pt[] = [];
  for (let i = 1; i + 1 < c.length; i++) {
    const a = c[i - 1]!;
    const b = c[i]!;
    const n = c[i + 1]!;
    if (b.x - a.x !== n.x - b.x || b.y - a.y !== n.y - b.y) {
      vertices.push({ x: b.x + 0.5, y: b.y + 0.5 });
      corners.push(b);
    }
  }
  vertices.push({ x: (last.x + beforeLast.x) / 2 + 0.5, y: (last.y + beforeLast.y) / 2 + 0.5 });
  return { vertices, corners };
}

/** Voľné miesto pre dotyčnicu rohu `i`: susedný roh dostane polovicu úseku, uzol celý úsek (po hranu uzlovej bunky). */
function roomOf(vertices: readonly Pt[], i: number): number {
  const side = (j: number): number => {
    const d = Math.hypot(vertices[i]!.x - vertices[j]!.x, vertices[i]!.y - vertices[j]!.y);
    return j === 0 || j === vertices.length - 1 ? d : d / 2;
  };
  return Math.min(side(i - 1), side(i + 1));
}

function cornerInfo(chain: Chain, radius: number): { corners: Pt[]; room: number[] } {
  const { vertices, corners } = chainVertices(chain);
  return { corners, room: corners.map((_, k) => Math.min(radius, roomOf(vertices, k + 1))) };
}

function pathOfChain(chain: Chain, radius: number): RailPath {
  const { vertices } = chainVertices(chain);
  const { points, radii } = roundPolyline(vertices, radius, (i) => roomOf(vertices, i));
  const cells = chain.cells.slice(1, -1).map((c) => cellKey(c.x, c.y));
  return makePath(points, cells, radii);
}

/** Bod a smer (jednotkový vektor) cesty vo vzdialenosti `s`; mimo cesty pokračuje priamo v smere koncového úseku. */
export function pointAt(path: RailPath, s: number): { point: Pt; dir: Pt } {
  const pts = path.points;
  const n = pts.length;
  if (n < 2) return { point: pts[0] ?? { x: 0, y: 0 }, dir: { x: 0, y: -1 } };
  let i = 0;
  if (s >= path.length) i = n - 2;
  else if (s > 0) {
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (path.cum[mid]! <= s) lo = mid;
      else hi = mid - 1;
    }
    i = lo;
  }
  const a = pts[i]!;
  const b = pts[i + 1]!;
  const len = path.cum[i + 1]! - path.cum[i]!;
  const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const along = s - path.cum[i]!;
  return { point: { x: a.x + dir.x * along, y: a.y + dir.y * along }, dir };
}

/** Najbližší bod cesty k `p`: vzdialenosť po ceste `s` a odchýlka `dist`. */
export function projectOnPath(path: RailPath, p: Pt): { s: number; dist: number } {
  let best = { s: 0, dist: Infinity };
  for (let i = 0; i + 1 < path.points.length; i++) {
    const a = path.points[i]!;
    const b = path.points[i + 1]!;
    const len = path.cum[i + 1]! - path.cum[i]!;
    const t = Math.max(0, Math.min(len, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len));
    const x = a.x + ((b.x - a.x) / len) * t;
    const y = a.y + ((b.y - a.y) / len) * t;
    const dist = Math.hypot(p.x - x, p.y - y);
    if (dist < best.dist - EPS) best = { s: path.cum[i]! + t, dist };
  }
  return best;
}

export interface CarPose {
  x: number;
  y: number;
  /** 0 = hore, v smere hodinových ručičiek (stupne). */
  angle: number;
  /** Predný a zadný podvozok (bunky) — oba ležia na osi koľaje. */
  front: Pt;
  rear: Pt;
}

/**
 * Pózy `count` vozov od hlavy: hlava má stred na `sHead`, ďalšie vozy idú proti smeru jazdy (`dir` = +1 ak jazda ide v smere rastúceho `s`)
 * s rozstupom `carLength + gap`. Každý voz má dva podvozky na osi koľaje (±`bogieHalf` od stredu po koľaji); stred voza je stred tetivy
 * medzi nimi a uhol je smer tetivy, takže voz v oblúku neodstáva z koľají.
 */
export function placeCars(
  path: RailPath,
  sHead: number,
  dir: 1 | -1,
  count: number,
  carLength: number,
  gap: number = COUPLER_GAP_CELLS,
  bogieHalf: number = BOGIE_HALF_CELLS,
): CarPose[] {
  return Array.from({ length: count }, (_, k) => {
    const centre = sHead - dir * k * (carLength + gap);
    const front = pointAt(path, centre + dir * bogieHalf).point;
    const rear = pointAt(path, centre - dir * bogieHalf).point;
    return {
      x: (front.x + rear.x) / 2,
      y: (front.y + rear.y) / 2,
      angle: (Math.atan2(front.x - rear.x, -(front.y - rear.y)) * 180) / Math.PI,
      front,
      rear,
    };
  });
}

/** Najbližšia cesta k bodu `p` (do `maxDist` bunky) s projekciou; `undefined`, ak žiadna nie je dosť blízko. */
export function nearestPath(paths: readonly RailPath[], p: Pt, maxDist: number): { path: RailPath; s: number } | undefined {
  let best: { path: RailPath; s: number; dist: number } | undefined;
  for (const path of paths) {
    const hit = projectOnPath(path, p);
    if (hit.dist <= maxDist && (best === undefined || hit.dist < best.dist)) best = { path, s: hit.s, dist: hit.dist };
  }
  return best === undefined ? undefined : { path: best.path, s: best.s };
}

/**
 * Pózy vlaku z pozícií, ktoré dal sim: hlava (voz 0) sa premietne na najbližšiu cestu, jej smer jazdy určí uhol hlavy; vozy sa rozložia po ceste.
 * Bez cesty v dosahu (`maxDist`) vráti `undefined` — volajúci použije pózy zo simu.
 */
export function trainPosesOnPaths(
  paths: readonly RailPath[],
  head: { x: number; y: number; angle: number },
  count: number,
  carLength: number,
  maxDist = 1,
): CarPose[] | undefined {
  const hit = nearestPath(paths, head, maxDist);
  if (hit === undefined) return undefined;
  const rad = (head.angle * Math.PI) / 180;
  const tangent = pointAt(hit.path, hit.s).dir;
  const dir = tangent.x * Math.sin(rad) + tangent.y * -Math.cos(rad) >= 0 ? 1 : -1;
  return placeCars(hit.path, hit.s, dir, count, carLength);
}
