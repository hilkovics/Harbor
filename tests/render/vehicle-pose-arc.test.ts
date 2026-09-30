import { describe, expect, it } from 'vitest';
import { Grid, ROAD_KINDS, type CellCoord, type RoadKind } from '@sim/grid';
import { VEHICLE_OFFSET_PX, createRoadKindAt, createRoadMaskAt, forwardOf } from '@render/lane';
import { CARRIER_WIDTH_PX, TRUCK_WIDTH_PX } from '@render/world-scale';
import { cornerTurn, headingDelta, normalizeAngle, turnArcPose } from '@render/turn-arc';
import { vehiclePose } from '@render/vehicle-view';
import type { VehicleVM, ViewRotation } from '@render/view-models';

const CELL = 64;
const HEADINGS: readonly ViewRotation[] = [0, 90, 180, 270];
/** Toleranca karty T03-19: ± 2 px na stredovej čiare. */
const TOLERANCE = 2 / CELL;
/** Stred zákruty v testovacej mriežke. */
const CENTER: CellCoord = { x: 10, y: 10 };
/** Rýchlosť vozidla v bunkách za tick: `straddle_carrier` (data/defs/vehicles.json) a rýchlosť, ktorá prejde aj viac ako pol bunky. */
const SPEEDS = [0.4, 0.9] as const;
const SAMPLES_PER_TICK = 20;

interface Scenario {
  readonly grid: Grid;
  /** Stredy buniek trasy v bunkách (x + 0,5; y + 0,5). */
  readonly path: readonly { x: number; y: number }[];
  readonly entry: ViewRotation;
  readonly exit: ViewRotation;
  readonly delta: number;
}

/** Trasa: 3 bunky pred zákrutou, stred (10; 10), 3 bunky po nej; všetky bunky sú cesty typu `kinds(index)`. */
function scenario(entry: ViewRotation, delta: 90 | -90, kinds: (index: number) => RoadKind = () => 'two_lane'): Scenario {
  const grid = new Grid(24, 24, () => ({ terrain: 'land' }));
  const exit = normalizeAngle(entry + delta) as ViewRotation;
  const dIn = forwardOf(entry);
  const dOut = forwardOf(exit);
  const cells: CellCoord[] = [];
  for (let k = 3; k >= 1; k--) cells.push({ x: CENTER.x - k * dIn.x, y: CENTER.y - k * dIn.y });
  cells.push(CENTER);
  for (let k = 1; k <= 3; k++) cells.push({ x: CENTER.x + k * dOut.x, y: CENTER.y + k * dOut.y });
  cells.forEach((cell, index) => {
    const at = grid.at(cell.x, cell.y);
    at.road = 'road';
    at.roadKind = kinds(index);
    at.roadDir = kinds(index) === 'one_way' ? 'N' : null;
  });
  return { grid, path: cells.map((cell) => ({ x: cell.x + 0.5, y: cell.y + 0.5 })), entry, exit, delta };
}

interface SimPoint {
  readonly x: number;
  readonly y: number;
  readonly heading: ViewRotation;
}

/**
 * Poloha po lomenej čiare cez stredy buniek po prejdení vzdialenosti `distance`; kurz úseku, na ktorom vozidlo leží
 * (pravý koniec úseku patrí úseku — kurz sa mení až pri ďalšom pohybe, ako v `Vehicle.advance`).
 */
function simAt(path: Scenario['path'], distance: number): SimPoint {
  let start = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const last = i + 2 === path.length;
    if (distance <= start + length + 1e-12 || last) {
      const share = Math.min(1, Math.max(0, (distance - start) / length));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const heading = dx > 0 ? 90 : dx < 0 ? 270 : dy > 0 ? 180 : 0;
      return { x: a.x + dx * share, y: a.y + dy * share, heading };
    }
    start += length;
  }
  throw new Error('prázdna trasa');
}

