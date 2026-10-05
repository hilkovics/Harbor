/**
 * Demo F5 UI (predstih T05-06): ContractsPanel (Ponuky / Aktívne / História, prázdny stav), TopHUD s kladným aj záporným
 * dennom delta a XP, GameOverModal „Bankrot" a toasty kontraktov (success / warning / danger). V kontexte „hry" (TopHUD
 * hore, panel kontraktov vpravo, toasty vľavo od panelu — rozloženie prototypu design/ui/game-ui.source.html) a pod tým
 * kontrolné pásy stavov. Statické dáta (`f5-ui-data.ts`), žiadna simulácia. Spustenie: dev server →
 * /src/ui/__demo__/f5-ui-demo.html; screenshot robí tests/e2e/f5-ui-demo.spec.ts.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContractCard, ContractsPanel, type ContractCardData, type ContractsTab } from '../contracts-panel';
import { GameOverModal } from '../game-over-modal';
import { Toasts } from '../toasts';
import { TopHUDView } from '../top-hud';
import {
  F5_ALL,
  F5_CASH_CENTS,
  F5_CASH_DEBT_CENTS,
  F5_DELTA_NEGATIVE_CENTS,
  F5_DELTA_POSITIVE_CENTS,
  F5_GALLERY,
  F5_NEXT_OFFER_TICKS,
  F5_NO_OFFERS,
  F5_TIME,
  F5_XP,
  contractToasts,
} from './f5-ui-data';
import { DEMO_SPEEDS } from './static-bridge';
import './demo-base';
import './f5-ui-demo.css';

function noop(): void {
  // Demo: HUD je len kulisa, rýchlosť sa nemení.
}

/** Lokálny záznam poslednej akcie, aby šlo overiť zapojenie callbackov (`onAccept`, `onDecline`, `onNewGame`…). */
function useActionLog(): { readonly text: string; readonly record: (action: string) => void } {
  const [lastAction, setLastAction] = useState<string | null>(null);
  return { text: lastAction === null ? 'Posledná akcia: —' : `Posledná akcia: ${lastAction}`, record: setLastAction };
}

interface StatefulPanelProps {
  readonly contracts: readonly ContractCardData[];
  readonly initialTab: ContractsTab;
  readonly record: (action: string) => void;
  readonly nextOfferInTicks?: number | null;
}

/** ContractsPanel s lokálnym stavom záložky; akcie sa zapisujú do záznamu. */
function StatefulPanel({ contracts, initialTab, record, nextOfferInTicks }: StatefulPanelProps) {
  const [tab, setTab] = useState<ContractsTab>(initialTab);
  return (
    <ContractsPanel
      contracts={contracts}
      tab={tab}
      onTabChange={(next) => {
        setTab(next);
        record(`onTabChange(${next})`);
      }}
      time={F5_TIME}
      onAccept={(id) => {
        record(`onAccept(${String(id)})`);
      }}
      onDecline={(id) => {
        record(`onDecline(${String(id)})`);
      }}
      onClose={() => {
        record('onClose()');
      }}
      nextOfferInTicks={nextOfferInTicks}
    />
  );
}

