/**
 * ContractsPanel pripojený na simuláciu (`@ui/contracts-panel` je čisto prezentačný, T05-06): pravý panel s ponukami,
 * prebiehajúcimi a uzavretými kontraktmi. Otvára ho ikona kontraktov v TopHUD (`PanelSelection`), zatvára `onClose` a Esc;
 * klávesová skratka `C` ho prepína (ako v titulku ikony).
 *
 * - Karty sú v snapshote (`contracts`, prepočet len pri zmene revízie), čas na kartách sa počíta z `tick`.
 * - „Prijať“ / „Odmietnuť“: `validate(AcceptContract | DeclineContract)` → `dispatch` len pri `ok` (pravidlo 5,
 *   `contract-actions.ts`); príkaz nesie `id` prvého kontraktu skupiny voyage a sim ho aplikuje na celú skupinu (roundtrip);
 *   dôvod, prečo sa ponuku nedá prijať, je v karte (`disabledReason`).
 * - Bez otvoreného panelu sa nevykreslí nič (ani hooky nad snapshotom), takže pravý okraj mapy ostáva klikateľný.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ContractsPanel, type ContractCardId, type ContractsTab } from '@ui/contracts-panel';
import { acceptOffer, declineOffer } from './contract-actions';
import type { OverlaySelection } from './overlay-selection';
import type { PanelSelection } from './panel-selection';
import { useSimBridge, useSimSnapshot } from './use-sim-snapshot';

/** Je cieľ udalosti textové pole (klávesa nesmie prepínať panel)? */
function isEditable(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/**
 * `C` prepína panel kontraktov, Esc ho zatvára (len keď je otvorený). Kým je otvorený modálny overlay (Nastavenia,
 * Uložiť/načítať), klávesy patria jemu (T06-03b): panel sa pod ním neprepína ani nezatvára.
 */
export function usePanelKeys(panels: PanelSelection, overlays?: OverlaySelection): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.repeat || isEditable(event.target)) return;
      if (overlays?.isOpen() === true) return;
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
  }, [panels, overlays]);
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
      acceptOffer(bridge, Number(id));
    },
    [bridge],
  );
  const decline = useCallback(
    (id: ContractCardId) => {
      declineOffer(bridge, Number(id));
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
  /** Otvorený overlay (T06-03b): kým je, skratky `C` a Esc panel neovládajú. */
  readonly overlays?: OverlaySelection;
}

export function ConnectedContractsPanel({ panels, overlays }: ConnectedContractsPanelProps) {
  const open = useSyncExternalStore(panels.subscribe, panels.get, panels.get) === 'contracts';
  usePanelKeys(panels, overlays);
  return open ? <OpenContractsPanel panels={panels} /> : null;
}
