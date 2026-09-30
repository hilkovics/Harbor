/**
 * Formátovače pre UI (DESIGN_BRIEF §6.1, §6.4). Čisté funkcie bez závislosti na prostredí: zámerne bez
 * `Intl`/`toLocaleString`, aby výstup nezávisel od locale prehliadača ani Node (testy, screenshoty).
 */

/** Matematické mínus U+2212 (nie spojovník), ako v design systéme: `−$4,820`. */
export const MINUS_SIGN = '\u2212';

/** Znak plus pre kladné zmeny (`+$12,300`). */
export const PLUS_SIGN = '+';

/** Pomlčka U+2014 ako zástupný text pre chýbajúcu alebo neplatnú hodnotu. */
export const EM_DASH = '\u2014';

/** Vloží čiarky ako oddeľovač tisícov do reťazca číslic (`1234560` → `1,234,560`). */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Celé doláre zo sumy v centoch (`absCents` ≥ 0): zaokrúhlenie polovice smerom od nuly. */
function roundedDollars(absCents: number): number {
  // Bez delenia necelým číslom: (abs + 50) - ((abs + 50) mod 100) je násobok 100, presný aj pre veľké sumy.
  const shifted = absCents + 50;
  return (shifted - (shifted % 100)) / 100;
}

/**
 * Peniaze pre UI: `$1,234,560`, záporné `−$2,500` (U+2212). Suma je v centoch, zaokrúhlená na celé doláre,
 * polovica smerom od nuly (`150` → `$2`, `−150` → `−$2`); hodnota, ktorá sa zaokrúhli na nulu, je vždy `$0`
 * (bez mínusu). Neplatná hodnota (`NaN`, `±Infinity`) → `—`, aby UI nikdy neukázalo `$NaN`.
 */
export function formatMoney(cents: number): string {
  if (!Number.isFinite(cents)) return EM_DASH;
  const dollars = roundedDollars(Math.abs(cents));
  const body = `$${groupThousands(String(dollars))}`;
  return cents < 0 && dollars !== 0 ? `${MINUS_SIGN}${body}` : body;
}

/**
 * Zmena peňazí so znamienkom: `+$12,300`, `−$4,820`; hodnota zaokrúhlená na nulu je `$0` (bez znamienka).
 * Rovnaké zaokrúhlenie ako `formatMoney`.
 */
export function formatMoneyDelta(cents: number): string {
  const body = formatMoney(cents);
  return moneySign(cents) > 0 ? `${PLUS_SIGN}${body}` : body;
}

/** Znamienko sumy pre farbu/ikonu: -1, 0, +1 (podľa hodnoty zaokrúhlenej na doláre; neplatná hodnota = 0). */
export function moneySign(cents: number): -1 | 0 | 1 {
  if (!Number.isFinite(cents) || roundedDollars(Math.abs(cents)) === 0) return 0;
  return cents < 0 ? -1 : 1;
}

/** Skúsenosti: `340 XP`, `12,340 XP` (celé číslo, čiarka ako oddeľovač tisícov; neplatná hodnota → `— XP`). */
export function formatXp(xp: number): string {
  if (!Number.isFinite(xp)) return `${EM_DASH} XP`;
  return `${groupThousands(String(Math.max(0, Math.trunc(xp))))} XP`;
}

/**
 * Počet kusov: `1,240`, s jednotkou `1,240 TEU` (celé číslo, čiarka ako oddeľovač tisícov, záporné s U+2212).
 * Neplatná hodnota (`NaN`, `±Infinity`) → `—`.
 */
export function formatCount(count: number, unit?: string): string {
  if (!Number.isFinite(count)) return EM_DASH;
  const whole = Math.trunc(count);
  const body = `${whole < 0 ? MINUS_SIGN : ''}${groupThousands(String(Math.abs(whole)))}`;
  return unit === undefined || unit === '' ? body : `${body} ${unit}`;
}

