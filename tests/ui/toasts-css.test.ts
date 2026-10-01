// Strážca pravidiel štýlu Toastov (DESIGN_BRIEF §6.1, §6.4): len tokeny, tabular-nums, focus ring, krátke prechody.
import { describe, expect, it } from 'vitest';
import { TOKENS_CSS, loadCss } from './css-guard';

const css = loadCss('src/ui/toasts.css');
const { source } = css;

describe('toasts.css — len tokeny', () => {
  it('neobsahuje pevné farby (hex, rgb(a), hsl(a), pomenované farby); farby idú cez var() / color-mix()', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
    expect(source).not.toMatch(/:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey)\b/i);
  });

  it('každý použitý var(--x) je definovaný v design/tokens.css alebo lokálne v toasts.css', () => {
    const local = css.localProperties();
    const used = css.usedProperties();
    expect(used.size).toBeGreaterThan(15);
    for (const name of used) {
      if (local.has(name)) continue;
      expect(TOKENS_CSS, `token ${name}`).toContain(`${name}:`);
    }
  });

  it('jediné pevné rozmery v px sú 1 px (čiara) a 2 px (focus ring, korekcie, radius pruhu)', () => {
    const pixels = new Set([...source.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g)].map((match) => match[0]));
    expect([...pixels].sort()).toEqual(['1px', '2px']);
  });

  it('prechody nie sú dlhšie ako 200 ms a nič sa nanimuje', () => {
    const transitions = [...source.matchAll(/transition:([^;]+);/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/(\d+)ms/g)]);
    expect(transitions.length).toBeGreaterThan(0);
    for (const duration of transitions) expect(Number(duration[1])).toBeLessThanOrEqual(200);
    expect(source).not.toMatch(/(?<!-)animation:\s*(?!none)[a-z]/);
  });
});

describe('toasts.css — pravidlá komponentu', () => {
  it('zásobník: absolútna poloha vľavo od panelu (--side-panel-w) nad BuildBarom (--build-bar-h), tabular-nums', () => {
    const body = css.ruleBody('.toasts');
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/right:\s*calc\(var\(--side-panel-w\) \+ var\(--space-6\)\)/);
    expect(body).toMatch(/bottom:\s*calc\(var\(--build-bar-h\) \+ var\(--space-3\)\)/);
    expect(body).toMatch(/gap:\s*var\(--space-2\)/);
    expect(body).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  it('toast: povrch --ui-surface, hrana --ui-border, radius --radius-md, tieň --shadow-panel', () => {
    const body = css.ruleBody('.toast');
    expect(body).toMatch(/background:\s*var\(--ui-surface\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--ui-border\)/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(body).toMatch(/box-shadow:\s*var\(--shadow-panel\)/);
  });

  it('tóny: info / success / warning / danger → --ui-info / --ui-success / --ui-warning / --ui-danger', () => {
    expect(css.ruleBody('.toast--info')).toMatch(/--toast-tone:\s*var\(--ui-info\)/);
    expect(css.ruleBody('.toast--success')).toMatch(/--toast-tone:\s*var\(--ui-success\)/);
    expect(css.ruleBody('.toast--warning')).toMatch(/--toast-tone:\s*var\(--ui-warning\)/);
    expect(css.ruleBody('.toast--danger')).toMatch(/--toast-tone:\s*var\(--ui-danger\)/);
  });

  it('pruh aj ikona nesú farbu tónu; pruh je 4 px (--space-1) na celú výšku', () => {
    const stripe = css.ruleBody('.toast__stripe');
    expect(stripe).toMatch(/background:\s*var\(--toast-tone\)/);
    expect(stripe).toMatch(/width:\s*var\(--space-1\)/);
    expect(stripe).toMatch(/align-self:\s*stretch/);
    expect(css.ruleBody('.toast__icon')).toMatch(/color:\s*var\(--toast-tone\)/);
  });

  it('názov 600 / --fs-sm, popis --ui-text-2 / --fs-xs', () => {
    const title = css.ruleBody('.toast__title');
    expect(title).toMatch(/font-size:\s*var\(--fs-sm\)/);
    expect(title).toMatch(/font-weight:\s*var\(--fw-semibold\)/);
    const text = css.ruleBody('.toast__text');
    expect(text).toMatch(/color:\s*var\(--ui-text-2\)/);
    expect(text).toMatch(/font-size:\s*var\(--fs-xs\)/);
  });

  it('akcia: accent text bez podkladu, hover --ui-accent-hover; zavrieť 24 px (--icon-md)', () => {
    const action = css.ruleBody('.toast__action');
    expect(action).toMatch(/color:\s*var\(--ui-accent\)/);
    expect(action).toMatch(/background:\s*none/);
    expect(css.ruleBody('.toast__action:hover')).toMatch(/color:\s*var\(--ui-accent-hover\)/);
    const close = css.ruleBody('.toast__close');
    expect(close).toMatch(/width:\s*var\(--icon-md\)/);
    expect(close).toMatch(/height:\s*var\(--icon-md\)/);
  });

  it('klikateľné prvky majú focus-visible ring 2 px --ui-accent', () => {
    expect(css.ruleBody('.toast__action:focus-visible,\n.toast__close:focus-visible')).toMatch(/outline:\s*2px solid var\(--ui-accent\)/);
  });

  it('zásobník je nad zásterkou overlayov a modálov (chyby ukladania sa ukazujú pri otvorenom dialógu)', () => {
    const zIndex = (body: string): number => Number(/z-index:\s*(\d+)/.exec(body)?.[1]);
    const toasts = zIndex(css.ruleBody('.toasts'));
    expect(toasts).toBeGreaterThan(zIndex(loadCss('src/ui/modal-dialog.css').ruleBody('.modal-scrim')));
    expect(toasts).toBeGreaterThan(zIndex(loadCss('src/ui/game-over-modal.css').ruleBody('.game-over')));
  });

  it('respektuje prefers-reduced-motion', () => {
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
