import { describe, expect, it } from 'vitest';
import {
  EM_DASH,
  MINUS_SIGN,
  TIMES_SIGN,
  formatCount,
  formatDateTime,
  formatDuration,
  formatFootprint,
  formatFraction,
  formatGameTime,
  formatMoney,
  formatMoneyDelta,
  formatPercent,
  formatSpeed,
  formatXp,
  moneySign,
} from '@ui/format';

const MINUS = '\u2212';

describe('formatMoney', () => {
  // Presná tabuľka z karty T01-10 (záporné s U+2212).
  const table: ReadonlyArray<readonly [number, string]> = [
    [0, '$0'],
    [49, '$0'],
    [99, '$1'],
    [149, '$1'],
    [150, '$2'],
    [-49, '$0'],
    [-150, `${MINUS}$2`],
    [120_000_000, '$1,200,000'],
    [123_456_000, '$1,234,560'],
    [-250_000, `${MINUS}$2,500`],
  ];

  it.each(table)('%i c → %s', (cents, expected) => {
    expect(formatMoney(cents)).toBe(expected);
  });

  it('mínus je U+2212, nie spojovník-mínus', () => {
    expect(MINUS_SIGN).toBe(MINUS);
    expect(formatMoney(-100)).toBe('−$1');
    expect(formatMoney(-100)).not.toContain('-');
  });

  it('polovica sa zaokrúhľuje smerom od nuly (symetricky pre kladné aj záporné)', () => {
    expect(formatMoney(50)).toBe('$1');
    expect(formatMoney(250)).toBe('$3');
    expect(formatMoney(-50)).toBe(`${MINUS}$1`);
    expect(formatMoney(-250)).toBe(`${MINUS}$3`);
    expect(formatMoney(149)).toBe('$1');
    expect(formatMoney(-149)).toBe(`${MINUS}$1`);
  });

  it('hodnota zaokrúhlená na nulu nikdy nemá mínus (aj -0)', () => {
    expect(formatMoney(-1)).toBe('$0');
    expect(formatMoney(-49)).toBe('$0');
    expect(formatMoney(-0)).toBe('$0');
  });

  it('oddeľovač tisícov po trojiciach, aj pre veľké sumy', () => {
    expect(formatMoney(99_900)).toBe('$999');
    expect(formatMoney(100_000)).toBe('$1,000');
    expect(formatMoney(123_456_789)).toBe('$1,234,568');
    expect(formatMoney(99_999_999_999)).toBe('$1,000,000,000');
    expect(formatMoney(-123_456_789_000)).toBe(`${MINUS}$1,234,567,890`);
  });

  it('neplatná hodnota → pomlčka, nikdy $NaN', () => {
    expect(formatMoney(Number.NaN)).toBe(EM_DASH);
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe(EM_DASH);
    expect(formatMoney(Number.NEGATIVE_INFINITY)).toBe(EM_DASH);
  });
});

describe('formatMoneyDelta / moneySign', () => {
  it('kladná zmena má +, záporná U+2212, nula bez znamienka', () => {
    expect(formatMoneyDelta(1_230_000)).toBe('+$12,300');
    expect(formatMoneyDelta(-482_000)).toBe(`${MINUS}$4,820`);
    expect(formatMoneyDelta(0)).toBe('$0');
  });

  it('hodnota zaokrúhlená na nulu je $0 bez znamienka a znamienko 0', () => {
    expect(formatMoneyDelta(49)).toBe('$0');
    expect(formatMoneyDelta(-49)).toBe('$0');
    expect(moneySign(49)).toBe(0);
    expect(moneySign(-49)).toBe(0);
  });

  it('moneySign: -1 / 0 / +1; neplatná hodnota = 0', () => {
    expect(moneySign(150)).toBe(1);
    expect(moneySign(-150)).toBe(-1);
    expect(moneySign(0)).toBe(0);
    expect(moneySign(Number.NaN)).toBe(0);
  });

  it('neplatná hodnota → pomlčka bez +', () => {
    expect(formatMoneyDelta(Number.NaN)).toBe(EM_DASH);
  });
});

