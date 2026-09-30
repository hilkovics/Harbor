/**
 * ContractsPanel (DESIGN_BRIEF §6.2 bod 3; rozloženie z prototypu design/ui/game-ui.source.html, pravý panel
 * `contracts` a `contracts_empty`): hlavička „Kontrakty", záložky Ponuky / Aktívne / História (s počtami) a zoznam kariet.
 * Karta: glyf kategórie, typ nákladu, objem (TEU) + XP, odmena, SLA (pilulka s farbou podľa naliehavosti), trieda lode,
 * stav; pri aktívnom kontrakte progres `Vyložené` / `Exportované` voči objemu a penalizácie; pri ponuke čas do
 * expirácie a tlačidlá „Prijať" / „Odmietnuť".
 *
 * Komponent je čisto prezentačný (props → DOM, bez hookov a bez čítania simulácie): zoznam `ContractCardData`, aktívnu
 * záložku a mierku času dodáva app vrstva (Fáza 5), zápis ide výlučne cez callbacky `onAccept(id)` / `onDecline(id)`
 * (rodič z nich pošle `AcceptContractCommand` / `DeclineContractCommand` cez `dispatch`). Zablokované „Prijať" nesie
 * dôvod (`disabledReason`): tlačidlo je `aria-disabled`, dôvod je v `title` aj viditeľný pod tlačidlami.
 *
 * Časy sú v tickoch (`slaDeadlineTick`, `offerExpiresTick`…) a `time.nowTick` je aktuálny tick; ako ich previesť na dni
 * a hodiny určuje `time.ticksPerHour` / `time.ticksPerDay` (z `SimClock`), formátuje `formatDuration`.
 */
import type { ReactNode } from 'react';
import {
  EM_DASH,
  formatCount,
  formatDuration,
  formatFraction,
  formatMoney,
  formatMoneyDelta,
  formatXp,
  moneySign,
  type TimeScale,
} from './format';
import { Icon, toIconName, type IconName } from './icon';
import './contracts-panel.css';

/** Stavy kontraktu presne podľa ARCHITECTURE §9.1. */
export type ContractCardState =
  | 'offered'
  | 'accepted'
  | 'ship_en_route'
  | 'unloading'
  | 'exporting'
  | 'completed'
  | 'failed'
  | 'expired';

/** Kategória nákladu (farba a glyf karty): `--cargo-<kategória>`, `ic_<kategória>`. */
export type ContractCargoCategory = 'container' | 'bulk' | 'liquid' | 'gas' | 'roro';

/** Id kontraktu (v simulácii branded číslo; UI ho len vracia v callbackoch). */
export type ContractCardId = number | string;

export type ContractsTab = 'offers' | 'active' | 'history';

/** Dáta jednej karty. Polia `volumeUnits`…`offerExpiresTick` zodpovedajú `Contract` z ARCHITECTURE §9.1. */
export interface ContractCardData {
  readonly id: ContractCardId;
  readonly state: ContractCardState;
  readonly cargoCategory: ContractCargoCategory;
  /** Názov nákladu pre hráča (`Kontajnery`). */
  readonly cargoLabel: string;
  /** Jednotka objemu (`TEU`). */
  readonly unit: string;
  readonly volumeUnits: number;
  readonly rewardCents: number;
  readonly xpReward: number;
  readonly shipClassId: string;
  /** Názov triedy lode pre hráča; bez neho sa ukáže `shipClassId`. */
  readonly shipClassLabel?: string;
  /** Tick, kedy ponuka expiruje (relevantné pre `offered`). */
  readonly offerExpiresTick: number;
  /** Dĺžka SLA okna (v tickoch) z šablóny; potrebná len pre ponuku, kým ešte nie je `slaDeadlineTick`. */
  readonly slaWindowTicks?: number;
  readonly slaDeadlineTick?: number;
  readonly shipArrivalTick?: number;
  /** Tick uzavretia (completed / failed / expired) — do nej sa v histórii počíta „včas" / „o N neskôr". */
  readonly closedTick?: number;
  readonly unitsUnloaded: number;
  readonly unitsExported: number;
  readonly penaltiesCents: number;
  /** Dôvod, prečo sa ponuku nedá prijať (napr. „Nedostatok kapacity"); pri jeho prítomnosti je „Prijať" zablokované. */
  readonly disabledReason?: string;
}

