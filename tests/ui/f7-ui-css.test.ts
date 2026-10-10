// TF7-03: strážca štýlu pre finančné grafy, ParcelPanel a MonthlyReportModal (DESIGN_BRIEF §6.4): len tokeny z
// design/tokens.css, žiadne pevné farby v CSS ani v TSX, čísla s tabular-nums.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOKENS_CSS, loadCss } from './css-guard';

const STYLES = [
  'src/ui/finance-charts.css',
  'src/ui/finance-panel.css',
  'src/ui/parcel-panel.css',
  'src/ui/monthly-report-modal.css',
] as const;

const SOURCES = ['src/ui/finance-charts.tsx', 'src/ui/finance-panel.tsx', 'src/ui/parcel-panel.tsx', 'src/ui/monthly-report-modal.tsx'] as const;

describe.each(STYLES)('%s — len tokeny', (path) => {
  const css = loadCss(path);

  it('bez pevných farieb (hex, rgb(a), hsl(a), pomenované farby)', () => {
    expect(css.source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css.source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
    expect(css.source).not.toMatch(/:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey)\b/i);
  });

  it('každý použitý var(--x) je definovaný v design/tokens.css alebo lokálne', () => {
    const local = css.localProperties();
    for (const name of css.usedProperties()) {
      if (local.has(name)) continue;
      expect(TOKENS_CSS, `token ${name}`).toContain(`${name}:`);
    }
  });
});

describe.each(SOURCES)('%s — žiadne pevné farby v TSX', (path) => {
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

  it('farby sú len var(--token) alebo rgba z tokenov', () => {
    expect(source).not.toMatch(/['"`]#[0-9a-fA-F]{3,8}['"`]/);
    expect(source).not.toMatch(/\b(?:rgb|hsl)a?\(/i);
  });
});

describe('finančné grafy a parcely — tabular-nums', () => {
  it('čísla na osiach, kartách a v tabuľkách sú tabular-nums', () => {
    expect(loadCss('src/ui/finance-charts.css').ruleBody('.finance-charts__axis')).toContain('tabular-nums');
    expect(loadCss('src/ui/parcel-panel.css').ruleBody('.parcel-panel__card-value')).toContain('tabular-nums');
    expect(loadCss('src/ui/monthly-report-modal.css').ruleBody('.monthly-report__tile-value')).toContain('tabular-nums');
    expect(loadCss('src/ui/finance-panel.css').ruleBody('.finance-panel__breakdown .finance-panel__num')).toContain('tabular-nums');
  });

  it('stav parcely sa farbí cez tokeny --parcel-*', () => {
    const css = loadCss('src/ui/parcel-panel.css');
    expect(css.ruleBody('.parcel-panel__outline')).toContain('var(--parcel-for-sale)');
    expect(css.ruleBody('.parcel-panel__outline[data-state="owned"]')).toContain('var(--parcel-owned)');
    expect(css.ruleBody('.parcel-panel__outline[data-state="leased"]')).toContain('var(--parcel-leased)');
  });
});
