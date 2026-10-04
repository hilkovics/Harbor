// Spoločné pomôcky strážcov štýlu (DESIGN_BRIEF §6.4): načítanie CSS bez komentárov, telo pravidla podľa selektora
// a zoznam použitých/lokálne definovaných custom properties. Používajú ich tests/ui/*-css.test.ts.
import { readFileSync } from 'node:fs';

/** Obsah `design/tokens.css` (zdroj pravdy pre `--*` premenné). */
export const TOKENS_CSS = readFileSync(new URL('../../design/tokens.css', import.meta.url), 'utf8');

export interface CssFile {
  /** Zdroj bez komentárov (komentáre smú spomenúť hex farby či px). */
  readonly source: string;
  /** Telo prvého pravidla, ktorého selektor presne zodpovedá `selector` (chýbajúce pravidlo = chyba testu). */
  ruleBody(selector: string): string;
  /** Premenné `--x` definované lokálne v súbore. */
  localProperties(): Set<string>;
  /** Premenné `--x` použité cez `var(--x)`. */
  usedProperties(): Set<string>;
}

export function loadCss(relativePath: string): CssFile {
  const raw = readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  return {
    source,
    ruleBody(selector: string): string {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(source);
      if (match === null) throw new Error(`Pravidlo '${selector}' sa nenašlo v ${relativePath}`);
      return match[1] ?? '';
    },
    localProperties: () => new Set([...source.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string)),
    usedProperties: () => new Set([...source.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1] as string)),
  };
}
