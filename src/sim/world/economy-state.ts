/**
 * Parsovanie `WorldState.economy` (v5, ADR-025): fail-fast kontrola tvaru a hodnôt stavu ekonomiky (`Economy.getState()`)
 * s JSON pointerom pod `/economy`. Hotovosť je v `WorldState.cashCents` (od v1), preto tu nie je.
 */
import type { SimClock } from '../core/sim-clock';
import { DAILY_SUMMARIES_KEPT, MONTHLY_SUMMARIES_KEPT, type EconomyState } from '../economy/economy';
import type { CategoryTotals, DaySummary, LedgerEntry, MonthSummary } from '../economy/ledger';
import { isLedgerCategory } from '../economy/ledger-category';
import { WorldStateError, checkArray, checkInteger, checkKeys, describeValue, isPlainObject, pointerSegment } from './state-check';

/** Kľúče `economy` v poradí `Economy.getState()`. */
export const ECONOMY_STATE_KEYS: readonly (keyof EconomyState)[] = ['entries', 'today', 'daily', 'monthly', 'daysNegative', 'gameOver'];
const ENTRY_KEYS: readonly (keyof LedgerEntry)[] = ['tick', 'amountCents', 'category', 'refId'];
const TODAY_KEYS = ['incomeCents', 'expenseCents'] as const;
const DAY_KEYS: readonly (keyof DaySummary)[] = ['day', 'incomeCents', 'expenseCents', 'cashEndCents'];
const MONTH_KEYS: readonly (keyof MonthSummary)[] = ['month', 'incomeCents', 'expenseCents', 'cashEndCents'];

/** Bezpečné celé číslo (aj záporné). */
function checkSafeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new WorldStateError(path, `musí byť bezpečné celé číslo (centy), dostal ${describeValue(value)}`);
  }
  return value;
}

/** Súčty podľa kategórie: len známe kategórie s kladnou celou hodnotou (kategória bez pohybu chýba). */
function parseTotals(value: unknown, path: string): CategoryTotals {
  if (!isPlainObject(value)) throw new WorldStateError(path, `musí byť objekt, dostal ${describeValue(value)}`);
  const totals: CategoryTotals = {};
  for (const [key, amount] of Object.entries(value)) {
    const at = `${path}${pointerSegment(key)}`;
    if (!isLedgerCategory(key)) throw new WorldStateError(at, 'neznáma kategória knihy');
    totals[key] = checkInteger(amount, 1, at);
  }
  return totals;
}

/** Záznamy knihy: tick 0 … `clock.tick` neklesajúco, suma celá, známa kategória, `refId` voliteľný reťazec. */
function parseEntries(value: unknown, clockTick: number, path: string): LedgerEntry[] {
  let lastTick = 0;
  return checkArray(value, path).map((raw: unknown, i): LedgerEntry => {
    const at = `${path}${pointerSegment(i)}`;
    if (!isPlainObject(raw)) throw new WorldStateError(at, `musí byť objekt, dostal ${describeValue(raw)}`);
    for (const key of Object.keys(raw)) {
      if (!(ENTRY_KEYS as readonly string[]).includes(key)) throw new WorldStateError(`${at}${pointerSegment(key)}`, 'neznámy kľúč');
    }
    const tick = checkInteger(raw['tick'], lastTick, `${at}/tick`);
    if (tick > clockTick) throw new WorldStateError(`${at}/tick`, `záznam v budúcnosti (tick ${String(tick)} > ${String(clockTick)})`);
    lastTick = tick;
    const amountCents = checkSafeInteger(raw['amountCents'], `${at}/amountCents`);
    const category = raw['category'];
    if (!isLedgerCategory(category)) throw new WorldStateError(`${at}/category`, `neznáma kategória ${describeValue(category)}`);
    if (!Object.hasOwn(raw, 'refId')) return { tick, amountCents, category };
    const refId = raw['refId'];
    if (typeof refId !== 'string') throw new WorldStateError(`${at}/refId`, `musí byť reťazec, dostal ${describeValue(refId)}`);
    return { tick, amountCents, category, refId };
  });
}

/**
 * Súhrny období (deň alebo mesiac): najviac `capacity`, index obdobia rastie a je < `openPeriod` (uzavreté obdobia),
 * súčty `parseTotals`, `cashEndCents` celé.
 */
function parseSummaries<K extends 'day' | 'month'>(
  value: unknown,
  periodKey: K,
  keys: readonly string[],
  capacity: number,
  openPeriod: number,
  path: string,
): (Record<K, number> & { incomeCents: CategoryTotals; expenseCents: CategoryTotals; cashEndCents: number })[] {
  const items = checkArray(value, path);
  if (items.length > capacity) throw new WorldStateError(path, `najviac ${String(capacity)} súhrnov, dostal ${String(items.length)}`);
  let next = 0;
  return items.map((raw: unknown, i) => {
    const at = `${path}${pointerSegment(i)}`;
    const entry = checkKeys(raw, keys, at);
    const period = checkInteger(entry[periodKey], next, `${at}/${periodKey}`);
    if (period >= openPeriod) throw new WorldStateError(`${at}/${periodKey}`, `obdobie ${String(period)} ešte nie je uzavreté (aktuálne ${String(openPeriod)})`);
    next = period + 1;
    const summary = {
      incomeCents: parseTotals(entry['incomeCents'], `${at}/incomeCents`),
      expenseCents: parseTotals(entry['expenseCents'], `${at}/expenseCents`),
      cashEndCents: checkSafeInteger(entry['cashEndCents'], `${at}/cashEndCents`),
    };
    return { [periodKey]: period, ...summary } as Record<K, number> & typeof summary;
  });
}

/**
 * Overí `raw` ako `EconomyState` pri hodinách `clock` (záznamy nie v budúcnosti, súhrny len uzavretých dní a mesiacov).
 * Chyby: `WorldStateError` s cestou `/economy/…`. Výsledok nezdieľa objekty so vstupom.
 */
export function parseEconomyState(raw: unknown, clock: SimClock): EconomyState {
  const path = '/economy';
  const state = checkKeys(raw, ECONOMY_STATE_KEYS, path);
  const entries = parseEntries(state['entries'], clock.tick, `${path}/entries`);
  const today = checkKeys(state['today'], TODAY_KEYS, `${path}/today`);
  const daily: DaySummary[] = parseSummaries(state['daily'], 'day', DAY_KEYS, DAILY_SUMMARIES_KEPT, clock.gameDay, `${path}/daily`);
  const monthly: MonthSummary[] = parseSummaries(state['monthly'], 'month', MONTH_KEYS, MONTHLY_SUMMARIES_KEPT, clock.gameMonth, `${path}/monthly`);
  const daysNegative = checkInteger(state['daysNegative'], 0, `${path}/daysNegative`);
  const gameOver = state['gameOver'];
  if (typeof gameOver !== 'boolean') throw new WorldStateError(`${path}/gameOver`, `musí byť boolean, dostal ${describeValue(gameOver)}`);
  return {
    entries,
    today: {
      incomeCents: parseTotals(today['incomeCents'], `${path}/today/incomeCents`),
      expenseCents: parseTotals(today['expenseCents'], `${path}/today/expenseCents`),
    },
    daily,
    monthly,
    daysNegative,
    gameOver,
  };
}
