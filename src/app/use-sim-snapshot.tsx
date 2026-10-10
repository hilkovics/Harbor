// React väzba na SimBridge (CLAUDE.md: bez globálnych store knižníc — UI číta `useSimSnapshot`, zapisuje `dispatch`).
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { DEFAULT_SNAPSHOT_THROTTLE_MS, createSnapshotStore, type Equality } from './snapshot-store';
import type { SimBridge, WorldSnapshot } from './sim-bridge';

const SimBridgeContext = createContext<SimBridge | null>(null);

/** Sprístupní `bridge` komponentom pod sebou (`useSimBridge`, `useSimSnapshot`). */
export function SimBridgeProvider({ bridge, children }: { bridge: SimBridge; children?: ReactNode }) {
  return <SimBridgeContext.Provider value={bridge}>{children}</SimBridgeContext.Provider>;
}

/** Bridge z najbližšieho `SimBridgeProvider` — na `dispatch(command)` a `validate(command)`. */
export function useSimBridge(): SimBridge {
  const bridge = useContext(SimBridgeContext);
  if (bridge === null) {
    throw new Error('useSimBridge: chýba <SimBridgeProvider bridge={…}> nad komponentom');
  }
  return bridge;
}

/**
 * Vyberie hodnotu zo snapshotu sveta; komponent sa prekreslí najviac raz za `throttleMs` a len ak sa vybraná
 * hodnota zmenila (`isEqual`, predvolene `Object.is`). Selektor preto vracaj primitíva alebo stabilné referencie,
 * prípadne pridaj vlastné `isEqual`.
 *
 * @example const cash = useSimSnapshot((s) => s.cashCents);
 */
export function useSimSnapshot<T>(
  selector: (snapshot: WorldSnapshot) => T,
  throttleMs: number = DEFAULT_SNAPSHOT_THROTTLE_MS,
  isEqual?: Equality<T>,
): T {
  const bridge = useSimBridge();
  const store = useMemo(() => createSnapshotStore(bridge, throttleMs), [bridge, throttleMs]);
  const getSnapshot = (): T => store.select(selector, isEqual);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
