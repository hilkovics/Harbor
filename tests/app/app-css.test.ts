// Strážca štýlu kostry stránky (DESIGN_BRIEF §6.4): len tokeny z design/tokens.css, žiadne pevné farby ani rozmery.
import { describe, expect, it } from 'vitest';
import { TOKENS_CSS, loadCss } from '../ui/css-guard';

const css = loadCss('src/app/app.css');
const { source } = css;

describe('app.css — len tokeny', () => {
  it('neobsahuje pevné farby (hex, rgb(a), hsl(a), pomenované farby)', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
    expect(source).not.toMatch(/:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey)\b/i);
  });

  it('každý použitý var(--x) je definovaný v design/tokens.css alebo lokálne v app.css', () => {
    const local = css.localProperties();
    for (const name of css.usedProperties()) {
      if (local.has(name)) continue;
      expect(TOKENS_CSS, `token ${name}`).toContain(`${name}:`);
    }
  });

  it('jediné pevné rozmery v px sú 1 px (čiara, skrytý prvok) a 2 px (focus ring, korekcie)', () => {
    const pixels = new Set([...source.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g)].map((match) => match[0]));
    expect([...pixels].sort()).toEqual(['1px', '2px']);
  });
});

describe('app.css — rozloženie', () => {
  it('BuildBar je prilepený k spodnému okraju a berie myš (UI vrstva ju inak prepúšťa mape)', () => {
    const body = css.ruleBody('.app__build');
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/bottom:\s*0/);
    expect(body).toMatch(/pointer-events:\s*auto/);
  });

  it('DEV nástroje sú pod HUD vľavo (výška HUD z tokenu), aby nezakrývali pravý panel, a berú myš', () => {
    const body = css.ruleBody('.app__dev');
    expect(body).toMatch(/top:\s*calc\(var\(--hud-top-h\)/);
    expect(body).toMatch(/left:\s*var\(--space-3\)/);
    expect(body).not.toMatch(/right:/);
    expect(body).toMatch(/pointer-events:\s*auto/);
  });

  it('pravý panel (inšpektor) je pod HUD a nad BuildBar, šírka z --side-panel-w, berie myš', () => {
    const body = css.ruleBody('.app__side');
    expect(body).toMatch(/top:\s*calc\(var\(--hud-top-h\)/);
    expect(body).toMatch(/right:\s*var\(--space-3\)/);
    expect(body).toMatch(/width:\s*var\(--side-panel-w\)/);
    expect(body).toMatch(/max-height:\s*calc\([^;]*var\(--hud-top-h\)[^;]*var\(--build-bar-h\)/);
    expect(body).toMatch(/pointer-events:\s*auto/);
  });

  it('štítok „chýbajú peniaze“ má varovnú farbu a ikonu, nie farbu chyby', () => {
    expect(css.ruleBody('.build-tip--funds')).toMatch(/border-color:\s*var\(--ui-warning\)/);
    expect(css.ruleBody('.build-tip--funds .build-tip__icon')).toMatch(/color:\s*var\(--ui-warning\)/);
  });

  it('DEV tlačidlo má focus ring z --ui-accent', () => {
    expect(css.ruleBody('.dev-spawn:focus-visible')).toMatch(/outline:\s*2px solid var\(--ui-accent\)/);
  });

  it('UI vrstva prepúšťa myš mape; HUD ju berie', () => {
    expect(css.ruleBody('.app__ui')).toMatch(/pointer-events:\s*none/);
    expect(css.ruleBody('.app__hud')).toMatch(/pointer-events:\s*auto/);
  });
});
