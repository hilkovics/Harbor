import { describe, it, expect } from 'vitest';
import { formatMoney, formatGameTime } from '@ui/format';

describe('format table', () => {
  describe('formatMoney', () => {
    it.each<[number, string]>([
      // [cents, expectedOutput]
      [0, '$0'],
      [49, '$0'],
      [99, '$1'],
      [149, '$1'],
      [150, '$2'],
      [-49, '$0'],
      [-150, '−$2'],
      [120000000, '$1,200,000'],
      [123456000, '$1,234,560'],
      [-250000, '−$2,500'],
    ])(
      'formatMoney($cents) → "$expected"',
      (cents, expected) => {
        expect(formatMoney(cents)).toBe(expected);
      }
    );
  });

  describe('formatGameTime', () => {
    it.each<[number, number, number, string]>([
      // [day, hour, minute, expected]
      [0, 0, 0, 'Deň 1 · 00:00'],
      [0, 0, 1, 'Deň 1 · 00:01'],
      [0, 1, 0, 'Deň 1 · 01:00'],
      [0, 23, 59, 'Deň 1 · 23:59'],
      [1, 0, 0, 'Deň 2 · 00:00'],
      [11, 14, 20, 'Deň 12 · 14:20'],
    ])(
      'formatGameTime({ day: $day, hour: $hour, minute: $minute }) → "$expected"',
      (day, hour, minute, expected) => {
        const result = formatGameTime({ day, hour, minute });
        expect(result).toBe(expected);
      }
    );
  });
});
