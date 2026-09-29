import { describe, expect, it } from 'vitest';
import { APP_MAP_ID, GAME_SEED, KEY_PAN_MAX_DT_MS, KEY_PAN_PX_PER_SECOND, WHEEL_ZOOM_PER_PX, createAppWorld, loadAppMap } from '@app/config';

describe('config aplikácie', () => {
  it('seed je uint32 (Rng ho prijme) a mapa aplikácie je harbor_01', () => {
    expect(Number.isInteger(GAME_SEED) && GAME_SEED >= 0 && GAME_SEED <= 0xffff_ffff).toBe(true);
    expect(APP_MAP_ID).toBe('harbor_01');
    expect(loadAppMap().id).toBe(APP_MAP_ID);
  });

  it('createAppWorld: nová hra z defs a mapy, východiskový seed; ten istý seed = rovnaký svet', () => {
    const a = createAppWorld();
    const b = createAppWorld(GAME_SEED);
    expect(a.map.id).toBe(APP_MAP_ID);
    expect(a.clock.tick).toBe(0);
    expect(a.cashCents).toBe(a.defs.economy.startingCashCents);
    expect(JSON.stringify(a.serialize())).toBe(JSON.stringify(b.serialize()));
    expect(a.serialize().seed).toBe(GAME_SEED);
  });

  it('živá mriežka sveta je samostatná kópia (šablóna mapy sa nemení)', () => {
    const world = createAppWorld();
    expect(world.grid).not.toBe(world.map.grid);
  });

  it('ladiace konštanty ovládania sú kladné', () => {
    expect(KEY_PAN_PX_PER_SECOND).toBeGreaterThan(0);
    expect(KEY_PAN_MAX_DT_MS).toBeGreaterThan(0);
    expect(WHEEL_ZOOM_PER_PX).toBeGreaterThan(0);
  });
});
