// Zdieľaný pohyb po cestách (T04-04, ADR-024): Carrier ako báza vozidla aj kamióna — chyby vstupu v triede podtriedy,
// prechod modulom `jumpTo`, plánovanie k bunke `planRouteToCell` a kontrola pohybu s cieľom = konkrétna bunka.
import { describe, expect, it } from 'vitest';
import { NO_ACCESS } from '@sim/logistics';
import {
  Carrier,
  advanceCarrier,
  carrierMotionProblem,
  carrierPoseProblem,
  carrierPosition,
  carrierRouteProblem,
  planRouteToCell,
  type CarrierInit,
  type MotionTraits,
} from '@sim/movement';
import { Vehicle, VehicleError, vehiclePosition } from '@sim/vehicles';
import { DEFS } from '../world/world-fixtures';
import { QUAY_ROAD, dispatchWorld } from '../logistics/dispatch-fixtures';

class TestError extends Error {}

/** Minimálna podtrieda — overuje, že báza nepozná triedu nosiča. */
class TestCarrier extends Carrier {
  readonly id = 1 as never;
  readonly kind = 'vehicle' as const;

  constructor(init: CarrierInit) {
    super(init);
  }

  get lengthCells(): number {
    return 2;
  }

  get label(): string {
    return 'test #1';
  }

  protected invalidInput(message: string): Error {
    return new TestError(message);
  }
}

const DRIVE: MotionTraits = { motion: 'drive', waits: false };
const PARK: MotionTraits = { motion: 'park', waits: false };

describe('Carrier', () => {
  it('chyby metód pohybu idú v triede chyby podtriedy (Vehicle → VehicleError, iný nosič → vlastná)', () => {
    const carrier = new TestCarrier({ x: 0.5, y: 0.5, heading: 0, route: [0] });
    expect(() => carrier.followRoute([5])).toThrow(TestError);
    const vehicle = new Vehicle({
      id: 7 as never,
      def: DEFS.vehicles.get('straddle_carrier'),
      depotId: 3 as never,
      state: 'idle',
      x: 0.5,
      y: 0.5,
      heading: 0,
      purchaseCostCents: 0,
      route: [0],
    });
    expect(() => vehicle.followRoute([5])).toThrow(VehicleError);
    expect(vehicle).toBeInstanceOf(Carrier);
  });

  it('jumpTo: stojaci nosič sa objaví v strede inej bunky s trasou [cell], kurz ostáva; rozbehnutý → chyba, nezmení sa', () => {
    const width = 10;
    const carrier = new TestCarrier({ x: 2.5, y: 0.5, heading: 90, route: [2, 3, 4] });
    carrier.replanPending = true;
    carrier.jumpTo(25, width);
    expect([carrier.cell, carrier.nextCell, carrier.progress, carrier.x, carrier.y, carrier.heading, carrier.replanPending]).toEqual([25, undefined, 0, 5.5, 2.5, 90, false]);
    const moving = new TestCarrier({ x: 2.75, y: 0.5, heading: 90, route: [2, 3], progress: 0.25 });
    expect(() => moving.jumpTo(25, width)).toThrow(TestError);
    expect([moving.cell, moving.progress]).toEqual([2, 0.25]);
    expect(() => carrier.jumpTo(-1, width)).toThrow(TestError);
  });

  it('carrierPosition = vehiclePosition (jedna implementácia) a pomocníci vstupu hlásia problémy s popisom nosiča', () => {
    expect(carrierPosition(12, 13, 0.5, 10)).toEqual(vehiclePosition(12, 13, 0.5, 10));
    expect(carrierPoseProblem('x', { x: Number.NaN, y: 0, heading: 0 })).toMatch(/x: poloha/);
    expect(carrierPoseProblem('x', { x: 0, y: 0, heading: 45 as never })).toMatch(/kurz/);
    expect(carrierRouteProblem('x', { route: [] })).toMatch(/trasa/);
    expect(carrierRouteProblem('x', { route: [1], progress: 0.5 })).toMatch(/bez ďalšej bunky/);
    expect(carrierRouteProblem('x', { route: [1, 2], progress: 0.5, waitTicks: -1 })).toMatch(/waitTicks/);
    expect(carrierRouteProblem('x', { route: [1, 2], progress: 0.5, waitTicks: 2 })).toBeUndefined();
  });
});

describe('planRouteToCell a kontrola pohybu s cieľovou bunkou', () => {
  it('plán do bunky po ceste, jazda po trase a príchod; NO_ACCESS a bunka bez cesty → false, nosič sa nezmení', () => {
    const { world } = dispatchWorld();
    const start = world.grid.index(QUAY_ROAD[0].x, QUAY_ROAD[0].y);
    const target = world.grid.index(QUAY_ROAD[5].x, QUAY_ROAD[5].y);
    const position = carrierPosition(start, undefined, 0, world.grid.width);
    const carrier = new TestCarrier({ x: position.x, y: position.y, heading: 90, route: [start] });
    expect(planRouteToCell(world, carrier, NO_ACCESS)).toBe(false);
    expect(planRouteToCell(world, carrier, world.grid.index(0, 0))).toBe(false);
    expect(carrier.remainingRoute()).toEqual([start]);
    expect(planRouteToCell(world, carrier, target)).toBe(true);
    expect(carrier.remainingRoute()).toHaveLength(6);
    expect(carrierMotionProblem(world, carrier, 'drive', DRIVE, target)).toBeUndefined();
    expect(carrierMotionProblem(world, carrier, 'drive', DRIVE, start)?.problem).toMatch(/trasa nekončí na cieľovej bunke/);
    let arrived = false;
    for (let i = 0; i < 20 && !arrived; i++) arrived = advanceCarrier(world, carrier, 0.6);
    expect(arrived).toBe(true);
    expect(carrier.cell).toBe(target);
    expect(carrierMotionProblem(world, carrier, 'park', PARK, target)).toBeUndefined();
    expect(carrierMotionProblem(world, carrier, 'park', PARK, start)?.problem).toMatch(/nestojí na cieľovej bunke/);
  });
});
