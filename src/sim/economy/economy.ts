/**
 * Economy — hotovosť a účtovná kniha sveta (ARCHITECTURE §9.2, ADR-025).
 *
 * - `post(amountCents, category, refId?)` je **jediná** cesta zmeny hotovosti: zapíše `LedgerEntry` do kruhového bufferu
 *   (`economy.ledgerEntriesKept` posledných záznamov), pripočíta sumu do súčtov otvoreného dňa a emituje `MoneyChanged`
 *   s kategóriou ako `reason` (rovnaký tvar ako F1–F4). Nulová suma sa zapíše aj emituje (príkazy nad cestami ju tak
 *   hlásia od F1, ADR-013); či pohyb vznikne, rozhoduje volajúci.
 * - Uzavretie dňa a mesiaca volá `EconomySystem` (krok 9, §6): `closeDay` z otvorených súčtov vytvorí `DaySummary`,
 *   `closeMonth` sčíta denné súhrny mesiaca do `MonthSummary`, `recordSolvency` vedie počítadlo dní so zápornou
 *   hotovosťou a príznak `gameOver` (bankrot, rozhodnutie orchestrátora F5 č. 3).
 * - Histórie majú pevnú štrukturálnu kapacitu `DAILY_SUMMARIES_KEPT` a `MONTHLY_SUMMARIES_KEPT` (§9.2).
 *
 * `post` alokuje len záznam knihy (príkazy, uzavretie dňa, udalosti kontraktov — nie každý tick); tick bez uzavretia dňa
 * sa ekonomiky nedotkne.
 */
import { RingBuffer } from '../core/ring-buffer';
import type { EventBus } from '../core/event-bus';
import type { SimEvent } from '../events/sim-event';
import type { LedgerCategory } from './ledger-category';
import {
  addToTotals,
  freezeTotals,
  sumTotals,
  type CategoryTotals,
  type DaySummary,
  type LedgerEntry,
  type MonthSummary,
} from './ledger';

/**
 * Koľko denných súhrnov sa drží (§9.2: `daily: DaySummary[365]`) — rok histórie pre grafy financií. Musí byť aspoň
 * dĺžka mesiaca (30 dní), lebo `MonthSummary` vzniká súčtom denných súhrnov mesiaca.
 */
export const DAILY_SUMMARIES_KEPT = 365;

/** Koľko mesačných súhrnov sa drží (§9.2: `monthly: MonthSummary[36]`) — tri herné roky. */
export const MONTHLY_SUMMARIES_KEPT = 36;

/** Závislosti ekonomiky zo sveta: zbernica udalostí (`MoneyChanged`) a hodiny (tick záznamu). */
export interface EconomyEnv {
  readonly events: EventBus<SimEvent>;
  readonly clock: { readonly tick: number };
}

/** Súčty otvoreného (ešte neuzavretého) dňa. */
export interface OpenDayTotals {
  readonly incomeCents: Readonly<CategoryTotals>;
  readonly expenseCents: Readonly<CategoryTotals>;
}

/** Stav ekonomiky do save (bez hotovosti — tá je v `WorldState.cashCents` od v1); čistý JSON. */
export interface EconomyState {
  /** Posledné záznamy knihy od najstaršieho (najviac `ledgerEntriesKept`). */
  readonly entries: readonly LedgerEntry[];
  /** Súčty otvoreného dňa (pohyby od posledného `DayClosed`). */
  readonly today: OpenDayTotals;
  /** Denné súhrny od najstaršieho (najviac `DAILY_SUMMARIES_KEPT`). */
  readonly daily: readonly DaySummary[];
  /** Mesačné súhrny od najstaršieho (najviac `MONTHLY_SUMMARIES_KEPT`). */
  readonly monthly: readonly MonthSummary[];
  /** Počet uzavretých dní za sebou so zápornou hotovosťou. */
  readonly daysNegative: number;
  /** Bankrot nastal (`GameOver`) — svet už netickuje systémy. */
  readonly gameOver: boolean;
}

export class Economy {
  private cash: number;
  private readonly entryBuffer: RingBuffer<LedgerEntry>;
  private readonly dailyBuffer = new RingBuffer<DaySummary>(DAILY_SUMMARIES_KEPT);
  private readonly monthlyBuffer = new RingBuffer<MonthSummary>(MONTHLY_SUMMARIES_KEPT);
  private dayIncome: CategoryTotals = {};
  private dayExpense: CategoryTotals = {};
  /** Σ príjmov − Σ výdavkov otvoreného dňa (O(1) pre HUD). */
  private dayDelta = 0;
  private negativeDays = 0;
  private over = false;
  /** Kópie bufferov pre gettery `entries` / `daily` / `monthly`; `undefined` = zneplatnené zápisom. */
  private entriesView: readonly LedgerEntry[] | undefined;
  private dailyView: readonly DaySummary[] | undefined;
  private monthlyView: readonly MonthSummary[] | undefined;

