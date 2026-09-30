// T05-07: „Nová hra“ = reštart bootstrapu (zrušenie bežiacej hry, nový svet s novým seedom a rovnakou mapou).
import { describe, expect, it, vi } from 'vitest';
import type { World } from '@sim/world';
import type { AppHandle, BootstrapOptions } from '@app/bootstrap';
import { GAME_SEED, createAppWorld, randomGameSeed } from '@app/config';
import { runGame } from '@app/run-game';

interface Booted {
  readonly options: BootstrapOptions;
  readonly destroy: ReturnType<typeof vi.fn>;
}

function fakeBoot() {
  const booted: Booted[] = [];
  const boot = (_root: HTMLElement, options: BootstrapOptions): Promise<AppHandle> => {
    const destroy = vi.fn();
    booted.push({ options, destroy });
    return Promise.resolve({ destroy } as unknown as AppHandle);
  };
  return { boot, booted };
}

const ROOT = {} as HTMLElement;

describe('runGame', () => {
  it('prvá hra štartuje bez vlastného sveta (predvolený seed v bootstrape)', async () => {
    const { boot, booted } = fakeBoot();
    const runner = runGame(ROOT, { boot });
    await runner.current();
    expect(booted).toHaveLength(1);
    expect(booted[0]?.options.world).toBeUndefined();
    expect(booted[0]?.options.onNewGame).toBeTypeOf('function');
  });

  it('„Nová hra“ zruší bežiacu hru a spustí novú so svetom z nového seedu', async () => {
    const { boot, booted } = fakeBoot();
    const created: number[] = [];
    const worlds: World[] = [];
    const runner = runGame(ROOT, {
      boot,
      nextSeed: () => 4242,
      createWorld: (seed) => {
        created.push(seed);
        const world = createAppWorld(seed);
        worlds.push(world);
        return world;
      },
    });
    await runner.current();
    booted[0]?.options.onNewGame?.();
    await runner.current();
    expect(booted[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(booted).toHaveLength(2);
    expect(created).toEqual([4242]);
    expect(booted[1]?.options.world).toBe(worlds[0]);
    expect(worlds[0]?.seed).toBe(4242);
    expect(worlds[0]?.map.id).toBe(createAppWorld().map.id); // rovnaká mapa
  });

  it('dvojklik na „Novú hru“ spustí len jeden reštart', async () => {
    const { boot, booted } = fakeBoot();
    const runner = runGame(ROOT, { boot, nextSeed: () => 7 });
    await runner.current();
    const onNewGame = booted[0]?.options.onNewGame;
    onNewGame?.();
    onNewGame?.();
    await runner.current();
    expect(booted).toHaveLength(2);
    // po dokončení reštartu ide ďalší (druhý bankrot)
    booted[1]?.options.onNewGame?.();
    await runner.current();
    expect(booted).toHaveLength(3);
    expect(booted[1]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('dispose zruší bežiacu hru a zakáže ďalší reštart', async () => {
    const { boot, booted } = fakeBoot();
    const runner = runGame(ROOT, { boot });
    await runner.current();
    await runner.dispose();
    expect(booted[0]?.destroy).toHaveBeenCalledTimes(1);
    booted[0]?.options.onNewGame?.();
    await runner.current();
    expect(booted).toHaveLength(1);
  });
});

describe('randomGameSeed', () => {
  it('vracia uint32 a nie je to seed prvej hry', () => {
    const seeds = Array.from({ length: 8 }, randomGameSeed);
    for (const seed of seeds) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
    expect(new Set(seeds).size).toBeGreaterThan(1);
    expect(GAME_SEED).toBe(20260929);
  });
});
