import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROAD_KINDS, type RoadKind } from '@sim/grid';
import { MANIFEST_CELL_PX } from '@render/entity-assets';
import { LANE_CENTER_PX, VEHICLE_OFFSET_PX, forwardOf, laneMagnitude, rightOf } from '@render/lane';
import {
  cornerAlpha,
  cornerTurn,
  headingDelta,
  isQuarterTurn,
  lerpHeading,
  normalizeAngle,
  turnArcPose,
  turnArcRadius,
} from '@render/turn-arc';
import type { ViewRotation } from '@render/view-models';
import { CARRIER_WIDTH_PX, TRUCK_WIDTH_PX } from '@render/world-scale';

const HEADINGS: readonly ViewRotation[] = [0, 90, 180, 270];
const PX = MANIFEST_CELL_PX;
/** Toleranca karty T03-19: ± 2 px na stredovej čiare. */
const TOLERANCE_CELLS = 2 / PX;

/** Všetky zákruty o 90°: vstupný kurz a smer otáčania (+90 pravá, −90 ľavá). */
const TURNS = HEADINGS.flatMap((from) =>
  ([90, -90] as const).map((delta) => ({ from, to: normalizeAngle(from + delta) as ViewRotation, delta })),
);

function readAsset(path: string): string {
  return readFileSync(new URL(`../../assets/${path}`, import.meta.url), 'utf8');
}

/** Stred oblúka voči stredu bunky: roh, v ktorom sa stretávajú hrany vstupu a výstupu. */
function arcCenter(from: ViewRotation, to: ViewRotation): { x: number; y: number } {
  const dIn = forwardOf(from);
  const dOut = forwardOf(to);
  return { x: -0.5 * dIn.x + 0.5 * dOut.x, y: -0.5 * dIn.y + 0.5 * dOut.y };
}

describe('geometria oblúka je odvodená zo sprite `road_corner.svg`', () => {
  const corner = readAsset('infra/road_corner.svg');

  it('sprite: stredová čiara je oblúk polomeru 32 okolo rohu (64; 0), asfalt siaha od polomeru 6 po 58', () => {
    expect(corner).toContain('d="M32 0A32 32 0 0 0 64 32"'); // stredová čiara
    expect(corner).toContain('M6 0A58 58 0 0 0 64 58'); // vonkajší okraj asfaltu: polomer 58
    expect(corner).toContain('A6 6 0 0 1 58 0'); // vnútorný okraj: polomer 6
  });

  it('polomery dráhy vozidla: pravá zákruta 32 − posun px, ľavá 32 + posun px (dvojpruhová), stred 32 px (jednopruhová)', () => {
    for (const { from, to, delta } of TURNS) {
      const right = turnArcRadius('two_lane', from, to) * PX;
      expect(right, `${String(from)}→${String(to)}`).toBeCloseTo(delta > 0 ? 32 - VEHICLE_OFFSET_PX : 32 + VEHICLE_OFFSET_PX, 9);
      for (const kind of ['one_lane', 'one_way'] as const) expect(turnArcRadius(kind, from, to) * PX).toBeCloseTo(32, 9);
    }
  });

  it('pruhy ležia symetricky okolo stredovej čiary (32 ± 13) a v asfalte 6…58', () => {
    expect(32 - LANE_CENTER_PX).toBe(19);
    expect(32 + LANE_CENTER_PX).toBe(45);
    expect(19 - LANE_CENTER_PX).toBeGreaterThanOrEqual(6);
    expect(45 + LANE_CENTER_PX).toBeLessThanOrEqual(58);
  });
});

