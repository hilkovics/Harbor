/**
 * Životný cyklus hry nad `bootstrap` (T05-07): spustí prvú hru a na „Novú hru“ (modál po bankrote) zruší bežiacu a spustí
 * novú — nový svet s novým seedom a rovnakou mapou (`createAppWorld`). Oddelené od `main.tsx`, aby sa dalo testovať
 * s falošným `bootstrap`.
 *
 * Zrušenie a nový štart idú cez `Promise` (mikroúloha po klikacom handleri), nikdy priamo z handlera: React root, z ktorého
 * tlačidlo volalo, sa tak neruší počas vlastnej udalosti. Dvojklik na „Novú hru“ spustí len jednu reštartáciu.
 */
import type { World } from '@sim/world';
import { bootstrap, type AppHandle, type BootstrapOptions } from './bootstrap';
import { createAppWorld, randomGameSeed } from './config';

export interface RunGameDeps {
  /** Predvolene `bootstrap`; test dosadí falošný. */
  readonly boot?: (root: HTMLElement, options: BootstrapOptions) => Promise<AppHandle>;
  /** Nový svet pre „Novú hru“; predvolene `createAppWorld(seed)`. */
  readonly createWorld?: (seed: number) => World;
  /** Seed „Novej hry“; predvolene `randomGameSeed`. */
  readonly nextSeed?: () => number;
}

export interface GameRunner {
  /** Práve bežiaca hra (po reštarte už nová). */
  readonly current: () => Promise<AppHandle>;
  /** Zruší bežiacu hru a zakáže ďalší reštart (HMR, odchod zo stránky). */
  readonly dispose: () => Promise<void>;
}

export function runGame(root: HTMLElement, deps: RunGameDeps = {}): GameRunner {
  const boot = deps.boot ?? bootstrap;
  const createWorld = deps.createWorld ?? ((seed: number) => createAppWorld(seed));
  const nextSeed = deps.nextSeed ?? randomGameSeed;
  let disposed = false;
  let restarting = false;

  const start = (world?: World): Promise<AppHandle> =>
    boot(root, {
      ...(world === undefined ? {} : { world }),
      onNewGame: restart,
    });

  function restart(): void {
    if (disposed || restarting) return;
    restarting = true;
    current = current.then(async (handle) => {
      handle.destroy();
      try {
        return await start(createWorld(nextSeed()));
      } finally {
        restarting = false;
      }
    });
  }

  let current = start();

  return {
    current: () => current,
    dispose: async () => {
      disposed = true;
      (await current).destroy();
    },
  };
}
