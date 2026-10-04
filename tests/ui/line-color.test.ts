// T6C-05 / T6C-06a: farby liniek z tokenu (`lines.json` → `colorToken`); tokeny `--line-*` sú v design/tokens.css (T6C-04), takže
// UI nemá per-token náhrady, len neutrálnu pre neznámy token.
import { describe, expect, it } from 'vitest';
import * as lineColorModule from '@ui/line-color';
import { LINE_TOKEN_DEFAULT_FALLBACK, lineColor, lineStyle } from '@ui/line-color';
import linesJson from '@data/defs/lines.json';
import { TOKENS_CSS } from './css-guard';

describe('lineColor', () => {
  it('token linky z lines.json s neutrálnou náhradou; bez tabuľky náhrad za iné tokeny', () => {
    expect(lineColor('line-blue')).toBe('var(--line-blue, var(--ui-text-2))');
    expect(lineColor('line-amber')).toBe('var(--line-amber, var(--ui-text-2))');
    expect(lineColor('line-teal')).toBe('var(--line-teal, var(--ui-text-2))');
    expect(lineColorModule).not.toHaveProperty('LINE_TOKEN_FALLBACK');
  });

  it('každá linka z lines.json má token `--<colorToken>` v design/tokens.css a neutrálna náhrada je definovaná tiež', () => {
    for (const line of linesJson.items) expect(TOKENS_CSS, line.id).toMatch(new RegExp(`--${line.colorToken}:\\s*#`));
    expect(TOKENS_CSS).toContain(`--${LINE_TOKEN_DEFAULT_FALLBACK}:`);
  });

  it('neznámy token (platný názov) má predvolenú náhradu textu', () => {
    expect(lineColor('line-pink')).toBe('var(--line-pink, var(--ui-text-2))');
  });

  it('nevhodný názov tokenu sa do CSS nedostane — len náhradná farba', () => {
    for (const bad of ['', 'Line Blue', 'line-blue;}', 'x); color: red', '--line-blue', 'url(javascript:1)']) {
      expect(lineColor(bad), bad).toBe('var(--ui-text-2)');
    }
  });
});

describe('lineStyle', () => {
  it('inline štýl nastaví premennú `--line-color` (jedinú), ktorú číta CSS komponentov', () => {
    expect(lineStyle('line-blue')).toEqual({ '--line-color': 'var(--line-blue, var(--ui-text-2))' });
  });
});