describe('turnArcPose: začiatok, stred a koniec oblúka (všetky kurzy, obe zákruty, všetky typy ciest)', () => {
  it.each(TURNS.flatMap((turn) => ROAD_KINDS.map((kind) => ({ ...turn, kind }))))(
    '$kind, $from° → $to° ($delta): začiatok na hrane vstupu, stred na osi rohu, koniec na hrane výstupu',
    ({ from, to, delta, kind }) => {
      const lane = laneMagnitude(kind);
      const rIn = rightOf(from);
      const rOut = rightOf(to);
      const dIn = forwardOf(from);
      const dOut = forwardOf(to);
      const start = turnArcPose(kind, from, to, 0);
      const middle = turnArcPose(kind, from, to, 0.5);
      const end = turnArcPose(kind, from, to, 1);
      // vstup: stred hrany „za nami“ + posun pruhu vpravo od smeru jazdy
      expect(start.x).toBeCloseTo(-0.5 * dIn.x + lane * rIn.x, 12);
      expect(start.y).toBeCloseTo(-0.5 * dIn.y + lane * rIn.y, 12);
      // výstup: stred hrany „pred nami“ + posun pruhu vpravo od nového smeru
      expect(end.x).toBeCloseTo(0.5 * dOut.x + lane * rOut.x, 12);
      expect(end.y).toBeCloseTo(0.5 * dOut.y + lane * rOut.y, 12);
      // stred oblúka leží na priamke roh → stred bunky, vo vzdialenosti polomeru od rohu
      const q = arcCenter(from, to);
      const radius = turnArcRadius(kind, from, to);
      const cornerDistance = Math.hypot(q.x, q.y); // √2 / 2
      expect(middle.x).toBeCloseTo(q.x * (1 - radius / cornerDistance), 12);
      expect(middle.y).toBeCloseTo(q.y * (1 - radius / cornerDistance), 12);
      // uhol: kurz vstupu → os medzi kurzami → kurz výstupu, najkratším oblúkom
      expect(start.angle).toBe(from);
      expect(middle.angle).toBe(normalizeAngle(from + delta / 2));
      expect(end.angle).toBe(to);
    },
  );

  it.each(TURNS.flatMap((turn) => ROAD_KINDS.map((kind) => ({ ...turn, kind }))))(
    '$kind, $from° → $to°: vozidlo drží polomer, uhol rastie monotónne a jeho predok mieri po dotyčnici',
    ({ from, to, delta, kind }) => {
      const q = arcCenter(from, to);
      const radius = turnArcRadius(kind, from, to);
      let previousAngle: number = from;
      let travelled = 0;
      let last = turnArcPose(kind, from, to, 0);
      for (let i = 0; i <= 100; i++) {
        const pose = turnArcPose(kind, from, to, i / 100);
        expect(Math.hypot(pose.x - q.x, pose.y - q.y)).toBeCloseTo(radius, 12);
        // uhol sa mení jedným smerom (pravá +, ľavá −) a v krokoch po 0,9°
        const step = headingDelta(previousAngle as ViewRotation, pose.angle as ViewRotation);
        if (i > 0) expect(Math.sign(step)).toBe(Math.sign(delta));
        if (i > 0) expect(Math.abs(step)).toBeCloseTo(0.9, 6);
        previousAngle = pose.angle;
        // smer pohybu je zhodný s uhlom spritu (predok = smer jazdy): úsečka medzi susednými vzorkami
        if (i > 0) {
          const dx = pose.x - last.x;
          const dy = pose.y - last.y;
          const heading = normalizeAngle((Math.atan2(dx, -dy) * 180) / Math.PI);
          const mean = normalizeAngle((last.angle + pose.angle) / 2 + (Math.abs(last.angle - pose.angle) > 180 ? 180 : 0));
          expect(Math.abs(headingDelta(heading as ViewRotation, mean as ViewRotation))).toBeLessThan(1);
          travelled += Math.hypot(dx, dy);
        }
        last = pose;
      }
      // dĺžka oblúka ≈ štvrť obvodu
      expect(travelled).toBeCloseTo((Math.PI / 2) * radius, 3);
    },
  );

  it('alpha mimo [0, 1] sa orezáva na hranu', () => {
    expect(turnArcPose('two_lane', 0, 90, -3)).toEqual(turnArcPose('two_lane', 0, 90, 0));
    expect(turnArcPose('two_lane', 0, 90, 7)).toEqual(turnArcPose('two_lane', 0, 90, 1));
  });

  it('zákruta, ktorá nie je o 90° (rovno, obrat), je RangeError', () => {
    expect(() => turnArcPose('two_lane', 90, 90, 0.5)).toThrow(RangeError);
    expect(() => turnArcPose('two_lane', 90, 270, 0.5)).toThrow(RangeError);
    expect(() => turnArcRadius('two_lane', 0, 180)).toThrow(RangeError);
  });
});

describe('vozidlo v zákrute ostane na asfalte cesty', () => {
  it.each(TURNS)('dvojpruhová cesta, $from° → $to°: kamión (28 px) v asfalte okolo vnútorného rohu (polomery 6…58 px, ± 2 px), carrier (34 px) ± 5 px', ({ from, to }) => {
    const q = arcCenter(from, to);
    for (const [width, tolerance] of [
      [TRUCK_WIDTH_PX, TOLERANCE_CELLS],
      [CARRIER_WIDTH_PX, 5 / PX],
    ] as const) {
      const halfWidth = width / 2 / PX;
      for (let i = 0; i <= 100; i++) {
        const pose = turnArcPose('two_lane', from, to, i / 100);
        const radius = Math.hypot(pose.x - q.x, pose.y - q.y);
        expect(radius - halfWidth).toBeGreaterThanOrEqual(6 / PX - tolerance); // vnútorný okraj asfaltu (6 px)
        expect(radius + halfWidth).toBeLessThanOrEqual(58 / PX + tolerance); // vonkajší okraj asfaltu (58 px)
      }
    }
  });

  it.each(TURNS)('jednopruhová cesta, $from° → $to°: dráha stredu je na osi (polomer 32 px)', ({ from, to }) => {
    const q = arcCenter(from, to);
    for (let i = 0; i <= 100; i++) {
      const pose = turnArcPose('one_lane', from, to, i / 100);
      expect(Math.hypot(pose.x - q.x, pose.y - q.y) * PX).toBeCloseTo(32, 9);
    }
  });

  it('pravidlo pruhu: posun dráhy od osi nikdy nepresiahne stred pruhu (13 px)', () => {
    expect(VEHICLE_OFFSET_PX).toBeLessThanOrEqual(LANE_CENTER_PX);
  });
});

