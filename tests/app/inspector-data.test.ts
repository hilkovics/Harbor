import { describe, expect, it } from 'vitest';
import { PlaceModuleCommand, commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { CraneModule } from '@sim/modules';
import { BERTH_STATE_DOCKED, BERTH_STATE_FREE, inspectorData, sameInspectorData } from '@app/inspector-data';
import { createApp } from './app-fixtures';

const ROOT_BERTH = 1 as EntityId;
const ROOT_CRANE = 2 as EntityId;

/** Posúva svet po ticku, kým `done()` neplatí (strop chráni pred nekonečnou slučkou pri chybe). */
function tickUntil(app: ReturnType<typeof createApp>, done: () => boolean, limit = 4000): void {
  for (let i = 0; i < limit && !done(); i += 1) app.world.tick();
  expect(done(), 'podmienka sa do limitu ticků nesplnila').toBe(true);
}

function spawnFeeder(app: ReturnType<typeof createApp>): void {
  app.bridge.dispatch(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }));
}

describe('inspectorData: Root kotvisko a žeriav pri štarte', () => {
  it('kotvisko bez lode: Voľné, apron 0/0/8, bez lode; odstrániť nejde (má žeriav), refundácia 0 (starter)', () => {
    const app = createApp();
    expect(inspectorData(app.bridge, ROOT_BERTH)).toEqual({
      id: 1,
      defId: 'berth_standard',
      displayName: 'Kotvisko',
      kind: 'berth',
      footprint: { w: 8, h: 3 },
      stateLabel: BERTH_STATE_FREE,
      ok: true,
      apron: { used: 0, reserved: 0, capacity: 8 },
      dockedShip: null,
      connected: false, // kotvisko má cestné konektory a žiadna cesta k nim ešte nevedie
      refundCents: 0,
      removable: false,
      removeBlockedReason: 'Na kotvisku stoja žeriavy',
    });
  });

  it('nečinný žeriav: badge Nečinný (zelený), vyťaženosť 0 %, odstrániť ide; starter modul nič nevráti', () => {
    const app = createApp();
    expect(inspectorData(app.bridge, ROOT_CRANE)).toEqual({
      id: 2,
      defId: 'crane_container_gantry',
      displayName: 'Kontajnerový žeriav',
      kind: 'crane',
      footprint: { w: 2, h: 3 },
      stateLabel: 'Nečinný',
      ok: true,
      crane: { state: 'idle', utilizationPct: 0, blockedPct: 0 },
      refundCents: 0,
      removable: true,
    });
  });

  it('neexistujúci modul → null (panel sa skryje)', () => {
    expect(inspectorData(createApp().bridge, 999 as EntityId)).toBeNull();
  });
});

