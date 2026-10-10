// TF7-03: fixtures pre finančné grafy, ParcelPanel a MonthlyReportModal (čisté dáta v centoch, žiadna simulácia).
import type { FinanceChartCategory, FinancePeriod, ParcelInfo } from '@ui/index';

export const F7_CATEGORIES: readonly FinanceChartCategory[] = [
  { id: 'handling', label: 'Manipulácia' },
  { id: 'port_fees', label: 'Prístavné poplatky' },
  { id: 'storage', label: 'Skladovanie' },
  { id: 'wages', label: 'Mzdy' },
  { id: 'opex', label: 'Prevádzka' },
];

/** Tri denné obdobia; výdaje sú kladné sumy zaplatené (centy). */
export const F7_DAILY: readonly FinancePeriod[] = [
  {
    label: 'Deň 1',
    incomeByCat: { handling: 120_000, port_fees: 30_000 },
    expenseByCat: { wages: 45_000, opex: 12_000 },
    cashEnd: 9_000_000,
  },
  {
    label: 'Deň 2',
    incomeByCat: { handling: 80_000, storage: 20_000 },
    expenseByCat: { wages: 45_000, opex: 15_000 },
    cashEnd: 9_040_000,
  },
  {
    label: 'Deň 3',
    incomeByCat: { handling: 200_000 },
    expenseByCat: { wages: 45_000, opex: 12_000, storage: 5_000 },
    cashEnd: 9_138_000,
  },
];

/** Dva mesačné obdobia; posledné je aktuálne. */
export const F7_MONTHLY: readonly FinancePeriod[] = [
  {
    label: 'Mesiac 1',
    incomeByCat: { handling: 1_200_000, port_fees: 286_200 },
    expenseByCat: { wages: 900_000, opex: 312_900 },
    cashEnd: 12_345_600,
  },
  {
    label: 'Mesiac 2',
    incomeByCat: { handling: 1_000_000, port_fees: 300_000, storage: 150_000 },
    expenseByCat: { wages: 900_000, opex: 200_000, storage: 50_000 },
    cashEnd: 12_335_600,
  },
];

export const F7_PARCEL_FOR_SALE: ParcelInfo = {
  id: 'parcel_east_1',
  w: 12,
  h: 8,
  state: 'for_sale',
  priceCents: 64_000_000,
  leasePerMonthCents: 980_000,
};

export const F7_PARCEL_LEASED: ParcelInfo = { ...F7_PARCEL_FOR_SALE, id: 'parcel_east_2', state: 'leased' };
export const F7_PARCEL_OWNED: ParcelInfo = { ...F7_PARCEL_FOR_SALE, id: 'parcel_east_3', state: 'owned' };
