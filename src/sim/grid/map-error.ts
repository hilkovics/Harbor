/**
 * Chyba mapy (vzor: `DefError`). Loader mapy je fail-fast — neplatná mapa sa nikdy nedostane do `World`.
 * Správa: `<mapId><path>: <problém>`, napr. `harbor_01/parcels/1/rect: prekrýva parcelu 'starter' (/parcels/0)`.
 */
export class MapError extends Error {
  /** `MapDef.id`; ak id chýba alebo nie je reťazec, `'map'`. */
  readonly mapId: string;
  /** JSON pointer (RFC 6901) do `MapDef`, napr. `/terrain/5` alebo `/starter/roads/3`; `''` = celá mapa. */
  readonly path: string;
  readonly problem: string;

  constructor(mapId: string, path: string, problem: string) {
    super(`${mapId}${path}: ${problem}`);
    this.name = 'MapError';
    this.mapId = mapId;
    this.path = path;
    this.problem = problem;
  }
}

/** Segment JSON pointeru s escapovaním podľa RFC 6901 (`~` → `~0`, `/` → `~1`). */
export function pointerSegment(segment: string | number): string {
  return `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}