/** VM v ticku `tick` (poloha po `tick` tickoch, predchádzajúca po `tick − 1`), ako ho dodá SimBridge. */
function tickVM(path: Scenario['path'], speed: number, tick: number): VehicleVM {
  const prev = simAt(path, speed * (tick - 1));
  const curr = simAt(path, speed * tick);
  return {
    id: 1,
    defId: 'straddle_carrier',
    x: curr.x,
    y: curr.y,
    prevX: prev.x,
    prevY: prev.y,
    heading: curr.heading,
    prevHeading: prev.heading,
    loaded: false,
    state: 'to_dropoff',
  };
}

interface Sample {
  readonly tick: number;
  readonly alpha: number;
  readonly sim: SimPoint;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/** Vzorky pózy vozidla po celej trase, `SAMPLES_PER_TICK` v každom ticku (posledný vzorok ticku = prvý ďalšieho). */
function drive(scene: Scenario, speed: number): Sample[] {
  const roadKindAt = createRoadKindAt(scene.grid);
  const roadMaskAt = createRoadMaskAt(scene.grid);
  const length = scene.path.length - 1;
  const ticks = Math.ceil(length / speed) + 1;
  const samples: Sample[] = [];
  for (let tick = 1; tick <= ticks; tick++) {
    const vm = tickVM(scene.path, speed, tick);
    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      const alpha = i / SAMPLES_PER_TICK;
      const pose = vehiclePose(vm, alpha, CELL, roadKindAt, roadMaskAt);
      samples.push({ tick, alpha, sim: simAt(scene.path, speed * (tick - 1 + alpha)), x: pose.x / CELL, y: pose.y / CELL, angle: pose.angle });
    }
  }
  return samples;
}

/** Stred oblúka zákruty v svete (roh bunky), v ktorom sa stretávajú hrany vstupu a výstupu. */
function arcCenterWorld(scene: Scenario): { x: number; y: number } {
  const dIn = forwardOf(scene.entry);
  const dOut = forwardOf(scene.exit);
  return { x: CENTER.x + 0.5 - 0.5 * dIn.x + 0.5 * dOut.x, y: CENTER.y + 0.5 - 0.5 * dIn.y + 0.5 * dOut.y };
}

const inCornerCell = (point: { x: number; y: number }): boolean => Math.floor(point.x) === CENTER.x && Math.floor(point.y) === CENTER.y;

const CASES = HEADINGS.flatMap((entry) => ([90, -90] as const).map((delta) => ({ entry, delta, exit: normalizeAngle(entry + delta) })));

