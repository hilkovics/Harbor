// TF7-03: MonthlyReportModal — top 3 zmeny netta kategórií oproti predchádzajúcemu mesiacu, súhrn a prázdne stavy.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MonthlyReportModal, TOP_CHANGES_COUNT, topChanges, type MonthlyReportSummary } from '@ui/index';
import { F7_CATEGORIES, F7_MONTHLY } from './f7-finance-fixtures';
import { fieldText } from './react-tree';

const summary: MonthlyReportSummary = {
  monthLabel: 'Mesiac 2 · deň 31–60',
  current: F7_MONTHLY[1]!,
  previous: F7_MONTHLY[0]!,
  categories: F7_CATEGORIES,
};

const render = (props: { summary?: MonthlyReportSummary }): string =>
  renderToStaticMarkup(createElement(MonthlyReportModal, { onClose: vi.fn(), ...props }));

describe('topChanges', () => {
  it('zmena netta po kategóriách, bez nulových, zoradené podľa absolútnej hodnoty, najviac 3', () => {
    const changes = topChanges(F7_MONTHLY[1]!, F7_MONTHLY[0]!, F7_CATEGORIES);
    expect(TOP_CHANGES_COUNT).toBe(3);
    // handling −200,000; opex +112,900; storage +100,000; port_fees +13,800 (vypadne); wages 0 (vypadne)
    expect(changes.map((c) => c.id)).toEqual(['handling', 'opex', 'storage']);
    expect(changes.map((c) => c.delta)).toEqual([-200_000, 112_900, 100_000]);
    expect(changes[1]?.label).toBe('Prevádzka');
  });

  it('bez zmien vráti prázdny zoznam', () => {
    expect(topChanges(F7_MONTHLY[0]!, F7_MONTHLY[0]!, F7_CATEGORIES)).toEqual([]);
  });
});

describe('MonthlyReportModal — render', () => {
  it('dialóg s nadpisom, označením mesiaca a súhrnom v peniazoch', () => {
    const html = render({ summary });
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"/);
    expect(html).toContain('aria-label="Mesačný report"');
    expect(fieldText(html, 'month-label')).toBe('Mesiac 2 · deň 31–60');
    expect(fieldText(html, 'income')).toBe('$14,500');
    expect(fieldText(html, 'expense')).toBe('$11,500');
    expect(fieldText(html, 'net')).toBe('+$3,000');
    expect(fieldText(html, 'cash')).toBe('$123,356');
  });

  it('tabuľka kategórií za mesiac a top zmeny', () => {
    const html = render({ summary });
    expect(fieldText(html, 'income-handling')).toBe('$10,000');
    expect(fieldText(html, 'expense-wages')).toBe('$9,000');
    expect(html.match(/data-category="/g)).toHaveLength(F7_CATEGORIES.length);
    expect(html.match(/data-change="/g)).toHaveLength(3);
    expect(html).toContain('data-change="handling"');
  });

  it('bez predchádzajúceho mesiaca text namiesto zmien', () => {
    const html = render({ summary: { monthLabel: 'Mesiac 1', current: F7_MONTHLY[0]!, categories: F7_CATEGORIES } });
    expect(fieldText(html, 'no-previous')).toBe('Predchádzajúci mesiac ešte nie je k dispozícii.');
    expect(html).not.toContain('data-change=');
  });

  it('bez súhrnu prázdny stav a tlačidlo Zavrieť', () => {
    const html = render({});
    expect(fieldText(html, 'empty')).toBe('Report za uplynulý mesiac zatiaľ nie je k dispozícii.');
    expect(html).toContain('Zavrieť');
  });

  it('žiadne pevné farby v markupe', () => {
    expect(render({ summary })).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});
