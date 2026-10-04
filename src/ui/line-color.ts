/**
 * Farby námorných liniek (F6c, ADR-034) pre prezentáciu: `lines.json` nesie len **názov tokenu** (`line-blue`), farbu
 * určuje `design/tokens.css`. Token `--line-*` pridáva render (T6C-04); kým v `tokens.css` nie je, použije sa najbližší
 * existujúci token (`LINE_TOKEN_FALLBACK`), takže UI nikdy nenesie pevnú farbu a po zlúčení preberie farbu z tokenu bez zásahu.
 * Výsledok je hodnota CSS (`var(--line-blue, var(--ui-accent))`) pre vlastnú vlastnosť nastavenú inline (`--line-color`).
 */
import type { CSSProperties } from 'react';

/** Najbližší existujúci token pre token linky (modrá / jantárová / tyrkysová). Neznámy token → `LINE_TOKEN_DEFAULT_FALLBACK`. */
export const LINE_TOKEN_FALLBACK: Readonly<Record<string, string>> = Object.freeze({
  'line-blue': 'ui-accent',
  'line-amber': 'ui-warning',
  'line-teal': 'cargo-gas',
});

/** Náhradný token pre linku, ktorej token nepoznáme. */
export const LINE_TOKEN_DEFAULT_FALLBACK = 'ui-text-2';

/** Názov tokenu je len `[a-z0-9-]` (do CSS sa nikdy nedostane iný reťazec než názov vlastnosti). */
const TOKEN_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Hodnota farby linky pre CSS: `var(--<token>, var(--<náhrada>))`; nevhodný názov tokenu → len náhrada. */
export function lineColor(colorToken: string): string {
  const fallback = `var(--${LINE_TOKEN_FALLBACK[colorToken] ?? LINE_TOKEN_DEFAULT_FALLBACK})`;
  return TOKEN_NAME.test(colorToken) ? `var(--${colorToken}, ${fallback})` : fallback;
}

/** Inline štýl s farbou linky v premennej `--line-color` (odznak linky na karte kontraktu, riadky depa). */
export function lineStyle(colorToken: string): CSSProperties {
  return { '--line-color': lineColor(colorToken) } as CSSProperties;
}
