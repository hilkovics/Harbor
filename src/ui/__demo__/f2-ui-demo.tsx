/**
 * Demo F2 UI (T02-08): BuildBar + ModuleInspector v kontexte „hry" (TopHUD hore, panel vpravo, BuildBar dole — rozloženie
 * prototypu design/ui/game-ui.source.html) a pod tým kontrolné pásy stavov. Statické dáta, žiadna simulácia.
 * Spustenie: dev server → /src/ui/__demo__/f2-ui-demo.html; screenshot robí tests/e2e/f2-ui-demo.spec.ts.
 */
import { createRoot } from 'react-dom/client';
import { TopHUDView } from '../top-hud';
import { ModuleInspector } from '../module-inspector';
import { BuildBarDemo, BuildBarStatesDemo, DEMO_CASH_CENTS } from './build-bar.demo';
import { BERTH_DOCKED, ModuleInspectorDemo, useActionLog } from './module-inspector.demo';
import { DEMO_SPEEDS } from './static-bridge';
import './demo-base';
import './f2-ui-demo.css';

function noop(): void {
  // Demo: HUD je len kulisa, rýchlosť sa nemení.
}

/** „Hra": mapa z tokenov, HUD hore, inšpektor kotviska vpravo, BuildBar dole. */
function GameStage() {
  const log = useActionLog();
  return (
    <div className="f2-demo__map f2-demo__stage" data-testid="stage">
      <span className="f2-demo__map-label">{`MAPA · PixiJS canvas · ${log.text}`}</span>
      <div className="f2-demo__stage-hud">
        <TopHUDView cashCents={DEMO_CASH_CENTS} day={11} hour={14} minute={20} speed={1} speeds={DEMO_SPEEDS} onSpeedChange={noop} />
      </div>
      <div className="f2-demo__stage-panel">
        <ModuleInspector data={BERTH_DOCKED} onRemove={log.onRemove} onClose={log.onClose} />
      </div>
      <div className="f2-demo__stage-bar" data-testid="stage-bar">
        <BuildBarDemo />
      </div>
    </div>
  );
}

export function F2UiDemo() {
  return (
    <main className="f2-demo">
      <section className="f2-demo__section">
        <div className="f2-demo__caption">BuildBar (Terminál, kotvisko vybrané, žeriav bez peňazí) + ModuleInspector (kotvisko) v kontexte hry</div>
        <GameStage />
      </section>
      <section className="f2-demo__section">
        <div className="f2-demo__caption">ModuleInspector — žeriav blocked / vykladá, štartové kotvisko</div>
        <ModuleInspectorDemo />
      </section>
      <section className="f2-demo__section" data-testid="states">
        <div className="f2-demo__caption">BuildBar — stavy položky (dostupná, bez peňazí, zamknutá, dlhý názov) a druhá povolená kategória</div>
        <div className="f2-demo__map f2-demo__map--bar">
          <BuildBarStatesDemo />
        </div>
      </section>
    </main>
  );
}

/** Pripojí demo do `element`. */
export function mountF2UiDemo(element: HTMLElement): void {
  createRoot(element).render(<F2UiDemo />);
}
