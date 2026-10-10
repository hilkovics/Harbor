/**
 * Finančné rady pre grafy (F7, ADR-044; VM `FinanceVM`): denné a mesačné súhrny z ledgera (`Economy.daily` / `monthly`)
 * v tvare `{ label, incomeByCat, expenseByCat, cashEnd }`. Len čítanie, hodnoty v centoch, výdavky ako kladná veľkosť.
 */
import type { World } from '../world/world';
import type { CategoryTotals, DaySummary, MonthSummary } from './ledger';
import { LEDGER_CATEGORIES, type LedgerCategory } from './ledger-category';

export interface FinancePoint {
  /** `Deň N` / `Mesiac N` (1-based). */
  readonly label: string;
  /** Index obdobia (0-based deň alebo mesiac). */
  readonly period: number;
  readonly incomeByCat: Readonly<CategoryTotals>;
  readonly expenseByCat: Readonly<CategoryTotals>;
  readonly cashEnd: number;
}

export interface FinanceSeries {
  readonly categories: readonly LedgerCategory[];
  readonly daily: readonly FinancePoint[];
  readonly monthly: readonly FinancePoint[];
}

function dailyPoint(summary: DaySummary): FinancePoint {
  return { label: `Deň ${String(summary.day + 1)}`, period: summary.day, incomeByCat: summary.incomeCents, expenseByCat: summary.expenseCents, cashEnd: summary.cashEndCents };
}

function monthlyPoint(summary: MonthSummary): FinancePoint {
  return { label: `Mesiac ${String(summary.month + 1)}`, period: summary.month, incomeByCat: summary.incomeCents, expenseByCat: summary.expenseCents, cashEnd: summary.cashEndCents };
}

/** Rady z uzavretých dní a mesiacov (od najstaršieho). */
export function financeSeries(world: Pick<World, 'economy'>): FinanceSeries {
  return {
    categories: LEDGER_CATEGORIES,
    daily: world.economy.daily.map(dailyPoint),
    monthly: world.economy.monthly.map(monthlyPoint),
  };
}
