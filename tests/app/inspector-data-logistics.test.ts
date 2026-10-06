// T03-10: dáta inšpektora pre sklad a depo vozidiel (F3) + `connected` pre moduly s cestným konektorom.
import { describe, expect, it } from 'vitest';
import { VEHICLE_STATES } from '@sim/vehicles';
import { DEPOT_VEHICLE_STATE, depotVehicleDef, inspectorData } from '@app/inspector-data';
import { DEPOT_ID, YARD_ID, buildLogistics, buyVehicles, createApp, frameUntil, runCommands } from './app-fixtures';
import { setCash } from '../sim/helpers/economy';

describe('inspectorData: sklad (kontajnerový dvor)', () => {
  it('prázdny pripojený dvor: 0 / 0 / 48, počítadlá 0, jednotka TEU, pripojený, odstrániteľný s refundom polovice ceny', () => {
    const app = createApp();
    buildLogistics(app);
    const data = inspectorData(app.bridge, YARD_ID);
    expect(data).toMatchObject({
      id: YARD_ID,
      defId: 'container_yard_small',
      displayName: 'Kontajnerový dvor S',
      kind: 'storage',
      footprint: { w: 4, h: 4 },
      stateLabel: 'V prevádzke',
      ok: true,
      storage: { stored: 0, reserved: 0, capacity: 48, unitsIn: 0, unitsOut: 0, split: { import: 0, export: 0, tranship: 0, empty: 0 }, unitLabel: 'TEU' },
      connected: true,
      refundCents: 7_500_000,
      removable: true,
    });
    // R2: geometria z defu (4×4×3 = 48 TEU) a stohy; kapacita = min(capacityUnits 64, geometria 48)
    expect(data?.yardBlock).toBeDefined();
    expect(data?.yardBlock?.geometry).toEqual({ bays: 4, rows: 4, maxTier: 3 });
    expect(data?.yardBlock?.capacityTeu).toBe(48);
    expect(data?.yardBlock?.usedTeu).toBe(0);
    expect(data?.yardBlock?.stacks?.length).toBe(16); // 4 bays × 4 rows
  });

  it('dvor bez cesty: connected false (badge „Nepripojené“ nesie UI)', () => {
    const app = createApp();
    buildLogistics(app, { roads: false });
    expect(inspectorData(app.bridge, YARD_ID)).toMatchObject({ connected: false, storage: { stored: 0, capacity: 48 } });
  });

  it('kapacita, stored, reserved a počítadlá idú z modulu; po vykládke sedí unitsIn a dvor s nákladom nejde odstrániť', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 2);
    runCommands(app, [{ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }]);
    let reservedSeen = 0;
    frameUntil(
      app,
      () => {
        reservedSeen += inspectorData(app.bridge, YARD_ID)?.storage?.reserved ?? 0;
        return app.world.cargo.countByKind('in_storage') === 4;
      },
      12000,
    );
    // nájdi dvor, do ktorého sa ukladalo (alokátor berie bližší); súčet cez oba dvory je 4
    const yards = [YARD_ID, YARD_ID + 1].map((id) => inspectorData(app.bridge, id as never));
    expect(yards.reduce((sum, data) => sum + (data?.storage?.stored ?? 0), 0)).toBe(4);
    expect(yards.reduce((sum, data) => sum + (data?.storage?.unitsIn ?? 0), 0)).toBe(4);
    expect(yards.reduce((sum, data) => sum + (data?.storage?.reserved ?? 0), 0)).toBe(0);
    const used = yards.find((data) => (data?.storage?.stored ?? 0) > 0);
    expect(used).toMatchObject({ removable: false, removeBlockedReason: 'Modul obsahuje náklad' });
    expect(reservedSeen).toBeGreaterThan(0);
  });
});