describe('formatGameTime', () => {
  // Presná tabuľka z karty T01-10 (day je 0-based).
  const table: ReadonlyArray<readonly [number, number, number, string]> = [
    [0, 0, 0, 'Deň 1 · 00:00'],
    [0, 0, 1, 'Deň 1 · 00:01'],
    [0, 1, 0, 'Deň 1 · 01:00'],
    [0, 23, 59, 'Deň 1 · 23:59'],
    [1, 0, 0, 'Deň 2 · 00:00'],
    [11, 14, 20, 'Deň 12 · 14:20'],
  ];

  it.each(table)('(day %i, %i:%i) → %s', (day, hour, minute, expected) => {
    expect(formatGameTime({ day, hour, minute })).toBe(expected);
  });

  it('oddeľovač je stredná bodka U+00B7 s medzerami', () => {
    expect(formatGameTime({ day: 0, hour: 0, minute: 0 })).toBe('Deň 1 · 00:00');
  });

  it('viacciferný deň sa nezalamuje ani neorezáva', () => {
    expect(formatGameTime({ day: 364, hour: 9, minute: 5 })).toBe('Deň 365 · 09:05');
    expect(formatGameTime({ day: 999, hour: 12, minute: 0 })).toBe('Deň 1000 · 12:00');
  });
});

describe('formatSpeed / formatXp', () => {
  it('0 = Pauza, ostatné N× (U+00D7)', () => {
    expect(formatSpeed(0)).toBe('Pauza');
    expect(formatSpeed(1)).toBe('1×');
    expect(formatSpeed(8)).toBe('8×');
  });

  it('XP: celé číslo s oddeľovačom tisícov, neplatné → pomlčka', () => {
    expect(formatXp(340)).toBe('340 XP');
    expect(formatXp(12_340)).toBe('12,340 XP');
    expect(formatXp(340.9)).toBe('340 XP');
    expect(formatXp(-5)).toBe('0 XP');
    expect(formatXp(Number.NaN)).toBe(`${EM_DASH} XP`);
  });
});

describe('formatFootprint', () => {
  it('šírka × výška s U+00D7, bez medzier', () => {
    expect(TIMES_SIGN).toBe('\u00D7');
    expect(formatFootprint({ w: 8, h: 3 })).toBe('8×3');
    expect(formatFootprint({ w: 2, h: 3 })).toBe('2×3');
    expect(formatFootprint({ w: 12, h: 8 })).toBe('12×8');
  });
});

describe('formatPercent', () => {
  const table: ReadonlyArray<readonly [number, string]> = [
    [0, '0 %'],
    [7, '7 %'],
    [72, '72 %'],
    [72.4, '72 %'],
    [72.5, '73 %'],
    [100, '100 %'],
    [-0.4, '0 %'],
    [-12, `${MINUS}12 %`],
  ];

  it.each(table)('%d → %s', (value, expected) => {
    expect(formatPercent(value)).toBe(expected);
  });

  it('neplatná hodnota → pomlčka, nikdy „NaN %"', () => {
    expect(formatPercent(Number.NaN)).toBe(`${EM_DASH} %`);
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe(`${EM_DASH} %`);
  });
});

describe('formatFraction', () => {
  it('časť / celok s medzerami okolo lomky, voliteľná jednotka', () => {
    expect(formatFraction(3, 4)).toBe('3 / 4');
    expect(formatFraction(1, 4, 'TEU')).toBe('1 / 4 TEU');
    expect(formatFraction(0, 4, 'slotov')).toBe('0 / 4 slotov');
    expect(formatFraction(1, 4, '')).toBe('1 / 4');
  });

  it('oddeľovač tisícov a zrezanie desatinných miest', () => {
    expect(formatFraction(1_820, 2_400, 'TEU')).toBe('1,820 / 2,400 TEU');
    expect(formatFraction(3.9, 4.2)).toBe('3 / 4');
  });

  it('neplatná hodnota → pomlčka', () => {
    expect(formatFraction(Number.NaN, 4)).toBe(EM_DASH);
    expect(formatFraction(1, Number.POSITIVE_INFINITY, 'TEU')).toBe(EM_DASH);
  });
});