/** „Hra": mapa z tokenov, HUD (kladný delta + XP), panel Ponúk vpravo a toasty kontraktov vľavo od panelu. */
function GameStage() {
  const log = useActionLog();
  const [closedToasts, setClosedToasts] = useState<readonly (number | string)[]>([]);
  const toasts = contractToasts(
    (id) => {
      setClosedToasts((current) => [...current, id]);
      log.record(`toast onClose(${String(id)})`);
    },
    (id) => {
      log.record(`toast onShow(${String(id)})`);
    },
  ).filter((toast) => !closedToasts.includes(toast.id));
  return (
    <div className="f5-demo__map f5-demo__stage" data-testid="stage">
      <span className="f5-demo__map-label">{`MAPA · PixiJS canvas · ${log.text}`}</span>
      <div className="f5-demo__stage-hud">
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
      <div className="f5-demo__stage-panel">
        <StatefulPanel contracts={F5_ALL} initialTab="offers" record={log.record} />
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
  readonly nextOfferInTicks?: number | null;
}

/** Panel v rámci s výškou ako v hre; callbacky sa zapisujú pod panel. */
function PanelFrame({ title, testId, contracts, initialTab, nextOfferInTicks }: PanelFrameProps) {
  const log = useActionLog();
  return (
    <figure className="f5-demo__figure" data-testid={testId}>
      <figcaption className="f5-demo__caption">{title}</figcaption>
      <div className="f5-demo__map f5-demo__map--panel">
        <StatefulPanel contracts={contracts} initialTab={initialTab} record={log.record} nextOfferInTicks={nextOfferInTicks} />
      </div>
      <span className="f5-demo__log" data-field="last-action">
        {log.text}
      </span>
    </figure>
  );
}

interface HudFrameProps {
  readonly title: string;
  readonly testId: string;
  readonly cashCents: number;
  readonly dailyDeltaCents: number | null;
  readonly xp: number | null;
}

/** Jedna lišta HUD nad „mapou" (poloprehľadné `--ui-bg`). */
function HudFrame({ title, testId, cashCents, dailyDeltaCents, xp }: HudFrameProps) {
  return (
    <figure className="f5-demo__figure" data-testid={testId}>
      <figcaption className="f5-demo__caption">{title}</figcaption>
      <div className="f5-demo__map f5-demo__map--hud">
        <TopHUDView
          cashCents={cashCents}
          day={11}
          hour={14}
          minute={20}
          speed={1}
          speeds={DEMO_SPEEDS}
          onSpeedChange={noop}
          dailyDeltaCents={dailyDeltaCents}
          xp={xp}
        />
      </div>
    </figure>
  );
}

/** Galéria: každý stav karty samostatne (bez panela), callbacky zapisuje záznam. */
function CardGallery() {
  const log = useActionLog();
  return (
    <section className="f5-demo__section" data-testid="gallery">
      <div className="f5-demo__caption">{`Karty všetkých stavov: 3 ponuky (aj zablokovaná, aj expirujúca čoskoro) · prijaté · loď na ceste · vykladá sa · exportuje sa · ohrozené · po termíne · splnené včas / neskoro · zlyhané · expirovaná · ${log.text}`}</div>
      <div className="f5-demo__gallery">
        {F5_GALLERY.map((contract) => (
          <ContractCard
            key={contract.id}
            contract={contract}
            time={F5_TIME}
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

function GameOverFrame() {
  const log = useActionLog();
  return (
    <figure className="f5-demo__figure" data-testid="game-over">
      <figcaption className="f5-demo__caption">GameOverModal „Bankrot" (cash &lt; 0 po 30 dní) — nad mapou</figcaption>
      <div className="f5-demo__map f5-demo__map--modal">
        <span className="f5-demo__map-label">MAPA · PixiJS canvas</span>
        <GameOverModal
          daysSurvived={142}
          completedContracts={87}
          xp={12_340}
          bankruptcyDays={30}
          onNewGame={() => {
            log.record('onNewGame()');
          }}
          onLoadGame={() => {
            log.record('onLoadGame()');
          }}
        />
      </div>
      <span className="f5-demo__log" data-field="last-action">
        {log.text}
      </span>
    </figure>
  );
}

export function F5UiDemo() {
  return (
    <main className="f5-demo">
      <section className="f5-demo__section">
        <div className="f5-demo__caption">Panel kontraktov (Ponuky) + TopHUD s kladným denným delta a XP + toasty výplaty / penalizácie / failu v kontexte hry</div>
        <GameStage />
      </section>
      <section className="f5-demo__section">
        <div className="f5-demo__caption">Záložky Aktívne · História · prázdne Ponuky (vzor contracts_empty)</div>
        <div className="f5-demo__row">
          <PanelFrame title="Aktívne — 6 kontraktov" testId="panel-active" contracts={F5_ALL} initialTab="active" />
          <PanelFrame title="História — splnené, zlyhané, expirované" testId="panel-history" contracts={F5_ALL} initialTab="history" />
          <PanelFrame
            title="Ponuky — prázdny stav"
            testId="panel-empty"
            contracts={F5_NO_OFFERS}
            initialTab="offers"
            nextOfferInTicks={F5_NEXT_OFFER_TICKS}
          />
        </div>
      </section>
      <CardGallery />
      <section className="f5-demo__section" data-testid="hud-strips">
        <div className="f5-demo__caption">TopHUD — kladná delta (▲ zelená) · záporná delta pri cash &lt; 0 (▼ červená) · bez dát (zástupné —)</div>
        <HudFrame title="Kladná delta, 340 XP" testId="hud-positive" cashCents={F5_CASH_CENTS} dailyDeltaCents={F5_DELTA_POSITIVE_CENTS} xp={F5_XP} />
        <HudFrame title="Záporná delta, cash &lt; 0" testId="hud-negative" cashCents={F5_CASH_DEBT_CENTS} dailyDeltaCents={F5_DELTA_NEGATIVE_CENTS} xp={F5_XP} />
        <HudFrame title="Bez dát (F1–F4)" testId="hud-placeholder" cashCents={F5_CASH_CENTS} dailyDeltaCents={null} xp={null} />
      </section>
      <section className="f5-demo__section">
        <GameOverFrame />
      </section>
    </main>
  );
}

/** Pripojí demo do `element`. */
export function mountF5UiDemo(element: HTMLElement): void {
  createRoot(element).render(<F5UiDemo />);
}
