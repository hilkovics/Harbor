// Strážca pravidiel štýlu BuildBaru (DESIGN_BRIEF §6.4): len tokeny, tabular-nums, focus ring, krátke prechody.
import { describe, expect, it } from 'vitest';
import { TOKENS_CSS, loadCss } from './css-guard';

const css = loadCss('src/ui/build-bar.css');
const { source } = css;

describe('build-bar.css — len tokeny', () => {
  it('neobsahuje pevné farby (hex, rgb(a), hsl(a), pomenované farby); farby idú cez var() / color-mix()', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
    expect(source).not.toMatch(/:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey)\b/i);
  });

  it('každý použitý var(--x) je definovaný v design/tokens.css alebo lokálne v build-bar.css', () => {
    const local = css.localProperties();
    const used = css.usedProperties();
    expect(used.size).toBeGreaterThan(10);
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

describe('build-bar.css — pravidlá komponentu', () => {
  it('BuildBar má výšku --build-bar-h, pozadie --ui-bg a hornú hranu --ui-border', () => {
    const body = css.ruleBody('.build-bar');
    expect(body).toMatch(/height:\s*var\(--build-bar-h\)/);
    expect(body).toMatch(/background:\s*var\(--ui-bg\)/);
    expect(body).toMatch(/border-top:\s*1px solid var\(--ui-border\)/);
  });

  it('všetky čísla majú font-variant-numeric: tabular-nums (pás, cena, tooltip)', () => {
    expect(css.ruleBody('.build-bar')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(css.ruleBody('.build-bar__item-price')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(css.ruleBody('.build-bar__tip-text')).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('cena položky bez peňazí je --ui-money-neg (§6.2), zamknutá má stlmenú ikonu --ui-text-3', () => {
    expect(css.ruleBody('.build-bar__item--unaffordable .build-bar__item-cost')).toMatch(/color:\s*var\(--ui-money-neg\)/);
    expect(css.ruleBody('.build-bar__item--locked .build-bar__item-icon')).toMatch(/color:\s*var\(--ui-text-3\)/);
  });

  it('kurzor not-allowed má len zamknutá položka; drahá je vyberateľná (ghost s ikonou $), takže ho nemá', () => {
    expect(css.ruleBody('.build-bar__item--locked')).toMatch(/cursor:\s*not-allowed/);
    expect(source).not.toMatch(/\.build-bar__item--unaffordable(?::hover)?\s*[,{]/);
  });

  it('vybraná položka má accent obrys; hover a focus taktiež', () => {
    expect(css.ruleBody('.build-bar__item--selected,\n.build-bar__item--selected:hover')).toMatch(/border-color:\s*var\(--ui-accent\)/);
    expect(css.ruleBody('.build-bar__item:hover,\n.build-bar__item:focus-visible')).toMatch(/border-color:\s*var\(--ui-accent\)/);
  });

  it('aktívny tab: --ui-surface-2 s textom --ui-text; zamknutý tab --ui-text-3 a kurzor not-allowed', () => {
    const active = css.ruleBody('.build-bar__tab--active');
    expect(active).toMatch(/background:\s*var\(--ui-surface-2\)/);
    expect(active).toMatch(/color:\s*var\(--ui-text\)/);
    const locked = css.ruleBody('.build-bar__tab--locked,\n.build-bar__tab:disabled');
    expect(locked).toMatch(/color:\s*var\(--ui-text-3\)/);
    expect(locked).toMatch(/cursor:\s*not-allowed/);
  });

  it('klikateľné prvky majú focus-visible ring 2 px --ui-accent', () => {
    expect(css.ruleBody('.build-bar__item:focus-visible')).toMatch(/outline:\s*2px solid var\(--ui-accent\)/);
    expect(css.ruleBody('.build-bar__tab:focus-visible')).toMatch(/outline:\s*2px solid var\(--ui-accent\)/);
  });

  it('tooltip je skrytý, kým sa položka nezvýrazní (hover / focus-visible)', () => {
    const hidden = css.ruleBody('.build-bar__tip');
    expect(hidden).toMatch(/visibility:\s*hidden/);
    expect(hidden).toMatch(/pointer-events:\s*none/);
    expect(css.ruleBody('.build-bar__item:hover .build-bar__tip,\n.build-bar__item:focus-visible .build-bar__tip')).toMatch(
      /visibility:\s*visible/,
    );
  });

  it('respektuje prefers-reduced-motion', () => {
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
