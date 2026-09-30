/**
 * ContractsPanel pripojený na simuláciu (`@ui/contracts-panel` je čisto prezentačný, T05-06): pravý panel s ponukami,
 * prebiehajúcimi a uzavretými kontraktmi. Otvára ho ikona kontraktov v TopHUD (`PanelSelection`), zatvára `onClose` a Esc;
 * klávesová skratka `C` ho prepína (ako v titulku ikony).
 *
 * - Karty sú v snapshote (`contracts`, prepočet len pri zmene revízie), čas na kartách sa počíta z `tick`.
 * - „Prijať“ / „Odmietnuť“: `validate(AcceptContract | DeclineContract)` → `dispatch` len pri `ok` (pravidlo 5); dôvod,
 *   prečo sa ponuku nedá prijať, je v karte (`disabledReason`).
 * - Bez otvoreného panelu sa nevykreslí nič (ani hooky nad snapshotom), takže pravý okraj mapy ostáva klikateľný.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AcceptContractCommand, DeclineContractCommand } from '@sim/commands';
import { ContractsPanel, type ContractCardId, type ContractsTab } from '@ui/contracts-panel';
import type { PanelSelection } from './panel-selection';
import { useSimBridge, useSimSnapshot } from './use-sim-snapshot';

/** Je cieľ udalosti textové pole (klávesa nesmie prepínať panel)? */
function isEditable(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** `C` prepína panel kontraktov, Esc ho zatvára (len keď je otvorený). */
function usePanelKeys(panels: PanelSelection): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.repeat || isEditable(event.target)) return;
      if (event.code === 'KeyC') {
        panels.toggle('contracts');
      } else if (event.code === 'Escape' && panels.get() === 'contracts') {
        panels.select(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [panels]);
}

function OpenContractsPanel({ panels }: { readonly panels: PanelSelection }) {
  const bridge = useSimBridge();
  const [tab, setTab] = useState<ContractsTab>('offers');
  const contracts = useSimSnapshot((snapshot) => snapshot.contracts);
  const nowTick = useSimSnapshot((snapshot) => snapshot.tick);
  const ticksPerHour = useSimSnapshot((snapshot) => snapshot.ticksPerHour);
  const ticksPerDay = useSimSnapshot((snapshot) => snapshot.ticksPerDay);
  const nextOfferInTicks = useSimSnapshot((snapshot) => snapshot.nextOfferInTicks);

  const accept = useCallback(
    (id: ContractCardId) => {
      const command = new AcceptContractCommand(Number(id));
      if (bridge.validate(command).ok) bridge.dispatch(command);
    },
    [bridge],
  );
  const decline = useCallback(
    (id: ContractCardId) => {
      const command = new DeclineContractCommand(Number(id));
      if (bridge.validate(command).ok) bridge.dispatch(command);
    },
    [bridge],
  );
  const close = useCallback(() => {
    panels.select(null);
  }, [panels]);

  return (
    <div className="app__side app__side--tall" data-panel="contracts">
      <ContractsPanel
        contracts={contracts}
        tab={tab}
        onTabChange={setTab}
        time={{ ticksPerHour, ticksPerDay, nowTick }}
        onAccept={accept}
        onDecline={decline}
        onClose={close}
        nextOfferInTicks={nextOfferInTicks}
      />
    </div>
  );
}

export interface ConnectedContractsPanelProps {
  readonly panels: PanelSelection;
}

export function ConnectedContractsPanel({ panels }: ConnectedContractsPanelProps) {
  const open = useSyncExternalStore(panels.subscribe, panels.get, panels.get) === 'contracts';
  usePanelKeys(panels);
  return open ? <OpenContractsPanel panels={panels} /> : null;
}
