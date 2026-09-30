// T05-07: `window.__sim.contracts()` a `acceptFirstOffer()` — e2e (T05-09) podľa nich prijme kontrakt a čaká na výplatu.
import { describe, expect, it } from 'vitest';
import { installDevHook, type DevHook } from '@app/dev-hook';
import { createApp } from './app-fixtures';

function hookFor(app: ReturnType<typeof createApp>): DevHook {
  const target: { __sim?: DevHook } = {};
  const hook = installDevHook(app.bridge, { enabled: true, target });
  if (hook === null) throw new Error('DevHook sa nenainštaloval');
  return hook;
}

describe('DevHook.contracts', () => {
  it('pred prvým tickom nie sú kontrakty; potom ponuky v plochom serializovateľnom tvare vzostupne podľa id', () => {
    const app = createApp();
    const hook = hookFor(app);
    expect(hook.contracts()).toEqual([]);
    app.loop.frame(app.loop.tickMs);
    const list = hook.contracts();
    expect(list).toHaveLength(app.world.defs.economy.offersPerDay);
    expect(list.every((contract) => contract.state === 'offered')).toBe(true);
    expect(list.map((contract) => contract.id)).toEqual([...list.map((contract) => contract.id)].sort((a, b) => a - b));
    expect(JSON.parse(JSON.stringify(list))).toEqual(list);
    expect(list[0]).toMatchObject({ unitsUnloaded: 0, unitsExported: 0, penaltiesCents: 0 });
  });
});

describe('DevHook.acceptFirstOffer', () => {
  it('bez ponúk vráti null', () => {
    const app = createApp();
    expect(hookFor(app).acceptFirstOffer()).toBeNull();
  });

  it('prijme ponuku s najnižším id; aplikuje sa pri najbližšom frame; ďalšie volanie berie ďalšiu', () => {
    const app = createApp();
    const hook = hookFor(app);
    app.loop.frame(app.loop.tickMs);
    const [first, second] = hook.contracts();
    const accepted = hook.acceptFirstOffer();
    expect(accepted).toBe(first?.id);
    app.loop.frame(app.loop.tickMs);
    expect(hook.contracts().find((contract) => contract.id === accepted)?.state).toBe('accepted');
    expect(hook.acceptFirstOffer()).toBe(second?.id);
  });
});
