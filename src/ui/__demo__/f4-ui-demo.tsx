/**
 * Demo F4 UI (T04-07): ModuleInspector brány, čakacej plochy (stojísk) a rampy (docky, staging, „Neprevádzková") a
 * BuildBar Landside so skutočnými položkami brána / čakacia plocha / rampa. V kontexte „hry" (TopHUD hore, inšpektor
 * brány vpravo, BuildBar Landside dole — rozloženie prototypu design/ui/game-ui.source.html) a pod tým kontrolné pásy
 * stavov. Statické dáta (`f4-ui-data.ts`), žiadna simulácia. Spustenie: dev server → /src/ui/__demo__/f4-ui-demo.html;
 * screenshot robí tests/e2e/f4-ui-demo.spec.ts.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BuildBar, type BuildBarCategory } from '../build-bar';
import { ModuleInspector, type ModuleInspectorData } from '../module-inspector';
import { TopHUDView } from '../top-hud';
import {
  F4_CASH_CENTS,
  F4_CATEGORIES,
  F4_STATES_CATEGORIES,
  GATE_DISCONNECTED,
  GATE_QUEUE_3,
  RAMP_NO_GATE,
  RAMP_OPERATIONAL,
  WAITING_3_OF_6,
  WAITING_FULL,
} from './f4-ui-data';
import { DEMO_SPEEDS } from './static-bridge';
import './demo-base';
import './f4-ui-demo.css';

function noop(): void {
  // Demo: HUD je len kulisa, rýchlosť sa nemení.
}

/** Lokálny záznam poslednej akcie, aby šlo overiť zapojenie callbackov (`onSelect`, `onRemove`…). */
function useActionLog(): { readonly text: string; readonly record: (action: string) => void } {
  const [lastAction, setLastAction] = useState<string | null>(null);
  return { text: lastAction === null ? 'Posledná akcia: —' : `Posledná akcia: ${lastAction}`, record: setLastAction };
}

interface StatefulBarProps {
  readonly categories: readonly BuildBarCategory[];
  readonly initialSelected: string | null;
  readonly idPrefix: string;
  readonly record: (action: string) => void;
}

/** BuildBar Landside s lokálnym stavom kategórie a výberu; výber sa zapíše do záznamu. */
function StatefulBar({ categories, initialSelected, idPrefix, record }: StatefulBarProps) {
  const [activeCategoryId, setActiveCategoryId] = useState('landside');
  const [selectedDefId, setSelectedDefId] = useState<string | null>(initialSelected);
  return (
    <BuildBar
      categories={categories}
      activeCategoryId={activeCategoryId}
      selectedDefId={selectedDefId}
      onSelectCategory={setActiveCategoryId}
      onSelect={(defId) => {
        setSelectedDefId(defId);
        record(`onSelect(${String(defId)})`);
      }}
      idPrefix={idPrefix}
    />
  );
}

/** „Hra": mapa z tokenov, HUD hore, inšpektor brány (fronta 3) vpravo, BuildBar Landside (brána vybraná) dole. */
function GameStage() {
  const log = useActionLog();
  return (
    <div className="f4-demo__map f4-demo__stage" data-testid="stage">
      <span className="f4-demo__map-label">{`MAPA · PixiJS canvas · ${log.text}`}</span>
      <div className="f4-demo__stage-hud">
        <TopHUDView cashCents={F4_CASH_CENTS} day={11} hour={14} minute={20} speed={1} speeds={DEMO_SPEEDS} onSpeedChange={noop} />
      </div>
      <div className="f4-demo__stage-panel">
        <ModuleInspector
          data={GATE_QUEUE_3}
          onRemove={(id) => {
            log.record(`onRemove(${String(id)})`);
          }}
          onClose={() => {
            log.record('onClose()');
          }}
        />
      </div>
      <div className="f4-demo__stage-bar" data-testid="stage-bar">
        <StatefulBar categories={F4_CATEGORIES} initialSelected="truck_gate" idPrefix="demo-f4" record={log.record} />
      </div>
    </div>
  );
}

interface InspectorFrameProps {
  readonly title: string;
  readonly data: ModuleInspectorData;
  readonly testId: string;
}

/** Inšpektor v rámci s výškou ako v hre; callbacky sa zapisujú pod panel. */
function InspectorFrame({ title, data, testId }: InspectorFrameProps) {
  const log = useActionLog();
  return (
    <figure className="f4-demo__figure" data-testid={testId}>
      <figcaption className="f4-demo__caption">{title}</figcaption>
      <div className="f4-demo__map f4-demo__map--panel">
        <ModuleInspector
          data={data}
          onRemove={(id) => {
            log.record(`onRemove(${String(id)})`);
          }}
          onClose={() => {
            log.record('onClose()');
          }}
        />
      </div>
      <span className="f4-demo__log" data-field="last-action">
        {log.text}
      </span>
    </figure>
  );
}

export function F4UiDemo() {
  const barLog = useActionLog();
  return (
    <main className="f4-demo">
      <section className="f4-demo__section">
        <div className="f4-demo__caption">Inšpektor brány (fronta 3, 20 / h, 18 tickov) + BuildBar Landside (cesty, brána, čakacia plocha, rampa) v kontexte hry</div>
        <GameStage />
      </section>
      <section className="f4-demo__section">
        <div className="f4-demo__caption">Brána bez cesty (vzor insp_gate: Nepripojené) · čakacia plocha 3 + 1 rezervované z 6 · plná čakacia plocha</div>
        <div className="f4-demo__row">
          <InspectorFrame title="Brána — nepripojená, nepustí nikoho" data={GATE_DISCONNECTED} testId="gate-disconnected" />
          <InspectorFrame title="Čakacia plocha — 3 obsadené, 1 rezervované, 2 voľné" data={WAITING_3_OF_6} testId="waiting-3" />
          <InspectorFrame title="Čakacia plocha — plná (4 + 2 rezervované)" data={WAITING_FULL} testId="waiting-full" />
        </div>
      </section>
      <section className="f4-demo__section">
        <div className="f4-demo__caption">Rampa v prevádzke (dock 1: 2 / 2 + kamión, dock 2: 1 / 2) · neprevádzková rampa (chýba brána na ceste)</div>
        <div className="f4-demo__row">
          <InspectorFrame title="Rampa — v prevádzke" data={RAMP_OPERATIONAL} testId="ramp-ok" />
          <InspectorFrame title="Rampa — neprevádzková, dôvod: chýba brána" data={RAMP_NO_GATE} testId="ramp-inoperative" />
        </div>
      </section>
      <section className="f4-demo__section" data-testid="states">
        <div className="f4-demo__caption">{`BuildBar Landside — stavy položiek (bez peňazí, dostupná, vybraná, zamknutá technológiou) · ${barLog.text}`}</div>
        <div className="f4-demo__map f4-demo__map--bar">
          <StatefulBar categories={F4_STATES_CATEGORIES} initialSelected="loading_ramp_container" idPrefix="demo-f4-states" record={barLog.record} />
        </div>
      </section>
    </main>
  );
}

/** Pripojí demo do `element`. */
export function mountF4UiDemo(element: HTMLElement): void {
  createRoot(element).render(<F4UiDemo />);
}
