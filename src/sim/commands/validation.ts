/**
 * Výsledok validácie príkazu (CLAUDE.md, pravidlo 5; ARCHITECTURE §12.2). UI volá `validate` na živý ghost
 * a `World` ho volá znova tesne pred `apply` (stav sa medzitým mohol zmeniť).
 */
import type { CellCoord } from '../grid/grid';

/** Dôvody odmietnutia príkazu (F1 výber; ďalšie pribudnú s ďalšími príkazmi). */
export const VALIDATION_REASONS = [
  'out_of_bounds',
  'terrain',
  'occupied',
  'parcel_not_owned',
  'insufficient_funds',
  'no_road',
  'invalid_speed',
  'empty',
] as const;

export type ValidationReason = (typeof VALIDATION_REASONS)[number];

export interface ValidationResult {
  /** `true` = príkaz možno aplikovať; `false` = `reasons` je neprázdne a `apply` sa nesmie zavolať. */
  readonly ok: boolean;
  /** Dôvody odmietnutia (bez duplicít); pri `ok === true` prázdne. */
  readonly reasons: readonly ValidationReason[];
  /** Bunky, na ktoré sa výsledok vzťahuje (ghost v UI ich zafarbí); príkazy bez buniek vracajú prázdne pole. */
  readonly cells: readonly CellCoord[];
  /** Cena príkazu v centoch (USD), ktorú by `apply` strhol z hotovosti; 0 = zadarmo. */
  readonly costCents: number;
}
