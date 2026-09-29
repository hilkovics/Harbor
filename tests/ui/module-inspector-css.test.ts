// Strážca pravidiel štýlu ModuleInspectoru (DESIGN_BRIEF §6.1, §6.4): len tokeny, tabular-nums, focus ring, krátke prechody.
import { describe, expect, it } from 'vitest';
import { TOKENS_CSS, loadCss } from './css-guard';

const css = loadCss('src/ui/module-inspector.css');
const { source } = css;

describe('module-inspector.css — len tokeny', () => {
  it('neobsahuje pevné farby (hex, rgb(a), hsl(a), pomenované farby); farby idú cez var() / color-mix()', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
    expect(source).not.toMatch(/:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey)\b/i);
  });

  it('každý použitý var(--x) je definovaný v design/tokens.css alebo lokálne v module-inspector.css', () => {
    const local = css.localProperties();
    const used = css.usedProperties();
    expect(used.size).toBeGreaterThan(15);
    for (const name of used) {
      if (local.has(name)) continue;
      expect(TOKENS_CSS, `token ${name}`).toContain(`${name}:`);
    }
  });

  it('jediné pevné rozmery v px sú 1 px (čiara) a 2 px (focus ring, korekcie); ostatné idú cez tokeny', () => {
    const pixels = new Set([...source.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g)].map((match) => match[0]));
    expect([...pixels].sort()).toEqual(['1px', '2px']);
  });

  it('prechody nie sú dlhšie ako 200 ms a nič sa nanimuje (okrem prechodov)', () => {
    const transitions = [...source.matchAll(/transition:([^;]+);/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/(\d+)ms/g)]);
    expect(transitions.length).toBeGreaterThan(0);
    for (const duration of transitions) expect(Number(duration[1])).toBeLessThanOrEqual(200);
    expect(source).not.toMatch(/(?<!-)animation:\s*(?!none)[a-z]/);
  });
});

describe('module-inspector.css — pravidlá komponentu', () => {
  it('panel má šírku --side-panel-w, pozadie --ui-bg, hranu --ui-border, radius --radius-lg a --shadow-panel', () => {
    const body = css.ruleBody('.module-inspector');
    expect(body).toMatch(/width:\s*var\(--side-panel-w\)/);
    expect(body).toMatch(/background:\s*var\(--ui-bg\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--ui-border\)/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-lg\)/);
    expect(body).toMatch(/box-shadow:\s*var\(--shadow-panel\)/);
  });

  it('všetky čísla majú tabular-nums (panel), hodnoty dlaždíc sú --fs-xl a --fw-bold', () => {
    expect(css.ruleBody('.module-inspector')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    const value = css.ruleBody('.module-inspector__stat-value');
    expect(value).toMatch(/font-size:\s*var\(--fs-xl\)/);
    expect(value).toMatch(/font-weight:\s*var\(--fw-bold\)/);
  });

  it('badge: zelený (--ui-success) pre ok, žltý (--module-disconnected) pre varovanie', () => {
    expect(css.ruleBody('.module-inspector__badge--ok')).toMatch(/color:\s*var\(--ui-success\)/);
    expect(css.ruleBody('.module-inspector__badge--warn')).toMatch(/color:\s*var\(--module-disconnected\)/);
  });

  it('banner upozornenia používa --module-disconnected (ako „Nepripojené k ceste" v prototype)', () => {
    expect(css.ruleBody('.module-inspector__banner')).toMatch(/border:\s*1px solid var\(--module-disconnected\)/);
  });

  it('tón dlaždice: warn = --ui-warning, danger = --ui-danger', () => {
    expect(css.ruleBody('.module-inspector__stat-value--warn')).toMatch(/color:\s*var\(--ui-warning\)/);
    expect(css.ruleBody('.module-inspector__stat-value--danger')).toMatch(/color:\s*var\(--ui-danger\)/);
  });

  it('segmenty pruhov: apron v farbe kontajnera (svetlejšia = rezervované), čas žeriavu accent / warning', () => {
    expect(source).toMatch(/\.module-inspector__bar-fill--used\s*\{\s*background:\s*var\(--cargo-container\)/);
    expect(css.ruleBody('.module-inspector__swatch--reserved,\n.module-inspector__bar-fill--reserved')).toMatch(
      /background:\s*var\(--cargo-container-light\)/,
    );
    expect(css.ruleBody('.module-inspector__swatch--busy,\n.module-inspector__bar-fill--busy')).toMatch(/background:\s*var\(--ui-accent\)/);
    expect(css.ruleBody('.module-inspector__swatch--blocked,\n.module-inspector__bar-fill--blocked')).toMatch(/background:\s*var\(--ui-warning\)/);
  });

  it('tlačidlo Odstrániť: danger obrys; nedostupné je stlmené s kurzorom not-allowed', () => {
    expect(css.ruleBody('.module-inspector__btn--danger')).toMatch(/border-color:\s*var\(--ui-danger\)/);
    const disabled = css.ruleBody(".module-inspector__btn[aria-disabled='true']");
    expect(disabled).toMatch(/cursor:\s*not-allowed/);
    expect(disabled).toMatch(/opacity:\s*0\.6/);
  });

  it('klikateľné prvky majú focus-visible ring 2 px --ui-accent', () => {
    expect(css.ruleBody('.module-inspector__close:focus-visible,\n.module-inspector__btn:focus-visible')).toMatch(
      /outline:\s*2px solid var\(--ui-accent\)/,
    );
  });

  it('telo sa posúva (overflow-y: auto), akcie sú prilepené naspodok (margin-top: auto)', () => {
    expect(css.ruleBody('.module-inspector__body')).toMatch(/overflow-y:\s*auto/);
    expect(css.ruleBody('.module-inspector__actions')).toMatch(/margin-top:\s*auto/);
  });

  it('respektuje prefers-reduced-motion', () => {
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
