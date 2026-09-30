/**
 * Typy terénu (ARCHITECTURE §5.1) a ich znaky v mape (§4.7). Terén je statický — hráč ho nemení (GDD princíp 2).
 *
 * Vlastnosti terénu sú tabuľka (`TERRAIN_TRAITS`), nie `switch`: pravidlá, ktoré sa pýtajú „je to voda?“ alebo
 * „dá sa tu postaviť cesta?“, čítajú jedno miesto (CLAUDE.md, pravidlo 7).
 */

/** Všetky typy terénu v pevnom poradí (§5.1). */
export const TERRAIN_TYPES = ['deep_water', 'shallow_water', 'quay', 'land', 'blocked'] as const;

export type TerrainType = (typeof TERRAIN_TYPES)[number];

export interface TerrainTraits {
  /** Znak v `MapDef.terrain` (§4.7). */
  readonly char: string;
  /** Hlboká alebo plytká voda — plavba lodí, `seaLane`, `anchorage`; nikdy cesta ani modul na súši. */
  readonly water: boolean;
  /** Dá sa tu položiť vrstva dopravy — cesta aj koľaj (`Cell.road`, ADR-006): pevnina a nábrežie, nie voda ani `blocked`. */
  readonly roadBuildable: boolean;
}

/** Vlastnosti každého typu terénu (§4.7 legenda znakov, §5.1, ADR-006). */
export const TERRAIN_TRAITS: Readonly<Record<TerrainType, TerrainTraits>> = Object.freeze({
  deep_water: Object.freeze({ char: '~', water: true, roadBuildable: false }),
  shallow_water: Object.freeze({ char: '=', water: true, roadBuildable: false }),
  quay: Object.freeze({ char: 'Q', water: false, roadBuildable: true }),
  land: Object.freeze({ char: '.', water: false, roadBuildable: true }),
  blocked: Object.freeze({ char: '#', water: false, roadBuildable: false }),
});

/** Spätná tabuľka znak → terén, odvodená z `TERRAIN_TRAITS` (jediný zdroj pravdy). */
const TERRAIN_BY_CHAR: ReadonlyMap<string, TerrainType> = new Map(
  TERRAIN_TYPES.map((terrain) => [TERRAIN_TRAITS[terrain].char, terrain] as const),
);

/** Terén pre znak mapy; neznámy znak → `undefined` (loader mapy z toho spraví `MapError`). */
export function terrainFromChar(char: string): TerrainType | undefined {
  return TERRAIN_BY_CHAR.get(char);
}

/** Hlboká alebo plytká voda. */
export function isWater(terrain: TerrainType): boolean {
  return TERRAIN_TRAITS[terrain].water;
}

/** Terén unesie cestu alebo koľaj (pevnina, nábrežie). Ostatné pravidlá stavby (modul, parcela) sú v príkazoch. */
export function isRoadBuildable(terrain: TerrainType): boolean {
  return TERRAIN_TRAITS[terrain].roadBuildable;
}