describe('inspectorData: depo vozidiel', () => {
  it('depo s dvoma nečinnými vozidlami: riadky s labelom a refundom, kapacita 6, nákup dostupný za cenu z defu', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 2);
    const data = inspectorData(app.bridge, DEPOT_ID);
    expect(data).toMatchObject({
      defId: 'vehicle_depot',
      kind: 'depot',
      stateLabel: 'V prevádzke',
      connected: true,
      depot: { capacity: 10, canBuy: true, buyPriceCents: app.world.defs.vehicles.get('straddle_carrier').purchaseCents },
      removable: false,
      removeBlockedReason: 'Depo má vozidlá',
    });
    expect(data?.depot?.buyBlockedReason).toBeUndefined();
    expect(data?.depot?.vehicles).toEqual(
      [...app.world.vehicles.keys()].map((id) => ({ id, label: 'Straddle carrier', state: 'idle', fsmState: 'parked', detailedState: 'Parkuje v depe', refundCents: 2_400_000 })),
    );
  });

  it('prázdne depo je odstrániteľné a nákup je dostupný', () => {
    const app = createApp();
    buildLogistics(app);
    expect(inspectorData(app.bridge, DEPOT_ID)).toMatchObject({ removable: true, depot: { vehicles: [], canBuy: true } });
  });

  it('plné depo: canBuy false, dôvod „Depo je plné“', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, app.world.defs.modules.get('vehicle_depot').params['capacity'] as number);
    const data = inspectorData(app.bridge, DEPOT_ID);
    expect(data?.depot).toMatchObject({ canBuy: false, buyBlockedReason: 'Depo je plné' });
    expect(data?.depot?.vehicles).toHaveLength(app.world.defs.modules.get('vehicle_depot').params['capacity'] as number);
  });

  it('nedostatok peňazí: canBuy false, „Nedostatok peňazí“', () => {
    const app = createApp();
    buildLogistics(app);
    setCash(app.world, 1_000);
    expect(inspectorData(app.bridge, DEPOT_ID)?.depot).toMatchObject({ canBuy: false, buyBlockedReason: 'Nedostatok peňazí' });
  });

  it('nepripojené depo: connected false a nákup zablokovaný dôvodom „Nepripojené k ceste“', () => {
    const app = createApp();
    buildLogistics(app, { roads: false });
    const data = inspectorData(app.bridge, DEPOT_ID);
    expect(data).toMatchObject({ connected: false, depot: { canBuy: false, buyBlockedReason: 'Nepripojené k ceste' } });
  });

  it('viac dôvodov naraz sa spojí ` · ` v poradí VALIDATION_REASONS (peniaze pred pripojením)', () => {
    const app = createApp();
    buildLogistics(app, { roads: false });
    setCash(app.world, 0);
    expect(inspectorData(app.bridge, DEPOT_ID)?.depot?.buyBlockedReason).toBe('Nedostatok peňazí · Nepripojené k ceste');
  });

  it('vozidlá za behu: pracovné stavy sú `busy`, nečinné `idle`; predať ide len nečinnému (validate → refund)', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 2);
    runCommands(app, [{ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }]);
    const seen = new Set<string>();
    frameUntil(
      app,
      () => {
        const rows = inspectorData(app.bridge, DEPOT_ID)?.depot?.vehicles ?? [];
        for (const row of rows) {
          seen.add(row.state);
          const vehicle = app.world.vehicles.get(row.id as never);
          expect(row.state).toBe(DEPOT_VEHICLE_STATE[vehicle?.state ?? 'idle']);
        }
        return app.world.cargo.countByKind('in_storage') === 4;
      },
      12000,
    );
    expect(seen.has('busy')).toBe(true);
    expect(seen.has('idle')).toBe(true);
  });
});

describe('DEPOT_VEHICLE_STATE a depotVehicleDef', () => {
  it('každý stav FSM vozidla má stav v zozname depa: idle, to_depot a parked → idle, no_path → no_path, ostatné → busy', () => {
    expect(Object.keys(DEPOT_VEHICLE_STATE).sort()).toEqual([...VEHICLE_STATES].sort());
    expect(DEPOT_VEHICLE_STATE.idle).toBe('idle');
    expect(DEPOT_VEHICLE_STATE.no_path).toBe('no_path');
    // parkovanie (R1): zatiaľ sa zobrazuje ako nečinné (texty nových stavov prinesie TR1-07)
    for (const state of ['to_depot', 'parked'] as const) expect(DEPOT_VEHICLE_STATE[state]).toBe('idle');
    for (const state of VEHICLE_STATES.filter((s) => !['idle', 'no_path', 'to_depot', 'parked'].includes(s))) expect(DEPOT_VEHICLE_STATE[state]).toBe('busy');
  });

  it('ponúkané vozidlo depa je prvý def bez technológie (straddle_carrier)', () => {
    expect(depotVehicleDef(createApp().world.defs)?.id).toBe('straddle_carrier');
  });
});
