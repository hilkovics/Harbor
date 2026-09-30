/**
 * Kategórie účtovnej knihy (ARCHITECTURE §9.2). Každý pohyb peňazí má práve jednu kategóriu — používa ju
 * udalosť `MoneyChanged` (dôvod zmeny) a od F5 aj `LedgerEntry` a denné/mesačné súhrny.
 */

/** Všetky kategórie v poradí §9.2. */
export const LEDGER_CATEGORIES = [
  'contract_revenue',
  'penalty',
  'module_capex',
  'module_sale',
  'road_capex',
  /** Refundácia pri odstránení cesty/koľaje (ADR-012). */
  'road_sale',
  'parcel_purchase',
  'parcel_lease',
  'maintenance',
  'wages',
  'vehicle_capex',
  'vehicle_sale',
] as const;

export type LedgerCategory = (typeof LEDGER_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(LEDGER_CATEGORIES);

/** Je hodnota známa kategória knihy (parsovanie save)? */
export function isLedgerCategory(value: unknown): value is LedgerCategory {
  return typeof value === 'string' && CATEGORY_SET.has(value);
}
