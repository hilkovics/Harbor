/**
 * TopHUD s dátami F5 (T05-07): denná zmena hotovosti (`dailyDeltaCents`) a XP zo snapshotu, ikona kontraktov otvára
 * panel (`PanelSelection`). Ostatné ikony panelov (financie, štatistiky, tech) zatiaľ nemajú panel — klik na ne nič
 * nerobí, kým ich nepripojí príslušná fáza.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { TopHUD } from '@ui/top-hud';
import { isPanelId, type PanelSelection } from './panel-selection';
import { useSimSnapshot } from './use-sim-snapshot';

export interface ConnectedTopHUDProps {
  readonly panels: PanelSelection;
}

export function ConnectedTopHUD({ panels }: ConnectedTopHUDProps) {
  const dailyDeltaCents = useSimSnapshot((snapshot) => snapshot.dailyDeltaCents);
  const xp = useSimSnapshot((snapshot) => snapshot.xp);
  const activePanel = useSyncExternalStore(panels.subscribe, panels.get, panels.get);
  const toggle = useCallback(
    (id: string) => {
      if (isPanelId(id)) panels.toggle(id);
    },
    [panels],
  );
  return <TopHUD dailyDeltaCents={dailyDeltaCents} xp={xp} activePanel={activePanel} onTogglePanel={toggle} />;
}
