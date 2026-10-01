import { describe, expect, it } from 'vitest';
import { TOKENS_CSS, loadCss } from './css-guard';

// Strážca štýlu (DESIGN_BRIEF §6.4) pre overlay Nastavenia a Uložiť/načítať: len tokeny, žiadne pevné farby,
// jediné pevné px sú 1 px čiary a 2 px ring/korekcie, čísla tabular-nums, focus ring, prefers-reduced-motion.
const FILES = ['src/ui/modal-dialog.css', 'src/ui/settings-panel.css', 'src/ui/save-load-panel.css'] as const;

describe.each(FILES)('%s', (file) => {
  const css = loadCss(file);

  it('žiadne pevné farby a len 1 px / 2 px pevné rozmery', () => {
    expect(css.source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css.source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
    const pixels = new Set([...css.source.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g)].map((match) => match[0]));
    for (const pixel of pixels) expect(['1px', '2px'], pixel).toContain(pixel);
  });

  it('každá použitá premenná je token z design/tokens.css alebo lokálna definícia', () => {
    for (const name of css.usedProperties()) {
      if (css.localProperties().has(name)) continue;
      expect(TOKENS_CSS, `token ${name}`).toContain(`${name}:`);
    }
  });
});

describe('modal-dialog.css', () => {
  const css = loadCss('src/ui/modal-dialog.css');

  it('dialóg: povrch, rámik, okruhliny a tieň z tokenov; čísla tabular-nums', () => {
    const body = css.ruleBody('.modal-dialog');
    expect(body).toMatch(/background:\s*var\(--ui-surface\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--ui-border\)/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-lg\)/);
    expect(body).toMatch(/box-shadow:\s*var\(--shadow-panel\)/);
    expect(body).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('zásterka pokrýva celý kontajner nad hrou', () => {
    const body = css.ruleBody('.modal-scrim');
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/inset:\s*0/);
    expect(body).toMatch(/background:\s*color-mix\(in srgb, var\(--ui-bg\)/);
  });

  it('hlavné tlačidlo: accent plocha s tmavým textom; ✕ a tlačidlá majú focus ring 2 px --ui-accent', () => {
    expect(css.ruleBody('.modal-btn--primary')).toMatch(/background:\s*var\(--ui-accent\)/);
    expect(css.ruleBody('.modal-btn--primary')).toMatch(/color:\s*var\(--ui-surface\)/);
    expect(css.ruleBody('.modal-btn:focus-visible')).toMatch(/outline:\s*2px solid var\(--ui-accent\)/);
    expect(css.ruleBody('.modal-dialog__close:focus-visible')).toMatch(/outline:\s*2px solid var\(--ui-accent\)/);
    expect(css.ruleBody('.modal-btn--danger')).toMatch(/border-color:\s*var\(--ui-danger\)/);
  });

  it('respektuje prefers-reduced-motion', () => {
    expect(css.source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe('settings-panel.css', () => {
  const css = loadCss('src/ui/settings-panel.css');

  it('riadok má dolnú čiaru --ui-border; segment: vybraný --ui-surface-2 + --ui-text, kontajner --ui-bg', () => {
    expect(css.ruleBody('.settings-row')).toMatch(/border-bottom:\s*1px solid var\(--ui-border\)/);
    expect(css.ruleBody('.segmented')).toMatch(/background:\s*var\(--ui-bg\)/);
    expect(css.ruleBody('.segmented__btn--active')).toMatch(/background:\s*var\(--ui-surface-2\)/);
    expect(css.ruleBody('.segmented__btn--active')).toMatch(/color:\s*var\(--ui-text\)/);
    expect(css.ruleBody('.segmented__btn:focus-visible')).toMatch(/outline:\s*2px solid var\(--ui-accent\)/);
  });

  it('názov skupiny: malé verzálky so stopou (prototyp)', () => {
    const body = css.ruleBody('.settings-group__title');
    expect(body).toMatch(/text-transform:\s*uppercase/);
    expect(body).toMatch(/font-size:\s*var\(--fs-xs\)/);
  });

  it('respektuje prefers-reduced-motion', () => {
    expect(css.source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe('save-load-panel.css', () => {
  const css = loadCss('src/ui/save-load-panel.css');

  it('riadok slotu s dolnou čiarou; ikony preview: cash --ui-success, XP --ui-xp', () => {
    expect(css.ruleBody('.save-slot')).toMatch(/border-bottom:\s*1px solid var\(--ui-border\)/);
    expect(css.ruleBody('.save-slot__icon--cash')).toMatch(/color:\s*var\(--ui-success\)/);
    expect(css.ruleBody('.save-slot__icon--xp')).toMatch(/color:\s*var\(--ui-xp\)/);
  });

  it('respektuje prefers-reduced-motion', () => {
    expect(css.source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
