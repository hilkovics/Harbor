// Dopredné plánovanie jobov pod hákom (TR3-02d, ADR-040 dodatok): `logistics.hookJobLookahead` ohraničuje joby vykládky aj nakládky na žeriav a ťahače sa pred žeriavom radia vopred.
import { describe, expect, it } from 'vitest';
import { loadMap, parseMapDef } from '@sim/grid';
import { CraneModule } from '@sim/modules';
import { World } from '@sim/world';
import { acceptCommand, hookDefs, send } from '../helpers/f6a';
import { offerTranship } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

const ECONOMY = { startingCashCents: 400_000_000, transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] };

describe('hookJobLookahead: joby pod hákom na žeriav', () => {
  const scenario = loadScenarioFile('tt_rtg_2blocks');
  const world = World.create(hookDefs(0, { economy: ECONOMY }), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed, { checkInvariants: true });
  runScenario(world, scenario, 1);
  send(world, acceptCommand(offerTranship(world, { units: 40 }).id));
  const lookahead = world.defs.logistics.hookJobLookahead;
  const cranes = [...world.modules.values()].filter((module): module is CraneModule => module instanceof CraneModule);
  let maxUnload = 0;
  let maxLoad = 0;
  let overLimit = 0;
  for (let i = 0; i < 20_000; i++) {
    world.tick();
    for (const crane of cranes) {
      let unload = 0;
      let load = 0;
      for (const job of world.jobs.values()) {
        if (job.from.kind === 'in_crane' && job.from.craneId === crane.id) unload += 1;
        if (job.to.kind === 'in_crane' && job.to.craneId === crane.id) load += 1;
      }
      maxUnload = Math.max(maxUnload, unload);
      maxLoad = Math.max(maxLoad, load);
      if (unload > lookahead || load > lookahead) overLimit += 1;
    }
  }

  it('def je kladné celé číslo a žiadny žeriav nikdy nemá viac jobov vykládky ani nakládky než okno', () => {
    expect(Number.isInteger(lookahead)).toBe(true);
    expect(lookahead).toBeGreaterThanOrEqual(1);
    expect(overLimit).toBe(0);
  });

  it('pipeline funguje: vykládka aj nakládka majú vopred priradených viac jobov než 1', () => {
    expect(maxUnload).toBeGreaterThan(1);
    expect(maxUnload).toBeLessThanOrEqual(lookahead);
    expect(maxLoad).toBeGreaterThan(world.defs.logistics.hookPairedLoadJobs);
  });

  it('nič sa nestratilo a svet je konzistentný', () => {
    assertCargoConservation(world);
    expect([...world.vehicles.values()].filter((vehicle) => vehicle.blockedTicks >= world.defs.logistics.traffic.stuckTicks)).toHaveLength(0);
  });
}, 300_000);
