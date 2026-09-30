// Ekonomika: Economy (hotovosť + účtovná kniha), LedgerEntry, denné a mesačné súhrny (ARCHITECTURE §9.2, ADR-025).
export { LEDGER_CATEGORIES, isLedgerCategory } from './ledger-category';
export type { LedgerCategory } from './ledger-category';
export { addToTotals, freezeTotals, sumTotals } from './ledger';
export type { CategoryTotals, DaySummary, LedgerEntry, MonthSummary } from './ledger';
export { DAILY_SUMMARIES_KEPT, Economy, MONTHLY_SUMMARIES_KEPT } from './economy';
export type { EconomyEnv, EconomyState, OpenDayTotals } from './economy';
