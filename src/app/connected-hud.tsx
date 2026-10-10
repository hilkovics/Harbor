/**
 * TopHUD s dátami F5 (T05-07): denná zmena hotovosti (`dailyDeltaCents`) a XP zo snapshotu, ikona kontraktov otvára
 * panel (`PanelSelection`), ikony ⚙ a diskety (T06-03b) otvárajú overlay (`OverlaySelection`). Ostatné ikony panelov (financie, štatistiky, tech) zatiaľ nemajú panel — klik na ne nič
 * nerobí, kým ich nepripojí príslušná fáza.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { TopHUD } from '@ui/top-hud';
import type { OverlaySelection } from './overlay-selection';
import { isPanelId, type PanelSelection } from './panel-selection';
import { useSimSnapshot } from './use-sim-snapshot';

export interface ConnectedTopHUDProps {
  readonly panels: PanelSelection;
  /** Overlaye Nastavenia a Uložiť/načítať (T06-03b); bez nich sú ikony ⚙ a diskety aktívne, ale bez akcie. */
  readonly overlays?: OverlaySelection;
}

export function ConnectedTopHUD({ panels, overlays }: ConnectedTopHUDProps) {
  const dailyDeltaCents = useSimSnapshot((snapshot) => snapshot.dailyDeltaCents);
  const xp = useSimSnapshot((snapshot) => snapshot.xp);
  const activePanel = useSyncExternalStore(panels.subscribe, panels.get, panels.get);
  const toggle = useCallback(
    (id: string) => {
      if (isPanelId(id)) panels.toggle(id);
    },
    [panels],
  );
  const openSettings = useCallback(() => {
    overlays?.open('settings');
  }, [overlays]);
  const openSaves = useCallback(() => {
    overlays?.open('saves');
  }, [overlays]);
  return (
    <TopHUD
      dailyDeltaCents={dailyDeltaCents}
      xp={xp}
      activePanel={activePanel}
      onTogglePanel={toggle}
      onOpenSettings={overlays === undefined ? undefined : openSettings}
      onOpenSaves={overlays === undefined ? undefined : openSaves}
    />
  );
}