describe('cornerTurn: vstupný a výstupný kurz zo tvaru bunky a kurzu vozidla', () => {
  // maska N=1 E=2 S=4 W=8; zákruta N+E: vstup zo severu (kurz 180°) → východ (90°) a vstup z východu (270°) → sever (0°)
  it.each([
    [1 | 2, 180, 180, 90],
    [1 | 2, 90, 180, 90], // výstupná polovica: vozidlo už mieri na východ
    [1 | 2, 270, 270, 0],
    [1 | 2, 0, 270, 0],
    [2 | 4, 270, 270, 180],
    [2 | 4, 180, 270, 180],
    [2 | 4, 0, 0, 90],
    [2 | 4, 90, 0, 90],
    [4 | 8, 0, 0, 270],
    [4 | 8, 270, 0, 270],
    [4 | 8, 90, 90, 180],
    [4 | 8, 180, 90, 180],
    [8 | 1, 90, 90, 0],
    [8 | 1, 0, 90, 0],
    [8 | 1, 180, 180, 270],
    [8 | 1, 270, 180, 270],
  ] as const)('maska %i, kurz %i° → vstup %i°, výstup %i°', (mask, heading, from, to) => {
    expect(cornerTurn(mask, heading)).toEqual({ from, to });
  });

  it('bunka, ktorá nie je zákruta (koniec, rovná, T, križovatka, izolovaná), vráti null', () => {
    for (const mask of [0, 1, 2, 4, 8, 1 | 4, 2 | 8, 1 | 2 | 8, 1 | 2 | 4, 15]) {
      for (const heading of HEADINGS) expect(cornerTurn(mask, heading), `maska ${String(mask)}`).toBeNull();
    }
  });
});

describe('pomocné funkcie uhlov', () => {
  it('normalizeAngle a headingDelta', () => {
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(360)).toBe(0);
    expect(headingDelta(270, 0)).toBe(90); // cez sever, nie o −270°
    expect(headingDelta(0, 270)).toBe(-90);
    expect(headingDelta(90, 90)).toBe(0);
    expect(Math.abs(headingDelta(0, 180))).toBe(180);
  });

  it('isQuarterTurn: len kolmé kurzy', () => {
    expect(isQuarterTurn(0, 90)).toBe(true);
    expect(isQuarterTurn(270, 0)).toBe(true);
    expect(isQuarterTurn(90, 90)).toBe(false);
    expect(isQuarterTurn(90, 270)).toBe(false);
  });

  it('lerpHeading otáča najkratším oblúkom; obrat o 180° sa neinterpoluje', () => {
    expect(lerpHeading(270, 0, 0.5)).toBe(315);
    expect(lerpHeading(0, 270, 0.5)).toBe(315);
    expect(lerpHeading(90, 180, 0)).toBe(90);
    expect(lerpHeading(90, 180, 1)).toBe(180);
    expect(lerpHeading(90, 270, 0.3)).toBe(270);
  });

  it('cornerAlpha: 0,5 + priemet posunu od stredu bunky na smer jazdy, orezané na [0, 1]', () => {
    const center = { x: 5.5, y: 5.5 };
    expect(cornerAlpha({ x: 5.5, y: 5.0 }, center, 180)).toBeCloseTo(0, 12); // hrana N, ide na juh
    expect(cornerAlpha({ x: 5.5, y: 5.5 }, center, 180)).toBe(0.5);
    expect(cornerAlpha({ x: 6.0, y: 5.5 }, center, 90)).toBeCloseTo(1, 12); // hrana E, ide na východ
    expect(cornerAlpha({ x: 5.5, y: 5.25 }, center, 0)).toBeCloseTo(0.75, 12); // ide na sever, je nad stredom
    expect(cornerAlpha({ x: 9, y: 5.5 }, center, 90)).toBe(1);
    expect(cornerAlpha({ x: 1, y: 5.5 }, center, 90)).toBe(0);
  });
});

/** Kontrola typu: typy ciest, ktoré render pozná, sú práve tie zo simu. */
describe('typy ciest', () => {
  it('polomer 32 px pre všetky jednopruhové typy sa berie z počtu pruhov', () => {
    const kinds: readonly RoadKind[] = ROAD_KINDS;
    expect(kinds.filter((kind) => laneMagnitude(kind) === 0)).toEqual(['one_lane', 'one_way']);
  });
});
