/**
 * SaveLoadPanel pripojený na `SaveController` (T06-03b): tenký wrapper — zoznam slotov čítá cez `useSyncExternalStore`
 * (`saves.subscribe` / `saves.getState`), akcie volajú metódy kontroléra (ten sám hlási zlyhania toastom). Otvára ho
 * ikona diskety v TopHUD (`OverlaySelection` = `saves`); pri otvorení sa sloty načítajú z úložiska znova (mohla ich zmeniť
 * iná karta prehliadača). Bez otvoreného overlayu sa nevykreslí nič.
 *
 * Načítanie a import reštartujú hru (`runGame`) a tým zrušia aj tento strom; pri chybe overlay ostáva otvorený a toast
 * povie dôvod.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { SaveLoadPanel, type SaveLoadPanelProps } from '@ui/save-load-panel';
import type { OverlaySelection } from './overlay-selection';
import type { SaveController } from './save/save-controller';
import { useOverlayEscape } from './use-overlay-escape';

/**
 * Akcie panelu nad kontrolérom (bez hookov, testovateľné bez DOM). Výsledky `ActionResult` sa zahadzujú: zlyhanie už
 * ohlásil kontrolér toastom.
 */
export function saveLoadActions(saves: SaveController): Omit<SaveLoadPanelProps, 'slots' | 'onClose'> {
  return {
    onSave: (slot) => {
      saves.save(slot);
    },
    onLoad: (slot) => {
      saves.load(slot);
    },
    onDelete: (slot) => {
      saves.remove(slot);
    },
    onExport: () => {
      saves.exportGame();
    },
    onImport: (file) => {
      void saves.importFile(file);
    },
  };
}

function OpenSaveLoad({ overlays, saves }: ConnectedSaveLoadProps) {
  const { slots } = useSyncExternalStore(saves.subscribe, saves.getState, saves.getState);
  useEffect(() => {
    saves.refreshSlots();
  }, [saves]);
  useOverlayEscape(overlays);
  // `.app__modal` vracia dialógu myš (`.app__ui` ju prepúšťa mape) a zakrýva mapu aj panely.
  return (
    <div className="app__modal">
      <SaveLoadPanel slots={slots} {...saveLoadActions(saves)} onClose={overlays.close} />
    </div>
  );
}

export interface ConnectedSaveLoadProps {
  readonly overlays: OverlaySelection;
  readonly saves: SaveController;
}

export function ConnectedSaveLoad({ overlays, saves }: ConnectedSaveLoadProps) {
  const open = useSyncExternalStore(overlays.subscribe, overlays.get, overlays.get) === 'saves';
  return open ? <OpenSaveLoad overlays={overlays} saves={saves} /> : null;
}