/** Aktuálny čas simulácie a mierka na prevod ticku na dni/hodiny. */
export interface ContractsTimeScale extends TimeScale {
  readonly nowTick: number;
}

export interface ContractsPanelProps {
  readonly contracts: readonly ContractCardData[];
  readonly tab: ContractsTab;
  readonly onTabChange: (tab: ContractsTab) => void;
  readonly time: ContractsTimeScale;
  readonly onAccept: (id: ContractCardId) => void;
  readonly onDecline: (id: ContractCardId) => void;
  readonly onClose?: () => void;
  /** Za koľko ticků príde ďalšia ponuka (prázdny stav Ponúk); `null`/vynechané = text bez času. */
  readonly nextOfferInTicks?: number | null;
}

// --- Čisté pomocné funkcie (testované samostatne) ---------------------------------------------------------------------

/** Prah dní, od ktorého je SLA zelené (≥ 5 dní) a žlté (≥ 3 dni); pod ním červené (prototyp `slaC`). */
export const SLA_OK_DAYS = 5;
export const SLA_WARN_DAYS = 3;
/** Aktívny kontrakt s SLA pod týmto počtom dní je „Ohrozené" (prototyp: SLA 1 deň → Ohrozené). */
export const AT_RISK_DAYS = 1;

export const CONTRACT_TAB_LABELS: Readonly<Record<ContractsTab, string>> = {
  offers: 'Ponuky',
  active: 'Aktívne',
  history: 'História',
};

const TAB_ORDER: readonly ContractsTab[] = ['offers', 'active', 'history'];

/** Záložka, do ktorej stav patrí: ponuka / prebiehajúci kontrakt / uzavretý kontrakt. */
export function contractTab(state: ContractCardState): ContractsTab {
  if (state === 'offered') return 'offers';
  if (state === 'completed' || state === 'failed' || state === 'expired') return 'history';
  return 'active';
}

/** Počty kariet na záložku (do popisiek záložiek). */
export function tabCounts(contracts: readonly ContractCardData[]): Readonly<Record<ContractsTab, number>> {
  const counts: Record<ContractsTab, number> = { offers: 0, active: 0, history: 0 };
  for (const contract of contracts) counts[contractTab(contract.state)] += 1;
  return counts;
}

/** Karty jednej záložky v poradí, v akom ich dodal rodič. */
export function contractsForTab(contracts: readonly ContractCardData[], tab: ContractsTab): readonly ContractCardData[] {
  return contracts.filter((contract) => contractTab(contract.state) === tab);
}

/** Suma vpravo hore: splnený = odmena − penalizácie, zlyhaný = −penalizácie (odmena prepadá), inak odmena. */
export function contractPayoutCents(contract: ContractCardData): number {
  if (contract.state === 'completed') return contract.rewardCents - contract.penaltiesCents;
  if (contract.state === 'failed') return -contract.penaltiesCents;
  return contract.rewardCents;
}

export type ContractTone = 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'muted';

export interface ContractSla {
  readonly text: string;
  readonly tone: 'ok' | 'warn' | 'danger' | 'muted';
  readonly title: string;
}

function slaToneForDays(days: number): 'ok' | 'warn' | 'danger' {
  if (days >= SLA_OK_DAYS) return 'ok';
  return days >= SLA_WARN_DAYS ? 'warn' : 'danger';
}

/**
 * SLA pilulka: ponuka = dĺžka okna po príchode lode; aktívny = zostávajúci čas (po termíne `po termíne o …`);
 * uzavretý = `včas` / `o … neskôr` (ak je známy `closedTick`); expirovaná ponuka nemá SLA (`null`).
 */
export function contractSla(contract: ContractCardData, time: ContractsTimeScale): ContractSla | null {
  const { state } = contract;
  if (state === 'expired') return null;
  if (state === 'offered') {
    if (contract.slaWindowTicks === undefined) return { text: EM_DASH, tone: 'muted', title: 'SLA nie je známe' };
    return {
      text: formatDuration(contract.slaWindowTicks, time),
      tone: slaToneForDays(contract.slaWindowTicks / time.ticksPerDay),
      title: 'SLA: čas na export po príchode lode',
    };
  }
  const deadline = contract.slaDeadlineTick;
  if (deadline === undefined) return { text: EM_DASH, tone: 'muted', title: 'SLA nie je známe' };
  if (state === 'completed' || state === 'failed') {
    if (contract.closedTick === undefined) return null;
    const late = contract.closedTick - deadline;
    return late <= 0
      ? { text: 'včas', tone: 'ok', title: 'Splnené v rámci SLA' }
      : { text: `o ${formatDuration(late, time)} neskôr`, tone: 'danger', title: 'Splnené po termíne SLA' };
  }
  const remaining = deadline - time.nowTick;
  if (remaining < 0) {
    return { text: `po termíne o ${formatDuration(-remaining, time)}`, tone: 'danger', title: 'SLA termín uplynul' };
  }
  return { text: formatDuration(remaining, time), tone: slaToneForDays(remaining / time.ticksPerDay), title: 'Zostáva do SLA termínu' };
}

