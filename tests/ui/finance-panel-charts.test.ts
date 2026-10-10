// TF7-03: FinancePanel s voliteľnými daily / monthly (prepínač Deň / Mesiac, grafy, tabuľka za posledné obdobie).
// Pôvodné vstupy (categories, energyCents) musia zostať nezmenené — pokrýva finance-panel.test.ts.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FINANCE_PERIOD_LABELS,
  FinancePanel,
  availableFinancePeriods,
  financeBreakdownRows,
  resolveFinancePeriod,
  type FinancePanelProps,
} from '@ui/index';
import { F7_CATEGORIES, F7_DAILY, F7_MONTHLY } from './f7-finance-fixtures';
import { fieldText } from './react-tree';

const render = (props: FinancePanelProps): string => renderToStaticMarkup(createElement(FinancePanel, props));

/** Otváracia značka tlačidla s `data-period` (atribúty sú v jednom tagu). */
const periodButton = (html: string, period: string): string => {
  const match = new RegExp(`<button[^>]*data-period="${period}"[^>]*>`).exec(html);
  return match?.[0] ?? '';
};

describe('FinancePanel — pôvodné správanie bez období', () => {
  it('bez daily/monthly nie sú prepínač ani grafy', () => {
    const html = render({ categories: [{ id: 'handling', label: 'Manipulácia', cents: 100 }] });
    expect(html).not.toContain('data-period=');
    expect(html).not.toContain('data-chart=');
    expect(html).toContain('data-category="handling"');
  });

  it('availableFinancePeriods a resolveFinancePeriod', () => {
    expect(availableFinancePeriods(undefined, undefined)).toEqual([]);
    expect(availableFinancePeriods(F7_DAILY, undefined)).toEqual(['day']);
    expect(availableFinancePeriods(F7_DAILY, F7_MONTHLY)).toEqual(['day', 'month']);
    expect(resolveFinancePeriod('day', ['month'])).toBe('month');
    expect(resolveFinancePeriod('month', ['month', 'day'])).toBe('month');
    expect(resolveFinancePeriod('day', [])).toBeUndefined();
    expect(FINANCE_PERIOD_LABELS).toEqual({ day: 'Deň', month: 'Mesiac' });
  });
});

describe('FinancePanel — denné a mesačné obdobia', () => {
  it('s daily je aktívny Deň a Mesiac je vypnutý (bez mesačných dát)', () => {
    const html = render({ daily: F7_DAILY, chartCategories: F7_CATEGORIES });
    expect(periodButton(html, 'day')).toContain('aria-pressed="true"');
    expect(periodButton(html, 'month')).toContain('disabled');
    expect(html).toContain('data-mode="day"');
    expect(html).toContain('data-chart="stacked-bars"');
    expect(html).toContain('data-chart="line"');
  });

  it('len monthly → zobrazí sa Mesiac aj keď je vyžiadaný Deň', () => {
    const html = render({ monthly: F7_MONTHLY, chartCategories: F7_CATEGORIES });
    expect(html).toContain('data-mode="month"');
    expect(periodButton(html, 'month')).toContain('aria-pressed="true"');
    expect(periodButton(html, 'day')).toContain('disabled');
  });

  it('hotovosť a rozsah z posledného obdobia', () => {
    const html = render({ daily: F7_DAILY, chartCategories: F7_CATEGORIES });
    expect(fieldText(html, 'finance-cash')).toBe('$91,380');
    expect(fieldText(html, 'finance-range')).toBe('Deň 1 – Deň 3');
  });

  it('prázdne obdobia zobrazia prázdny stav bez grafu', () => {
    const html = render({ daily: [] });
    expect(fieldText(html, 'finance-empty')).toBe('Zatiaľ žiadne údaje.');
    expect(html).not.toContain('data-chart=');
  });
});

describe('FinancePanel — tabuľka kategórií za posledné obdobie', () => {
  it('príjem, výdaj a netto v peniazoch; výdaj bez mínusu, netto so znamienkom', () => {
    const html = render({ daily: F7_DAILY, chartCategories: F7_CATEGORIES });
    expect(fieldText(html, 'breakdown-income-handling')).toBe('$2,000');
    expect(fieldText(html, 'breakdown-expense-wages')).toBe('$450');
    expect(fieldText(html, 'breakdown-net-handling')).toBe('+$2,000');
    expect(fieldText(html, 'breakdown-net-wages')).toBe('−$450');
    expect(fieldText(html, 'breakdown-net-total')).toBe('+$1,380');
    expect(fieldText(html, 'breakdown-expense-total')).toBe('$620');
  });

  it('riadok Spolu a riadky kategórií z chartCategories', () => {
    const html = render({ monthly: F7_MONTHLY, chartCategories: F7_CATEGORIES });
    expect(html.match(/data-breakdown="/g)).toHaveLength(F7_CATEGORIES.length + 1);
    expect(html).toContain('data-breakdown="total"');
  });

  it('financeBreakdownRows: nulová kategória má netto 0 a neplatné obdobie vráti prázdny zoznam', () => {
    const rows = financeBreakdownRows(F7_DAILY[2], F7_DAILY, F7_CATEGORIES);
    expect(rows.find((r) => r.id === 'port_fees')).toEqual({ id: 'port_fees', label: 'Prístavné poplatky', income: 0, expense: 0, net: 0 });
    expect(financeBreakdownRows(undefined, F7_DAILY)).toEqual([]);
  });
});
