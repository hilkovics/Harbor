/**
 * Účtovná kniha (ARCHITECTURE §9.2, ADR-025): záznam jedného pohybu peňazí (`LedgerEntry`) a súhrny účtovných období
 * (`DaySummary`, `MonthSummary`). Všetky sumy sú celé centy (USD).
 *
 * Súhrny delia pohyby podľa **znamienka** sumy, nie podľa kategórie: kladná suma je príjem (`incomeCents`), záporná
 * výdavok (`expenseCents`, uložený ako **kladná** veľkosť). Nulový pohyb (napr. `PlaceRoad` s nulovou čistou cenou,
 * ADR-013) má záznam v knihe, ale súhrn nemení. Platí `cashEnd(d) = cashEnd(d − 1) + Σ income(d) − Σ expense(d)`.
 */
import { LEDGER_CATEGORIES, type LedgerCategory } from './ledger-category';

/** Jeden pohyb peňazí: `tick` = `clock.tick` v okamihu zápisu (počas príkazov pred krokom 1 ešte predchádzajúci tick). */
export interface LedgerEntry {
  readonly tick: number;
  /** Zmena hotovosti v centoch (záporná = výdavok). */
  readonly amountCents: number;
  readonly category: LedgerCategory;
  /** Voliteľný odkaz na pôvodcu (`module:12`, `vehicle:3`, `contract:7`); agregované pohyby (údržba, mzdy) ho nemajú. */
  readonly refId?: string;
}

/** Súčty v centoch podľa kategórie; kategória bez pohybu v objekte chýba (nie 0). Hodnoty sú vždy kladné. */
export type CategoryTotals = Partial<Record<LedgerCategory, number>>;

/**
 * Uzavretý herný deň (`day` 0-based = `clock.gameDay − 1` v ticku `DayClosed`). Obsahuje všetky pohyby od
 * predchádzajúceho uzavretia po údržbu a mzdy tohto uzavretia vrátane (krok 9, §6).
 */
export interface DaySummary {
  readonly day: number;
  readonly incomeCents: Readonly<CategoryTotals>;
  readonly expenseCents: Readonly<CategoryTotals>;
  /** Hotovosť po uzavretí dňa. */
  readonly cashEndCents: number;
}

/** Uzavretý herný mesiac (`month` 0-based) = súčet jeho denných súhrnov; `cashEndCents` = posledný deň mesiaca. */
export interface MonthSummary {
  readonly month: number;
  readonly incomeCents: Readonly<CategoryTotals>;
  readonly expenseCents: Readonly<CategoryTotals>;
  readonly cashEndCents: number;
}

/** Pripočíta kladnú `amount` ku kategórii (meniteľný objekt súčtov). */
export function addToTotals(totals: CategoryTotals, category: LedgerCategory, amount: number): void {
  totals[category] = (totals[category] ?? 0) + amount;
}

/** Súčet všetkých kategórií. */
export function sumTotals(totals: Readonly<CategoryTotals>): number {
  let sum = 0;
  for (const category of LEDGER_CATEGORIES) sum += totals[category] ?? 0;
  return sum;
}

/**
 * Zmrazená kópia súčtov s kľúčmi v kanonickom poradí `LEDGER_CATEGORIES` (súhrny sú readonly DTO — idú aj v udalostiach
 * a v save; poradie kľúčov nezávisí od poradia pohybov, takže `serialize()` po obnove je bitovo rovnaký).
 */
export function freezeTotals(totals: Readonly<CategoryTotals>): Readonly<CategoryTotals> {
  const copy: CategoryTotals = {};
  for (const category of LEDGER_CATEGORIES) {
    const value = totals[category];
    if (value !== undefined) copy[category] = value;
  }
  return Object.freeze(copy);
}