/** Herný čas z `WorldSnapshot`/`SimClock`; `day` je 0-based. */
export interface GameTimeParts {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function pad2(value: number): string {
  const text = String(Math.trunc(value));
  return text.length >= 2 ? text : `0${text}`;
}

/** `Deň N · HH:MM`, kde N = `day + 1` (SimClock je 0-based, hráč vidí od Dňa 1). */
export function formatGameTime({ day, hour, minute }: GameTimeParts): string {
  return `Deň ${String(Math.trunc(day) + 1)} \u00B7 ${pad2(hour)}:${pad2(minute)}`;
}

/** Popisok rýchlosti: `0` → `Pauza`, inak `N×` (U+00D7). */
export function formatSpeed(speed: number): string {
  return speed === 0 ? 'Pauza' : `${String(speed)}\u00D7`;
}

/** Krát U+00D7 pre rozmery (`8×3`) a rýchlosti (`4×`). */
export const TIMES_SIGN = '×';

/** Rozmer footprintu modulu v bunkách: `8×3` (šírka × výška po rotácii). */
export function formatFootprint(footprint: { readonly w: number; readonly h: number }): string {
  return `${String(Math.trunc(footprint.w))}${TIMES_SIGN}${String(Math.trunc(footprint.h))}`;
}

/**
 * Percentá: `72 %` (celé číslo, medzera pred `%` ako v prototype, záporné s U+2212). Hodnota sa neorezáva na 0–100 —
 * orezanie (napr. pre šírku pruhu) patrí volajúcemu. Neplatná hodnota (`NaN`, `±Infinity`) → `— %`.
 */
export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) return `${EM_DASH} %`;
  const rounded = Math.round(Math.abs(percent));
  return `${percent < 0 && rounded !== 0 ? MINUS_SIGN : ''}${String(rounded)} %`;
}

/**
 * Pomer `časť / celok` s voliteľnou jednotkou: `3 / 4`, `1 / 4 TEU` (celé čísla s čiarkou ako oddeľovačom tisícov,
 * medzery okolo lomky ako v prototype). Neplatná hodnota → `—`.
 */
export function formatFraction(part: number, total: number, unit?: string): string {
  if (!Number.isFinite(part) || !Number.isFinite(total)) return EM_DASH;
  const body = `${groupThousands(String(Math.trunc(part)))} / ${groupThousands(String(Math.trunc(total)))}`;
  return unit === undefined || unit === '' ? body : `${body} ${unit}`;
}

/** Mierka herného času v tickoch (z `SimClock`/`time` defu; UI si ju nechá dodať, nezná dĺžku ticku). */
export interface TimeScale {
  readonly ticksPerHour: number;
  readonly ticksPerDay: number;
}

/** Slovenské skloňovanie dní: 1 deň, 2–4 dni, inak dní. */
function dayWord(days: number): string {
  if (days === 1) return 'deň';
  return days >= 2 && days <= 4 ? 'dni' : 'dní';
}

/**
 * Trvanie v tickoch pre SLA a expiráciu: `6 dní`, `1 deň`, `2 d 5 h`, `5 h`, `< 1 h` (zaokrúhlené nadol, záporné ako 0).
 * Bez `Intl`, aby výstup nezávisel od locale. Neplatná hodnota alebo mierka → `—`.
 */
export function formatDuration(ticks: number, scale: TimeScale): string {
  if (!Number.isFinite(ticks) || !(scale.ticksPerDay > 0) || !(scale.ticksPerHour > 0)) return EM_DASH;
  const total = Math.max(0, ticks);
  const days = Math.floor(total / scale.ticksPerDay);
  const hours = Math.floor((total - days * scale.ticksPerDay) / scale.ticksPerHour);
  if (days > 0) return hours === 0 ? `${String(days)} ${dayWord(days)}` : `${String(days)} d ${String(hours)} h`;
  return hours > 0 ? `${String(hours)} h` : '< 1 h';
}
