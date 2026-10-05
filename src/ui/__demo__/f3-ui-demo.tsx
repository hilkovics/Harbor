/**
 * Demo F3 UI (T03-09): BuildBar (Sklady / Logistika s položkou „kúpiť"), ModuleInspector (sklad, depo, nepripojený
 * modul) a Toasts v kontexte „hry" (TopHUD hore, inšpektor dvora vpravo, toasty vľavo od neho, BuildBar dole —
 * rozloženie prototypu design/ui/game-ui.source.html) a pod tým kontrolné pásy stavov. Statické dáta (`f3-ui-data.ts`),
 * žiadna simulácia. Spustenie: dev server → /src/ui/__demo__/f3-ui-demo.html; screenshot robí tests/e2e/f3-ui-demo.spec.ts.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BuildBar, type BuildBarCategory } from '../build-bar';
import { ModuleInspector, type ModuleInspectorData } from '../module-inspector';
import { TopHUDView } from '../top-hud';
import { Toasts, type ToastData } from '../toasts';
import {
  ALL_TONE_TOAST_SEEDS,
  DEPOT_2,
  DEPOT_FULL,
  F3_CASH_CENTS,
  F3_CATEGORIES,
  F3_STATES_CATEGORIES,
  STAGE_TOAST_SEEDS,
  YARD_72,
  YARD_DISCONNECTED,
  YARD_FULL,
} from './f3-ui-data';
import { DEMO_SPEEDS } from './static-bridge';
import './demo-base';
import './f3-ui-demo.css';

function noop(): void {
  // Demo: HUD je len kulisa, rýchlosť sa nemení.
}

/** Lokálny záznam poslednej akcie, aby šlo overiť zapojenie callbackov (`onBuy`, `onBuyVehicle`, `onSellVehicle`…). */
function useActionLog(): { readonly text: string; readonly record: (action: string) => void } {
  const [lastAction, setLastAction] = useState<string | null>(null);
  return { text: lastAction === null ? 'Posledná akcia: —' : `Posledná akcia: ${lastAction}`, record: setLastAction };
}

interface StatefulBarProps {
  readonly categories: readonly BuildBarCategory[];
  readonly initialCategoryId: string;
  readonly initialSelected: string | null;
  readonly idPrefix: string;
  readonly record: (action: string) => void;
}

/** BuildBar s lokálnym stavom kategórie a výberu; nákup (`buy`) sa len zapíše do záznamu. */
function StatefulBar({ categories, initialCategoryId, initialSelected, idPrefix, record }: StatefulBarProps) {
  const [activeCategoryId, setActiveCategoryId] = useState(initialCategoryId);
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
      onBuy={(defId) => {
        record(`onBuy(${defId})`);
      }}
      idPrefix={idPrefix}
    />
  );
}

/** Toasty s lokálnym zoznamom: „Zavrieť" toast odstráni, „Zobraziť / Ukázať" zapíše akciu. */
function useToasts(
  seeds: readonly (Omit<ToastData, 'onClose' | 'onShow'> & { readonly withShow: boolean })[],
  record: (action: string) => void,
): readonly ToastData[] {
  const [closed, setClosed] = useState<readonly (string | number)[]>([]);
  return seeds
    .filter((seed) => !closed.includes(seed.id))
    .map(({ withShow, ...seed }) => ({
      ...seed,
      ...(withShow
        ? {
            onShow: (id: string | number) => {
              record(`onShow(${String(id)})`);
            },
          }
        : {}),
      onClose: (id: string | number) => {
        setClosed((current) => [...current, id]);
        record(`onClose(${String(id)})`);
      },
    }));
}