  /**
   * @param cashCents počiatočná hotovosť (bezpečné celé číslo)
   * @param entriesKept kapacita knihy (`economy.ledgerEntriesKept`, celé ≥ 1)
   */
  constructor(
    private readonly env: EconomyEnv,
    cashCents: number,
    entriesKept: number,
  ) {
    if (!Number.isSafeInteger(cashCents)) throw new RangeError(`Economy: cashCents musí byť bezpečné celé číslo, dostal ${String(cashCents)}`);
    this.cash = cashCents;
    this.entryBuffer = new RingBuffer<LedgerEntry>(entriesKept);
  }

  /**
   * Obnoví ekonomiku zo `getState()` — stav musí byť overený (`parseEconomyState` vo `world-state`). Záznamov nad kapacitu
   * knihy (menší `ledgerEntriesKept` v defe) sa ponechajú najnovšie.
   */
  static fromState(env: EconomyEnv, cashCents: number, entriesKept: number, state: EconomyState): Economy {
    const economy = new Economy(env, cashCents, entriesKept);
    for (const entry of state.entries) economy.entryBuffer.push(Object.freeze({ ...entry }));
    for (const { day, cashEndCents, ...totals } of state.daily) {
      economy.dailyBuffer.push(Object.freeze({ day, ...frozenTotalsOf(totals), cashEndCents }));
    }
    for (const { month, cashEndCents, ...totals } of state.monthly) {
      economy.monthlyBuffer.push(Object.freeze({ month, ...frozenTotalsOf(totals), cashEndCents }));
    }
    economy.dayIncome = { ...state.today.incomeCents };
    economy.dayExpense = { ...state.today.expenseCents };
    economy.dayDelta = sumTotals(economy.dayIncome) - sumTotals(economy.dayExpense);
    economy.negativeDays = state.daysNegative;
    economy.over = state.gameOver;
    return economy;
  }

  /** Hotovosť v centoch (USD); môže byť záporná. */
  get cashCents(): number {
    return this.cash;
  }

  /** Počet uzavretých dní za sebou so zápornou hotovosťou (0 po dni s hotovosťou ≥ 0). */
  get daysNegative(): number {
    return this.negativeDays;
  }

  /** Nastal bankrot (`GameOver`). */
  get gameOver(): boolean {
    return this.over;
  }

  /** Posledné záznamy knihy od najstaršieho (kópia; nová po každom `post`). */
  get entries(): readonly LedgerEntry[] {
    this.entriesView ??= Object.freeze(this.entryBuffer.toArray());
    return this.entriesView;
  }

  /** Denné súhrny od najstaršieho (posledný = naposledy uzavretý deň). */
  get daily(): readonly DaySummary[] {
    this.dailyView ??= Object.freeze(this.dailyBuffer.toArray());
    return this.dailyView;
  }

  /** Mesačné súhrny od najstaršieho. */
  get monthly(): readonly MonthSummary[] {
    this.monthlyView ??= Object.freeze(this.monthlyBuffer.toArray());
    return this.monthlyView;
  }

  /** Čistá zmena hotovosti v otvorenom dni (príjmy − výdavky od posledného `DayClosed`). */
  todayDeltaCents(): number {
    return this.dayDelta;
  }

  /** Súčty otvoreného dňa (zmrazené kópie). */
  openDay(): OpenDayTotals {
    return { incomeCents: freezeTotals(this.dayIncome), expenseCents: freezeTotals(this.dayExpense) };
  }

  /**
   * Jediná cesta zmeny hotovosti: `cash += amountCents`, záznam knihy a `MoneyChanged { cashCents, deltaCents, reason }`.
   * Suma musí byť bezpečné celé číslo a nová hotovosť tiež (inak `RangeError`, nič sa nezmení).
   */
  post(amountCents: number, category: LedgerCategory, refId?: string): void {
    const next = this.cash + amountCents;
    if (!Number.isSafeInteger(amountCents) || !Number.isSafeInteger(next)) {
      throw new RangeError(`Economy.post: suma musí byť bezpečné celé číslo centov a hotovosť ostať v rozsahu, dostal ${String(amountCents)} (${category})`);
    }
    this.cash = next;
    const tick = this.env.clock.tick;
    this.entryBuffer.push(Object.freeze(refId === undefined ? { tick, amountCents, category } : { tick, amountCents, category, refId }));
    this.entriesView = undefined;
    if (amountCents > 0) addToTotals(this.dayIncome, category, amountCents);
    else if (amountCents < 0) addToTotals(this.dayExpense, category, -amountCents);
    this.dayDelta += amountCents;
    this.env.events.emit({ type: 'MoneyChanged', cashCents: next, deltaCents: amountCents, reason: category });
  }

