/**
 * Farby námorných liniek (F6c, ADR-034) pre prezentáciu: `lines.json` nesie len **názov tokenu** (`line-blue`), farbu určuje
 * `design/tokens.css` (`--line-blue`, `--line-amber`, `--line-teal`; T6C-04), takže UI nikdy nenesie pevnú farbu. Výsledok je
 * hodnota CSS (`var(--line-blue, var(--ui-text-2))`) pre vlastnú vlastnosť nastavenú inline (`--line-color`); neutrálna náhrada
 * platí len pre token, ktorý `tokens.css` nepozná (nová linka v `lines.json` bez farby).
 */
import type { CSSProperties } from 'react';

/** Náhradný token pre linku, ktorej token `design/tokens.css` nepozná (neutrálny text). */
export const LINE_TOKEN_DEFAULT_FALLBACK = 'ui-text-2';

/** Názov tokenu je len `[a-z0-9-]` (do CSS sa nikdy nedostane iný reťazec než názov vlastnosti). */
const TOKEN_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Hodnota farby linky pre CSS: `var(--<token>, var(--ui-text-2))`; nevhodný názov tokenu → len náhrada. */
export function lineColor(colorToken: string): string {
  const fallback = `var(--${LINE_TOKEN_DEFAULT_FALLBACK})`;
  return TOKEN_NAME.test(colorToken) ? `var(--${colorToken}, ${fallback})` : fallback;
}

/** Inline štýl s farbou linky v premennej `--line-color` (odznak linky na karte kontraktu, riadky depa). */
export function lineStyle(colorToken: string): CSSProperties {
  return { '--line-color': lineColor(colorToken) } as CSSProperties;
}
