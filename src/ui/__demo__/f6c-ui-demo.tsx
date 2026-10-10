/**
 * Demo F6c UI (T6C-05; ADR-034): ContractsPanel s kartami repositioningu prázdnych (linka, počet prázdnych, plavba, dostupné
 * prázdne, naložené) a prekládky (trasa loď A → loď B s odpočtom do príchodu B, vyložené / čakajúce / naložené / zmeškané, predané),
 * inšpektor depa prázdnych (dostupné / poškodené / v oprave podľa linky, opravárenské miesta), inšpektory skladu a lode so štyrmi
 * smermi a toasty nových udalostí (návrat prázdnych, oprava hotová, výdaj zlyhal, tranship zmeškaný / zachránený / predaný).
 * V kontexte „hry“ (TopHUD, panel kontraktov vpravo, toasty vľavo od panelu — rozloženie prototypu design/ui/game-ui.source.html)
 * a pod tým kontrolné pásy. Statické dáta (`f6c-ui-data.ts`), žiadna simulácia. Spustenie: dev server →
 * /src/ui/__demo__/f6c-ui-demo.html; screenshot a kontrolu robí tests/e2e/f6c-ui-demo.spec.ts.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContractCard, ContractsPanel, type ContractCardData, type ContractsTab } from '../contracts-panel';
import { ModuleInspector, type ModuleInspectorData } from '../module-inspector';
import { Toasts, type ToastData } from '../toasts';
import { TopHUDView } from '../top-hud';
import {
  F6C_ACTIVE,
  F6C_ALL,
  F6C_BERTH,
  F6C_BERTH_LASHING,
  F6C_DEPOT_BUSY,
  F6C_DEPOT_QUIET,
  F6C_GALLERY,
  F6C_HISTORY,
  F6C_TIME,
  F6C_YARD,
  emptyToasts,
  transhipToasts,
} from './f6c-ui-data';
import { F5_CASH_CENTS, F5_DELTA_POSITIVE_CENTS, F5_XP } from './f5-ui-data';
import { DEMO_SPEEDS } from './static-bridge';
import './demo-base';
import './f6c-ui-demo.css';

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
      time={F6C_TIME}
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

/** „Hra“: mapa z tokenov, HUD, panel Ponúk vpravo (repositioning, prekládka, export + prázdne) a toasty vľavo od panelu. */
function GameStage() {
  const log = useActionLog();
  const [closedToasts, setClosedToasts] = useState<readonly (number | string)[]>([]);
  const toasts: readonly ToastData[] = emptyToasts(
    (id) => {
      setClosedToasts((current) => [...current, id]);
      log.record(`toast onClose(${String(id)})`);
    },
    (id) => {
      log.record(`toast onShow(${String(id)})`);
    },
  ).filter((toast) => !closedToasts.includes(toast.id));
  return (
    <div className="f6c-demo__map f6c-demo__stage" data-testid="stage">
      <span className="f6c-demo__map-label">{`MAPA · PixiJS canvas · ${log.text}`}</span>
      <div className="f6c-demo__stage-hud">
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
      <div className="f6c-demo__stage-panel">
        <StatefulPanel contracts={F6C_ALL} initialTab="offers" record={log.record} />
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
    <figure className="f6c-demo__figure" data-testid={testId}>
      <figcaption className="f6c-demo__caption">{title}</figcaption>
      <div className="f6c-demo__map f6c-demo__map--panel">
        <StatefulPanel contracts={contracts} initialTab={initialTab} record={log.record} />
      </div>
      <span className="f6c-demo__log" data-field="last-action">
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
    <figure className="f6c-demo__figure" data-testid={testId}>
      <figcaption className="f6c-demo__caption">{title}</figcaption>
      <div className="f6c-demo__map f6c-demo__map--panel f6c-demo__map--inspector">
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
      <span className="f6c-demo__log" data-field="last-action">
        {log.text}
      </span>
    </figure>
  );
}

