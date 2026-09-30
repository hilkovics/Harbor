/**
 * Výsledok validácie príkazu (CLAUDE.md, pravidlo 5; ARCHITECTURE §12.2). UI volá `validate` na živý ghost
 * a `World` ho volá znova tesne pred `apply` (stav sa medzitým mohol zmeniť).
 */
import type { CellCoord } from '../grid/grid';

/**
 * Dôvody odmietnutia príkazu. Poradie je kanonické — výsledok validácie ich vracia v tomto poradí (`orderReasons`).
 * F1: prvých osem; F2 (docs/tasks/phase-02.md „Spoločné rozhrania", ADR-015): moduly (`PlaceModule`, `RemoveModule`)
 * a ladiaca loď (`SpawnShipDebug`, T02-05). Nový dôvod = nový riadok tu + slovenský popis v UI (`REASON_TEXT`).
 */
export const VALIDATION_REASONS = [
  'out_of_bounds',
  'terrain',
  'occupied',
  'parcel_not_owned',
  'insufficient_funds',
  'no_road',
  'invalid_speed',
  'empty',
  /** `PlaceModule`: def s daným id v `modules.json` nie je. */
  'unknown_def',
  /** Kotvisko: bunka hrany pri vode (`waterSide` po rotácii) nesusedí s vodou. */
  'no_water_side',
  /** Kotvisko: pás `frontWaterCells` pred hranou nie je celý voľná voda v mape (modul, pás iného kotviska, okraj). */
  'water_blocked',
  /** Žeriav: footprint neleží celý na jednom kotvisku. */
  'no_berth',
  /** Žeriav: rotácia sa líši od rotácie kotviska. */
  'rotation_mismatch',
  /** Žeriav: kotvisko už má `maxCranes` žeriavov. */
  'max_cranes',
  /** `RemoveModule`: na kotvisku stoja žeriavy. */
  'has_cranes',
  /** `RemoveModule`: modul drží náklad alebo má obsadený/rezervovaný slot. */
  'has_cargo',
  /** `RemoveModule`: pri kotvisku (aj pri kotvisku pod žeriavom) kotví loď alebo k nemu pláva (`berthing`/`docked`). */
  'ship_docked',
  /** `RemoveModule`: žeriav je uprostred cyklu. */
  'busy',
  /** `RemoveModule`: modul s daným id neexistuje. */
  'unknown_module',
  /** `SpawnShipDebug` (T02-05): neznáma trieda lode. */
  'unknown_ship_class',
  /** `SpawnShipDebug` (T02-05): neznámy typ nákladu. */
  'unknown_cargo',
  /** `SpawnShipDebug` (T02-05): loď daný náklad neprevezie (kategória). */
  'cargo_incompatible',
  /** `SpawnShipDebug` (T02-05): počet jednotiek mimo rozsahu. */
  'invalid_units',
  /** `PlaceModule`: rotácia mimo 0, 90, 180, 270. */
  'invalid_rotation',
] as const;

export type ValidationReason = (typeof VALIDATION_REASONS)[number];

export interface ValidationResult {
  /** `true` = príkaz možno aplikovať; `false` = `reasons` je neprázdne a `apply` sa nesmie zavolať. */
  readonly ok: boolean;
  /** Dôvody odmietnutia (bez duplicít); pri `ok === true` prázdne. */
  readonly reasons: readonly ValidationReason[];
  /**
   * Bunky, na ktoré sa výsledok vzťahuje (ghost v UI ich zafarbí); príkazy bez buniek vracajú prázdne pole.
   * Príkazy nad vrstvou dopravy (`RoadLayerCommand`): unikátne bunky, ktoré `apply` zmení, v poradí prvého výskytu
   * (pri odmietnutí tie, ktoré by samy prešli) — bunky už v cieľovom stave ani neplatné bunky tu nie sú.
   * `PlaceModule`: celý footprint po rotácii row-major (aj pri odmietnutí a aj bunky mimo mapy; `[]` pri `unknown_def`
   * alebo `invalid_rotation`). `RemoveModule`: footprint modulu (`[]` pri `unknown_module`). ADR-015.
   */
  readonly cells: readonly CellCoord[];
  /**
   * Cena príkazu v centoch (USD), ktorú by `apply` strhol z hotovosti; 0 = zadarmo, záporná = príjem
   * (napr. refundácia `RemoveRoad`, ADR-012). Cesty: pri odmietnutí cena platnej časti (`cells`). `PlaceModule`:
   * `def.costCents` aj pri odmietnutí (0 pri `unknown_def`); `RemoveModule`: −refundácia zo zaplatenej ceny (ADR-015).
   */
  readonly costCents: number;
}

/** Dôvody z množiny v kanonickom poradí `VALIDATION_REASONS` (deterministické, bez duplicít), zmrazené. */
export function orderReasons(found: ReadonlySet<ValidationReason>): readonly ValidationReason[] {
  return Object.freeze(VALIDATION_REASONS.filter((reason) => found.has(reason)));
}