export interface ContractStatus {
  readonly label: string;
  readonly icon: IconName;
  readonly tone: ContractTone;
}

const STATUS: Readonly<Record<ContractCardState, ContractStatus>> = {
  offered: { label: 'Ponuka', icon: 'ic_info', tone: 'info' },
  accepted: { label: 'Prijaté', icon: 'ic_check', tone: 'accent' },
  ship_en_route: { label: 'Loď na ceste', icon: 'ic_ship', tone: 'accent' },
  unloading: { label: 'Vykladá sa', icon: 'ic_busy', tone: 'accent' },
  exporting: { label: 'Exportuje sa', icon: 'ic_truck', tone: 'accent' },
  completed: { label: 'Splnené', icon: 'ic_check', tone: 'ok' },
  failed: { label: 'Zlyhané', icon: 'ic_close', tone: 'danger' },
  expired: { label: 'Expirovaná', icon: 'ic_clock', tone: 'muted' },
};

/** Stav karty; aktívny kontrakt blízko SLA termínu je `Ohrozené`, po termíne `Po termíne` (prototyp: Prebieha / Ohrozené). */
export function contractStatus(contract: ContractCardData, time: ContractsTimeScale): ContractStatus {
  if (contractTab(contract.state) === 'active' && contract.slaDeadlineTick !== undefined) {
    const remaining = contract.slaDeadlineTick - time.nowTick;
    if (remaining < 0) return { label: 'Po termíne', icon: 'ic_warning', tone: 'danger' };
    if (remaining < AT_RISK_DAYS * time.ticksPerDay) return { label: 'Ohrozené', icon: 'ic_warning', tone: 'warn' };
  }
  return STATUS[contract.state];
}

/** Percento pre šírku pruhu: 0–100, celé číslo, objem 0 → 0. */
export function progressPercent(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((part / total) * 100)));
}

/** Text expirácie ponuky (`Expiruje o 1 d 4 h`). */
export function offerExpiryText(contract: ContractCardData, time: ContractsTimeScale): string {
  return `Expiruje o ${formatDuration(contract.offerExpiresTick - time.nowTick, time)}`;
}

/** Ponuka expiruje do 1 dňa → zvýraznená. */
export function offerExpiresSoon(contract: ContractCardData, time: ContractsTimeScale): boolean {
  return contract.offerExpiresTick - time.nowTick < time.ticksPerDay;
}

/** Text lode: trieda a pri lodi na ceste čas do príchodu (`Panamax · o 5 h`). */
export function shipText(contract: ContractCardData, time: ContractsTimeScale): string {
  const name = contract.shipClassLabel ?? contract.shipClassId;
  if (contract.state === 'ship_en_route' && contract.shipArrivalTick !== undefined) {
    return `${name} · o ${formatDuration(contract.shipArrivalTick - time.nowTick, time)}`;
  }
  return name;
}

// --- Komponenty -----------------------------------------------------------------------------------------------------------

function ProgressBar({ field, label, part, total, unit }: { field: string; label: string; part: number; total: number; unit: string }) {
  const percent = progressPercent(part, total);
  return (
    <div className="contract-card__bar" data-field={field}>
      <div className="contract-card__bar-head">
        <span>{label}</span>
        <span className="contract-card__bar-value" data-field={`${field}-value`}>
          {formatFraction(part, total, unit)}
        </span>
      </div>
      <div
        className="contract-card__bar-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="contract-card__bar-fill" style={{ width: `${String(percent)}%` }} data-percent={percent} />
      </div>
    </div>
  );
}

export interface ContractCardProps {
  readonly contract: ContractCardData;
  readonly time: ContractsTimeScale;
  readonly onAccept: (id: ContractCardId) => void;
  readonly onDecline: (id: ContractCardId) => void;
}

