/**
 * Demo F6a UI (T6A-07; ADR-032): ContractsPanel s export bookingom (cieľový prístav, cut-off, dovezené / naložené, zadržané
 * VGM, rolled, vrátené) a spoločnou kartou voyage (roundtrip: import + export, jedno „Prijať oba“), inšpektor skladu
 * s rozdelením import / export, inšpektor lode pri kotvisku (náklad podľa smeru, lashing s progresom) a toasty nových udalostí.
 * V kontexte „hry“ (TopHUD, panel kontraktov vpravo, toasty vľavo od panelu — rozloženie prototypu design/ui/game-ui.source.html)
 * a pod tým kontrolné pásy. Statické dáta (`f6a-ui-data.ts`), žiadna simulácia. Spustenie: dev server →
 * /src/ui/__demo__/f6a-ui-demo.html; screenshot a kontrolu robí tests/e2e/f6a-ui-demo.spec.ts.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContractCard, ContractsPanel, type ContractCardData, type ContractsTab } from '../contracts-panel';
import { ModuleInspector, type ModuleInspectorData } from '../module-inspector';
import { Toasts, type ToastData } from '../toasts';
import { TopHUDView } from '../top-hud';
import {
  F6A_ACTIVE,
  F6A_ALL,
  F6A_BERTH_LASHING,
  F6A_BERTH_LOADING,
  F6A_GALLERY,
  F6A_HISTORY,
  F6A_TIME,
  F6A_YARD,
  exportToasts,
  penaltyToasts,
} from './f6a-ui-data';
import { F5_CASH_CENTS, F5_DELTA_POSITIVE_CENTS, F5_XP } from './f5-ui-data';
import { DEMO_SPEEDS } from './static-bridge';
import './demo-base';
import './f6a-ui-demo.css';

function noop(): void {
  // Demo: HUD je len kulisa, rýchlosť sa nemení.
}

/** Lokálny záznam poslednej akcie, aby šlo overiť zapojenie callbackov (`onAccept`, `onDecline`, `onRemove`…). */
function useActionLog(): { readonly text: string; readonly record: (action: string) => void } {
  const [lastAction, setLastAction] = useState<string | null>(null);
  return { text: lastAction === null ? 'Posledná akcia: —' : `Posledná akcia: ${lastAction}`, record: setLastAction };
}

interface StatefulPanelProps {
  readonly contracts: readonly ContractCardData[];
  readonly initialTab: ContractsTab;
  readonly record: (action: string) => void;
}

/** ContractsPanel s lokálnym stavom záložky; akcie sa zapisujú do záznamu. */
function StatefulPanel({ contracts, initialTab, record }: StatefulPanelProps) {
  const [tab, setTab] = useState<ContractsTab>(initialTab);
  return (
    <ContractsPanel
      contracts={contracts}
      tab={tab}
      onTabChange={(next) => {
        setTab(next);
        record(`onTabChange(${next})`);
      }}
      time={F6A_TIME}
      onAccept={(id) => {
        record(`onAccept(${String(id)})`);
      }}
      onDecline={(id) => {
        record(`onDecline(${String(id)})`);
      }}
      onClose={() => {
        record('onClose()');
      }}
    />
  );
}

/** „Hra“: mapa z tokenov, HUD, panel Ponúk vpravo (roundtrip, export s dôvodom, import) a toasty exportu vľavo od panelu. */
function GameStage() {
  const log = useActionLog();
  const [closedToasts, setClosedToasts] = useState<readonly (number | string)[]>([]);
  const toasts: readonly ToastData[] = exportToasts(
    (id) => {
      setClosedToasts((current) => [...current, id]);
      log.record(`toast onClose(${String(id)})`);
    },
    (id) => {
      log.record(`toast onShow(${String(id)})`);
    },
  ).filter((toast) => !closedToasts.includes(toast.id));
  return (
    <div className="f6a-demo__map f6a-demo__stage" data-testid="stage">
      <span className="f6a-demo__map-label">{`MAPA · PixiJS canvas · ${log.text}`}</span>
      <div className="f6a-demo__stage-hud">
        <TopHUDView
          cashCents={F5_CASH_CENTS}
          day={11}
          hour={14}
          minute={20}
          speed={1}
          speeds={DEMO_SPEEDS}
          onSpeedChange={noop}
          dailyDeltaCents={F5_DELTA_POSITIVE_CENTS}
          xp={F5_XP}
        />
      </div>
      <div className="f6a-demo__stage-panel">
        <StatefulPanel contracts={F6A_ALL} initialTab="offers" record={log.record} />
      </div>
      <Toasts toasts={toasts} />
    </div>
  );
}

interface PanelFrameProps {
  readonly title: string;
  readonly testId: string;
  readonly contracts: readonly ContractCardData[];
  readonly initialTab: ContractsTab;
}

