/**
 * DEV tlačidlo „Spawn feeder (DEV)“: pošle `SpawnShipDebug` (ladiaca loď, ADR-016) cez `dispatch`. Kým nie sú kontrakty
 * (F4/F5), je to jediný spôsob, ako v hre uvidieť loď. Zobrazuje ho `App` len vo vývojovom builde.
 */
import { useCallback } from 'react';
import { commandFromJSON } from '@sim/commands';
import { DEV_SPAWN_SHIP } from './config';
import { useSimBridge } from './use-sim-snapshot';

/** Text tlačidla: `Spawn feeder (DEV)`. */
export function devSpawnLabel(shipClassId: string = DEV_SPAWN_SHIP.shipClassId): string {
  return `Spawn ${shipClassId} (DEV)`;
}

/** Callback, ktorý odošle `SpawnShipDebug` z `DEV_SPAWN_SHIP` (zápis len cez `dispatch`). */
export function useSpawnDevShip(): () => void {
  const bridge = useSimBridge();
  return useCallback(() => {
    bridge.dispatch(commandFromJSON({ type: 'SpawnShipDebug', ...DEV_SPAWN_SHIP }));
  }, [bridge]);
}

export function DevSpawnButton() {
  const spawn = useSpawnDevShip();
  return (
    <button
      type="button"
      className="dev-spawn"
      data-field="dev-spawn-ship"
      title={`Ladiaca loď: ${String(DEV_SPAWN_SHIP.units)}× ${DEV_SPAWN_SHIP.cargoTypeId}`}
      onClick={spawn}
    >
      {devSpawnLabel()}
    </button>
  );
}
