/**
 * Životný cyklus hry nad `bootstrap` (T05-07): spustí prvú hru a na „Novú hru“ (modál po bankrote) zruší bežiacu a spustí
 * novú — nový svet s novým seedom a rovnakou mapou (`createAppWorld`). Oddelené od `main.tsx`, aby sa dalo testovať
 * s falošným `bootstrap`.
 *
 * Načítanie uloženej hry (T06-03, ADR-030 bod 5) je rovnaký reštart nad hotovým svetom (`onLoadGame`): hra štartuje
 * pozastavená (`startSpeed: 0`). Nová hra štartuje s `defaultSpeed` z nastavení. Úložisko slotov a nastavení
 * (`persistence`) zdieľa všetky hry v tejto relácii.
 *
 * Zrušenie a nový štart idú cez `Promise` (mikroúloha po klikacom handleri), nikdy priamo z handlera: React root, z ktorého
 * tlačidlo volalo, sa tak neruší počas vlastnej udalosti. Dvojklik na „Novú hru“ spustí len jednu reštartáciu.
 */
import type { World } from '@sim/world';
import { bootstrap, type AppHandle, type BootstrapOptions } from './bootstrap';
import { createAppWorld, randomGameSeed } from './config';
import { createPersistence, loadedToastSpec, type PersistenceServices } from './save/save-controller';
import type { ToastSpec } from './toast-center';

export interface RunGameDeps {
  /** Predvolene `bootstrap`; test dosadí falošný. */
  readonly boot?: (root: HTMLElement, options: BootstrapOptions) => Promise<AppHandle>;
  /** Nový svet pre „Novú hru“; predvolene `createAppWorld(seed)`. */
  readonly createWorld?: (seed: number) => World;
  /** Seed „Novej hry“; predvolene `randomGameSeed`. */
  readonly nextSeed?: () => number;
  /** Úložisko slotov a nastavení; predvolene `createPersistence()` nad `localStorage`. */
  readonly persistence?: PersistenceServices;
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
  const persistence = deps.persistence ?? createPersistence();
  let disposed = false;
  let restarting = false;

  const start = (world: World | undefined, startSpeed: number, startToast?: ToastSpec): Promise<AppHandle> =>
    boot(root, {
      ...(world === undefined ? {} : { world }),
      ...(startToast === undefined ? {} : { startToast }),
      startSpeed,
      persistence,
      onNewGame: restart,
      onLoadGame: load,
    });

  /** Zruší bežiacu hru a spustí novú nad svetom z `makeWorld` s rýchlosťou `startSpeed`; počas reštartu ďalší nepustí. */
  function replace(makeWorld: () => World, startSpeed: () => number, startToast?: ToastSpec): void {
    if (disposed || restarting) return;
    restarting = true;
    current = current.then(async (handle) => {
      handle.destroy();
      try {
        return await start(makeWorld(), startSpeed(), startToast);
      } finally {
        restarting = false;
      }
    });
  }

  function restart(): void {
    replace(() => createWorld(nextSeed()), () => persistence.settings.get().defaultSpeed);
  }

  /**
   * Načítanie uloženej hry: svet už obnovil `SaveController` (`World.deserialize`), tu sa len reštartuje v pauze. Toast
   * „Načítané“ nesie nový `bootstrap` (`startToast`), lebo `ToastCenter` pôvodnej hry sa pri reštarte ruší.
   */
  function load(world: World): void {
    replace(() => world, () => 0, loadedToastSpec(world));
  }

  let current = start(undefined, persistence.settings.get().defaultSpeed);

  return {
    current: () => current,
    dispose: async () => {
      disposed = true;
      (await current).destroy();
    },
  };
}
