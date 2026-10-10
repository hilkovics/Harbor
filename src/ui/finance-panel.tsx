/**
 * Tabuľka kategórií financií s riadkom `Energia` (TR5-04) a finančné grafy (TF7-03).
 *
 * Pôvodné správanie (bez `daily` / `monthly`) zostáva: tabuľka `categories` + riadok `Energia` (`energyCents`, predvolene 0).
 * Nové voliteľné vstupy `daily` / `monthly` (`FinancePeriod[]`) pridajú prepínač Deň / Mesiac, graf `StackedBars`
 * (príjmy nad osou, výdaje pod osou, farba podľa kategórie z tokenov, legenda), graf `LineChart` hotovosti na konci
 * obdobia a tabuľku kategórií (príjem, výdaj, netto) za posledné obdobie zvolenej rady.
 *
 * Čisto prezentačný: všetky sumy v centoch. Výdaje v `expenseByCat` a `energyCents` sú kladné sumy zaplatené. Peniaze cez
 * `formatMoney` / `formatMoneyDelta`, čísla s `tabular-nums`.
 */
import { useState } from 'react';
import { formatMoney, formatMoneyDelta, moneySign } from './format';
import {
  StackedBars,
  LineChart,
  categoryIds,
  periodTotals,
  categoryColor,
  finiteOr0,
  type FinanceChartCategory,
  type FinancePeriod,
} from './finance-charts';
import './finance-panel.css';

export type { FinancePeriod, FinanceChartCategory } from './finance-charts';

/** Riadok kategórie financií; `cents` je so znamienkom (príjem kladný, výdaj záporný). */
export interface FinanceCategoryRow {
  readonly id: string;
  readonly label: string;
  readonly cents: number;
}

/** Rada grafu: deň alebo mesiac. */
export type FinanceChartPeriod = 'day' | 'month';

/** Popisky prepínača rady. */
export const FINANCE_PERIOD_LABELS: Readonly<Record<FinanceChartPeriod, string>> = {
  day: 'Deň',
  month: 'Mesiac',
};

export interface FinancePanelProps {
  readonly categories?: readonly FinanceCategoryRow[];
  /** Výdaj za elektrinu reefrov v centoch (kladné číslo = zaplatené); predvolene 0. */
  readonly energyCents?: number;
  /** Denné obdobia (posledné sú najnovšie); bez hodnoty sa prepínač „Deň“ nezobrazí. */
  readonly daily?: readonly FinancePeriod[];
  /** Mesačné obdobia; bez hodnoty sa prepínač „Mesiac“ nezobrazí. */
  readonly monthly?: readonly FinancePeriod[];
  /** Kategórie grafov a tabuľky (poradie + názvy, `FinanceVM.categories`); chýbajúce id z dát sa doplnia ako názov = id. */
  readonly chartCategories?: readonly FinanceChartCategory[];
}

/** Názov kategórie energie v tabuľke. */
export const ENERGY_CATEGORY_LABEL = 'Energia';

/** Rady, ktoré má zmysel ponúknuť (podľa dostupných dát). */
export function availableFinancePeriods(
  daily: readonly FinancePeriod[] | undefined,
  monthly: readonly FinancePeriod[] | undefined,
): FinanceChartPeriod[] {
  const result: FinanceChartPeriod[] = [];
  if (daily !== undefined) result.push('day');
  if (monthly !== undefined) result.push('month');
  return result;
}

/**
 * Rada, ktorá sa zobrazí: požadovaná, ak je dostupná; inak prvá dostupná; bez dát `undefined`.
 */
export function resolveFinancePeriod(
  requested: FinanceChartPeriod,
  available: readonly FinanceChartPeriod[],
): FinanceChartPeriod | undefined {
  if (available.includes(requested)) return requested;
  return available[0];
}

/** Riadok tabuľky kategórií za posledné obdobie: príjem, výdaj, netto (centy, kladné magnitúdy). */
export interface FinanceBreakdownRow {
  readonly id: string;
  readonly label: string;
  readonly income: number;
  readonly expense: number;
  readonly net: number;
}

/** Riadky tabuľky kategórií pre jedno obdobie (poradie `categoryIds`). */
export function financeBreakdownRows(
  period: FinancePeriod | undefined,
  periods: readonly FinancePeriod[],
  categories: readonly FinanceChartCategory[] = [],
): FinanceBreakdownRow[] {
  if (period === undefined) return [];
  return categoryIds(periods, categories).map((category) => {
    const income = finiteOr0(period.incomeByCat[category.id]);
    const expense = finiteOr0(period.expenseByCat[category.id]);
    return { id: category.id, label: category.label, income, expense, net: income - expense };
  });
}

/** Tón čísla pre netto: pozitívne `--ui-money-pos`, negatívne `--ui-money-neg`, nula bez farby. */
function netTone(cents: number): string {
  const sign = moneySign(cents);
  if (sign > 0) return 'finance-panel__money--pos';
  if (sign < 0) return 'finance-panel__money--neg';
  return '';
}

