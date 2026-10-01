/**
 * Čistá (bez Reactu) logika za `useSimSnapshot`: throttling notifikácií a výber časti snapshotu so stabilnou
 * referenciou. Oddelené, aby sa dala testovať v Node bez DOM.
 */
import type { SimBridge, Unsubscribe, WorldSnapshot } from './sim-bridge';

/** Predvolený odstup notifikácií panelov (ARCHITECTURE §13: `throttleMs = 100`). */
export const DEFAULT_SNAPSHOT_THROTTLE_MS = 100;

/** Časovače; v testoch nahraditeľné. Predvolené volajú globálne `setTimeout`/`clearTimeout` pri každom použití. */
export interface TimerHost {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimers: TimerHost = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

export interface Throttle {
  /** Požiada o volanie `fire`; podľa stavu okamžite, alebo najneskôr po uplynutí odstupu (trailing). */
  notify(): void;
  /** Zruší čakajúce volanie; ďalšie `notify` sa ignoruje. */
  cancel(): void;
}

/**
 * Throttle s okamžitým prvým volaním (leading) a dobiehajúcim posledným (trailing): `fire` sa volá najviac raz
 * za `intervalMs`, ale posledná požiadavka nikdy nezanikne. `intervalMs = 0` znamená bez throttlingu.
 */
export function createThrottle(fire: () => void, intervalMs: number, timers: TimerHost = globalTimers): Throttle {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError(`createThrottle: intervalMs musí byť konečné číslo ≥ 0, dostal ${String(intervalMs)}`);
  }
  let cooldown: unknown = null;
  let pending = false;
  let cancelled = false;

  const startCooldown = (): void => {
    cooldown = timers.setTimeout(() => {
      cooldown = null;
      if (!pending || cancelled) return;
      pending = false;
      startCooldown();
      fire();
    }, intervalMs);
  };

  return {
    notify() {
      if (cancelled) return;
      if (intervalMs === 0) {
        fire();
        return;
      }
      if (cooldown !== null) {
        pending = true;
        return;
      }
      startCooldown();
      fire();
    },
    cancel() {
      cancelled = true;
      pending = false;
      if (cooldown !== null) {
        timers.clearTimeout(cooldown);
        cooldown = null;
      }
    },
  };
}

/** Porovnanie dvoch vybraných hodnôt; predvolene `Object.is`. */
export type Equality<T> = (previous: T, next: T) => boolean;

/** Adaptér `SimBridge` pre `useSyncExternalStore`: throttlované `subscribe` + `select` so stabilnou referenciou. */
export interface SnapshotStore {
  /** Stabilná funkcia (jedna na store) — vhodná ako `subscribe` argument `useSyncExternalStore`. */
  readonly subscribe: (onChange: () => void) => Unsubscribe;
  /**
   * Vyberie časť aktuálneho snapshotu. Výsledok sa vracia z cache, kým sa nezmení snapshot alebo `selector`;
   * ak nový výsledok `isEqual` predošlému, vráti sa predošlá referencia (selektor smie vracať nové objekty
   * bez toho, aby vyvolal nekonečné prekresľovanie).
   */
  select<T>(selector: (snapshot: WorldSnapshot) => T, isEqual?: Equality<T>): T;
}

interface SelectionCache {
  readonly snapshot: WorldSnapshot;
  readonly selector: unknown;
  readonly value: unknown;
}

export function createSnapshotStore(
  bridge: SimBridge,
  throttleMs: number = DEFAULT_SNAPSHOT_THROTTLE_MS,
  timers: TimerHost = globalTimers,
): SnapshotStore {
  let cache: SelectionCache | null = null;

  return {
    subscribe(onChange) {
      const throttle = createThrottle(onChange, throttleMs, timers);
      const unsubscribe = bridge.subscribe(() => {
        throttle.notify();
      });
      return () => {
        unsubscribe();
        throttle.cancel();
      };
    },
    select<T>(selector: (snapshot: WorldSnapshot) => T, isEqual: Equality<T> = Object.is): T {
      const snapshot = bridge.snapshot();
      if (cache !== null && cache.snapshot === snapshot && cache.selector === selector) return cache.value as T;
      let value = selector(snapshot);
      if (cache !== null && isEqual(cache.value as T, value)) value = cache.value as T;
      cache = { snapshot, selector, value };
      return value;
    },
  };
}
