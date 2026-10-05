/**
 * Vertikálny rez M1 v predvolenom režime `under_hook` (F6a, T6A-05, ADR-033): `vertical_slice` s bundled defmi (hák, buffer 1) dá
 * rovnaký golden report ako režim `apron` (`tests/sim/__golden__/vertical_slice.json`) — peniaze, exportované jednotky, včasnosť
 * a XP nezávisia od spôsobu odovzdávania žeriav ↔ vozidlo; `lostUnits 0`, každý presun je legálny (`assertCargoConservation`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@sim/events';
import { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { REPO_ROOT, loadScenarioFile, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS, PORT_MAP } from '../world/world-fixtures';

const TICKS = 60_000;
const RUN_TIMEOUT_MS = 300_000;

describe('vertical_slice v režime under_hook', () => {
  it('golden report (cashEnd, exportedUnits, onTimeRate, contractsCompleted, xp) je rovnaký ako v režime apron; žeriav čakal na vozidlo', () => {
    expect(BUNDLED_DEFS.modules.get('berth_standard').params['handoverMode']).toBe('under_hook');
    const scenario = loadScenarioFile('vertical_slice');
    const world = World.create(BUNDLED_DEFS, PORT_MAP, scenario.seed);
    const completed: SimEvent[] = [];
    runScenario(world, scenario, TICKS, {
      afterTick: (w, events) => {
        assertCargoConservation(w);
        for (const event of events) if (event.type === 'ContractCompleted') completed.push(event);
      },
    });
    const golden = JSON.parse(readFileSync(`${REPO_ROOT}tests/sim/__golden__/vertical_slice.json`, 'utf8')) as Record<string, unknown>;
    expect({
      cashEnd: world.cashCents,
      exportedUnits: world.cargo.exportedCount,
      onTimeRate: completed.length === 0 ? null : completed.filter((event) => event.type === 'ContractCompleted' && event.onTime).length / completed.length,
      contractsCompleted: completed.length,
      xp: world.xp,
    }).toEqual(golden);
    expect(lostUnits(world)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
    // Všetky jednotky opustili mapu po súši; žeriav pod hákom čakal na vozidlo (metrika `craneWaitForVehicleTicks`).
    expect(world.cargo.liveCount).toBe(0);
    const waits = [...world.modules.values()].map((module) => (module as { waitForVehicleTicks?: number }).waitForVehicleTicks ?? 0);
    expect(Math.max(...waits)).toBeGreaterThan(0);
  }, RUN_TIMEOUT_MS);
});