function ChartSection({
  periods,
  chartCategories,
  mode,
}: {
  readonly periods: readonly FinancePeriod[];
  readonly chartCategories: readonly FinanceChartCategory[];
  readonly mode: FinanceChartPeriod;
}) {
  if (periods.length === 0) {
    return <p className="finance-panel__empty" data-field="finance-empty">Zatiaľ žiadne údaje.</p>;
  }
  const last = periods[periods.length - 1];
  const ids = categoryIds(periods, chartCategories);
  const lastTotals = last === undefined ? undefined : periodTotals(last);
  const rows = financeBreakdownRows(last, periods, chartCategories);
  const range = `${periods[0]?.label ?? ''} – ${last?.label ?? ''}`;
  return (
    <>
      <div className="finance-panel__head">
        <span className="finance-panel__title">Príjmy vs. výdaje</span>
        <span className="finance-panel__range" data-field="finance-range">
          {range}
        </span>
      </div>
      <div className="finance-panel__frame" data-mode={mode}>
        <StackedBars periods={periods} categories={ids} label={`Príjmy a výdaje po ${mode === 'day' ? 'dňoch' : 'mesiacoch'}`} />
      </div>
      <div className="finance-panel__head">
        <span className="finance-panel__title">Hotovosť</span>
        <span className="finance-panel__value-strong" data-field="finance-cash">
          {last === undefined ? formatMoney(0) : formatMoney(last.cashEnd)}
        </span>
      </div>
      <div className="finance-panel__frame">
        <LineChart
          values={periods.map((period) => period.cashEnd)}
          labels={periods.map((period) => period.label)}
          label="Hotovosť na konci obdobia"
        />
      </div>
      <table className="finance-panel__breakdown" data-section="finance-breakdown">
        <thead>
          <tr>
            <th scope="col">Kategória</th>
            <th scope="col" className="finance-panel__num">Príjem</th>
            <th scope="col" className="finance-panel__num">Výdaj</th>
            <th scope="col" className="finance-panel__num">Netto</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id} data-breakdown={row.id}>
              <th scope="row">
                <span className="finance-panel__swatch" style={{ background: categoryColor(index) }} />
                {row.label}
              </th>
              <td className="finance-panel__num" data-field={`breakdown-income-${row.id}`}>
                {formatMoney(row.income)}
              </td>
              <td className="finance-panel__num" data-field={`breakdown-expense-${row.id}`}>
                {formatMoney(row.expense)}
              </td>
              <td className={`finance-panel__num ${netTone(row.net)}`} data-field={`breakdown-net-${row.id}`}>
                {formatMoneyDelta(row.net)}
              </td>
            </tr>
          ))}
          {lastTotals === undefined ? null : (
            <tr className="finance-panel__total" data-breakdown="total">
              <th scope="row">Spolu</th>
              <td className="finance-panel__num" data-field="breakdown-income-total">
                {formatMoney(lastTotals.income)}
              </td>
              <td className="finance-panel__num" data-field="breakdown-expense-total">
                {formatMoney(lastTotals.expense)}
              </td>
              <td className={`finance-panel__num ${netTone(lastTotals.net)}`} data-field="breakdown-net-total">
                {formatMoneyDelta(lastTotals.net)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

export function FinancePanel({
  categories = [],
  energyCents = 0,
  daily,
  monthly,
  chartCategories = [],
}: FinancePanelProps) {
  const safeEnergy = Number.isFinite(energyCents) ? energyCents : 0;
  const [requested, setRequested] = useState<FinanceChartPeriod>('day');
  const available = availableFinancePeriods(daily, monthly);
  const mode = resolveFinancePeriod(requested, available);
  const periods = (mode === 'day' ? daily : monthly) ?? [];
  return (
    <section className="finance-panel" aria-label="Financie" data-section="finance-categories">
      {mode === undefined ? null : (
        <div className="finance-panel__body">
          <div className="finance-panel__toggle" role="group" aria-label="Obdobie grafov">
            {(['day', 'month'] as const).map((option) => {
              const enabled = available.includes(option);
              const active = mode === option;
              return (
                <button
                  key={option}
                  type="button"
                  className={active ? 'finance-panel__toggle-btn finance-panel__toggle-btn--active' : 'finance-panel__toggle-btn'}
                  aria-pressed={active}
                  disabled={!enabled}
                  data-period={option}
                  onClick={() => setRequested(option)}
                >
                  {FINANCE_PERIOD_LABELS[option]}
                </button>
              );
            })}
          </div>
          <ChartSection periods={periods} chartCategories={chartCategories} mode={mode} />
        </div>
      )}
      <table className="finance-panel__table">
        <tbody>
          {categories.map((row) => (
            <tr key={row.id} className="finance-panel__row" data-category={row.id}>
              <th scope="row" className="finance-panel__label">
                {row.label}
              </th>
              <td className="finance-panel__value" data-field={`category-${row.id}`}>
                {formatMoneyDelta(row.cents)}
              </td>
            </tr>
          ))}
          <tr className="finance-panel__row" data-category="energy">
            <th scope="row" className="finance-panel__label">
              {ENERGY_CATEGORY_LABEL}
            </th>
            <td className="finance-panel__value" data-field="energy">
              {formatMoneyDelta(-safeEnergy)}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
