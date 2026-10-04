/**
 * Typy ciest (docs/tasks/phase-03.md „Doplnok od používateľa" rozhodnutie 12; ADR-020). Typ je vlastnosť bunky
 * s `road === 'road'` (`Cell.roadKind`), nie nová vrstva — cesta ostáva vrstvou bunky (ADR-006).
 *
 * - `two_lane` — obojsmerná dvojpruhová (štartové cesty mapy a predvolený typ `PlaceRoad`), vozidlo jazdí v pravom pruhu.
 * - `one_lane` — obojsmerná jednopruhová (úzka, lacnejšia a pomalšia), vozidlo jazdí stredom.
 * - `one_way` — jednosmerná jednopruhová (úzka), vozidlo jazdí stredom; bunka má smer `Cell.roadDir`.
 *
 * Správanie typu je tabuľka `ROAD_KIND_TRAITS` (nie `switch`, CLAUDE.md pravidlo 7); laditeľné čísla (cena za bunku,
 * `speedFactor`) sú v `infrastructure.json → roadKinds` (pravidlo 4). Pruh je len prezentácia (rozhodnutie 11):
 * sim modeluje cestu ako graf buniek a vozidlo ide stredom bunky; `lanes` hovorí rendereru, či posunúť vozidlo
 * do pravého pruhu. Tento modul nič neimportuje (hodnoty z neho číta aj `grid.ts`).
 */

/** Typy ciest v pevnom poradí (poradie kľúčov `infrastructure.json → roadKinds`). */
export const ROAD_KINDS = ['two_lane', 'one_lane', 'one_way'] as const;

export type RoadKind = (typeof ROAD_KINDS)[number];

/**
 * Typ bunky bez udaného typu: `PlaceRoad` bez `kind`, štartové cesty mapy, cesta v save bez typu a bunka bez cesty
 * (normalizovaný stav, ktorý stráži krok 12).
 */
export const DEFAULT_ROAD_KIND: RoadKind = 'two_lane';

/** Pevné (neladiteľné) vlastnosti typu cesty. */
export interface RoadKindTraits {
  /**
   * Počet jazdných pruhov na bunke (prezentácia, rozhodnutie 11): 2 = vozidlo v pravom pruhu (pravostranná premávka),
   * 1 = vozidlo stredom. Sim ho nepoužíva — vozidlo v sime ide vždy stredom bunky.
   */
  readonly lanes: 1 | 2;
  /**
   * Jednosmerná bunka: má smer `Cell.roadDir` a prechody cez ňu obmedzuje `isRoadStepAllowed` (road-direction.ts).
   * Ostatné typy majú `roadDir === null`.
   */
  readonly oneWay: boolean;
}

export const ROAD_KIND_TRAITS: Readonly<Record<RoadKind, RoadKindTraits>> = Object.freeze({
  two_lane: Object.freeze({ lanes: 2, oneWay: false }),
  one_lane: Object.freeze({ lanes: 1, oneWay: false }),
  one_way: Object.freeze({ lanes: 1, oneWay: true }),
});

/** Je hodnota jeden z typov ciest (napr. `kind` v JSON príkaze alebo v save)? */
export function isRoadKind(value: unknown): value is RoadKind {
  return (ROAD_KINDS as readonly unknown[]).includes(value);
}
