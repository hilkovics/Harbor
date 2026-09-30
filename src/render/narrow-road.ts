/**
 * Úzke cesty (`one_lane`, `one_way`; docs/tasks/phase-03.md T03-19): geometria procedurálnej dlaždice bez Pixi.
 *
 * Sprity `road_*.svg` sú len pre dvojpruhovú cestu (asfalt 52 px). Úzka cesta má jeden pruh — asfalt `NARROW_ASPHALT_PX` (40 px,
 * x 12–52) — a kreslí sa procedurálne s rovnakým autotile tvarom a rotáciou (`end` hore, `straight` zvislá, `corner` N→E, `t` bez
 * juhu, `cross`), okrajom 2 px vo vnútri asfaltu, zaoblením 6 px v križovatkách a BEZ stredovej čiary. Rozmery sú
 * odvodené zo spritov (`tests/render/narrow-road.test.ts` ich porovnáva so SVG); súradnice sú v px zdroja (bunka 64 px),
 * kreslenie ich škáluje na `--cell`.
 *
 * **Spoj úzkej a širokej cesty:** sprite širokej dlaždice siaha na hranu bunky s plnou šírkou 52 px (x 6–58) v každom ramene.
 * Rameno úzkej dlaždice, ktorého sused je široká cesta, sa preto pri hrane rozšíri lievikom o hĺbke `FLARE_DEPTH_PX`
 * (45° zrezanie), takže asfalt na hrane lícuje so širokým susedom a úzka vetva sa napája do jeho stredu bez schodíka.
 *
 * Cesty sú zoznam operácií `PathOp` (M/L/A/Z), aby geometriu šlo testovať bez Pixi; `road-layer.ts` ich prekladá na
 * `GraphicsContext`.
 */
import { AUTOTILE_SHAPE_BASE_MASK, type AutotileShape } from './autotile';
import type { Point } from './camera';
import { MANIFEST_CELL_PX } from './entity-assets';
import { ROAD_ASPHALT_PX, VEHICLE_WIDTH_PX } from './lane';

/**
 * Šírka asfaltu úzkej cesty v px zdroja: vozidlo v jednotnej mierke (`VEHICLE_WIDTH_PX` = 48) s rezervou 4 px po stranách
 * presahuje okraj asfaltu (kolesá), ale cesta nie je užšia než 40 px — jeden pruh pôvodných 26 px by sa s vozidlami v mierke 1 : 1
 * nezmestil (F5b č. 10). Dvojpruhová cesta má 52 px, úzka je o 12 px užšia a nemá stredovú čiaru.
 */
export const NARROW_ASPHALT_PX = VEHICLE_WIDTH_PX - 8;

/** Šírka okraja (obrubníka) v px zdroja: `stroke-width` v `road_*.svg`. */
export const ROAD_EDGE_PX = 2;

/** Polomer zaoblenia vnútorných rohov križovatky v px zdroja (`A6 6` v `road_t.svg` a `road_cross.svg`). */
export const ROAD_FILLET_PX = 6;

/** Hĺbka lievika v rameni úzkej dlaždice, ktorá susedí so širokou cestou (px zdroja): rozdiel polšírok 52 a 40 px (6), 45° zrezanie. */
export const FLARE_DEPTH_PX = (ROAD_ASPHALT_PX - NARROW_ASPHALT_PX) / 2;

/** Operácia cesty; súradnice v px zdroja. Uhly oblúka sú ako v Pixi (od +x, v smere hodinových ručičiek pri osi y nadol). */
export type PathOp =
  | { readonly op: 'M' | 'L'; readonly x: number; readonly y: number }
  | { readonly op: 'A'; readonly cx: number; readonly cy: number; readonly r: number; readonly from: number; readonly to: number }
  | { readonly op: 'Z' };

/** Výplne (asfalt) a čiary (okraje) dlaždice; každá cesta je samostatná. */
export interface NarrowRoadPaths {
  readonly fills: readonly (readonly PathOp[])[];
  readonly strokes: readonly (readonly PathOp[])[];
}

