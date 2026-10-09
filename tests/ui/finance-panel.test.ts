// TR5-04: finančný panel s riadkom Energia (predvolene 0, voliteľné kategórie; pôvodné správanie nedotknuté).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ENERGY_CATEGORY_LABEL, FinancePanel } from '@ui/index';
import { fieldText } from './react-tree';

describe('FinancePanel — riadok energie', () => {
  it('bez energyCents je riadok Energia 0 a žiadne kategórie navyše', () => {
    const html = renderToStaticMarkup(createElement(FinancePanel, {}));
    expect(ENERGY_CATEGORY_LABEL).toBe('Energia');
    expect(html).toContain('Energia');
    expect(fieldText(html, 'energy')).toBe('$0');
    expect(html.match(/data-category=/g)).toHaveLength(1);
  });

  it('energyCents sa zobrazí ako výdaj so záporným znamienkom', () => {
    const html = renderToStaticMarkup(createElement(FinancePanel, { energyCents: 432_000 }));
    expect(fieldText(html, 'energy')).toBe('−$4,320');
  });

  it('kategórie zostávajú pred energiou a neovplyvnia ju', () => {
    const html = renderToStaticMarkup(
      createElement(FinancePanel, {
        categories: [{ id: 'handling', label: 'Manipulácia', cents: 250_000 }],
        energyCents: 1_000,
      }),
    );
    expect(fieldText(html, 'category-handling')).toBe('+$2,500');
    expect(fieldText(html, 'energy')).toBe('−$10');
    expect(html.indexOf('data-category="handling"')).toBeLessThan(html.indexOf('data-category="energy"'));
  });

  it('neplatná hodnota energie sa berie ako 0', () => {
    const html = renderToStaticMarkup(createElement(FinancePanel, { energyCents: Number.NaN }));
    expect(fieldText(html, 'energy')).toBe('$0');
  });
});
