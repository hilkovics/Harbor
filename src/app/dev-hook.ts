/**
 * Ladiaci háčik `window.__sim` (ARCHITECTURE §16, E2E): sprístupní `World` a `SimBridge` Playwrightu a konzole.
 * Aktívny výlučne vo vývojovom builde (`import.meta.env.DEV`); v produkčnom builde je z modulu mŕtvy kód.
 */
import type { World } from '@sim/world';
import type { SimBridge } from './sim-bridge';

export interface DevHook {
  readonly world: World;
  readonly bridge: SimBridge;
  /**
   * STRED bunky (x, y) v súradniciach stránky (CSS px, vrátane posunu canvasu) — presne tam, kam má e2e kliknúť.
   * Doplní bootstrap z kamery (T01-11).
   */
  cellToScreen?: (cellX: number, cellY: number) => { x: number; y: number };
}

declare global {
  interface Window {
    __sim?: DevHook;
  }
}

export interface DevHookOptions {
  /** Predvolene `import.meta.env.DEV`; test ho vie vynútiť. */
  readonly enabled?: boolean;
  /** Kam háčik zapísať; predvolene `window` (v Node bez `window` sa nič nestane). */
  readonly target?: { __sim?: DevHook } | null;
  readonly cellToScreen?: DevHook['cellToScreen'];
}

/** Nainštaluje `window.__sim = { world, bridge, cellToScreen? }`. Vráti háčik, alebo `null`, ak je vypnutý/nie je cieľ. */
export function installDevHook(bridge: SimBridge, options: DevHookOptions = {}): DevHook | null {
  const enabled = options.enabled ?? import.meta.env.DEV;
  if (!enabled) return null;
  const target = options.target === undefined ? (typeof window === 'undefined' ? null : window) : options.target;
  if (target === null) return null;
  const hook: DevHook = { world: bridge.world, bridge };
  if (options.cellToScreen !== undefined) hook.cellToScreen = options.cellToScreen;
  target.__sim = hook;
  return hook;
}
