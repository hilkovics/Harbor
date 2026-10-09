// TR4-04: strážca štýlu gate-inspector.css (DESIGN_BRIEF §6.4): len tokeny, žiadne pevné farby, tabular-nums.
import { describe, expect, it } from 'vitest';
import { TOKENS_CSS, loadCss } from './css-guard';

const css = loadCss('src/ui/gate-inspector.css');
const { source } = css;

describe('gate-inspector.css — len tokeny', () => {
  it('neobsahuje pevné farby (hex, rgb(a), hsl(a), pomenované farby)', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
    expect(source).not.toMatch(/:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey)\b/i);
  });

  it('každý použitý var(--x) je definovaný v design/tokens.css alebo lokálne', () => {
    const local = css.localProperties();
    const used = css.usedProperties();
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) {
      if (local.has(name)) continue;
      expect(TOKENS_CSS, `token ${name}`).toContain(`${name}:`);
    }
  });

  it('jediné pevné px rozmery sú 1px (okraje) a 2px (odznak, focus ring)', () => {
    const pixels = new Set([...source.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g)].map((match) => match[0]));
    expect([...pixels].sort()).toEqual(['1px', '2px']);
  });

  it('prechody nie sú dlhšie ako 200 ms a nič sa neanimuje', () => {
    const transitions = [...source.matchAll(/transition:([^;]+);/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/(\d+)ms/g)]);
    expect(transitions.length).toBeGreaterThan(0);
    for (const duration of transitions) expect(Number(duration[1])).toBeLessThanOrEqual(200);
    expect(source).not.toMatch(/(?<!-)animation:\s*(?!none)[a-z]/);
  });
});

describe('gate-inspector.css — pravidlá komponentu', () => {
  it('inšpektor má šírku --side-panel-w, pozadie --ui-bg a okraj --ui-border', () => {
    const body = css.ruleBody('.gate-inspector');
    expect(body).toMatch(/width:\s*var\(--side-panel-w\)/);
    expect(body).toMatch(/background:\s*var\(--ui-bg\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--ui-border\)/);
  });

  it('čísla majú font-variant-numeric: tabular-nums (podtitul, hodnoty, TTT)', () => {
    expect(css.ruleBody('.gate-inspector__sub')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(css.ruleBody('.gate-inspector__value')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(css.ruleBody('.gate-inspector__bar-value')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(css.ruleBody('.gate-inspector__stat-value')).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('zvolený režim a sloty majú vlastné pravidlá (zvýraznenie tokenmi, obsadený slot farbou akcent)', () => {
    expect(css.ruleBody('.gate-inspector__segment--on')).toMatch(/border-color:\s*var\(--ui-accent\)/);
    expect(css.ruleBody('.gate-inspector__slot--taken')).toMatch(/background:\s*var\(--ui-accent\)/);
    expect(css.ruleBody('.gate-inspector__bar-fill')).toMatch(/background:\s*var\(--ui-accent\)/);
  });
});
