// TF7-03: čisté funkcie a SSR markup grafov financií (StackedBars, LineChart) — súčty, geometria, farby z tokenov.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  LineChart,
  StackedBars,
  categoryColor,
  categoryIds,
  linePath,
  linePoints,
  periodTotals,
  stackedBarLayout,
} from '@ui/index';
import { F7_CATEGORIES, F7_DAILY, F7_MONTHLY } from './f7-finance-fixtures';

describe('periodTotals', () => {
  it('príjem, výdaj a netto v centoch', () => {
    expect(periodTotals(F7_DAILY[0]!)).toEqual({ income: 150_000, expense: 57_000, net: 93_000 });
  });

  it('neplatná hodnota sa berie ako 0 (nikdy NaN)', () => {
    const totals = periodTotals({ label: 'x', incomeByCat: { a: Number.NaN, b: 100 }, expenseByCat: {}, cashEnd: 0 });
    expect(totals).toEqual({ income: 100, expense: 0, net: 100 });
  });
});

describe('categoryIds', () => {
  it('poradie z kategórií, potom neznáme id z dát (názov = id), bez duplicít', () => {
    const ids = categoryIds(F7_DAILY, [{ id: 'handling', label: 'Manipulácia' }]);
    expect(ids.map((c) => c.id)).toEqual(['handling', 'port_fees', 'wages', 'opex', 'storage']);
    expect(ids[0]).toEqual({ id: 'handling', label: 'Manipulácia' });
    expect(ids[1]?.label).toBe('port_fees');
  });
});

describe('categoryColor', () => {
  it('farby sú len názvy tokenov v var(), cyklicky', () => {
    expect(categoryColor(0)).toBe('var(--ui-accent)');
    expect(categoryColor(8)).toBe(categoryColor(0));
    expect(categoryColor(Number.NaN)).toBe('var(--ui-accent)');
  });
});

describe('stackedBarLayout', () => {
  const layout = stackedBarLayout(F7_MONTHLY, F7_CATEGORIES, CHART_WIDTH, CHART_HEIGHT);
  const first = layout.columns[0]!;
  const zeroY = CHART_HEIGHT / 2;
  // maxValue = najväčší súčet (príjem Mesiac 1 = 1,486,200 cent)
  const scale = (CHART_HEIGHT / 2 - 6) / 1_486_200;

  it('os nuly v strede a symetrická škála podľa najväčšieho súčtu', () => {
    expect(layout.zeroY).toBe(zeroY);
    expect(layout.maxValue).toBe(1_486_200);
  });

  it('príjmy sú nad osou, výdaje pod osou; výška segmentov zodpovedá sume', () => {
    const incomeSum = first.income.reduce((sum, s) => sum + s.height, 0);
    const expenseSum = first.expense.reduce((sum, s) => sum + s.height, 0);
    expect(incomeSum).toBeCloseTo(1_486_200 * scale, 6);
    expect(expenseSum).toBeCloseTo(1_212_900 * scale, 6);
    for (const segment of first.income) expect(segment.y + segment.height).toBeLessThanOrEqual(zeroY + 1e-9);
    for (const segment of first.expense) expect(segment.y).toBeGreaterThanOrEqual(zeroY - 1e-9);
  });

  it('stĺpce sú rovnomerne rozložené a šírka je 60 % pásma', () => {
    const band = CHART_WIDTH / F7_MONTHLY.length;
    expect(layout.columns[1]!.x - first.x).toBeCloseTo(band, 6);
    expect(first.width).toBeCloseTo(band * 0.6, 6);
  });

  it('nulová kategória nevytvorí segment', () => {
    const zero = stackedBarLayout([{ label: 'z', incomeByCat: { a: 0 }, expenseByCat: {}, cashEnd: 0 }], [{ id: 'a', label: 'A' }]);
    expect(zero.columns[0]!.income).toHaveLength(0);
  });
});

describe('linePoints / linePath', () => {
  it('x rovnomerne, hodnota max hore a min dole (v rámci výšky)', () => {
    const { points, lo, hi } = linePoints([5, -3, 10], 320, 120);
    expect(lo).toBe(-3);
    expect(hi).toBe(10);
    expect(points.map((p) => p.x)).toEqual([0, 160, 320]);
    expect(points[2]!.y).toBeCloseTo(6, 6);
    expect(points[1]!.y).toBeCloseTo(114, 6);
    expect(points[0]!.y).toBeCloseTo(6 + (5 / 13) * 108, 6);
  });

  it('prázdny vstup a plochá séria nevyrobia NaN', () => {
    expect(linePoints([]).points).toHaveLength(0);
    const flat = linePoints([0, 0]).points;
    expect(flat.every((p) => Number.isFinite(p.y))).toBe(true);
  });

  it('cesta začína M a pokračuje L', () => {
    const path = linePath(linePoints([1, 2, 3]).points);
    expect(path.startsWith('M')).toBe(true);
    expect(path.match(/L/g)).toHaveLength(2);
  });
});

describe('StackedBars / LineChart — SSR markup', () => {
  it('StackedBars: segmenty všetkých období a legenda kategórií', () => {
    const html = renderToStaticMarkup(createElement(StackedBars, { periods: F7_DAILY, categories: F7_CATEGORIES }));
    expect(html).toContain('data-chart="stacked-bars"');
    expect(html.match(/data-segment=/g)).toHaveLength(12);
    expect(html.match(/data-legend=/g)).toHaveLength(F7_CATEGORIES.length);
    expect(html).toContain('var(--ui-accent)');
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('LineChart: bod pre každé obdobie, osi a cesta', () => {
    const html = renderToStaticMarkup(
      createElement(LineChart, { values: F7_DAILY.map((p) => p.cashEnd), labels: F7_DAILY.map((p) => p.label) }),
    );
    expect(html).toContain('data-chart="line"');
    expect(html.match(/<circle/g)).toHaveLength(3);
    expect(html).toContain('Deň 3');
    expect(html).toContain('<path');
  });
});