const CELL = MANIFEST_CELL_PX;
const MID = CELL / 2;
const HALF = NARROW_ASPHALT_PX / 2;
/** Okraje asfaltu úzkej cesty a osi okrajových čiar (1 px dovnútra, stred čiary 2 px). */
const EDGE_LOW = MID - HALF;
const EDGE_HIGH = MID + HALF;
const LINE_LOW = EDGE_LOW + ROAD_EDGE_PX / 2;
const LINE_HIGH = EDGE_HIGH - ROAD_EDGE_PX / 2;
const FILLET = ROAD_FILLET_PX;
/** Polomer čiary okolo zaoblenia: o pol hrúbky čiary dnu od asfaltu. */
const FILLET_LINE = FILLET + ROAD_EDGE_PX / 2;
const HALF_PI = Math.PI / 2;

const TOLERANCE = 1e-9;

type Arm = 'n' | 'e' | 's' | 'w';
const ARMS: readonly Arm[] = ['n', 'e', 's', 'w'];
const ARM_BIT: Readonly<Record<Arm, number>> = { n: 1, e: 2, s: 4, w: 8 };

/** Cesta: pamätá si posledný bod, aby sa nevkladali nulové úsečky. */
class PathBuilder {
  readonly ops: PathOp[] = [];
  private lastX = Number.NaN;
  private lastY = Number.NaN;

  move(x: number, y: number): this {
    this.ops.push({ op: 'M', x, y });
    this.lastX = x;
    this.lastY = y;
    return this;
  }

  /** Úsečka do (x, y); nulová dĺžka sa vynechá. */
  line(x: number, y: number): this {
    if (Math.hypot(x - this.lastX, y - this.lastY) < TOLERANCE) return this;
    this.ops.push({ op: 'L', x, y });
    this.lastX = x;
    this.lastY = y;
    return this;
  }

  arc(cx: number, cy: number, r: number, from: number, to: number): this {
    this.ops.push({ op: 'A', cx, cy, r, from, to });
    this.lastX = cx + r * Math.cos(to);
    this.lastY = cy + r * Math.sin(to);
    return this;
  }

  close(): PathOp[] {
    this.ops.push({ op: 'Z' });
    return this.ops;
  }
}