/** Panel v rámci s výškou ako v hre; callbacky sa zapisujú pod panel. */
function PanelFrame({ title, testId, contracts, initialTab }: PanelFrameProps) {
  const log = useActionLog();
  return (
    <figure className="f6a-demo__figure" data-testid={testId}>
      <figcaption className="f6a-demo__caption">{title}</figcaption>
      <div className="f6a-demo__map f6a-demo__map--panel">
        <StatefulPanel contracts={contracts} initialTab={initialTab} record={log.record} />
      </div>
      <span className="f6a-demo__log" data-field="last-action">
        {log.text}
      </span>
    </figure>
  );
}

interface InspectorFrameProps {
  readonly title: string;
  readonly testId: string;
  readonly data: ModuleInspectorData;
}

/** Inšpektor v rámci s výškou ako v hre; odstránenie a zavretie sa zapisujú pod panel. */
function InspectorFrame({ title, testId, data }: InspectorFrameProps) {
  const log = useActionLog();
  return (
    <figure className="f6a-demo__figure" data-testid={testId}>
      <figcaption className="f6a-demo__caption">{title}</figcaption>
      <div className="f6a-demo__map f6a-demo__map--panel f6a-demo__map--inspector">
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
      <span className="f6a-demo__log" data-field="last-action">
        {log.text}
      </span>
    </figure>
  );
}

/** Galéria: každý stav export karty samostatne (bez panela), callbacky zapisuje záznam. */
function CardGallery() {
  const log = useActionLog();
  return (
    <section className="f6a-demo__section" data-testid="gallery">
      <div className="f6a-demo__caption">{`Export karty: ponuka s dôvodom · prijatý (príchody v pláne) · pred cut-off so zadržanými VGM · po cut-off (rolled, last minute, vrátené) · splnený · zlyhaný · ${log.text}`}</div>
      <div className="f6a-demo__gallery">
        {F6A_GALLERY.map((contract) => (
          <ContractCard
            key={contract.id}
            contract={contract}
            time={F6A_TIME}
            onAccept={(id) => {
              log.record(`onAccept(${String(id)})`);
            }}
            onDecline={(id) => {
              log.record(`onDecline(${String(id)})`);
            }}
          />
        ))}
      </div>
    </section>
  );
}

/** Toasty penalizácií bookingu v „mape“ s výškou zásobníka. */
function PenaltyToastFrame() {
  const [closed, setClosed] = useState<readonly (number | string)[]>([]);
  const toasts = penaltyToasts(
    (id) => {
      setClosed((current) => [...current, id]);
    },
    () => {
      // Demo: „Zobraziť“ nič neotvára.
    },
  ).filter((toast) => !closed.includes(toast.id));
  return (
    <figure className="f6a-demo__figure f6a-demo__figure--wide" data-testid="penalty-toasts">
      <figcaption className="f6a-demo__caption">Penalizácie bookingu — last minute · rolled · nesplnený booking</figcaption>
      <div className="f6a-demo__map f6a-demo__map--toasts">
        <Toasts toasts={toasts} />
      </div>
    </figure>
  );
}

export function F6aUiDemo() {
  return (
    <main className="f6a-demo">
      <section className="f6a-demo__section">
        <div className="f6a-demo__caption">Panel kontraktov (Ponuky: roundtrip s jedným „Prijať oba“, export s dôvodom, import) + toasty cut-off / rolled / VGM / loď odplávala s exportom</div>
        <GameStage />
      </section>
      <section className="f6a-demo__section">
        <div className="f6a-demo__caption">Záložky Aktívne · História s export bookingom a roundtripom</div>
        <div className="f6a-demo__row">
          <PanelFrame title="Aktívne — roundtrip, export pred / po cut-off, prijatý" testId="panel-active" contracts={[...F6A_ACTIVE, ...F6A_HISTORY]} initialTab="active" />
          <PanelFrame title="História — export splnený / zlyhaný, roundtrip uzavretý" testId="panel-history" contracts={[...F6A_ACTIVE, ...F6A_HISTORY]} initialTab="history" />
        </div>
      </section>
      <section className="f6a-demo__section">
        <div className="f6a-demo__caption">Inšpektory: sklad s rozdelením import / export · kotvisko s loďou (import + export na palube) · lashing s progresom</div>
        <div className="f6a-demo__row">
          <InspectorFrame title="Sklad — 30 import / 16 export" testId="inspector-yard" data={F6A_YARD} />
          <InspectorFrame title="Kotvisko — loď vykladá import a nakladá export" testId="inspector-loading" data={F6A_BERTH_LOADING} />
          <InspectorFrame title="Kotvisko — lashing a papiere" testId="inspector-lashing" data={F6A_BERTH_LASHING} />
        </div>
      </section>
      <CardGallery />
      <section className="f6a-demo__section">
        <PenaltyToastFrame />
      </section>
    </main>
  );
}

/** Pripojí demo do `element`. */
export function mountF6aUiDemo(element: HTMLElement): void {
  createRoot(element).render(<F6aUiDemo />);
}
