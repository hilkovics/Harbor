// T03-10: `window.__sim.dispatchJSON` — e2e staví cesty, dvory a depo serializovanými príkazmi (validate → dispatch).
import { describe, expect, it } from 'vitest';
import { installDevHook, type DevHook } from '@app/dev-hook';
import { DEPOT_ID, LOGISTICS_MODULES, LOGISTICS_ROADS, createApp } from './app-fixtures';

function hookFor(app: ReturnType<typeof createApp>): DevHook {
  const target: { __sim?: DevHook } = {};
  const hook = installDevHook(app.bridge, { enabled: true, target });
  if (hook === null) throw new Error('DevHook sa nenainštaloval');
  return hook;
}

describe('DevHook.dispatchJSON', () => {
  it('platný príkaz: vráti ok a po frame je aplikovaný (cesty, moduly, vozidlo)', () => {
    const app = createApp();
    const hook = hookFor(app);
    for (const cells of LOGISTICS_ROADS) expect(hook.dispatchJSON({ type: 'PlaceRoad', cells })).toMatchObject({ ok: true });
    app.loop.frame(0);
    for (const module of LOGISTICS_MODULES) expect(hook.dispatchJSON(module)).toMatchObject({ ok: true });
    app.loop.frame(0);
    expect(hook.dispatchJSON({ type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID })).toMatchObject({ ok: true });
    app.loop.frame(0);
    expect(app.world.vehicles.size).toBe(1);
    expect(hook.entities().vehicles).toHaveLength(1);
  });

  it('neplatný príkaz sa neodošle a výsledok vysvetlí prečo (validate)', () => {
    const app = createApp();
    const hook = hookFor(app);
    const result = hook.dispatchJSON({ type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: 99 });
    expect(result).toMatchObject({ ok: false, reasons: ['unknown_depot'] });
    app.loop.frame(0);
    expect(app.world.vehicles.size).toBe(0);
  });

  it('nesprávny tvar príkazu vyhodí (chyba testu je hneď viditeľná)', () => {
    const hook = hookFor(createApp());
    expect(() => hook.dispatchJSON({ type: 'NoSuchCommand' })).toThrow();
  });
});