describe('vehiclePose: jazda po oblúku v zákrute (všetky kurzy, ľavá aj pravá zákruta)', () => {
  it.each(CASES.flatMap((c) => SPEEDS.map((speed) => ({ ...c, speed }))))(
    '$entry° → $exit°, $speed bunky/tick: v bunke zákruty leží vozidlo na oblúku s polomerom pruhu, uhol sa plynulo otáča',
    ({ entry, delta, speed }) => {
      const scene = scenario(entry, delta);
      const q = arcCenterWorld(scene);
      const radius = (32 + (delta > 0 ? -VEHICLE_OFFSET_PX : VEHICLE_OFFSET_PX)) / CELL;
      const inside = drive(scene, speed).filter((sample) => inCornerCell(sample.sim));
      expect(inside.length).toBeGreaterThan(10);
      for (const sample of inside) {
        expect(Math.hypot(sample.x - q.x, sample.y - q.y), `tick ${String(sample.tick)} alpha ${String(sample.alpha)}`).toBeCloseTo(radius, 9);
        // parameter oblúka = podiel dráhy v bunke; uhol = kurz vstupu + otočenie o (podiel × 90°)
        const forward = forwardOf(sample.sim.heading);
        const along = (sample.sim.x - (CENTER.x + 0.5)) * forward.x + (sample.sim.y - (CENTER.y + 0.5)) * forward.y;
        const expected = normalizeAngle(entry + delta * (0.5 + along));
        expect(Math.abs(headingDelta(sample.angle as ViewRotation, expected as ViewRotation)), `uhol, tick ${String(sample.tick)}`).toBeLessThan(1e-6);
      }
    },
  );

  it.each(CASES.flatMap((c) => SPEEDS.map((speed) => ({ ...c, speed }))))(
    '$entry° → $exit°, $speed bunky/tick: dráha aj uhol sú plynulé (žiadny skok na hrane bunky, v strede ani na hranici ticku)',
    ({ entry, delta, speed }) => {
      const samples = drive(scenario(entry, delta), speed);
      let largest = 0;
      let largestAngle = 0;
      for (let i = 1; i < samples.length; i++) {
        largest = Math.max(largest, Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
        largestAngle = Math.max(largestAngle, Math.abs(headingDelta(samples[i - 1].angle as ViewRotation, samples[i].angle as ViewRotation)));
      }
      // krok jazdy je speed / 20; oblúk (π/2 · polomer ≈ 0,75–0,83 bunky) je kratší než dráha simu (1 bunka)
      expect(largest).toBeLessThan((speed / SAMPLES_PER_TICK) * 1.15);
      // uhol sa otáča len v bunke zákruty, o 90° za jednu bunku dráhy: najviac speed / 20 × 90° na vzorku
      expect(largestAngle).toBeLessThanOrEqual((speed / SAMPLES_PER_TICK) * 90 + 1e-6);
    },
  );

  it.each(CASES)('$entry° → $exit°: mimo zákruty vozidlo jazdí priamo vpravo od osi o `VEHICLE_OFFSET_PX`', ({ entry, delta }) => {
    const scene = scenario(entry, delta);
    const samples = drive(scene, 0.4);
    const outside = samples.filter((sample) => !inCornerCell(sample.sim));
    expect(outside.length).toBeGreaterThan(10);
    for (const sample of outside) {
      const forward = forwardOf(sample.sim.heading);
      const right = { x: -forward.y, y: forward.x }; // vpravo od smeru jazdy pri osi y nadol
      const offset = (sample.x - sample.sim.x) * right.x + (sample.y - sample.sim.y) * right.y;
      const along = (sample.x - sample.sim.x) * forward.x + (sample.y - sample.sim.y) * forward.y;
      expect(offset, `tick ${String(sample.tick)}`).toBeCloseTo(VEHICLE_OFFSET_PX / CELL, 9);
      expect(along).toBeCloseTo(0, 9);
      expect(sample.angle).toBe(sample.sim.heading);
    }
  });

  it.each(CASES)('$entry° → $exit°: telo kamióna (28 px) ostane v asfalte zákruty (polomery 6…58 px, ± 2 px), carrier (34 px) ± 5 px', ({ entry, delta }) => {
    const scene = scenario(entry, delta);
    const q = arcCenterWorld(scene);
    for (const [width, tolerance] of [
      [TRUCK_WIDTH_PX, TOLERANCE],
      [CARRIER_WIDTH_PX, 5 / CELL],
    ] as const) {
      const halfWidth = width / 2 / CELL;
      for (const sample of drive(scene, 0.4).filter((s) => inCornerCell(s.sim))) {
        const radius = Math.hypot(sample.x - q.x, sample.y - q.y);
        expect(radius - halfWidth).toBeGreaterThanOrEqual(6 / CELL - tolerance);
        expect(radius + halfWidth).toBeLessThanOrEqual(58 / CELL + tolerance);
      }
    }
  });

  it.each(ROAD_KINDS.filter((kind) => kind !== 'two_lane'))(
    'jednopruhová zákruta (%s): oblúk s polomerom 32 px (stred cesty), vozidlo prechádza stredom bunky po osi rohu',
    (kind) => {
      for (const { entry, delta } of CASES) {
        const scene = scenario(entry, delta, () => kind);
        const q = arcCenterWorld(scene);
        const inside = drive(scene, 0.4).filter((sample) => inCornerCell(sample.sim));
        expect(inside.length).toBeGreaterThan(5);
        for (const sample of inside) expect(Math.hypot(sample.x - q.x, sample.y - q.y)).toBeCloseTo(32 / CELL, 9);
        // stred bunky (sim) → stred oblúka: na priamke roh → stred bunky, 32 px od rohu
        const middle = inside.reduce((best, s) => (Math.abs(s.sim.x - 10.5) + Math.abs(s.sim.y - 10.5) < Math.abs(best.sim.x - 10.5) + Math.abs(best.sim.y - 10.5) ? s : best));
        const pose = turnArcPose(kind, entry, normalizeAngle(entry + delta) as ViewRotation, 0.5);
        expect(middle.x).toBeCloseTo(10.5 + pose.x, 1);
        expect(middle.y).toBeCloseTo(10.5 + pose.y, 1);
      }
    },
  );

  it('rôzne typy susedných ciest (dvojpruhová → jednopruhová zákruta → dvojpruhová): pózy sú spojité, žiadny skok posunu pruhu', () => {
    for (const { entry, delta } of CASES) {
      // bunky 0–2 sú pred zákrutou, 3 je zákruta, 4–6 po nej
      const scene = scenario(entry, delta, (index) => (index === 3 ? 'one_lane' : 'two_lane'));
      const samples = drive(scene, 0.4);
      let largest = 0;
      for (let i = 1; i < samples.length; i++) largest = Math.max(largest, Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
      expect(largest, `${String(entry)}° ${String(delta)}`).toBeLessThan(0.05);
    }
  });

  it('kontrola testu: bez masky susedov (bez oblúkov) vozidlo v zákrute leží mimo oblúka a jeho uhol sa v strede bunky láme', () => {
    const scene = scenario(180, -90);
    const roadKindAt = createRoadKindAt(scene.grid);
    const q = arcCenterWorld(scene);
    // vzorky bez `roadMaskAt`: priama jazda po lomenej čiare
    let onArc = 0;
    let inside = 0;
    for (let tick = 1; tick <= 12; tick++) {
      const vm = tickVM(scene.path, 0.4, tick);
      for (let i = 0; i < SAMPLES_PER_TICK; i++) {
        const alpha = i / SAMPLES_PER_TICK;
        const sim = simAt(scene.path, 0.4 * (tick - 1 + alpha));
        if (!inCornerCell(sim) || Math.abs(sim.x - 10.5) + Math.abs(sim.y - 10.5) < 0.2) continue;
        const pose = vehiclePose(vm, alpha, CELL, roadKindAt);
        inside += 1;
        if (Math.abs(Math.hypot(pose.x / CELL - q.x, pose.y / CELL - q.y) - (32 + VEHICLE_OFFSET_PX) / CELL) < 1e-6) onArc += 1;
      }
    }
    expect(inside).toBeGreaterThan(5);
    expect(onArc).toBeLessThan(inside); // bez oblúkov nie sú vzorky na oblúku
  });
});

describe('vehiclePose: zmena kurzu mimo zákruty a nezhoda s tvarom cesty', () => {
  /** Križovatka T: vozidlo prichádza od severu a zabáča na východ, bunka (10; 10) má troch susedov. */
  function junction(): Grid {
    const grid = new Grid(24, 24, () => ({ terrain: 'land' }));
    for (const [x, y] of [
      [10, 9],
      [10, 10],
      [11, 10],
      [9, 10],
    ]) {
      grid.at(x, y).road = 'road';
    }
    return grid;
  }

  const turning: VehicleVM = {
    id: 1,
    defId: 'straddle_carrier',
    prevX: 10.5,
    prevY: 10.3,
    x: 10.7,
    y: 10.5,
    prevHeading: 180,
    heading: 90,
    loaded: false,
    state: 'to_dropoff',
  };

  it('T-križovatka: bez oblúka; pozícia medzi pruhmi a uhol otočený najkratším oblúkom počas ticku', () => {
    const grid = junction();
    const roadKindAt = createRoadKindAt(grid);
    const roadMaskAt = createRoadMaskAt(grid);
    const start = vehiclePose(turning, 0, CELL, roadKindAt, roadMaskAt);
    const middle = vehiclePose(turning, 0.5, CELL, roadKindAt, roadMaskAt);
    const end = vehiclePose(turning, 1, CELL, roadKindAt, roadMaskAt);
    const lane = VEHICLE_OFFSET_PX / CELL;
    expect(start.x).toBeCloseTo((10.5 - lane) * CELL, 9); // kurz 180° (juh): západný pruh
    expect(start.y).toBeCloseTo(10.3 * CELL, 9);
    expect(end.x).toBeCloseTo(10.7 * CELL, 9);
    expect(end.y).toBeCloseTo((10.5 + lane) * CELL, 9); // kurz 90° (východ): južný pruh
    expect(middle.x).toBeCloseTo(((10.5 - lane + 10.7) / 2) * CELL, 9);
    expect([start.angle, middle.angle, end.angle]).toEqual([180, 135, 90]);
  });

  it('obrat o 180° sa neinterpoluje: uhol platí aktuálny kurz, pruh sa presunie počas ticku', () => {
    const grid = junction();
    const vm: VehicleVM = { ...turning, prevX: 10.5, prevY: 10.3, x: 10.5, y: 10.3, prevHeading: 180, heading: 0 };
    const pose = vehiclePose(vm, 0.5, CELL, createRoadKindAt(grid), createRoadMaskAt(grid));
    expect(pose.angle).toBe(0);
    expect(pose.x / CELL).toBeCloseTo(10.5, 9); // (−posun + posun) / 2: uprostred medzi pruhmi
  });

  it('zákruta v bunke, ale VM nesedí s tvarom cesty (koleno nie je stred bunky) → bez oblúka, ako T-križovatka', () => {
    const scene = scenario(180, -90);
    const roadKindAt = createRoadKindAt(scene.grid);
    const roadMaskAt = createRoadMaskAt(scene.grid);
    const vm: VehicleVM = { ...turning, prevX: 10.3, prevY: 10.2, x: 10.7, y: 10.5, prevHeading: 180, heading: 90 };
    const pose = vehiclePose(vm, 1, CELL, roadKindAt, roadMaskAt);
    const lane = VEHICLE_OFFSET_PX / CELL;
    expect(pose.x).toBeCloseTo(10.7 * CELL, 9);
    expect(pose.y).toBeCloseTo((10.5 + lane) * CELL, 9);
  });

  it('koľaj v bunke zákruty sa s cestou nespája: vozidlo na ceste tam oblúk nemá', () => {
    const scene = scenario(180, -90);
    scene.grid.at(CENTER.x + 1, CENTER.y).road = 'rail'; // východný sused zákruty už nie je cesta
    expect(cornerTurn(createRoadMaskAt(scene.grid)(CENTER.x, CENTER.y), 180)).toBeNull();
  });

  it('stojace vozidlo v strede bunky zákruty stojí v strede oblúka, uhol je os medzi kurzami', () => {
    const scene = scenario(180, -90);
    const vm: VehicleVM = {
      id: 1,
      defId: 'straddle_carrier',
      x: 10.5,
      y: 10.5,
      prevX: 10.5,
      prevY: 10.5,
      heading: 180,
      loaded: false,
      state: 'idle',
    };
    const pose = vehiclePose(vm, 1, CELL, createRoadKindAt(scene.grid), createRoadMaskAt(scene.grid));
    const arc = turnArcPose('two_lane', 180, 90, 0.5);
    expect(pose.x / CELL).toBeCloseTo(10.5 + arc.x, 12);
    expect(pose.y / CELL).toBeCloseTo(10.5 + arc.y, 12);
    expect(pose.angle).toBe(135);
  });
});
