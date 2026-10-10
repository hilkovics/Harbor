// T04-08 (R4, TR4-02): dáta inšpektora pre bránu — fronta a priepustnosť za hodinu. Rampa a čakacia plocha zanikli (ADR-041); kamióny vznikajú skutočným tickom reťazca.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { TruckGate } from '@sim/modules';
import { inspectorData } from '@app/inspector-data';
import { CHAIN_GATE_ID, buildFullChain, createPortApp, runCommands, type App } from './app-fixtures';

const TRUCK_A = 901 as EntityId;
const TRUCK_B = 902 as EntityId;

function landsideApp(): App {
  const app = createPortApp();
  buildFullChain(app, { units: 0, vehicles: 0 });
  return app;
}

const gateOf = (app: App): TruckGate => app.world.modules.get(CHAIN_GATE_ID) as TruckGate;

describe('inspectorData: brána', () => {
  it('pripojená prázdna brána: fronta 0, priepustnosť = ticksPerHour / processTicks, processTicks = stredný čas obsluhy z defu', () => {
    const app = landsideApp();
    const data = inspectorData(app.bridge, CHAIN_GATE_ID);
    const { ticksPerHour } = app.world.clock;
    expect(data).toMatchObject({
      defId: 'gate_in_lane',
      displayName: 'Vstupný pruh brány',
      kind: 'gate',
      footprint: { w: 1, h: 4 },
      stateLabel: 'V prevádzke',
      ok: true,
      connected: true,
      removable: true,
      gate: { queueLength: 0, throughputPerHour: ticksPerHour / 15, processTicks: 15 },
    });
    expect(data?.storage).toBeUndefined();
  });

  it('priepustnosť sa počíta z time.json, nie natvrdo: ticksPerHour × (1 / processTicks)', () => {
    const app = landsideApp();
    const throughput = inspectorData(app.bridge, CHAIN_GATE_ID)?.gate?.throughputPerHour ?? 0;
    const gate = gateOf(app);
    expect(throughput).toBe(app.world.clock.ticksPerHour / Math.max(1, Math.round(gate.meanServiceTicks(gate.mode))));
    expect(throughput).toBeGreaterThan(0);
  });

  it('fronta ide z modulu brány', () => {
    const app = landsideApp();
    gateOf(app).enqueue(TRUCK_A);
    gateOf(app).enqueue(TRUCK_B);
    expect(inspectorData(app.bridge, CHAIN_GATE_ID)?.gate?.queueLength).toBe(2);
  });

  it('nepripojená brána (bez ciest): priepustnosť 0, connected false, fronta a processTicks ostávajú', () => {
    const app = createPortApp();
    runCommands(app, [{ type: 'PlaceModule', defId: 'gate_in_lane', x: 52, y: 20, rotation: 0 }]);
    const gate = [...app.world.modules.values()].find((module): module is TruckGate => module instanceof TruckGate);
    expect(inspectorData(app.bridge, gate?.id as EntityId)).toMatchObject({
      connected: false,
      gate: { queueLength: 0, throughputPerHour: 0, processTicks: 15 },
    });
  });
});
