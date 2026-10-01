// T04-08: dáta inšpektora pre bránu, stojisko a rampu (F4) — fronta a priepustnosť za hodinu, obsadenie stojísk,
// docky rampy so staging sloty a text dôvodu neprevádzkovosti. Pole `truck` docku = kamión drží dock a práve nakladá
// (stav `loading`); kamióny vznikajú skutočným tickom celého reťazca.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { LoadingRamp, TruckGate, WaitingArea } from '@sim/modules';
import { inspectorData } from '@app/inspector-data';
import { RAMP_INOPERATIVE_TEXTS } from '@ui/module-inspector';
import { AREA_ID, CHAIN_RAMP_ID, GATE_ID, RAMP_ID, buildFullChain, buildLandside, createApp, frameUntil, type App } from './app-fixtures';

const TRUCK_A = 901 as EntityId;
const TRUCK_B = 902 as EntityId;

function landsideApp(): App {
  const app = createApp();
  buildLandside(app);
  return app;
}

const gateOf = (app: App): TruckGate => app.world.modules.get(GATE_ID) as TruckGate;
const areaOf = (app: App): WaitingArea => app.world.modules.get(AREA_ID) as WaitingArea;
const rampOf = (app: App): LoadingRamp => app.world.modules.get(RAMP_ID) as LoadingRamp;

/** Jednotka priamo na docku rampy (ledger s fiktívnymi držiteľmi; svet sa netikuje). */
function stage(app: App, dock: number): void {
  const { world } = app;
  const ramp = rampOf(app);
  const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as EntityId }).id;
  world.cargo.move(unit, { kind: 'in_crane', craneId: 901 as EntityId });
  world.cargo.move(unit, { kind: 'on_apron', berthId: 1 as EntityId, slot: 0 });
  world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
  ramp.reserve(dock);
  world.cargo.move(unit, { kind: 'at_ramp', rampId: ramp.id, dock });
  ramp.commit(dock, unit);
}

describe('inspectorData: brána', () => {
  it('pripojená prázdna brána: fronta 0, priepustnosť = ticksPerHour / processTicks, processTicks z defu', () => {
    const app = landsideApp();
    const data = inspectorData(app.bridge, GATE_ID);
    const { ticksPerHour } = app.world.clock;
    expect(data).toMatchObject({
      defId: 'truck_gate',
      displayName: 'Brána kamiónov',
      kind: 'gate',
      footprint: { w: 2, h: 2 },
      stateLabel: 'V prevádzke',
      ok: true,
      connected: true,
      removable: true,
      gate: { queueLength: 0, throughputPerHour: ticksPerHour / 18, processTicks: 18 },
    });
    expect(data?.storage).toBeUndefined();
    expect(data?.waitingArea).toBeUndefined();
    expect(data?.ramp).toBeUndefined();
  });

  it('priepustnosť sa počíta z time.json, nie natvrdo: ticksPerHour × (1 / processTicks)', () => {
    const app = landsideApp();
    const throughput = inspectorData(app.bridge, GATE_ID)?.gate?.throughputPerHour ?? 0;
    expect(throughput).toBe(app.world.clock.ticksPerHour / gateOf(app).params.processTicks);
    expect(throughput).toBeGreaterThan(0);
  });

  it('fronta ide z modulu brány', () => {
    const app = landsideApp();
    gateOf(app).enqueue(TRUCK_A);
    gateOf(app).enqueue(TRUCK_B);
    expect(inspectorData(app.bridge, GATE_ID)?.gate?.queueLength).toBe(2);
  });

  it('nepripojená brána (bez ciest): priepustnosť 0, connected false, fronta a processTicks ostávajú', () => {
    const app = createApp();
    buildLandside(app, { roads: false, parts: ['gate'] });
    expect(inspectorData(app.bridge, GATE_ID)).toMatchObject({
      connected: false,
      gate: { queueLength: 0, throughputPerHour: 0, processTicks: 18 },
    });
  });
});

describe('inspectorData: stojisko', () => {
  it('prázdne stojisko: 6 stojísk, nič obsadené ani rezervované', () => {
    const app = landsideApp();
    expect(inspectorData(app.bridge, AREA_ID)).toMatchObject({
      defId: 'truck_waiting_area',
      kind: 'waiting_area',
      footprint: { w: 4, h: 3 },
      stateLabel: 'V prevádzke',
      connected: true,
      waitingArea: { bays: 6, occupied: 0, reserved: 0 },
    });
  });

  it('rezervované (kamión na ceste) a obsadené (kamión stojí) sa počítajú zvlášť', () => {
    const app = landsideApp();
    const area = areaOf(app);
    area.reserveBay(TRUCK_A);
    area.reserveBay(TRUCK_B);
    area.occupyBay(TRUCK_B);
    expect(inspectorData(app.bridge, AREA_ID)?.waitingArea).toEqual({ bays: 6, occupied: 1, reserved: 1 });
    area.releaseBay(TRUCK_B);
    expect(inspectorData(app.bridge, AREA_ID)?.waitingArea).toEqual({ bays: 6, occupied: 0, reserved: 1 });
  });
});

