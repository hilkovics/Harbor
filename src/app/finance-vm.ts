/**
 * Dáta pre `FinancePanel` (R5, TR5-05): súčty kategórií účtovnej knihy za uchovanú históriu denných súhrnov (`economy.daily`) a otvorený deň.
 * `energyCents` je výdaj za elektrinu reefrov (kategória `energy`, kladné číslo = zaplatené); ostatné kategórie nesú čistý výsledok (príjem − výdaj).
 * Čistá funkcia nad `World`, nič nemení.
 */
import { LEDGER_CATEGORIES, type CategoryTotals, type LedgerCategory } from '@sim/economy';
import type { World } from '@sim/world';
import type { FinanceCategoryRow } from '@ui/finance-panel';

export interface FinanceVM {
  readonly energyCents: number;
  readonly categories: readonly FinanceCategoryRow[];
}

/** Názvy kategórií ledgera pre hráča (energia má vlastný riadok panelu). */
export const LEDGER_CATEGORY_LABELS: Readonly<Record<Exclude<LedgerCategory, 'energy'>, string>> = {
  contract_revenue: 'Výnosy kontraktov',
  penalty: 'Penále',
  module_capex: 'Nákup modulov',
  module_sale: 'Predaj modulov',
  road_capex: 'Cesty a koľaje',
  road_sale: 'Predaj ciest',
  parcel_purchase: 'Nákup parciel',
  parcel_lease: 'Prenájom parciel',
  maintenance: 'Údržba',
  wages: 'Mzdy',
  vehicle_capex: 'Nákup vozidiel',
  vehicle_sale: 'Predaj vozidiel',
  maintenance_repair: 'Opravy kontajnerov',
};

export function financeVM(world: Pick<World, 'economy'>): FinanceVM {
  const net: Partial<Record<LedgerCategory, number>> = {};
  const add = (income: Readonly<CategoryTotals>, expense: Readonly<CategoryTotals>): void => {
    for (const category of LEDGER_CATEGORIES) net[category] = (net[category] ?? 0) + (income[category] ?? 0) - (expense[category] ?? 0);
  };
  for (const day of world.economy.daily) add(day.incomeCents, day.expenseCents);
  const open = world.economy.openDay();
  add(open.incomeCents, open.expenseCents);
  const categories: FinanceCategoryRow[] = [];
  for (const category of LEDGER_CATEGORIES) {
    if (category === 'energy') continue;
    const cents = net[category] ?? 0;
    if (cents !== 0) categories.push({ id: category, label: LEDGER_CATEGORY_LABELS[category], cents });
  }
  return { energyCents: 0 - (net.energy ?? 0), categories };
}

/** Zhoda dvoch `FinanceVM` (throttlovaný snapshot sa prekreslí len pri zmene). */
export function sameFinance(a: FinanceVM, b: FinanceVM): boolean {
  return a.energyCents === b.energyCents && a.categories.length === b.categories.length && a.categories.every((row, i) => row.id === b.categories[i]?.id && row.cents === b.categories[i]?.cents);
}
