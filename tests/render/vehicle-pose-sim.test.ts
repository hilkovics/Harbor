import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core/entity-id';
import type { VehicleDef } from '@sim/defs/types';
import { Grid, type CellCoord } from '@sim/grid';
import { Vehicle } from '@sim/vehicles';
import { createRoadKindAt, createRoadMaskAt, forwardOf } from '@render/lane';
import { headingDelta, normalizeAngle } from '@render/turn-arc';
import { vehiclePose } from '@render/vehicle-view';
import type { VehicleVM, ViewRotation } from '@render/view-models';

/**
 * Skutočná `Vehicle` zo simu (nie modelová dráha): test overuje predpoklad, na ktorom stojí oblúk v zákrute —
 * `heading` sa mení skokom v strede bunky zákruty a `prevHeading ≠ heading` platí práve v jedinom ticku (karta T03-19,
 * odchýlka od zadania: oblúk sa nekreslí od `prevHeading → heading`, ale podľa polohy v bunke).
 */
const WIDTH = 24;
const CENTER: CellCoord = { x: 10, y: 10 };
const HEADINGS: readonly ViewRotation[] = [0, 90, 180, 270];
const DEF: VehicleDef = {
  id: 'straddle_carrier',
  displayName: 'Straddle carrier',
  capacityUnits: 1,
  speedCellsPerTick: 0.4,
  loadTicks: 3,
  unloadTicks: 3,
  cargoCategories: ['container'],
  purchaseCents: 1,
  wagePerDayCents: 1,
};

function corner(entry: ViewRotation, delta: 90 | -90): { grid: Grid; cells: CellCoord[]; exit: ViewRotation } {
  const grid = new Grid(WIDTH, WIDTH, () => ({ terrain: 'land' }));
  const exit = normalizeAngle(entry + delta) as ViewRotation;
  const dIn = forwardOf(entry);
  const dOut = forwardOf(exit);
  const cells: CellCoord[] = [];
  for (let k = 3; k >= 1; k--) cells.push({ x: CENTER.x - k * dIn.x, y: CENTER.y - k * dIn.y });
  cells.push(CENTER);
  for (let k = 1; k <= 3; k++) cells.push({ x: CENTER.x + k * dOut.x, y: CENTER.y + k * dOut.y });
  for (const cell of cells) grid.at(cell.x, cell.y).road = 'road';
  return { grid, cells, exit };
}

/** Ticky skutočného vozidla po trase cez zákrutu: VM ako ich skladá `SimBridge` (prev = stav pred posledným tickom). */
function driveRealVehicle(cells: readonly CellCoord[], entry: ViewRotation): VehicleVM[] {
  const first = cells[0];
  const vehicle = new Vehicle({
    id: 1 as EntityId,
    def: DEF,
    depotId: 1 as EntityId,
    state: 'to_dropoff',
    x: first.x + 0.5,
    y: first.y + 0.5,
    heading: entry,
    purchaseCostCents: 1,
    route: cells.map((cell) => cell.y * WIDTH + cell.x),
  });
  const result: VehicleVM[] = [];
  for (let tick = 0; tick < 30; tick++) {
    const before = { x: vehicle.x, y: vehicle.y, heading: vehicle.heading };
    const arrived = vehicle.advance(DEF.speedCellsPerTick, WIDTH);
    result.push({
      id: 1,
      defId: 'straddle_carrier',
      x: vehicle.x,
      y: vehicle.y,
      prevX: before.x,
      prevY: before.y,
      heading: vehicle.heading as ViewRotation,
      prevHeading: before.heading as ViewRotation,
      loaded: false,
      state: 'to_dropoff',
    });
    if (arrived) break;
  }
  return result;
}

describe('skutočné vozidlo zo simu v zákrute (karta T03-19: kurz sa mení skokom v strede bunky)', () => {
  const CASES = HEADINGS.flatMap((entry) => ([90, -90] as const).map((delta) => ({ entry, delta })));

  it.each(CASES)('$entry°, zákruta $delta: kurz sa zmení práve raz a ten tick prechádza stredom bunky zákruty', ({ entry, delta }) => {
    const { cells } = corner(entry, delta);
    const ticks = driveRealVehicle(cells, entry);
    const flips = ticks.filter((vm) => vm.prevHeading !== vm.heading);
    expect(flips).toHaveLength(1);
    const [flip] = flips;
    expect(headingDelta(flip.prevHeading ?? flip.heading, flip.heading)).toBe(delta);
    // koleno ticku = priesečník osi predchádzajúceho a aktuálneho úseku je stred bunky zákruty
    const vertical = flip.prevHeading === 0 || flip.prevHeading === 180;
    const knee = { x: vertical ? flip.prevX : flip.x, y: vertical ? flip.y : flip.prevY };
    expect(knee).toEqual({ x: CENTER.x + 0.5, y: CENTER.y + 0.5 });
    // pred zlomom je vozidlo už v bunke zákruty (vstupná polovica) so starým kurzom — kurz zákruty ešte nemá
    const before = ticks[ticks.indexOf(flip) - 1];
    expect(before.heading).toBe(entry);
    expect(Math.floor(before.x) === CENTER.x || Math.floor(before.y) === CENTER.y).toBe(true);
  });

  it.each(CASES)('$entry°, zákruta $delta: pózy skutočného vozidla idú po oblúku a sú spojité (každých 1/20 ticku)', ({ entry, delta }) => {
    const { grid, cells } = corner(entry, delta);
    const roadKindAt = createRoadKindAt(grid);
    const roadMaskAt = createRoadMaskAt(grid);
    const dIn = forwardOf(entry);
    const dOut = forwardOf(normalizeAngle(entry + delta) as ViewRotation);
    // stred oblúka = roh bunky zákruty, v ktorom sa stretávajú hrany vstupu a výstupu
    const q = { x: CENTER.x + 0.5 - 0.5 * dIn.x + 0.5 * dOut.x, y: CENTER.y + 0.5 - 0.5 * dIn.y + 0.5 * dOut.y };
    const radius = (delta > 0 ? 19 : 45) / 64;
    let previous: { x: number; y: number } | null = null;
    let onArc = 0;
    for (const vm of driveRealVehicle(cells, entry)) {
      for (let i = 0; i <= 20; i++) {
        const pose = vehiclePose(vm, i / 20, 64, roadKindAt, roadMaskAt);
        const point = { x: pose.x / 64, y: pose.y / 64 };
        if (previous !== null) expect(Math.hypot(point.x - previous.x, point.y - previous.y)).toBeLessThan(0.045);
        previous = point;
        if (Math.floor(point.x) === CENTER.x && Math.floor(point.y) === CENTER.y) {
          // pózy v bunke zákruty (mimo hranu, kde sa oblúk napája na priamy pruh) ležia presne na oblúku
          expect(Math.hypot(point.x - q.x, point.y - q.y)).toBeCloseTo(radius, 6);
          onArc += 1;
        }
      }
    }
    expect(onArc).toBeGreaterThan(20);
  });
});
