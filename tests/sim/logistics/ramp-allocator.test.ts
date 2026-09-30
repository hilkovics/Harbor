// RampAllocator (T04-03; ARCHITECTURE §7.3 bod 2; ADR-022, ADR-023): kandidát je rampa kategórie nákladu s voľným
// staging miestom, prevádzková a zo zdroja dosiahnuteľná po ceste; vyhráva najmenšia vzdialenosť, pri zhode menšie id.
// Výber svet nemení. Rozloženie: outbound-fixtures.ts.
import { describe, expect, it } from 'vitest';
import { acceptsOutbound, allocateRamp } from '@sim/logistics';
import { execute, gateOf, outboundWorld, rampOf, stagingOf } from './outbound-fixtures';

describe('allocateRamp / acceptsOutbound', () => {
  it('prevádzková rampa s voľným miestom a cestou zo skladu je kandidát; výber nič nerezervuje', () => {
    const { world, far } = outboundWorld();
    const ramp = rampOf(world);
    expect(acceptsOutbound(world, ramp, 'container')).toBe(true);
    expect(allocateRamp(world, far, 'container')).toBe(ramp);
    expect(stagingOf(ramp)).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it('iná kategória, plná rampa, neprevádzková rampa ani prázdny predvýber kandidáta nedajú', () => {
    const { world, far } = outboundWorld();
    const ramp = rampOf(world);
    expect(acceptsOutbound(world, ramp, 'bulk')).toBe(false);
    expect(allocateRamp(world, far, 'bulk')).toBeUndefined();
    expect(allocateRamp(world, far, 'container', [])).toBeUndefined();
    expect(allocateRamp(world, far, 'container', [far])).toBeUndefined();

    for (const dock of [0, 0, 1, 1]) ramp.reserve(dock);
    expect([ramp.freeCount, acceptsOutbound(world, ramp, 'container')]).toEqual([0, false]);
    expect(allocateRamp(world, far, 'container')).toBeUndefined();
    for (const dock of [0, 0, 1, 1]) ramp.release(dock);

    execute(world, { type: 'RemoveModule', moduleId: gateOf(world).id });
    expect([world.isRampOperational(ramp), acceptsOutbound(world, ramp, 'container')]).toEqual([false, false]);
    expect(allocateRamp(world, far, 'container')).toBeUndefined();
  });

  it('rampa zo zdroja nedosiahnuteľná po ceste (prevádzková pre kamióny) kandidát nie je', () => {
    const { world, far } = outboundWorld({ omitRoads: [{ x: 51, y: 30 }] });
    const ramp = rampOf(world);
    expect(acceptsOutbound(world, ramp, 'container')).toBe(true);
    expect(allocateRamp(world, far, 'container')).toBeUndefined();
  });
});
