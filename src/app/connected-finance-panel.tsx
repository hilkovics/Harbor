/**
 * FinancePanel pripojený na simuláciu (R5, TR5-05): pravý panel otvorený ikonou Financie v TopHUD (`PanelSelection` `finance`).
 * Dáta zo `financeVM` (kategórie ledgera + energia), prepočet pri každej throttlovanej notifikácii snapshotu. Bez otvoreného panelu nič.
 */
import { useSyncExternalStore } from 'react';
import { FinancePanel } from '@ui/finance-panel';
import { financeVM, sameFinance } from './finance-vm';
import type { PanelSelection } from './panel-selection';
import { useSimBridge, useSimSnapshot } from './use-sim-snapshot';

function OpenFinancePanel() {
  const bridge = useSimBridge();
  const finance = useSimSnapshot(() => financeVM(bridge.world), undefined, sameFinance);
  return (
    <div className="app__side" data-panel="finance">
      <FinancePanel categories={finance.categories} energyCents={finance.energyCents} />
    </div>
  );
}

export function ConnectedFinancePanel({ panels }: { readonly panels: PanelSelection }) {
  const open = useSyncExternalStore(panels.subscribe, panels.get, panels.get) === 'finance';
  return open ? <OpenFinancePanel /> : null;
}