describe('inspectorData: žeriav a loď za behu', () => {
  it('vyťaženosť = busy / (busy + idle + blocked), blokovaný podiel analogicky', () => {
    const app = createApp();
    const crane = app.world.modules.get(ROOT_CRANE);
    if (!(crane instanceof CraneModule)) throw new Error('Root žeriav chýba');
    crane.busyTicks = 6;
    crane.idleTicks = 2;
    crane.blockedTicks = 2;
    expect(inspectorData(app.bridge, ROOT_CRANE)?.crane).toEqual({ state: 'idle', utilizationPct: 60, blockedPct: 20 });
  });

  it('počas vykladania: žeriav „Vykladá“ a Odstrániť je zablokované dôvodmi ship_docked + busy', () => {
    const app = createApp();
    spawnFeeder(app);
    tickUntil(app, () => {
      const crane = app.world.modules.get(ROOT_CRANE);
      return crane instanceof CraneModule && (crane.state === 'grabbing' || crane.state === 'placing');
    });
    const data = inspectorData(app.bridge, ROOT_CRANE);
    expect(data).toMatchObject({ stateLabel: 'Vykladá', ok: true, removable: false, refundCents: 0 });
    expect(data?.crane?.state === 'grabbing' || data?.crane?.state === 'placing').toBe(true);
    expect(data?.crane?.utilizationPct).toBeGreaterThan(0);
    expect(data?.removeBlockedReason).toBe('Pri kotvisku kotví loď · Žeriav práve pracuje');
  });

  it('kotvisko s loďou: Loď kotví, Feeder x/4 TEU podľa ledgera, apron rastie s vykládkou', () => {
    const app = createApp();
    spawnFeeder(app);
    tickUntil(app, () => app.world.ships.size === 1 && [...app.world.ships.values()][0]?.state === 'docked');
    const first = inspectorData(app.bridge, ROOT_BERTH);
    expect(first?.stateLabel).toBe(BERTH_STATE_DOCKED);
    expect(first?.dockedShip).toMatchObject({ classLabel: 'Feeder', capacityUnits: app.world.defs.ships.get('feeder').capacityUnits, unitLabel: 'TEU' });
    const boardedAtDock = first?.dockedShip?.unitsOnBoard ?? 0;
    expect(boardedAtDock).toBeGreaterThan(0);
    expect(boardedAtDock).toBeLessThanOrEqual(4);
    expect((first?.apron?.used ?? 0) + (first?.apron?.reserved ?? 0)).toBeLessThanOrEqual(4); // rezervácia = jednotka v žeriave

    tickUntil(app, () => (inspectorData(app.bridge, ROOT_BERTH)?.apron?.used ?? 0) >= 1);
    const later = inspectorData(app.bridge, ROOT_BERTH);
    expect(later?.dockedShip?.unitsOnBoard ?? 4).toBeLessThan(4);
  });

  it('po vyložení a odplávaní: kotvisko Voľné, apron 4/8, žeriav opäť nečinný a odstrániteľný', () => {
    const app = createApp();
    spawnFeeder(app);
    tickUntil(app, () => app.world.ships.size === 0 && app.world.cargo.countByKind('on_apron') === 4, 8000);
    expect(inspectorData(app.bridge, ROOT_BERTH)).toMatchObject({
      stateLabel: BERTH_STATE_FREE,
      apron: { used: 4, reserved: 0, capacity: 8 },
      dockedShip: null,
    });
    expect(inspectorData(app.bridge, ROOT_CRANE)).toMatchObject({ stateLabel: 'Nečinný', removable: true });
  });
});

describe('inspectorData: postavený modul', () => {
  it('refundácia z ZAPLATENEJ ceny (50 % z 400 000 = 200 000), odstrániť ide (bez žeriavov, bez lode)', () => {
    const app = createApp();
    app.bridge.dispatch(new PlaceModuleCommand({ defId: 'berth_standard', x: 48, y: 14, rotation: 0 }));
    app.loop.frame(0);
    const built = [...app.world.modules.values()].find((module) => module.origin.x === 48 && module.kind === 'berth');
    expect(built).toBeDefined();
    const data = inspectorData(app.bridge, (built as { id: EntityId }).id);
    expect(data).toMatchObject({ displayName: 'Kotvisko', refundCents: 20_000_000, removable: true, stateLabel: BERTH_STATE_FREE });
    expect(data).not.toHaveProperty('removeBlockedReason');
  });
});

describe('sameInspectorData', () => {
  it('štrukturálna zhoda; null a rôzne dáta sa líšia', () => {
    const app = createApp();
    const a = inspectorData(app.bridge, ROOT_CRANE);
    const b = inspectorData(app.bridge, ROOT_CRANE);
    expect(a).not.toBe(b);
    expect(sameInspectorData(a, b)).toBe(true);
    expect(sameInspectorData(null, null)).toBe(true);
    expect(sameInspectorData(a, null)).toBe(false);
    expect(sameInspectorData(null, b)).toBe(false);
    expect(sameInspectorData(a, inspectorData(app.bridge, ROOT_BERTH))).toBe(false);
  });
});
