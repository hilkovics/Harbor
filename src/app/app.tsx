/**
 * Koreňový React komponent: UI vrstva nad mapou (HUD, banner pauzy, štítok ghostu). Mapa (Pixi canvas) žije
 * v samostatnom prvku pod ním, pripája ho `bootstrap`; táto vrstva nezachytáva myš mimo svojich prvkov.
 *
 * Nadpis „Modular Harbor“ je vizuálne skrytý, ale ostáva v strome (čítačky obrazovky, smoke test).
 */
import { TopHUD } from '@ui/top-hud';
import { BuildFeedbackLabel, type FeedbackSource } from './build-feedback';
import { PausedBanner } from './paused-banner';
import type { SimBridge } from './sim-bridge';
import { SimBridgeProvider } from './use-sim-snapshot';
import './app.css';

export interface AppProps {
  readonly bridge: SimBridge;
  /** Zdroj spätnej väzby ghostu (typicky `InputController`). */
  readonly feedback: FeedbackSource;
}

export function App({ bridge, feedback }: AppProps) {
  return (
    <SimBridgeProvider bridge={bridge}>
      <h1 className="app__title">Modular Harbor</h1>
      <PausedBanner />
      <BuildFeedbackLabel source={feedback} />
      <div className="app__hud">
        <TopHUD />
      </div>
    </SimBridgeProvider>
  );
}
