// Strážca pravidiel štýlu (DESIGN_BRIEF §6.4 a zadanie T01-10): len tokeny, tabular-nums, focus ring, krátke animácie.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/ui/top-hud.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../design/tokens.css', import.meta.url), 'utf8');

/** Zdroj bez komentárov (komentáre smú spomenúť hex farby či px). */
const source = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Telo prvého pravidla, ktorého selektor presne zodpovedá `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  if (match === null) throw new Error(`Pravidlo '${selector}' sa nenašlo v top-hud.css`);
  return match[1] ?? '';
}

describe('top-hud.css — len tokeny', () => {
  it('neobsahuje pevné farby (hex, rgb(a), hsl(a), pomenované farby); farby idú cez var() / color-mix()', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
    expect(source).not.toMatch(/:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey)\b/i);
  });

  it('každý použitý var(--x) je definovaný v design/tokens.css alebo lokálne v top-hud.css', () => {
    const local = new Set([...source.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string));
    const used = new Set([...source.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1] as string));
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) {
      if (local.has(name)) continue;
      expect(tokens, `token ${name}`).toContain(`${name}:`);
    }
  });

  it('jediné pevné rozmery v px sú 1 px (čiara) a 2 px (focus ring, korekcie); ostatné idú cez tokeny', () => {
    const pixels = new Set([...source.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g)].map((match) => match[0]));
    expect([...pixels].sort()).toEqual(['1px', '2px']);
  });

  it('prechody nie sú dlhšie ako 200 ms; jediná dlhšia animácia je diskrétny pulz (steps(1, end))', () => {
    const transitions = [...source.matchAll(/transition:([^;]+);/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/(\d+)ms/g)]);
    expect(transitions.length).toBeGreaterThan(0);
    for (const duration of transitions) expect(Number(duration[1])).toBeLessThanOrEqual(200);

    const animations = [...source.matchAll(/(?<!-)animation:([^;]+);/g)].map((match) => match[1] ?? '').filter((value) => value.trim() !== 'none');
    expect(animations).toHaveLength(1);
    expect(animations[0]).toMatch(/top-hud-debt-pulse\s+1\.6s\s+steps\(1, end\)\s+infinite/);
  });
});

describe('top-hud.css — pravidlá komponentu', () => {
  it('TopHUD má výšku --hud-top-h a pozadie --ui-bg s hranou --ui-border', () => {
    const body = ruleBody('.top-hud');
    expect(body).toMatch(/height:\s*var\(--hud-top-h\)/);
    expect(body).toMatch(/background:\s*var\(--ui-bg\)/);
    expect(body).toMatch(/border-bottom:\s*1px solid var\(--ui-border\)/);
  });

  it('farby čísel podľa prototypu: kladný delta --ui-money-pos, záporná hotovosť --ui-money-neg, XP --ui-xp', () => {
    expect(ruleBody('.top-hud__delta--pos')).toMatch(/color:\s*var\(--ui-money-pos\)/);
    expect(ruleBody('.top-hud--debt .top-hud__cash-value')).toMatch(/color:\s*var\(--ui-money-neg\)/);
    expect(ruleBody('.top-hud--debt .top-hud__cash-icon')).toMatch(/color:\s*var\(--ui-danger\)/);
    expect(ruleBody('.top-hud__cash-icon')).toMatch(/color:\s*var\(--ui-success\)/);
    expect(ruleBody('.top-hud__xp-icon')).toMatch(/color:\s*var\(--ui-xp\)/);
    // Záporný delta: svetlejšia červená odvodená z tokenov (kontrast ≥ 4,5 : 1 pre malý text).
    expect(ruleBody('.top-hud__delta--neg')).toMatch(/color:\s*color-mix\([^)]*var\(--ui-money-neg\)[^)]*var\(--ui-text\)/);
  });

  it('všetky čísla majú font-variant-numeric: tabular-nums', () => {
    const grouped = /([^{}]+)\{[^}]*font-variant-numeric:\s*tabular-nums[^}]*\}/.exec(source);
    expect(grouped).not.toBeNull();
    const selectors = (grouped?.[1] ?? '').split(',').map((part) => part.trim());
    for (const cls of ['.top-hud', '.top-hud__cash-value', '.top-hud__delta', '.top-hud__xp', '.top-hud__time', '.speed-control__btn']) {
      expect(selectors).toContain(cls);
    }
  });

  it('klikateľné prvky majú hover a focus-visible ring 2 px --ui-accent', () => {
    expect(ruleBody('.top-hud__panel:focus-visible,\n.speed-control__btn:focus-visible')).toMatch(/outline:\s*2px solid var\(--ui-accent\)/);
    expect(source).toMatch(/\.speed-control__btn:hover\s*\{/);
    expect(source).toMatch(/\.top-hud__panel:hover:not\(:disabled\)\s*\{/);
  });

  it('aktívna rýchlosť: accent (pauza: warning) s tmavým textom pre kontrast', () => {
    expect(ruleBody('.speed-control__btn--active')).toMatch(/background:\s*var\(--ui-accent\)/);
    expect(ruleBody('.speed-control__btn--active')).toMatch(/color:\s*var\(--ui-surface\)/);
    expect(source).toMatch(/\.speed-control__btn--active\.speed-control__btn--pause[\s\S]*?background:\s*var\(--ui-warning\)/);
  });

  it('respektuje prefers-reduced-motion', () => {
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
