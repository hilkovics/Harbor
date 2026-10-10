import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GameOverModal, bankruptcyText } from '@ui/game-over-modal';
import { TOKENS_CSS, loadCss } from './css-guard';
import { fieldText } from './react-tree';

const render = (extra: { onLoadGame?: () => void } = {}): string =>
  renderToStaticMarkup(
    createElement(GameOverModal, {
      daysSurvived: 142,
      completedContracts: 87,
      xp: 12_340,
      bankruptcyDays: 30,
      onNewGame: vi.fn(),
      ...extra,
    }),
  );

describe('GameOverModal', () => {
  it('alertdialog s nadpisom Bankrot, popisom a vysvetlením z bankruptcyDays', () => {
    const html = render();
    expect(html).toMatch(/role="alertdialog" aria-modal="true" aria-labelledby="[^"]+" aria-describedby="[^"]+"/);
    expect(html).toMatch(/id="[^"]+">Bankrot</);
    expect(fieldText(html, 'text')).toBe('Hotovosť zostala záporná 30 dní po sebe. Banka zablokovala účet prístavu.');
    expect(bankruptcyText(45)).toContain('45 dní');
  });

  it('štatistiky: prežité dni, kontrakty, XP s oddeľovačom tisícov', () => {
    const html = render();
    expect(fieldText(html, 'days')).toBe('142');
    expect(fieldText(html, 'contracts')).toBe('87');
    expect(fieldText(html, 'xp')).toBe('12,340 XP');
  });

  it('tlačidlo Nová hra je hlavné; s onLoadGame pribudne „Načítať" a Nová hra je sekundárne', () => {
    const plain = render();
    expect(plain).toMatch(/game-over__btn--primary"[^>]*data-action="new-game"/);
    expect(plain).not.toContain('data-action="load"');
    const withLoad = render({ onLoadGame: vi.fn() });
    expect(withLoad).toContain('data-action="load"');
    expect(withLoad).toMatch(/game-over__btn--secondary"[^>]*data-action="new-game"/);
  });
});

describe('game-over-modal.css', () => {
  const css = loadCss('src/ui/game-over-modal.css');

  it('len tokeny a jediné pevné px sú 1 px a 2 px', () => {
    expect(css.source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css.source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
    const pixels = new Set([...css.source.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g)].map((match) => match[0]));
    expect([...pixels].sort()).toEqual(['1px', '2px']);
    for (const name of css.usedProperties()) {
      if (css.localProperties().has(name)) continue;
      expect(TOKENS_CSS, `token ${name}`).toContain(`${name}:`);
    }
  });

  it('dialóg: danger obrys, čísla tabular-nums, tlačidlo s focus ringom', () => {
    expect(css.ruleBody('.game-over__dialog')).toMatch(/border:\s*1px solid var\(--ui-danger\)/);
    expect(css.ruleBody('.game-over')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(css.ruleBody('.game-over__btn:focus-visible')).toMatch(/outline:\s*2px solid var\(--ui-accent\)/);
    expect(css.source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
