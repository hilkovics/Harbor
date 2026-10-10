// TR5-04: strážca štýlu pre reefer-inspector.css, finance-panel.css a pravidlá zmesi typov v contracts-panel.css
// (DESIGN_BRIEF §6.4): len tokeny z design/tokens.css, žiadne pevné farby, tabular-nums pri číslach.
import { describe, expect, it } from 'vitest';
import { TOKENS_CSS, loadCss } from './css-guard';

const SOURCES = ['src/ui/reefer-inspector.css', 'src/ui/finance-panel.css', 'src/ui/contracts-panel.css'] as const;

describe.each(SOURCES)('%s — len tokeny', (path) => {
  const css = loadCss(path);
  const { source } = css;

  it('neobsahuje pevné farby (hex, rgb(a), hsl(a), pomenované farby)', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
    expect(source).not.toMatch(/:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey)\b/i);
  });

  it('každý použitý var(--x) je definovaný v design/tokens.css alebo lokálne', () => {
    const local = css.localProperties();
    for (const name of css.usedProperties()) {
      if (local.has(name)) continue;
      expect(TOKENS_CSS, `token ${name}`).toContain(`${name}:`);
    }
  });
});

describe('reefer-inspector.css a finance-panel.css — čísla a prechody', () => {
  it('reefer inšpektor používa tabular-nums pri hodnotách', () => {
    expect(loadCss('src/ui/reefer-inspector.css').ruleBody('.reefer-inspector__value')).toContain('tabular-nums');
  });

  it('tabuľka financií používa tabular-nums pri hodnote', () => {
    expect(loadCss('src/ui/finance-panel.css').ruleBody('.finance-panel__value')).toContain('tabular-nums');
  });
});

describe('contracts-panel.css — zmes typov', () => {
  const css = loadCss('src/ui/contracts-panel.css');

  it('čip kategórie má farbu okraja z tokenu a počty tabular-nums', () => {
    expect(css.ruleBody('.contract-card__type--reefer')).toContain('var(--container-reefer)');
    expect(css.ruleBody('.contract-card__type-count')).toContain('tabular-nums');
  });

  it('OOG odznak je v tóne upozornenia', () => {
    expect(css.ruleBody('.contract-card__oog')).toContain('var(--ui-warning)');
  });
});
