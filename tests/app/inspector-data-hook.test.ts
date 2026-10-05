// F6a (ADR-033): inšpektor žeriavu v predvolenom režime odovzdávania `under_hook` — žeriav bez vozidla pod hákom drží jednotku v ruke
// (predvolený buffer 0, T6D-02: apron nepoužije) a čaká; inšpektor to ukáže ako „Čaká na vozidlo“ (stav FSM ostáva `placing`). Režim `apron` (F2–F5)
// nikdy nečaká.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { CraneModule } from '@sim/modules';
import { World } from '@sim/world';
import { GameLoop } from '@app/game-loop';
import { inspectorData } from '@app/inspector-data';
import { SimBridge } from '@app/sim-bridge';
import { SEED, buildLogistics, createApp, frameUntil, runCommands, type App } from './app-fixtures';
import { BUNDLED_DEFS, MAP } from '../sim/world/world-fixtures';

const ROOT_BERTH = 1 as EntityId;
const ROOT_CRANE = 2 as EntityId;
const FEEDER = { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 } as const;

/** Svet nad bundled defmi tak, ako ho hra načíta: kotvisko v režime `under_hook` s predvoleným bufferom 0 (T6D-02). */
function createHookApp(): App {
  const world = World.create(BUNDLED_DEFS, MAP, SEED);
  const bridge = new SimBridge(world);
  return { world, bridge, loop: new GameLoop(world, bridge) };
}

const craneData = (app: App) => inspectorData(app.bridge, ROOT_CRANE);
const waiting = (app: App): boolean => craneData(app)?.crane?.waitingForVehicle === true;

describe('inspectorData: žeriav pod hákom čaká na vozidlo (ADR-033)', () => {
  it('bez vozidla: prvá jednotka visí v žeriave (buffer 0, apron prázdny) — badge „Čaká na vozidlo“, žltý, stav FSM placing', () => {
    const app = createHookApp();
    expect(BUNDLED_DEFS.modules.get('berth_standard')).toBeDefined();
    runCommands(app, [FEEDER]);
    // pred čakaním žeriav len vykladá
    frameUntil(app, () => craneData(app)?.crane?.state === 'grabbing');
    expect(craneData(app)).toMatchObject({ stateLabel: 'Vykladá', ok: true });
    expect(craneData(app)?.crane).not.toHaveProperty('waitingForVehicle');

    frameUntil(app, () => waiting(app), 4000);
    const data = craneData(app);
    expect(data).toMatchObject({ stateLabel: 'Čaká na vozidlo', ok: false, crane: { state: 'placing', waitingForVehicle: true } });
    const crane = app.world.modules.get(ROOT_CRANE);
    expect(crane instanceof CraneModule && crane.heldUnitId !== null).toBe(true);
    // buffer 0: apron je prázdny, jednotku žeriav drží; ďalšie ticky nič nezmenia (žeriav čaká, nevykladá)
    expect(inspectorData(app.bridge, ROOT_BERTH)?.apron).toMatchObject({ used: 0 });
    for (let i = 0; i < 20; i += 1) app.loop.frame(app.loop.tickMs);
    expect(waiting(app)).toBe(true);
    expect(app.world.cargo.countByKind('on_apron')).toBe(0);
    expect(app.world.cargo.countAt('on_ship', [...app.world.ships.keys()][0]!)).toBe(3);
  });

  it('po dodaní skladu, ciest a vozidla čakanie skončí: loď odpláva, 4 jednotky v sklade, žeriav Nečinný', () => {
    const app = createHookApp();
    runCommands(app, [FEEDER]);
    frameUntil(app, () => waiting(app), 4000);
    buildLogistics(app);
    // loď vznikla pred stavbou, takže depo nemá id 3 (id entít sú spoločná postupnosť) — nájde sa podľa defu
    const depot = [...app.world.modules.values()].find((module) => module.def.id === 'vehicle_depot');
    expect(depot).toBeDefined();
    runCommands(app, [{ type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: depot!.id }]);
    expect(app.world.vehicles.size).toBe(1);
    frameUntil(app, () => !waiting(app), 4000);
    frameUntil(app, () => app.world.ships.size === 0 && app.world.cargo.countByKind('in_storage') === 4, 20_000);
    expect(craneData(app)).toMatchObject({ stateLabel: 'Nečinný', ok: true });
    expect(craneData(app)?.crane).not.toHaveProperty('waitingForVehicle');
    expect(app.world.cargo.countByKind('on_apron')).toBe(0);
  });

  it('režim apron (F2–F5) žeriav nikdy nečaká na vozidlo: počas celej vykládky žiadne waitingForVehicle', () => {
    const app = createApp();
    runCommands(app, [FEEDER]);
    let ticks = 0;
    while ((app.world.ships.size === 0 || app.world.cargo.countByKind('on_apron') < 4) && ticks < 8000) {
      app.loop.frame(app.loop.tickMs);
      ticks += 1;
      expect(waiting(app), `tick ${String(ticks)}`).toBe(false);
    }
    expect(app.world.cargo.countByKind('on_apron')).toBe(4);
  });
});