/** Jedna karta kontraktu. */
export function ContractCard({ contract, time, onAccept, onDecline }: ContractCardProps) {
  const { id, state } = contract;
  const tab = contractTab(state);
  const sla = contractSla(contract, time);
  const status = contractStatus(contract, time);
  const payout = contractPayoutCents(contract);
  const payoutSign = moneySign(payout);
  const blocked = contract.disabledReason !== undefined;
  const soon = state === 'offered' && offerExpiresSoon(contract, time);
  const rewardTone = state === 'expired' ? 'muted' : payoutSign < 0 ? 'neg' : payoutSign > 0 ? 'pos' : 'zero';
  return (
    <article
      className={`contract-card contract-card--${contract.cargoCategory}`}
      data-contract-id={id}
      data-state={state}
      data-tab={tab}
      aria-label={`Kontrakt: ${contract.cargoLabel}, ${formatCount(contract.volumeUnits, contract.unit)}`}
    >
      <div className="contract-card__head">
        <div className="contract-card__tile">
          <Icon name={toIconName(contract.cargoCategory)} className="contract-card__tile-icon" />
        </div>
        <div className="contract-card__titles">
          <span className="contract-card__title" data-field="cargo">
            {contract.cargoLabel}
          </span>
          <span className="contract-card__meta">
            <span data-field="volume">{formatCount(contract.volumeUnits, contract.unit)}</span>
            {' · '}
            <span className="contract-card__xp" data-field="xp-reward">
              {formatXp(contract.xpReward)}
            </span>
          </span>
        </div>
        <span className={`contract-card__reward contract-card__reward--${rewardTone}`} data-field="reward">
          {state === 'expired' ? formatMoney(payout) : formatMoneyDelta(payout)}
        </span>
      </div>
      <div className="contract-card__chips">
        {sla !== null && (
          <span className={`contract-card__pill contract-card__pill--${sla.tone}`} title={sla.title} data-field="sla" data-tone={sla.tone}>
            <Icon name="ic_clock" className="contract-card__pill-icon" />
            {sla.text}
          </span>
        )}
        <span className="contract-card__pill contract-card__pill--plain" data-field="ship" data-ship-class={contract.shipClassId}>
          <Icon name="ic_ship" className="contract-card__pill-icon" />
          {shipText(contract, time)}
        </span>
        <span className="contract-card__spacer" />
        <span className={`contract-card__status contract-card__status--${status.tone}`} data-field="status" data-tone={status.tone}>
          <Icon name={status.icon} className="contract-card__status-icon" />
          {status.label}
        </span>
      </div>
      {tab === 'active' && (
        <div className="contract-card__bars">
          <ProgressBar field="unloaded" label="Vyložené" part={contract.unitsUnloaded} total={contract.volumeUnits} unit={contract.unit} />
          <ProgressBar field="exported" label="Exportované" part={contract.unitsExported} total={contract.volumeUnits} unit={contract.unit} />
        </div>
      )}
      {contract.penaltiesCents > 0 && (
        <div className="contract-card__penalty" data-field="penalties" title="Penalizácie za státie lode a meškanie exportu">
          <Icon name="ic_warning" className="contract-card__penalty-icon" />
          <span className="contract-card__penalty-label">Penalizácie</span>
          <span className="contract-card__penalty-value" data-field="penalties-value">
            {formatMoneyDelta(-contract.penaltiesCents)}
          </span>
        </div>
      )}
      {state === 'offered' && (
        <div className="contract-card__offer">
          <span className={soon ? 'contract-card__expiry contract-card__expiry--soon' : 'contract-card__expiry'} data-field="expiry">
            <Icon name="ic_clock" className="contract-card__expiry-icon" />
            {offerExpiryText(contract, time)}
          </span>
          <div className="contract-card__actions">
            <button
              type="button"
              className="contract-card__btn contract-card__btn--primary"
              aria-disabled={blocked}
              title={contract.disabledReason}
              data-action="accept"
              onClick={() => {
                if (!blocked) onAccept(id);
              }}
            >
              <Icon name="ic_check" className="contract-card__btn-icon" />
              Prijať
            </button>
            <button
              type="button"
              className="contract-card__btn"
              data-action="decline"
              onClick={() => {
                onDecline(id);
              }}
            >
              Odmietnuť
            </button>
          </div>
          {blocked && (
            <p className="contract-card__reason">
              <Icon name="ic_lock" className="contract-card__reason-icon" />
              <span data-field="accept-reason">{contract.disabledReason}</span>
            </p>
          )}
        </div>
      )}
    </article>
  );
}