describe('inspectorData: rampa', () => {
  it('prevádzková prázdna rampa: 2 docky s kapacitou stagingPerDock, bez kamióna, bez dôvodu', () => {
    const app = landsideApp();
    const data = inspectorData(app.bridge, RAMP_ID);
    expect(data).toMatchObject({
      defId: 'loading_ramp_container',
      kind: 'ramp',
      footprint: { w: 4, h: 2 },
      connected: true,
      ramp: {
        docks: [
          { staged: 0, capacity: 4, truck: false },
          { staged: 0, capacity: 4, truck: false },
        ],
        operational: true,
      },
    });
    expect(data?.ramp?.inoperativeReason).toBeUndefined();
    expect(Object.keys(data?.ramp ?? {})).not.toContain('inoperativeReason');
  });

  it('staged po dockoch idú z ledgera; rampa s jednotkami sa nedá odstrániť (has_cargo)', () => {
    const app = landsideApp();
    stage(app, 0);
    stage(app, 1);
    stage(app, 1);
    const data = inspectorData(app.bridge, RAMP_ID);
    expect(data?.ramp?.docks.map((dock) => dock.staged)).toEqual([1, 2]);
    expect(data).toMatchObject({ removable: false, removeBlockedReason: 'Modul obsahuje náklad' });
  });

  it('rampa bez brány a stojiska: neprevádzková s textom dôvodu zo simu (rampInoperativeText)', () => {
    const app = createApp();
    buildLandside(app, { parts: ['ramp'] });
    const ramp = app.world.modules.get(GATE_ID) as LoadingRamp; // jediný postavený modul má prvé voľné id
    const { reason } = app.world.rampStatus(ramp);
    expect(reason).not.toBeNull();
    const data = inspectorData(app.bridge, ramp.id);
    expect(data?.ramp?.operational).toBe(false);
    expect(data?.ramp?.inoperativeReason).toBe(RAMP_INOPERATIVE_TEXTS[reason as string]);
    expect(data?.ramp?.inoperativeReason).toEqual(expect.any(String));
  });

  it('rampa s cestami, ale bez brány: dôvod „Chýba brána na ceste.“; bez stojiska: „Chýba stojisko na ceste.“', () => {
    const noGate = createApp();
    buildLandside(noGate, { parts: ['waiting_area', 'ramp'] });
    const rampNoGate = [...noGate.world.modules.values()].find((module) => module instanceof LoadingRamp) as LoadingRamp;
    expect(noGate.world.rampStatus(rampNoGate).reason).toBe('no_gate');
    expect(inspectorData(noGate.bridge, rampNoGate.id)?.ramp).toMatchObject({ operational: false, inoperativeReason: 'Chýba brána na ceste.' });

    const noArea = createApp();
    buildLandside(noArea, { parts: ['gate', 'ramp'] });
    const rampNoArea = [...noArea.world.modules.values()].find((module) => module instanceof LoadingRamp) as LoadingRamp;
    expect(noArea.world.rampStatus(rampNoArea).reason).toBe('no_waiting_area');
    expect(inspectorData(noArea.bridge, rampNoArea.id)?.ramp).toMatchObject({ operational: false, inoperativeReason: 'Chýba stojisko na ceste.' });
  });

  it('po dostavaní brány a stojiska sa rampa v inšpektore prepne na prevádzkovú a dôvod zmizne', () => {
    const app = createApp();
    buildLandside(app, { parts: ['ramp'] });
    const ramp = [...app.world.modules.values()].find((module) => module instanceof LoadingRamp) as LoadingRamp;
    expect(inspectorData(app.bridge, ramp.id)?.ramp?.operational).toBe(false);
    buildLandside(app, { roads: false, parts: ['gate', 'waiting_area'] });
    const after = inspectorData(app.bridge, ramp.id);
    expect(after?.ramp?.operational).toBe(true);
    expect(Object.keys(after?.ramp ?? {})).not.toContain('inoperativeReason');
  });
});

describe('inspectorData: rampa, kamión v docku (celý reťazec)', () => {
  const truckFlags = (app: App): boolean[] => (inspectorData(app.bridge, CHAIN_RAMP_ID)?.ramp?.docks ?? []).map((dock) => dock.truck);
  const trucksOf = (app: App): { readonly dock: number; readonly state: string }[] => [...app.world.trucks.values()].filter((truck) => truck.rampId === CHAIN_RAMP_ID);

  it('`truck` je true len na docku, kde kamión práve nakladá (loading); na ceste k docku, v stojisku ani po odchode nie', () => {
    const app = createApp();
    buildFullChain(app, { units: 6 });
    const seen = { loadingTrue: 0, other: 0 };
    frameUntil(
      app,
      () => {
        const flags = truckFlags(app);
        const loading = new Set(trucksOf(app).filter((truck) => truck.state === 'loading').map((truck) => truck.dock));
        expect(flags).toEqual([0, 1].map((dock) => loading.has(dock)));
        if (loading.size > 0) seen.loadingTrue += 1;
        else seen.other += 1;
        return app.world.cargo.exportedCount === 6;
      },
      6000,
    );
    expect(seen.loadingTrue).toBeGreaterThan(0);
    expect(seen.other).toBeGreaterThan(0);
    expect(truckFlags(app)).toEqual([false, false]); // po exporte nikto nenakladá
  });

  it('kamión, ktorý dock drží, ale ešte k nemu ide (to_dock), sa neráta; rampa s nakladajúcim kamiónom sa nedá odstrániť', () => {
    const app = createApp();
    buildFullChain(app, { units: 6 });
    frameUntil(app, () => trucksOf(app).some((truck) => truck.state === 'to_dock'), 3000);
    const heading = trucksOf(app).find((truck) => truck.state === 'to_dock');
    expect(app.world.modules.get(CHAIN_RAMP_ID)).toBeInstanceOf(LoadingRamp);
    expect(truckFlags(app)[heading?.dock ?? 0]).toBe(false);
    frameUntil(app, () => trucksOf(app).some((truck) => truck.state === 'loading'), 3000);
    expect(inspectorData(app.bridge, CHAIN_RAMP_ID)).toMatchObject({ removable: false });
  });
});
