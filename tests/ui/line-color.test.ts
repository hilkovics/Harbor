// T6C-05: farby liniek z tokenu (`lines.json` → `colorToken`) s náhradou za existujúci token, kým `--line-*` nie je v tokens.css.
import { describe, expect, it } from 'vitest';
import { LINE_TOKEN_DEFAULT_FALLBACK, LINE_TOKEN_FALLBACK, lineColor, lineStyle } from '@ui/line-color';
import linesJson from '@data/defs/lines.json';
import { TOKENS_CSS } from './css-guard';

describe('lineColor', () => {
  it('token linky s náhradou za najbližší existujúci token (modrá, jantárová, tyrkysová)', () => {
    expect(lineColor('line-blue')).toBe('var(--line-blue, var(--ui-accent))');
    expect(lineColor('line-amber')).toBe('var(--line-amber, var(--ui-warning))');
    expect(lineColor('line-teal')).toBe('var(--line-teal, var(--cargo-gas))');
  });

  it('každá linka z lines.json má token v tabuľke náhrad a každá náhrada je definovaná v design/tokens.css', () => {
    for (const line of linesJson.items) expect(Object.keys(LINE_TOKEN_FALLBACK), line.id).toContain(line.colorToken);
    for (const fallback of [...Object.values(LINE_TOKEN_FALLBACK), LINE_TOKEN_DEFAULT_FALLBACK]) expect(TOKENS_CSS, fallback).toContain(`--${fallback}:`);
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
    expect(lineStyle('line-blue')).toEqual({ '--line-color': 'var(--line-blue, var(--ui-accent))' });
  });
});
