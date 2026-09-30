/**
 * ModuleInspector pripojený na simuláciu (`@ui/module-inspector` je čisto prezentačný, T02-10): pravý panel s dátami
 * vybraného modulu (`ModuleSelection`). Dáta sa skladajú zo živého sveta pri každej throttlovanej notifikácii snapshotu
 * (`useSimSnapshot`, 100 ms) a panel sa prekreslí len pri skutočnej zmene (`sameInspectorData`).
 *
 * - „Odstrániť“: `validate(RemoveModule)` → `dispatch` len pri `ok`; inak tlačidlo ostáva zablokované a dôvod ukazuje
 *   inšpektor (`removeBlockedReason`).
 * - „Zavrieť“ zruší výber; zaniknutý modul (`inspectorData → null`) panel skryje (výber zruší `bindSelectionRing`).
 * - Bez výberu sa do DOM nevykreslí nič, takže pravý okraj mapy ostáva klikateľný.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { RemoveModuleCommand } from '@sim/commands';
import { ModuleInspector } from '@ui/module-inspector';
import { inspectorData, sameInspectorData } from './inspector-data';
import type { ModuleSelection } from './module-selection';
import { useSimBridge, useSimSnapshot } from './use-sim-snapshot';

export interface ConnectedModuleInspectorProps {
  readonly selection: ModuleSelection;
}

export function ConnectedModuleInspector({ selection }: ConnectedModuleInspectorProps) {
  const bridge = useSimBridge();
  const moduleId = useSyncExternalStore(selection.subscribe, selection.get, selection.get);
  const data = useSimSnapshot(() => (moduleId === null ? null : inspectorData(bridge, moduleId)), undefined, sameInspectorData);
  const remove = useCallback(
    (id: number) => {
      const command = new RemoveModuleCommand(id);
      if (bridge.validate(command).ok) bridge.dispatch(command);
    },
    [bridge],
  );
  const close = useCallback(() => {
    selection.select(null);
  }, [selection]);
  if (moduleId === null || data === null) return null;
  return (
    <div className="app__side">
      <ModuleInspector data={data} onRemove={remove} onClose={close} />
    </div>
  );
}