/** „Hra": mapa z tokenov, HUD hore, inšpektor dvora vpravo, dva toasty vľavo od neho, BuildBar (Logistika) dole. */
function GameStage() {
  const log = useActionLog();
  const toasts = useToasts(STAGE_TOAST_SEEDS, log.record);
  return (
    <div className="f3-demo__map f3-demo__stage" data-testid="stage">
      <span className="f3-demo__map-label">{`MAPA · PixiJS canvas · ${log.text}`}</span>
      <div className="f3-demo__stage-hud">
        <TopHUDView cashCents={F3_CASH_CENTS} day={11} hour={14} minute={20} speed={1} speeds={DEMO_SPEEDS} onSpeedChange={noop} />
      </div>
      <div className="f3-demo__stage-panel">
        <ModuleInspector
          data={YARD_72}
          onRemove={(id) => {
            log.record(`onRemove(${String(id)})`);
          }}
          onClose={() => {
            log.record('onClose()');
          }}
        />
      </div>
      <Toasts toasts={toasts} />
      <div className="f3-demo__stage-bar" data-testid="stage-bar">
        <StatefulBar categories={F3_CATEGORIES} initialCategoryId="logistics" initialSelected="vehicle_depot" idPrefix="demo-f3" record={log.record} />
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
    <figure className="f3-demo__figure" data-testid={testId}>
      <figcaption className="f3-demo__caption">{title}</figcaption>
      <div className="f3-demo__map f3-demo__map--panel">
        <ModuleInspector
          data={data}
          onRemove={(id) => {
            log.record(`onRemove(${String(id)})`);
          }}
          onClose={() => {
            log.record('onClose()');
          }}
          onBuyVehicle={(depotId) => {
            log.record(`onBuyVehicle(${String(depotId)})`);
          }}
          onSellVehicle={(vehicleId) => {
            log.record(`onSellVehicle(${String(vehicleId)})`);
          }}
        />
      </div>
      <span className="f3-demo__log" data-field="last-action">
        {log.text}
      </span>
    </figure>
  );
}

function ToastsStrip() {
  const log = useActionLog();
  const toasts = useToasts(ALL_TONE_TOAST_SEEDS, log.record);
  return (
    <div className="f3-demo__toasts" data-testid="toasts-strip">
      <Toasts toasts={toasts} />
      <span className="f3-demo__log" data-field="last-action">
        {log.text}
      </span>
    </div>
  );
}

export function F3UiDemo() {
  const barLog = useActionLog();
  return (
    <main className="f3-demo">
      <section className="f3-demo__section">
        <div className="f3-demo__caption">
          Inšpektor dvora (zaplnenie 72 %) + Toasty „Chýba sklad" a „Nepripojené" + BuildBar Logistika (straddle carrier = kúpiť) v kontexte hry
        </div>
        <GameStage />
      </section>
      <section className="f3-demo__section">
        <div className="f3-demo__caption">Inšpektor depa (2 vozidlá, kúpiť) · plné depo s vozidlom bez cesty · dvor bez cesty (Nepripojené)</div>
        <div className="f3-demo__row">
          <InspectorFrame title="Depo — 2 vozidlá, nákup dostupný" data={DEPOT_2} testId="depot-2" />
          <InspectorFrame title="Depo — plné, jedno vozidlo bez cesty, nákup zablokovaný" data={DEPOT_FULL} testId="depot-full" />
          <InspectorFrame title="Dvor — nepripojený (vzor insp_gate)" data={YARD_DISCONNECTED} testId="yard-disconnected" />
        </div>
      </section>
      <section className="f3-demo__section">
        <div className="f3-demo__caption">Inšpektor dvora — takmer plný (91 %, voľné 0)</div>
        <div className="f3-demo__row">
          <InspectorFrame title="Dvor — 58 / 64 TEU, 6 rezervovaných" data={YARD_FULL} testId="yard-full" />
        </div>
      </section>
      <section className="f3-demo__section" data-testid="states">
        <div className="f3-demo__caption">{`BuildBar — stavy položiek Skladov a Logistiky (dostupná, bez peňazí, zamknutá, zamknutý nákup) · ${barLog.text}`}</div>
        <div className="f3-demo__map f3-demo__map--bar">
          <StatefulBar categories={F3_STATES_CATEGORIES} initialCategoryId="logistics" initialSelected={null} idPrefix="demo-f3-states" record={barLog.record} />
        </div>
      </section>
      <section className="f3-demo__section">
        <div className="f3-demo__caption">Toasts — všetky štyri tóny (prototyp: info, success, warning, danger)</div>
        <ToastsStrip />
      </section>
    </main>
  );
}

/** Pripojí demo do `element`. */
export function mountF3UiDemo(element: HTMLElement): void {
  createRoot(element).render(<F3UiDemo />);
}