/** Galéria: každý stav karty nových druhov samostatne (bez panela), callbacky zapisuje záznam. */
function CardGallery() {
  const log = useActionLog();
  return (
    <section className="f6c-demo__section" data-testid="gallery">
      <div className="f6c-demo__caption">{`Karty: repositioning (ponuka · bez depa · nakladá sa · splnený) · prekládka (ponuka · čaká na loď B · zmeškaná · predané) · ${log.text}`}</div>
      <div className="f6c-demo__gallery">
        {F6C_GALLERY.map((contract) => (
          <ContractCard
            key={contract.id}
            contract={contract}
            time={F6C_TIME}
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

/** Toasty prekládky (zachránený, predaný) v „mape“ s výškou zásobníka. */
function TranshipToastFrame() {
  const [closed, setClosed] = useState<readonly (number | string)[]>([]);
  const toasts = transhipToasts(
    (id) => {
      setClosed((current) => [...current, id]);
    },
    () => {
      // Demo: „Zobraziť“ nič neotvára.
    },
  ).filter((toast) => !closed.includes(toast.id));
  return (
    <figure className="f6c-demo__figure f6c-demo__figure--wide" data-testid="tranship-toasts">
      <figcaption className="f6c-demo__caption">Prekládka — zachránená po zmeškaní · predaná kamiónom</figcaption>
      <div className="f6c-demo__map f6c-demo__map--toasts">
        <Toasts toasts={toasts} />
      </div>
    </figure>
  );
}

export function F6cUiDemo() {
  return (
    <main className="f6c-demo">
      <section className="f6c-demo__section">
        <div className="f6c-demo__caption">Panel kontraktov (Ponuky: repositioning, repositioning bez depa, prekládka, export + prázdne) + toasty návrat prázdnych / oprava / výdaj zlyhal / tranship zmeškaný</div>
        <GameStage />
      </section>
      <section className="f6c-demo__section">
        <div className="f6c-demo__caption">Záložky Aktívne · História s prekládkou a repositioningom</div>
        <div className="f6c-demo__row">
          <PanelFrame title="Aktívne — čaká na loď B, vykladá sa, zmeškaná loď B, nakladá sa, prijaté" testId="panel-active" contracts={[...F6C_ACTIVE, ...F6C_HISTORY]} initialTab="active" />
          <PanelFrame title="História — repositioning splnený, prekládka s predanými, zlyhaná" testId="panel-history" contracts={[...F6C_ACTIVE, ...F6C_HISTORY]} initialTab="history" />
        </div>
      </section>
      <section className="f6c-demo__section">
        <div className="f6c-demo__caption">Inšpektory: depo prázdnych (čakajú na opravu · pokojné) · dvor so štyrmi smermi · kotvisko s loďou (export + tranship + prázdne) · lashing</div>
        <div className="f6c-demo__row">
          <InspectorFrame title="Depo prázdnych — poškodené čakajú na opravu" testId="inspector-depot-busy" data={F6C_DEPOT_BUSY} />
          <InspectorFrame title="Depo prázdnych — pokojné" testId="inspector-depot-quiet" data={F6C_DEPOT_QUIET} />
          <InspectorFrame title="Dvor — import / export / tranship / prázdne" testId="inspector-yard" data={F6C_YARD} />
        </div>
        <div className="f6c-demo__row">
          <InspectorFrame title="Kotvisko — export, tranship a prázdne na palube" testId="inspector-berth" data={F6C_BERTH} />
          <InspectorFrame title="Kotvisko — lashing so štyrmi smermi" testId="inspector-lashing" data={F6C_BERTH_LASHING} />
        </div>
      </section>
      <CardGallery />
      <section className="f6c-demo__section">
        <TranshipToastFrame />
      </section>
    </main>
  );
}

/** Pripojí demo do `element`. */
export function mountF6cUiDemo(element: HTMLElement): void {
  createRoot(element).render(<F6cUiDemo />);
}
