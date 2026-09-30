/**
 * Stav zaplnenia skladu pre sprite (DESIGN_BRIEF §4 „Zaplnenie skladov“): päť samostatných SVG `fill00…fill100`
 * (`sprites.<defId>.states` v manifeste). Čistá funkcia bez Pixi, aby sa dala tabuľkovo testovať v Node.
 *
 * Pravidlo (docs/tasks/phase-03.md, „Render view-modely“): `stored === 0` → 0; `stored >= capacity` → 100; inak podľa
 * pomeru `stored / capacity`: pod `FILL_25_BELOW` → 25, pod `FILL_50_BELOW` → 50, inak 75. Rezervácie sa nerátajú —
 * sprite ukazuje, čo v sklade fyzicky stojí (princíp „nič sa neteleportuje“).
 */

/** Stav zaplnenia = percentá zodpovedajúceho spritu. */
export type FillState = 0 | 25 | 50 | 75 | 100;

/** Všetky stavy vzostupne. */
export const FILL_STATES: readonly FillState[] = Object.freeze([0, 25, 50, 75, 100] as const);

/** Pomer, pod ktorým (a nad nulou) ukazuje sklad stav 25. */
export const FILL_25_BELOW = 0.375;

/** Pomer, pod ktorým ukazuje sklad stav 50; od neho vyššie (po plný sklad) 75. */
export const FILL_50_BELOW = 0.625;

/** Kľúč stavu v `sprites.<defId>.states` (manifest: `fill00`, `fill25`, `fill50`, `fill75`, `fill100`). */
const FILL_KEYS: Readonly<Record<FillState, string>> = { 0: 'fill00', 25: 'fill25', 50: 'fill50', 75: 'fill75', 100: 'fill100' };

/** Stav zaplnenia pre `stored` jednotiek v sklade s kapacitou `capacity`. Záporné a nečíselné `stored` sa berie ako prázdny sklad. */
export function fillState(stored: number, capacity: number): FillState {
  if (!(stored > 0)) return 0;
  if (!(stored < capacity)) return 100; // vrátane nulovej kapacity s nákladom
  const ratio = stored / capacity;
  if (ratio < FILL_25_BELOW) return 25;
  if (ratio < FILL_50_BELOW) return 50;
  return 75;
}

/** Kľúč spritu v manifeste pre stav zaplnenia. */
export function fillStateKey(state: FillState): string {
  return FILL_KEYS[state];
}
