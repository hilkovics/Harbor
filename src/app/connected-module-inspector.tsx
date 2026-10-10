/**
 * ModuleInspector pripojený na simuláciu (`@ui/module-inspector` je čisto prezentačný, T02-10): pravý panel s dátami
 * vybraného modulu (`ModuleSelection`). Dáta sa skladajú zo živého sveta pri každej throttlovanej notifikácii snapshotu
 * (`useSimSnapshot`, 100 ms) a panel sa prekreslí len pri skutočnej zmene (`sameInspectorData`).
 *
 * - „Odstrániť“: `validate(RemoveModule)` → `dispatch` len pri `ok`; inak tlačidlo ostáva zablokované a dôvod ukazuje
 *   inšpektor (`removeBlockedReason`).
 * - Depo (T03-10): „Kúpiť vozidlo“ → `BuyVehicle` do tohto depa (`depotVehicleDef`), „Predať“ → `SellVehicle`; oba príkazy
 *   idú cez `validate` a `dispatch` len pri `ok` (`vehicle-purchase`).
 * - Brána a predbránová plocha (R4, TR4-05): `GateLaneInspector` (režim → `SetGateLaneMode`), `PreGateInspector` a karta TTT (`gate-inspector-data.ts`).
 * - „Zavrieť“ zruší výber; zaniknutý modul (`inspectorData → null`) panel skryje (výber zruší `bindSelectionRing`).
 * - Bez výberu sa do DOM nevykreslí nič, takže pravý okraj mapy ostáva klikateľný.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { RemoveModuleCommand } from '@sim/commands';
import { GateLaneInspector, PreGateInspector, TurnTimeStat } from '@ui/gate-inspector';
import { BlockInspector, CraneInspector, MachineInspector } from '@ui/machine-inspector';
import { ModuleInspector } from '@ui/module-inspector';
import { blockPanelData, cranePanelData, sameBlockPanel, sameCranePanel, setBlockPriority, setCraneGang } from './machine-inspector-data';
import { gatePanelData, sameGatePanel, setGateLaneMode } from './gate-inspector-data';
import { ReeferBlockInspector } from '@ui/reefer-inspector';
import { reeferInspectorData, sameReeferInspector } from './reefer-inspector-data';
import { depotVehicleDef, inspectorData, sameInspectorData } from './inspector-data';
import type { ModuleSelection } from './module-selection';
import { useSimBridge, useSimSnapshot } from './use-sim-snapshot';
import { buyVehicleInDepot, sellVehicle } from './vehicle-purchase';

export interface ConnectedModuleInspectorProps {
  readonly selection: ModuleSelection;
}

export function ConnectedModuleInspector({ selection }: ConnectedModuleInspectorProps) {
  const bridge = useSimBridge();
  const moduleId = useSyncExternalStore(selection.subscribe, selection.get, selection.get);
  const data = useSimSnapshot(() => (moduleId === null ? null : inspectorData(bridge, moduleId)), undefined, sameInspectorData);
  const blockPanel = useSimSnapshot(() => (moduleId === null ? null : blockPanelData(bridge, moduleId)), undefined, sameBlockPanel);
  const cranePanel = useSimSnapshot(() => (moduleId === null ? null : cranePanelData(bridge, moduleId)), undefined, sameCranePanel);
  const gatePanel = useSimSnapshot(() => (moduleId === null ? null : gatePanelData(bridge, moduleId)), undefined, sameGatePanel);
  const reeferPanel = useSimSnapshot(() => (moduleId === null ? null : reeferInspectorData(bridge.world, moduleId)), undefined, sameReeferInspector);
  const remove = useCallback(
    (id: number) => {
      const command = new RemoveModuleCommand(id);
      if (bridge.validate(command).ok) bridge.dispatch(command);
    },
    [bridge],
  );
  const buyVehicle = useCallback(
    (depotId: number) => {
      const offer = depotVehicleDef(bridge.defs);
      if (offer !== undefined) buyVehicleInDepot(bridge, offer.id, depotId);
    },
    [bridge],
  );
  const sell = useCallback(
    (vehicleId: number) => {
      sellVehicle(bridge, vehicleId);
    },
    [bridge],
  );
  const close = useCallback(() => {
    selection.select(null);
  }, [selection]);
  if (moduleId === null || data === null) return null;
  return (
    <div className="app__side">
      <ModuleInspector data={data} onRemove={remove} onClose={close} onBuyVehicle={buyVehicle} onSellVehicle={sell} />
      {reeferPanel !== null && <ReeferBlockInspector data={reeferPanel} />}
      {blockPanel !== null && (
        <>
          {blockPanel.machine !== null && <MachineInspector data={blockPanel.machine} />}
          <BlockInspector
            priority={blockPanel.priority}
            onSetPriority={(order) => {
              setBlockPriority(bridge, blockPanel.blockId, order);
            }}
          />
        </>
      )}
      {gatePanel !== null && (
        <>
          {gatePanel.lane !== null && (
            <GateLaneInspector
              data={gatePanel.lane}
              onSetMode={(mode) => {
                setGateLaneMode(bridge, gatePanel.moduleId, mode);
              }}
            />
          )}
          {gatePanel.preGate !== null && <PreGateInspector data={gatePanel.preGate} />}
          <TurnTimeStat {...(gatePanel.tttMinutes === null ? {} : { minutes: gatePanel.tttMinutes })} />
        </>
      )}
      {cranePanel !== null && (
        <CraneInspector
          gang={cranePanel.gang}
          tractorsPerSts={cranePanel.tractorsPerSts}
          onSetGang={(mode, n) => {
            setCraneGang(bridge, cranePanel.craneId, mode, n);
          }}
        />
      )}
    </div>
  );
}
