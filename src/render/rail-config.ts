/**
 * Konfigurácia kreslenia koľají (R6): polomer veľkých oblúkov a rozmery procedurálnej koľaje.
 * Geometria zodpovedá spritom `assets/infra/rail_straight.svg` (64 px = 1 bunka), farby idú z tokenov (`--rail-base`, `--rail-tie`).
 */

/** Polomer oblúka zákruty v bunkách; na jednotlivej zákrute sa orežie podľa voľného rovného úseku (`rail-path.ts`). */
export const RAIL_CURVE_RADIUS_CELLS = 3;

/** Oblúk s dotyčnicou nanajvýš takou dlhou ako tesný sprite `rail_corner` (polomer 0,5 bunky) sa kreslí spritom. */
export const RAIL_TIGHT_RADIUS_CELLS = 0.5;

/** Px zdrojového sprite na bunku. */
const SPRITE_CELL_PX = 64;

/** Šírka podložky (štrk): sprite x 10–54. */
export const RAIL_BED_WIDTH_CELLS = 44 / SPRITE_CELL_PX;
/** Dĺžka pražca (kolmo na koľaj) a jeho hrúbka. */
export const RAIL_TIE_LENGTH_CELLS = 36 / SPRITE_CELL_PX;
export const RAIL_TIE_THICKNESS_CELLS = 4 / SPRITE_CELL_PX;
/** Rozstup pražcov (stred na stred) a posun prvého stredu od hrany bunky. */
export const RAIL_TIE_PITCH_CELLS = 8 / SPRITE_CELL_PX;
export const RAIL_TIE_FIRST_CELLS = 4 / SPRITE_CELL_PX;
/** Hrúbka koľajnice a vzdialenosť jej osi od osi koľaje (rozchod 19 px). */
export const RAIL_STEEL_WIDTH_CELLS = 3 / SPRITE_CELL_PX;
export const RAIL_STEEL_OFFSET_CELLS = 9.5 / SPRITE_CELL_PX;

/** Vzdialenosť „podvozkov“ od stredu vozňa (bunky): vozeň sa láme medzi nimi. */
export const BOGIE_HALF_CELLS = 1;
/** Medzera medzi vozmi (spojka), bunky. */
export const COUPLER_GAP_CELLS = 0.25;
