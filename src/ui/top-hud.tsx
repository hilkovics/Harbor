/**
 * TopHUD (DESIGN_BRIEF §6.1; rozloženie z prototypu design/ui/game-ui.source.html, <header>): 48 px lišta —
 * [ic_cash] hotovosť + denný delta │ [ic_xp] XP │ [ic_calendar] Deň N · HH:MM │ ⏸ 1× 2× 4× 8× │ … │ ikony panelov.
 *
 * - `TopHUDView` je prezentačný (props → DOM), používa ho aj demo a testy.
 * - `TopHUD` je pripojený: číta `useSimSnapshot(selector, 100)` a rýchlosť zapisuje výlučne cez
 *   `dispatch(commandFromJSON({ type: 'SetGameSpeed', speed }))` (CLAUDE.md, pravidlá 1 a 5).
 *
 * PLACEHOLDER (F1): sim zatiaľ nepozná denný delta ani XP (dáta prídu vo F5/F8, Economy.daily / XP), preto sú to
 * voliteľné props (`dailyDeltaCents`, `xp`) so zástupným `—`. Rovnako sú vo F1 neaktívne ikony panelov vpravo
 * (kontrakty, financie, štatistiky, tech) — panely prídu neskôr; len ⚙ je aktívne (bez akcie, kým nie sú nastavenia).
 */
import { useCallback, useEffect, useRef } from 'react';
import { useSimBridge, useSimSnapshot } from '@app/use-sim-snapshot';
import type { WorldSnapshot } from '@app/sim-bridge';
import { resolveSpeedRequest } from '@app/speed-request';
import { commandFromJSON } from '@sim/commands';
import { EM_DASH, formatGameTime, formatMoney, formatMoneyDelta, formatXp, moneySign } from './format';
import { Icon, TrendIcon, type IconName } from './icon';
import { SpeedControl } from './speed-control';
import './top-hud.css';

/** Odstup prekresľovania HUD (ARCHITECTURE §13: `useSimSnapshot(selector, throttleMs = 100)`). */
export const HUD_THROTTLE_MS = 100;

/** Tlačidlá panelov vpravo v poradí prototypu. `settings` je aktívne aj bez panelov. */
export const HUD_PANEL_BUTTONS: ReadonlyArray<{ readonly id: string; readonly icon: IconName; readonly title: string }> = [
  { id: 'contracts', icon: 'ic_contract', title: 'Kontrakty (C)' },
  { id: 'finance', icon: 'ic_cash', title: 'Financie (F)' },
  { id: 'stats', icon: 'ic_utilization', title: 'Štatistiky (S)' },
  { id: 'tech', icon: 'ic_xp', title: 'Strom technológií (T)' },
  { id: 'settings', icon: 'ic_settings', title: 'Nastavenia' },
];

export interface TopHUDViewProps {
  /** Hotovosť v centoch; záporná hodnota zapne stav varovania. */
  readonly cashCents: number;
  /** Herný deň, 0-based (zobrazí sa `day + 1`). */
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** Aktuálna rýchlosť, 0 = pauza. */
  readonly speed: number;
  readonly speeds: readonly number[];
  readonly onSpeedChange: (speed: number) => void;
  /** Denná zmena hotovosti v centoch; `null`/vynechané = zástupný text (PLACEHOLDER F1, dáta vo F5). */
  readonly dailyDeltaCents?: number | null;
  /** Skúsenosti; `null`/vynechané = zástupný text (PLACEHOLDER F1, dáta vo F8). */
  readonly xp?: number | null;
  /** Otvorí nastavenia; bez handlera je ⚙ aktívne, ale bez akcie. */
  readonly onOpenSettings?: () => void;
  /** Id otvoreného panelu (zvýrazní jeho ikonu); ostatné panely sú vo F1 neaktívne. */
  readonly activePanel?: string | null;
  /** Prepnutie panelu (kontrakty/financie/štatistiky/tech). Bez handlera sú ikony panelov neaktívne placeholdery. */
  readonly onTogglePanel?: (panelId: string) => void;
}

function DailyDelta({ cents }: { cents: number | null }) {
  if (cents === null) {
    return (
      <span className="top-hud__delta" data-field="cash-delta" data-placeholder="true" title="Denný výsledok zatiaľ nie je k dispozícii">
        {`${EM_DASH}/deň`}
      </span>
    );
  }
  const sign = moneySign(cents);
  const tone = sign > 0 ? ' top-hud__delta--pos' : sign < 0 ? ' top-hud__delta--neg' : '';
  return (
    <span className={`top-hud__delta${tone}`} data-field="cash-delta">
      {sign !== 0 && <TrendIcon direction={sign > 0 ? 'up' : 'down'} className="top-hud__trend" />}
      {`${formatMoneyDelta(cents)}/deň`}
    </span>
  );
}