  /**
   * Uzavrie deň `day`: zmrazený `DaySummary` zo súčtov otvoreného dňa s `cashEndCents` = aktuálna hotovosť, zapíše ho
   * do histórie a otvorí nový deň (súčty 0). Volá `EconomySystem` pri `DayClosed` po údržbe a mzdách.
   */
  closeDay(day: number): DaySummary {
    const summary: DaySummary = Object.freeze({
      day,
      incomeCents: freezeTotals(this.dayIncome),
      expenseCents: freezeTotals(this.dayExpense),
      cashEndCents: this.cash,
    });
    this.dailyBuffer.push(summary);
    this.dailyView = undefined;
    this.dayIncome = {};
    this.dayExpense = {};
    this.dayDelta = 0;
    return summary;
  }

  /**
   * Uzavrie mesiac `month` so dňami `firstDay … lastDay` (vrátane): súčet ich denných súhrnov v histórii, `cashEndCents`
   * = aktuálna hotovosť (posledný deň mesiaca je práve uzavretý). Dni pred načítaním staršieho save v súhrne chýbajú.
   */
  closeMonth(month: number, firstDay: number, lastDay: number): MonthSummary {
    const income: CategoryTotals = {};
    const expense: CategoryTotals = {};
    for (let i = this.dailyBuffer.size - 1; i >= 0; i--) {
      const day = this.dailyBuffer.at(i) as DaySummary;
      if (day.day < firstDay) break;
      if (day.day > lastDay) continue;
      mergeTotals(income, day.incomeCents);
      mergeTotals(expense, day.expenseCents);
    }
    const summary: MonthSummary = Object.freeze({
      month,
      incomeCents: freezeTotals(income),
      expenseCents: freezeTotals(expense),
      cashEndCents: this.cash,
    });
    this.monthlyBuffer.push(summary);
    this.monthlyView = undefined;
    return summary;
  }

  /**
   * Bankrotové počítadlo pri uzavretí dňa: hotovosť < 0 → `daysNegative + 1`, inak 0. Keď počítadlo dosiahne
   * `bankruptcyDays`, nastaví `gameOver` a vráti `true` (len raz — po bankrote už vracia `false`).
   */
  recordSolvency(bankruptcyDays: number): boolean {
    this.negativeDays = this.cash < 0 ? this.negativeDays + 1 : 0;
    if (this.over || this.negativeDays < bankruptcyDays) return false;
    this.over = true;
    return true;
  }

  /** Stav do save (čistý JSON, nové objekty). */
  getState(): EconomyState {
    return {
      entries: this.entryBuffer.toArray().map((entry) => ({ ...entry })),
      today: { incomeCents: { ...freezeTotals(this.dayIncome) }, expenseCents: { ...freezeTotals(this.dayExpense) } },
      daily: this.dailyBuffer.toArray().map((summary) => ({ day: summary.day, ...copiedTotalsOf(summary), cashEndCents: summary.cashEndCents })),
      monthly: this.monthlyBuffer
        .toArray()
        .map((summary) => ({ month: summary.month, ...copiedTotalsOf(summary), cashEndCents: summary.cashEndCents })),
      daysNegative: this.negativeDays,
      gameOver: this.over,
    };
  }
}

/** Pripočíta súčty `from` do `into`. */
function mergeTotals(into: CategoryTotals, from: Readonly<CategoryTotals>): void {
  for (const [category, value] of Object.entries(from) as [LedgerCategory, number][]) addToTotals(into, category, value);
}

/** Zmrazené súčty súhrnu v kanonickom poradí kategórií. */
function frozenTotalsOf(summary: Pick<DaySummary, 'incomeCents' | 'expenseCents'>): Pick<DaySummary, 'incomeCents' | 'expenseCents'> {
  return { incomeCents: freezeTotals(summary.incomeCents), expenseCents: freezeTotals(summary.expenseCents) };
}

/** Nezmrazené JSON kópie súčtov súhrnu (save). */
function copiedTotalsOf(summary: DaySummary | MonthSummary): Pick<DaySummary, 'incomeCents' | 'expenseCents'> {
  return { incomeCents: { ...summary.incomeCents }, expenseCents: { ...summary.expenseCents } };
}
