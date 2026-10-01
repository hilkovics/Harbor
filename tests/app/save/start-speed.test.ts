// T06-03: rýchlosť pri štarte — nová hra `defaultSpeed` z nastavení, načítaná hra v pauze (príkaz SetGameSpeed v prvom frame).
import { describe, expect, it } from 'vitest';
import { applyStartSpeed } from '@app/start-speed';
import { createApp, createWorld } from '../app-fixtures';

describe('applyStartSpeed', () => {
  it('undefined → rýchlosť sa nemení, nič sa nezaradí', () => {
    const world = createWorld();
    expect(applyStartSpeed(world, undefined)).toBe(false);
    expect(world.pendingCommandCount).toBe(0);
  });

  it('rovnaká rýchlosť ako aktuálna → nič sa nezaradí', () => {
    const world = createWorld();
    expect(applyStartSpeed(world, world.clock.speed)).toBe(false);
    expect(world.pendingCommandCount).toBe(0);
  });

  it('rýchlosť mimo time.speeds sa ignoruje (svet by príkaz odmietol)', () => {
    const world = createWorld();
    expect(applyStartSpeed(world, 3)).toBe(false);
    expect(applyStartSpeed(world, -1)).toBe(false);
    expect(world.pendingCommandCount).toBe(0);
  });

  it('pauza: príkaz čaká vo fronte, kým ho nezoberie prvý frame; do vtedy sa nič nezmenilo', () => {
    const world = createWorld();
    expect(world.clock.speed).toBe(1);
    expect(applyStartSpeed(world, 0)).toBe(true);
    expect(world.pendingCommandCount).toBe(1);
    expect(world.clock.speed).toBe(1);
  });

  it('prvý frame pauzu aplikuje ešte pred prvým tickom: hra neodtikne ani jeden tick', () => {
    const { world, loop, bridge } = createApp();
    applyStartSpeed(world, 0);
    loop.frame(10_000); // veľký dt: pri bežiacej hre by sa vykonalo veľa tickov
    expect(world.clock.speed).toBe(0);
    expect(world.clock.tick).toBe(0);
    expect(bridge.snapshot().speed).toBe(0);
    loop.frame(10_000);
    expect(world.clock.tick).toBe(0);
  });

  it('vyššia rýchlosť z nastavení (nová hra)', () => {
    const { world, loop } = createApp();
    applyStartSpeed(world, 4);
    loop.frame(0);
    expect(world.clock.speed).toBe(4);
  });
});