export function TopHUDView({
  cashCents,
  day,
  hour,
  minute,
  speed,
  speeds,
  onSpeedChange,
  dailyDeltaCents = null,
  xp = null,
  onOpenSettings,
  activePanel = null,
  onTogglePanel,
}: TopHUDViewProps) {
  const paused = speed === 0;
  const debt = cashCents < 0;
  return (
    <header className={debt ? 'top-hud top-hud--debt' : 'top-hud'} aria-label="Stav prístavu" data-paused={paused} data-debt={debt}>
      <div className="top-hud__cash" title={debt ? 'Záporná hotovosť' : undefined}>
        <Icon name="ic_cash" className="top-hud__cash-icon" />
        <span className="top-hud__cash-value" data-field="cash">
          {formatMoney(cashCents)}
        </span>
        {debt && <span className="top-hud__sr-only">Záporná hotovosť</span>}
        <DailyDelta cents={dailyDeltaCents} />
      </div>
      <span className="top-hud__divider" aria-hidden="true" />
      <div className={xp === null ? 'top-hud__xp top-hud__xp--empty' : 'top-hud__xp'}>
        <Icon name="ic_xp" className="top-hud__inline-icon top-hud__xp-icon" />
        <span data-field="xp" data-placeholder={xp === null ? 'true' : undefined}>
          {xp === null ? `${EM_DASH} XP` : formatXp(xp)}
        </span>
      </div>
      <span className="top-hud__divider" aria-hidden="true" />
      <div className="top-hud__clock">
        <Icon name="ic_calendar" className="top-hud__inline-icon top-hud__clock-icon" />
        <span className="top-hud__time" data-field="time">
          {formatGameTime({ day, hour, minute })}
        </span>
      </div>
      <span className="top-hud__divider" aria-hidden="true" />
      <SpeedControl value={speed} speeds={speeds} onChange={onSpeedChange} />
      <div className="top-hud__spacer" />
      <div className="top-hud__panels" role="group" aria-label="Panely">
        {HUD_PANEL_BUTTONS.map(({ id, icon, title }) => {
          const isSettings = id === 'settings';
          const handler = isSettings ? onOpenSettings : onTogglePanel === undefined ? undefined : () => { onTogglePanel(id); };
          const inactive = !isSettings && onTogglePanel === undefined;
          return (
            <button
              key={id}
              type="button"
              className={activePanel === id ? 'top-hud__panel top-hud__panel--active' : 'top-hud__panel'}
              aria-label={title}
              aria-pressed={isSettings ? undefined : activePanel === id}
              title={inactive ? `${title} · čoskoro` : title}
              data-field={`panel-${id}`}
              data-placeholder={inactive ? 'true' : undefined}
              disabled={inactive}
              onClick={handler}
            >
              <Icon name={icon} className="top-hud__panel-icon" />
            </button>
          );
        })}
      </div>
    </header>
  );
}

interface HudSlice {
  readonly cashCents: number;
  readonly speed: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** Výber pre HUD; nový objekt pri každom snapshote, preto ho `useSimSnapshot` porovnáva cez `sameHudSlice`. */
function selectHudSlice(snapshot: WorldSnapshot): HudSlice {
  return { cashCents: snapshot.cashCents, speed: snapshot.speed, day: snapshot.day, hour: snapshot.hour, minute: snapshot.minute };
}

function sameHudSlice(a: HudSlice, b: HudSlice): boolean {
  return a.cashCents === b.cashCents && a.speed === b.speed && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

// `resolveSpeedRequest` (klik na ⏸ pri pauze obnoví poslednú nenulovú rýchlosť) zdieľa klávesnica (Space,
// InputController), preto žije v `@app/speed-request`; odtiaľto sa len re-exportuje.
export { resolveSpeedRequest };

/** Callback, ktorý odošle `SetGameSpeed(speed)` do simulácie (zápis len cez `dispatch`). */
export function useSetGameSpeed(): (speed: number) => void {
  const bridge = useSimBridge();
  return useCallback(
    (speed: number) => {
      bridge.dispatch(commandFromJSON({ type: 'SetGameSpeed', speed }));
    },
    [bridge],
  );
}

export interface TopHUDProps {
  /** Denná zmena hotovosti v centoch (Economy.daily, F5); vynechané = zástupný text. */
  readonly dailyDeltaCents?: number | null;
  /** Skúsenosti (F8); vynechané = zástupný text. */
  readonly xp?: number | null;
  /** Ponúkané rýchlosti; predvolene `world.defs.time.speeds` (nie natvrdo v UI). */
  readonly speeds?: readonly number[];
  readonly onOpenSettings?: () => void;
  readonly activePanel?: string | null;
  readonly onTogglePanel?: (panelId: string) => void;
}

/** HUD pripojený na `SimBridge` (vyžaduje `<SimBridgeProvider>` vyššie v strome). */
export function TopHUD({ dailyDeltaCents, xp, speeds, onOpenSettings, activePanel, onTogglePanel }: TopHUDProps) {
  const bridge = useSimBridge();
  const hud = useSimSnapshot(selectHudSlice, HUD_THROTTLE_MS, sameHudSlice);
  const setSpeed = useSetGameSpeed();
  const speedList = speeds ?? bridge.world.defs.time.speeds;

  // Posledná nenulová rýchlosť: cieľ „obnoviť" po pauze. Aktualizuje sa po vykreslení, nie počas neho.
  const lastRunning = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (hud.speed !== 0) lastRunning.current = hud.speed;
  }, [hud.speed]);

  const currentSpeed = hud.speed;
  const onSpeedChange = useCallback(
    (requested: number) => {
      const fallback = speedList.find((speed) => speed !== 0);
      setSpeed(resolveSpeedRequest(requested, currentSpeed, lastRunning.current ?? fallback));
    },
    [setSpeed, currentSpeed, speedList],
  );

  return (
    <TopHUDView
      cashCents={hud.cashCents}
      day={hud.day}
      hour={hud.hour}
      minute={hud.minute}
      speed={hud.speed}
      speeds={speedList}
      onSpeedChange={onSpeedChange}
      dailyDeltaCents={dailyDeltaCents}
      xp={xp}
      onOpenSettings={onOpenSettings}
      activePanel={activePanel}
      onTogglePanel={onTogglePanel}
    />
  );
}
