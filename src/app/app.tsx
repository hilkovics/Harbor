/**
 * Koreňový React komponent: UI vrstva nad mapou (HUD, banner pauzy, štítok ghostu, BuildBar dole, vpravo inšpektor modulu
 * alebo panel kontraktov, toasty, modál konca hry, overlaye Nastavenia a Uložiť/načítať).
 * Mapa (Pixi canvas) žije v samostatnom prvku pod ním, pripája ho `bootstrap`; táto vrstva nezachytáva myš mimo
 * svojich prvkov.
 *
 * Nadpis „Modular Harbor“ je vizuálne skrytý, ale ostáva v strome (čítačky obrazovky, smoke test).
 */
import { useEffect, useState } from 'react';
import { BuildFeedbackLabel, type FeedbackSource } from './build-feedback';
import { BuildSelection } from './build-selection';
import { ConnectedBuildBar } from './connected-build-bar';
import { ConnectedContractsPanel } from './connected-contracts-panel';
import { ConnectedGameOver } from './connected-game-over';
import { ConnectedTopHUD } from './connected-hud';
import { ConnectedModuleInspector } from './connected-module-inspector';
import { ConnectedSaveLoad } from './connected-save-load';
import { ConnectedSettings } from './connected-settings';
import { ConnectedToasts } from './connected-toasts';
import { ModuleSelection } from './module-selection';
import { RoadSelection } from './road-selection';
import { OverlaySelection } from './overlay-selection';
import { PausedBanner } from './paused-banner';
import { PanelSelection, bindPanelExclusion } from './panel-selection';
import type { SaveController } from './save/save-controller';
import type { SimBridge } from './sim-bridge';
import type { ToastCenter } from './toast-center';
import { SimBridgeProvider } from './use-sim-snapshot';
import './app.css';

export interface AppProps {
  readonly bridge: SimBridge;
  /** Zdroj spätnej väzby ghostu (typicky `InputController`). */
  readonly feedback: FeedbackSource;
  /** Výber v BuildBar zdieľaný s ovládaním mapy (T02-10); bez neho si `App` vedie vlastný. */
  readonly selection?: BuildSelection;
  /** Výber modulu na mape (inšpektor vpravo) zdieľaný s ovládaním mapy (T02-10); bez neho si `App` vedie vlastný. */
  readonly moduleSelection?: ModuleSelection;
  /** Výber typu cesty (BuildBar Landside) zdieľaný s ovládaním mapy (T03-20); bez neho si `App` vedie vlastný. */
  readonly roadSelection?: RoadSelection;
  /** Oznámenia zo simu (T03-10: „Chýba sklad“, „Nepripojené“); bez neho sa zásobník toastov nezobrazí. */
  readonly toasts?: ToastCenter;
  /** Otvorený pravý panel (kontrakty) zdieľaný s toastami („Zobraziť“); bez neho si `App` vedie vlastný. */
  readonly panels?: PanelSelection;
  /** „Nová hra“ v modále konca hry (bootstrap postaví nový svet); bez neho sa stránka načíta odznova. */
  readonly onNewGame?: () => void;
  /**
   * Ukladanie a načítanie hry (T06-03): sloty, export/import, nastavenia. S ním sú ikony ⚙ a diskety v HUD funkčné
   * (overlaye Nastavenia a Uložiť/načítať, T06-03b); bez neho (testy, demo) sú aktívne, ale bez akcie.
   */
  readonly saves?: SaveController;
  /** Otvorený overlay (Nastavenia / Uložiť a načítať) zdieľaný s ovládaním mapy (blokuje herné klávesy); bez neho si `App` vedie vlastný. */
  readonly overlays?: OverlaySelection;
}

/** Predvolená „Nová hra“: načítanie stránky odznova (bootstrap zostaví nový svet). */
function reloadPage(): void {
  window.location.reload();
}

export function App({ bridge, feedback, selection, moduleSelection, roadSelection, toasts, panels, onNewGame, saves, overlays }: AppProps) {
  // Bez zdieľaného výberu (testy, demo) si App vytvorí vlastný; `useState` drží jednu inštanciu medzi rendermi.
  const [ownSelection] = useState(() => new BuildSelection());
  const [ownModuleSelection] = useState(() => new ModuleSelection());
  const [ownRoadSelection] = useState(() => new RoadSelection());
  const [ownPanels] = useState(() => new PanelSelection());
  const [ownOverlays] = useState(() => new OverlaySelection());
  const panelSelection = panels ?? ownPanels;
  const overlaySelection = overlays ?? ownOverlays;
  const inspectedModules = moduleSelection ?? ownModuleSelection;
  // Panel kontraktov a inšpektor sa delia o pravý okraj: otvorený panel má prednosť (zruší výber modulu).
  useEffect(() => bindPanelExclusion(panelSelection, inspectedModules), [panelSelection, inspectedModules]);
  return (
    <SimBridgeProvider bridge={bridge}>
      <h1 className="app__title">Modular Harbor</h1>
      <PausedBanner />
      <BuildFeedbackLabel source={feedback} />
      <div className="app__hud">
        <ConnectedTopHUD panels={panelSelection} overlays={saves === undefined ? undefined : overlaySelection} />
      </div>
      <ConnectedModuleInspector selection={inspectedModules} />
      <ConnectedContractsPanel panels={panelSelection} overlays={overlaySelection} />
      {toasts !== undefined && <ConnectedToasts center={toasts} />}
      <div className="app__build">
        <ConnectedBuildBar selection={selection ?? ownSelection} roadSelection={roadSelection ?? ownRoadSelection} />
      </div>
      <ConnectedGameOver onNewGame={onNewGame ?? reloadPage} />
      {saves !== undefined && (
        <>
          <ConnectedSettings overlays={overlaySelection} saves={saves} />
          <ConnectedSaveLoad overlays={overlaySelection} saves={saves} />
        </>
      )}
    </SimBridgeProvider>
  );
}
