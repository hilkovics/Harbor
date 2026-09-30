/**
 * Koreňový React komponent: UI vrstva nad mapou (HUD, banner pauzy, štítok ghostu, BuildBar dole, DEV nástroje).
 * Mapa (Pixi canvas) žije v samostatnom prvku pod ním, pripája ho `bootstrap`; táto vrstva nezachytáva myš mimo
 * svojich prvkov.
 *
 * Nadpis „Modular Harbor“ je vizuálne skrytý, ale ostáva v strome (čítačky obrazovky, smoke test).
 */
import { useState } from 'react';
import { TopHUD } from '@ui/top-hud';
import { BuildFeedbackLabel, type FeedbackSource } from './build-feedback';
import { BuildSelection } from './build-selection';
import { ConnectedBuildBar } from './connected-build-bar';
import { DevSpawnButton } from './dev-spawn-button';
import { PausedBanner } from './paused-banner';
import type { SimBridge } from './sim-bridge';
import { SimBridgeProvider } from './use-sim-snapshot';
import './app.css';

export interface AppProps {
  readonly bridge: SimBridge;
  /** Zdroj spätnej väzby ghostu (typicky `InputController`). */
  readonly feedback: FeedbackSource;
  /** Výber v BuildBar zdieľaný s ovládaním mapy (T02-10); bez neho si `App` vedie vlastný. */
  readonly selection?: BuildSelection;
  /**
   * DEV nástroje (tlačidlo „Spawn feeder (DEV)“) sa zobrazia len vo vývojovom builde (`import.meta.env.DEV`); `false`
   * ich vypne aj tam (testy). V produkčnom builde ich bundler z modulu odstráni.
   */
  readonly devTools?: boolean;
}

export function App({ bridge, feedback, selection, devTools = true }: AppProps) {
  // Bez zdieľaného výberu (testy, demo) si App vytvorí vlastný; `useState` drží jednu inštanciu medzi rendermi.
  const [ownSelection] = useState(() => new BuildSelection());
  return (
    <SimBridgeProvider bridge={bridge}>
      <h1 className="app__title">Modular Harbor</h1>
      <PausedBanner />
      <BuildFeedbackLabel source={feedback} />
      <div className="app__hud">
        <TopHUD />
      </div>
      {import.meta.env.DEV && devTools && (
        <div className="app__dev">
          <DevSpawnButton />
        </div>
      )}
      <div className="app__build">
        <ConnectedBuildBar selection={selection ?? ownSelection} />
      </div>
    </SimBridgeProvider>
  );
}