const EMPTY_TEXTS: Readonly<Record<ContractsTab, { readonly title: string; readonly text: string }>> = {
  offers: { title: 'Žiadne ponuky', text: 'Nové ponuky prichádzajú každý deň.' },
  active: { title: 'Žiadne aktívne kontrakty', text: 'Prijmi ponuku a loď sa vydá do prístavu.' },
  history: { title: 'Zatiaľ žiadna história', text: 'Tu nájdeš splnené, zlyhané a expirované kontrakty.' },
};

/** Text prázdneho stavu; pri Ponukách s `nextOfferInTicks` ukáže, kedy príde ďalšia (prototyp: „Ďalšia ponuka príde o 2 dni."). */
export function emptyState(tab: ContractsTab, time: TimeScale, nextOfferInTicks?: number | null): { title: string; text: string } {
  const base = EMPTY_TEXTS[tab];
  if (tab === 'offers' && nextOfferInTicks !== undefined && nextOfferInTicks !== null) {
    return { title: base.title, text: `Ďalšia ponuka príde o ${formatDuration(nextOfferInTicks, time)}.` };
  }
  return base;
}

function Tabs({ tab, counts, onTabChange }: { tab: ContractsTab; counts: Readonly<Record<ContractsTab, number>>; onTabChange: (tab: ContractsTab) => void }) {
  return (
    <div className="contracts-panel__tabs" role="tablist" aria-label="Kontrakty">
      {TAB_ORDER.map((id) => {
        const selected = id === tab;
        // História je bez počtu (prototyp: „História"); ostatné „Ponuky · 3".
        const label = id === 'history' ? CONTRACT_TAB_LABELS[id] : `${CONTRACT_TAB_LABELS[id]} · ${String(counts[id])}`;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`contracts-tab-${id}`}
            aria-selected={selected}
            aria-controls="contracts-tabpanel"
            className={selected ? 'contracts-panel__tab contracts-panel__tab--active' : 'contracts-panel__tab'}
            data-tab={id}
            data-count={counts[id]}
            onClick={() => {
              onTabChange(id);
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ContractsEmpty({ tab, time, nextOfferInTicks }: { tab: ContractsTab; time: TimeScale; nextOfferInTicks?: number | null }): ReactNode {
  const { title, text } = emptyState(tab, time, nextOfferInTicks);
  return (
    <div className="contracts-panel__empty" data-section="empty" data-tab={tab}>
      <div className="contracts-panel__empty-badge">
        <Icon name="ic_contract" className="contracts-panel__empty-icon" />
      </div>
      <span className="contracts-panel__empty-title" data-field="empty-title">
        {title}
      </span>
      <span className="contracts-panel__empty-text" data-field="empty-text">
        {text}
      </span>
    </div>
  );
}

export function ContractsPanel({ contracts, tab, onTabChange, time, onAccept, onDecline, onClose, nextOfferInTicks }: ContractsPanelProps) {
  const counts = tabCounts(contracts);
  const shown = contractsForTab(contracts, tab);
  return (
    <aside className="contracts-panel" aria-label="Kontrakty" data-tab={tab}>
      <div className="contracts-panel__header">
        <Icon name="ic_contract" className="contracts-panel__header-icon" />
        <span className="contracts-panel__title">Kontrakty</span>
        <button type="button" className="contracts-panel__close" title="Zavrieť (Esc)" aria-label="Zavrieť kontrakty" onClick={onClose}>
          <Icon name="ic_close" className="contracts-panel__close-icon" />
        </button>
      </div>
      <div className="contracts-panel__body">
        <Tabs tab={tab} counts={counts} onTabChange={onTabChange} />
        <div className="contracts-panel__list" role="tabpanel" id="contracts-tabpanel" aria-labelledby={`contracts-tab-${tab}`}>
          {shown.length === 0 ? (
            <ContractsEmpty tab={tab} time={time} nextOfferInTicks={nextOfferInTicks} />
          ) : (
            shown.map((contract) => <ContractCard key={contract.id} contract={contract} time={time} onAccept={onAccept} onDecline={onDecline} />)
          )}
        </div>
      </div>
    </aside>
  );
}
