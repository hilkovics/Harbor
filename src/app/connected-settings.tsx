/**
 * SettingsPanel pripojený na `SaveController` (T06-03b): tenký wrapper — nastavenia číta cez `useSyncExternalStore`
 * (`saves.subscribe` / `saves.getState`), `Uložiť` volá `saves.setSettings`. Ponuka rýchlostí a intervalov autosave sa
 * odvádza z toho, čo úložisko nastavení prijme (`SETTINGS_SPEEDS`, `MAX_AUTOSAVE_EVERY_DAYS`), takže UI nikdy neponúkne
 * hodnotu, ktorú by `normalizeSettings` potichu nahradila predvolenou (UI tieto konštanty neimportuje, dostane ich cez props).
 */
import { useSyncExternalStore } from 'react';
import { SettingsPanel } from '@ui/settings-panel';
import type { OverlaySelection } from './overlay-selection';
import type { SaveController } from './save/save-controller';
import { MAX_AUTOSAVE_EVERY_DAYS, SETTINGS_SPEEDS, type DefaultSpeed } from './settings';
import { useOverlayEscape } from './use-overlay-escape';

/** Predvolené rýchlosti, ktoré panel ponúka: všetky prijateľné okrem pauzy (hra po štarte nemá bežať v pauze, ADR-030 bod 2). */
export const OFFERED_SPEEDS: readonly DefaultSpeed[] = SETTINGS_SPEEDS.filter((speed) => speed !== 0);

function OpenSettings({ overlays, saves }: ConnectedSettingsProps) {
  const { settings } = useSyncExternalStore(saves.subscribe, saves.getState, saves.getState);
  useOverlayEscape(overlays);
  // `.app__modal` vracia dialógu myš (`.app__ui` ju prepúšťa mape) a zakrýva mapu aj panely.
  return (
    <div className="app__modal">
      <SettingsPanel
        settings={settings}
        onChange={(next) => {
          saves.setSettings(next);
        }}
        onClose={overlays.close}
        speeds={OFFERED_SPEEDS}
        maxAutosaveDays={MAX_AUTOSAVE_EVERY_DAYS}
      />
    </div>
  );
}

export interface ConnectedSettingsProps {
  readonly overlays: OverlaySelection;
  readonly saves: SaveController;
}

export function ConnectedSettings({ overlays, saves }: ConnectedSettingsProps) {
  const open = useSyncExternalStore(overlays.subscribe, overlays.get, overlays.get) === 'settings';
  return open ? <OpenSettings overlays={overlays} saves={saves} /> : null;
}