describe('formatCount', () => {
  it('celé číslo s čiarkou ako oddeľovačom tisícov, voliteľná jednotka', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(46)).toBe('46');
    expect(formatCount(1_240)).toBe('1,240');
    expect(formatCount(1_240, 'TEU')).toBe('1,240 TEU');
    expect(formatCount(12, '')).toBe('12');
  });

  it('zrezanie desatinných miest, záporné s U+2212, nula bez znamienka', () => {
    expect(formatCount(3.9)).toBe('3');
    expect(formatCount(-1_500)).toBe(`${MINUS}1,500`);
    expect(formatCount(-0.4)).toBe('0');
  });

  it('neplatná hodnota → pomlčka', () => {
    expect(formatCount(Number.NaN)).toBe(EM_DASH);
    expect(formatCount(Number.POSITIVE_INFINITY, 'TEU')).toBe(EM_DASH);
  });
});

describe('formatDuration', () => {
  const scale = { ticksPerHour: 360, ticksPerDay: 8640 };
  const table: ReadonlyArray<readonly [number, string]> = [
    [0, '< 1 h'],
    [359, '< 1 h'],
    [360, '1 h'],
    [5 * 360, '5 h'],
    [8640, '1 deň'],
    [2 * 8640, '2 dni'],
    [4 * 8640, '4 dni'],
    [5 * 8640, '5 dní'],
    [6 * 8640, '6 dní'],
    [8640 + 4 * 360, '1 d 4 h'],
    [2 * 8640 + 5 * 360 + 100, '2 d 5 h'],
    [-500, '< 1 h'],
  ];
  it.each(table)('%i tickov → %s', (ticks, expected) => {
    expect(formatDuration(ticks, scale)).toBe(expected);
  });

  it('neplatná hodnota alebo mierka → —', () => {
    expect(formatDuration(Number.NaN, scale)).toBe(EM_DASH);
    expect(formatDuration(100, { ticksPerHour: 0, ticksPerDay: 8640 })).toBe(EM_DASH);
  });
});

describe('formatDateTime', () => {
  it('UTC: deň. mesiac. rok HH:MM bez núl vpredu pri dni a mesiaci', () => {
    expect(formatDateTime('2026-10-01T12:35:00.000Z', 0)).toBe('1. 10. 2026 12:35');
    expect(formatDateTime('2026-01-09T03:05:59.000Z', 0)).toBe('9. 1. 2026 03:05');
  });

  it('posun časovej zóny sa premietne aj do dňa (UTC+2 cez polnoc, UTC−5 pred polnocou)', () => {
    expect(formatDateTime('2026-10-01T23:30:00.000Z', 120)).toBe('2. 10. 2026 01:30');
    expect(formatDateTime('2026-10-01T02:00:00.000Z', -300)).toBe('30. 9. 2026 21:00');
    expect(formatDateTime('2026-12-31T23:59:00.000Z', 60)).toBe('1. 1. 2027 00:59');
  });

  it('bez posunu použije časovú zónu prehliadača (výsledok je dátum s HH:MM) a neplatný reťazec → —', () => {
    expect(formatDateTime('2026-10-01T12:35:00.000Z')).toMatch(/^\d{1,2}\. \d{1,2}\. 20\d{2} \d{2}:\d{2}$/);
    expect(formatDateTime('nie je dátum')).toBe(EM_DASH);
    expect(formatDateTime('')).toBe(EM_DASH);
  });
});