/** Bod na kružnici. */
function onCircle(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

/** Otočí operácie o `quarterTurns` × 90° v smere hodinových ručičiek okolo stredu bunky. */
function rotateOps(ops: readonly PathOp[], quarterTurns: number): PathOp[] {
  const turn = (x: number, y: number): { x: number; y: number } => {
    let dx = x - MID;
    let dy = y - MID;
    for (let i = 0; i < quarterTurns; i++) [dx, dy] = [-dy, dx];
    return { x: MID + dx, y: MID + dy };
  };
  return ops.map((op): PathOp => {
    if (op.op === 'Z') return op;
    if (op.op === 'A') {
      const center = turn(op.cx, op.cy);
      return { ...op, cx: center.x, cy: center.y, from: op.from + quarterTurns * HALF_PI, to: op.to + quarterTurns * HALF_PI };
    }
    return { ...op, ...turn(op.x, op.y) };
  });
}

/** Hĺbka lievika v rameniach základnej orientácie (0 = bez lievika). */
type Cuts = Readonly<Record<Arm, number>>;

function straightPaths(cuts: Cuts): NarrowRoadPaths {
  const strokes = [LINE_LOW, LINE_HIGH].map((x) => new PathBuilder().move(x, cuts.n).line(x, CELL - cuts.s).ops);
  const fill = new PathBuilder().move(EDGE_LOW, 0).line(EDGE_HIGH, 0).line(EDGE_HIGH, CELL).line(EDGE_LOW, CELL).close();
  return { fills: [fill], strokes };
}

function endPaths(cuts: Cuts): NarrowRoadPaths {
  const fill = new PathBuilder()
    .move(EDGE_LOW, 0)
    .line(EDGE_HIGH, 0)
    .line(EDGE_HIGH, MID)
    .arc(MID, MID, HALF, 0, Math.PI)
    .close();
  const stroke = new PathBuilder()
    .move(LINE_LOW, cuts.n)
    .line(LINE_LOW, MID)
    .arc(MID, MID, HALF - ROAD_EDGE_PX / 2, Math.PI, 0)
    .line(LINE_HIGH, cuts.n).ops;
  return { fills: [fill], strokes: [stroke] };
}

/** Zákruta N→E: štvrťkruhový pás okolo pravého horného rohu (64; 0), polomery 12…52, čiary na 13 a 51. */
function cornerPaths(cuts: Cuts): NarrowRoadPaths {
  const outer = MID + HALF;
  const inner = MID - HALF;
  const fill = new PathBuilder()
    .move(CELL - outer, 0)
    .arc(CELL, 0, outer, Math.PI, HALF_PI)
    .line(CELL, inner)
    .arc(CELL, 0, inner, HALF_PI, Math.PI)
    .close();
  const strokes = [outer - ROAD_EDGE_PX / 2, inner + ROAD_EDGE_PX / 2].map((r) => {
    // oblúk sa skracuje o lievik na začiatku (hrana N: y = cuts.n) a na konci (hrana E: x = 64 − cuts.e)
    const from = Math.PI - Math.asin(cuts.n / r);
    const to = HALF_PI + Math.asin(cuts.e / r);
    const start = onCircle(CELL, 0, r, from);
    return new PathBuilder().move(start.x, start.y).arc(CELL, 0, r, from, to).ops;
  });
  return { fills: [fill], strokes };
}

/** T bez juhu: vodorovný pás (y 12–52) s ramenom N; zaoblenie 6 px v oboch vnútorných rohoch, južný okraj bez prerušenia. */
function tPaths(cuts: Cuts): NarrowRoadPaths {
  const top = EDGE_LOW; // horný okraj vodorovného pásu (y 12)
  const fill = new PathBuilder()
    .move(EDGE_LOW, 0)
    .line(EDGE_HIGH, 0)
    .line(EDGE_HIGH, top - FILLET)
    .arc(EDGE_HIGH + FILLET, top - FILLET, FILLET, Math.PI, HALF_PI)
    .line(CELL, top)
    .line(CELL, EDGE_HIGH)
    .line(0, EDGE_HIGH)
    .line(0, top)
    .line(EDGE_LOW - FILLET, top)
    .arc(EDGE_LOW - FILLET, top - FILLET, FILLET, HALF_PI, 0)
    .close();
  const south = new PathBuilder().move(cuts.w, LINE_HIGH).line(CELL - cuts.e, LINE_HIGH).ops;
  const northEast = new PathBuilder()
    .move(LINE_HIGH, cuts.n)
    .line(LINE_HIGH, top - FILLET)
    .arc(EDGE_HIGH + FILLET, top - FILLET, FILLET_LINE, Math.PI, HALF_PI)
    .line(CELL - cuts.e, LINE_LOW).ops;
  const northWest = new PathBuilder()
    .move(cuts.w, LINE_LOW)
    .line(EDGE_LOW - FILLET, LINE_LOW)
    .arc(EDGE_LOW - FILLET, top - FILLET, FILLET_LINE, HALF_PI, 0)
    .line(LINE_LOW, cuts.n).ops;
  return { fills: [fill], strokes: [south, northEast, northWest] };
}

/** Križovatka: štyri ramená, zaoblenie 6 px vo všetkých vnútorných rohoch, okrajové čiary len pri zaobleniach. */
function crossPaths(cuts: Cuts): NarrowRoadPaths {
  const low = EDGE_LOW;
  const high = EDGE_HIGH;
  const fill = new PathBuilder()
    .move(low, 0)
    .line(high, 0)
    .line(high, low - FILLET)
    .arc(high + FILLET, low - FILLET, FILLET, Math.PI, HALF_PI)
    .line(CELL, low)
    .line(CELL, high)
    .line(high + FILLET, high)
    .arc(high + FILLET, high + FILLET, FILLET, 3 * HALF_PI, Math.PI)
    .line(high, CELL)
    .line(low, CELL)
    .line(low, high + FILLET)
    .arc(low - FILLET, high + FILLET, FILLET, 0, -HALF_PI)
    .line(0, high)
    .line(0, low)
    .line(low - FILLET, low)
    .arc(low - FILLET, low - FILLET, FILLET, HALF_PI, 0)
    .close();
  const northEast = new PathBuilder()
    .move(LINE_HIGH, cuts.n)
    .line(LINE_HIGH, low - FILLET)
    .arc(high + FILLET, low - FILLET, FILLET_LINE, Math.PI, HALF_PI)
    .line(CELL - cuts.e, LINE_LOW).ops;
  const southEast = new PathBuilder()
    .move(CELL - cuts.e, LINE_HIGH)
    .line(high + FILLET, LINE_HIGH)
    .arc(high + FILLET, high + FILLET, FILLET_LINE, 3 * HALF_PI, Math.PI)
    .line(LINE_HIGH, CELL - cuts.s).ops;
  const southWest = new PathBuilder()
    .move(LINE_LOW, CELL - cuts.s)
    .line(LINE_LOW, high + FILLET)
    .arc(low - FILLET, high + FILLET, FILLET_LINE, 0, -HALF_PI)
    .line(cuts.w, LINE_HIGH).ops;
  const northWest = new PathBuilder()
    .move(cuts.w, LINE_LOW)
    .line(low - FILLET, LINE_LOW)
    .arc(low - FILLET, low - FILLET, FILLET_LINE, HALF_PI, 0)
    .line(LINE_LOW, cuts.n).ops;
  return { fills: [fill], strokes: [northEast, southEast, southWest, northWest] };
}

const SHAPE_PATHS: Readonly<Record<AutotileShape, (cuts: Cuts) => NarrowRoadPaths>> = {
  straight: straightPaths,
  end: endPaths,
  corner: cornerPaths,
  t: tPaths,
  cross: crossPaths,
};

/**
 * Šikmá čiara okraja lievika: hranica asfaltu ide z (`outer`; 0) do (`inner`; hĺbka lievika); čiara leží o pol hrúbky
 * okraja kolmo dnu (asfalt je vpravo hore), začína na hrane bunky (y = 0) a končí na osi zvislej čiary ramena (x = 13).
 */
function slantedEdgeLine(outer: number, inner: number): { start: Point; end: Point } {
  const dx = inner - outer;
  const dy = FLARE_DEPTH_PX;
  const length = Math.hypot(dx, dy);
  const half = ROAD_EDGE_PX / 2;
  const nx = (dy / length) * half;
  const ny = (-dx / length) * half;
  const startShare = -ny / dy; // čiara pretína hranu bunky (y = 0)
  const endShare = (LINE_LOW - outer - nx) / dx; // a os zvislej čiary ramena (x = LINE_LOW)
  return {
    start: { x: outer + nx + startShare * dx, y: 0 },
    end: { x: LINE_LOW, y: ny + endShare * dy },
  };
}

/** Lievik ramena N so **rovným** okrajom (straight, end, t, cross): dva klinové výplne a dve šikmé čiary. */
function straightArmFlare(wideHalf: number): NarrowRoadPaths {
  const outerLeft = MID - wideHalf;
  const outerRight = MID + wideHalf;
  const fills = [
    new PathBuilder().move(outerLeft, 0).line(EDGE_LOW, 0).line(EDGE_LOW, FLARE_DEPTH_PX).close(),
    new PathBuilder().move(outerRight, 0).line(EDGE_HIGH, 0).line(EDGE_HIGH, FLARE_DEPTH_PX).close(),
  ];
  const left = slantedEdgeLine(outerLeft, EDGE_LOW);
  const strokes = [
    new PathBuilder().move(left.start.x, left.start.y).line(left.end.x, left.end.y).ops,
    // pravá strana je zrkadlo ľavej podľa osi bunky
    new PathBuilder().move(CELL - left.start.x, left.start.y).line(CELL - left.end.x, left.end.y).ops,
  ];
  return { fills, strokes };
}

/**
 * Lievik ramena zákruty (N alebo E): klin je ohraničený oblúkom okraja zákruty, šikmá čiara sa napája na skrátený oblúk
 * čiary okraja. `arm` = `n` (hrana y = 0, oblúky začínajú uhlom π a idú dnu klesaním uhla) alebo `e` (hrana x = 64,
 * oblúky končia uhlom π/2 a idú dnu rastom uhla). Široký asfalt siaha na polomery 32 ± `wideHalf` od rohu (64; 0).
 */
function cornerArmFlare(arm: 'n' | 'e', wideHalf: number): NarrowRoadPaths {
  const outer = MID + HALF;
  const inner = MID - HALF;
  const half = ROAD_EDGE_PX / 2;
  const edgeAngle = arm === 'n' ? Math.PI : HALF_PI;
  const inward = arm === 'n' ? -1 : 1;
  const wedge = (radius: number, wideRadius: number): PathOp[] => {
    const start = onCircle(CELL, 0, wideRadius, edgeAngle);
    const edge = onCircle(CELL, 0, radius, edgeAngle);
    const tipAngle = edgeAngle + inward * Math.asin(FLARE_DEPTH_PX / radius);
    return new PathBuilder().move(start.x, start.y).line(edge.x, edge.y).arc(CELL, 0, radius, edgeAngle, tipAngle).close();
  };
  const slant = (lineRadius: number, wideLineRadius: number): PathOp[] => {
    const start = onCircle(CELL, 0, wideLineRadius, edgeAngle);
    const tip = onCircle(CELL, 0, lineRadius, edgeAngle + inward * Math.asin(FLARE_DEPTH_PX / lineRadius));
    return new PathBuilder().move(start.x, start.y).line(tip.x, tip.y).ops;
  };
  return {
    fills: [wedge(outer, MID + wideHalf), wedge(inner, MID - wideHalf)],
    strokes: [slant(outer - half, MID + wideHalf - half), slant(inner + half, MID - wideHalf + half)],
  };
}

/**
 * Geometria úzkej dlaždice tvaru `shape` v základnej orientácii. `flareMask` (N = 1, E = 2, S = 4, W = 8, základná orientácia)
 * určuje ramená, ktorých sused je široká cesta — tie dostanú lievik do šírky `wideHalf` × 2 (px zdroja) na hrane bunky;
 * bity, ktoré `shape` nemá ako ramená, sa ignorujú.
 */
export function narrowRoadPaths(shape: AutotileShape, flareMask = 0, wideHalf = 26): NarrowRoadPaths {
  const armMask = AUTOTILE_SHAPE_BASE_MASK[shape] & flareMask;
  const flared = (arm: Arm): boolean => (armMask & ARM_BIT[arm]) !== 0 && wideHalf > HALF;
  const cuts: Cuts = {
    n: flared('n') ? FLARE_DEPTH_PX : 0,
    e: flared('e') ? FLARE_DEPTH_PX : 0,
    s: flared('s') ? FLARE_DEPTH_PX : 0,
    w: flared('w') ? FLARE_DEPTH_PX : 0,
  };
  const base = SHAPE_PATHS[shape](cuts);
  const fills = [...base.fills];
  const strokes = [...base.strokes];
  ARMS.forEach((arm, quarterTurns) => {
    if (!flared(arm)) return;
    if (shape === 'corner') {
      const flare = cornerArmFlare(arm as 'n' | 'e', wideHalf);
      fills.push(...flare.fills);
      strokes.push(...flare.strokes);
      return;
    }
    const flare = straightArmFlare(wideHalf);
    fills.push(...flare.fills.map((ops) => rotateOps(ops, quarterTurns)));
    strokes.push(...flare.strokes.map((ops) => rotateOps(ops, quarterTurns)));
  });
  return { fills, strokes };
}
