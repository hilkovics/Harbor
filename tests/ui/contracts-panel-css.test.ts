// Strážca pravidiel štýlu ContractsPanel a kariet (DESIGN_BRIEF §6.1, §6.4): len tokeny, tabular-nums, focus ring, krátke prechody.
import { describe, expect, it } from 'vitest';
import { TOKENS_CSS, loadCss } from './css-guard';

const css = loadCss('src/ui/contracts-panel.css');
const { source } = css;

describe('contracts-panel.css — len tokeny', () => {
  it('neobsahuje pevné farby (hex, rgb(a), hsl(a), pomenované farby)', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
    expect(source).not.toMatch(/:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey)\b/i);
  });

  it('každý použitý var(--x) je definovaný v design/tokens.css alebo lokálne', () => {
    const local = css.localProperties();
    const used = css.usedProperties();
    expect(used.size).toBeGreaterThan(20);
    for (const name of used) {
      if (local.has(name)) continue;
      expect(TOKENS_CSS, `token ${name}`).toContain(`${name}:`);
    }
  });

  it('jediné pevné rozmery v px sú 1 px (čiara) a 2 px (focus ring, korekcie)', () => {
    const pixels = new Set([...source.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g)].map((match) => match[0]));
    expect([...pixels].sort()).toEqual(['1px', '2px']);
  });

  it('prechody nie sú dlhšie ako 200 ms a nič sa nanimuje', () => {
    const durations = [...source.matchAll(/transition:([^;]+);/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/(\d+)ms/g)]);
    expect(durations.length).toBeGreaterThan(0);
    for (const duration of durations) expect(Number(duration[1])).toBeLessThanOrEqual(200);
    expect(source).not.toMatch(/(?<!-)animation:\s*(?!none)[a-z]/);
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe('contracts-panel.css — pravidlá komponentu', () => {
  it('panel: šírka --side-panel-w, povrch --ui-bg, tieň, tabular-nums', () => {
    const body = css.ruleBody('.contracts-panel');
    expect(body).toMatch(/width:\s*var\(--side-panel-w\)/);
    expect(body).toMatch(/background:\s*var\(--ui-bg\)/);
    expect(body).toMatch(/box-shadow:\s*var\(--shadow-panel\)/);
    expect(body).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('karta: povrch --ui-surface, hrana --ui-border, radius --radius-md', () => {
    const body = css.ruleBody('.contract-card');
    expect(body).toMatch(/background:\s*var\(--ui-surface\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--ui-border\)/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-md\)/);
  });

  it('kategórie nákladu → farby --cargo-* (kvapaliny a RoRo svetlý variant)', () => {
    expect(css.ruleBody('.contract-card--container')).toMatch(/--cc-cat:\s*var\(--cargo-container\)/);
    expect(css.ruleBody('.contract-card--bulk')).toMatch(/--cc-cat:\s*var\(--cargo-bulk\)/);
    expect(css.ruleBody('.contract-card--liquid')).toMatch(/--cc-cat:\s*var\(--cargo-liquid-light\)/);
    expect(css.ruleBody('.contract-card--gas')).toMatch(/--cc-cat:\s*var\(--cargo-gas\)/);
    expect(css.ruleBody('.contract-card--roro')).toMatch(/--cc-cat:\s*var\(--cargo-roro-light\)/);
    expect(css.ruleBody('.contract-card__bar-fill')).toMatch(/background:\s*var\(--cc-cat\)/);
  });

  it('SLA pilulky: zelená / žltá / červená z tokenov success / warning / danger', () => {
    expect(css.ruleBody('.contract-card__pill--ok')).toMatch(/color:\s*var\(--ui-success\)/);
    expect(css.ruleBody('.contract-card__pill--warn')).toMatch(/color:\s*var\(--ui-warning\)/);
    expect(css.ruleBody('.contract-card__pill--danger')).toMatch(/var\(--ui-danger\)/);
  });

  it('odmena: kladná --ui-money-pos, záporná z --ui-money-neg', () => {
    expect(css.ruleBody('.contract-card__reward--pos')).toMatch(/color:\s*var\(--ui-money-pos\)/);
    expect(css.ruleBody('.contract-card__reward--neg')).toMatch(/var\(--ui-money-neg\)/);
  });

  it('hlavné tlačidlo: accent plocha, hover --ui-accent-hover, zablokované stlmené', () => {
    const primary = css.ruleBody('.contract-card__btn--primary');
    expect(primary).toMatch(/background:\s*var\(--ui-accent\)/);
    expect(css.ruleBody('.contract-card__btn--primary:hover')).toMatch(/background:\s*var\(--ui-accent-hover\)/);
    expect(source).toMatch(/\.contract-card__btn--primary\[aria-disabled='true'\]/);
  });

  it('klikateľné prvky majú focus-visible ring 2 px --ui-accent', () => {
    const body = css.ruleBody(
      '.contracts-panel__close:focus-visible,\n.contracts-panel__tab:focus-visible,\n.contract-card__btn:focus-visible',
    );
    expect(body).toMatch(/outline:\s*2px solid var\(--ui-accent\)/);
  });
});
