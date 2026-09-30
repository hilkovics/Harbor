/**
 * PathCache — memo ciest `Pathfinder.findPath` (ARCHITECTURE §7.4; rozhodnutie orchestrátora F3 č. 5).
 *
 * - Kľúč = dvojica (`from`, `to`) zložená do jedného čísla `from × cellCount + to`; hodnota = zmrazená cesta alebo
 *   `null` (aj „bez cesty" sa pamätá — vozidlo v `no_path` sa pýta opakovane).
 * - **Invalidácia bez odberu udalostí:** cache si pamätá `roadVersion` zdroja (`World`), pri ktorej vznikla; pri
 *   každom dotaze ho porovná a pri zmene sa celá vyprázdni. `World.roadVersion` zvyšuje `PlaceRoad`/`RemoveRoad`
 *   (`RoadChanged`, aj prestavba typu alebo smeru cesty — ADR-020) a `World.deserialize`.
 * - Cache je čisté memo: `findPath` je deterministická funkcia ciest a dvojice buniek, takže zásah aj miss vrátia
 *   rovnakú cestu — obsah cache nie je stav simulácie a do save nepatrí.
 * - Veľkosť nie je obmedzená: kľúče vznikajú z polôh vozidiel pri plánovaní a vonkajších buniek konektorov
 *   a každá zmena ciest cache vyprázdni.
 */
import { assertCellIndex, type Pathfinder } from './pathfinder';

/** Zdroj verzie cestnej siete (`World` ho spĺňa): mení sa pri každej zmene vrstvy ciest. */
export interface RoadVersionSource {
  readonly roadVersion: number;
}

/** Počítadlá zásahov (diagnostika, testy). */
export interface CacheDiagnostics {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  /** Koľkokrát sa cache vyprázdnila pre zmenu `roadVersion`. */
  readonly invalidations: number;
}

/**
 * Spoločná logika lazy memo nad dvojicami buniek so zneplatnením podľa `roadVersion` (PathCache, DistanceMatrix).
 * `compute` sa volá len pri miss; výsledok sa uloží aj keď je „bez cesty".
 */
export class RoadPairMemo<T> {
  private readonly entries = new Map<number, T>();
  private version: number;
  private hitCount = 0;
  private missCount = 0;
  private invalidationCount = 0;

  constructor(
    private readonly cellCount: number,
    private readonly roads: RoadVersionSource,
    private readonly caller: string,
  ) {
    this.version = roads.roadVersion;
  }

  /** Hodnota pre dvojicu (`from`, `to`); pri miss ju spočíta `compute`. Index mimo mriežky → `RangeError`. */
  get(from: number, to: number, compute: (from: number, to: number) => T): T {
    assertCellIndex(from, this.cellCount, this.caller);
    assertCellIndex(to, this.cellCount, this.caller);
    this.refresh();
    const key = from * this.cellCount + to;
    if (this.entries.has(key)) {
      this.hitCount += 1;
      return this.entries.get(key) as T;
    }
    this.missCount += 1;
    const value = compute(from, to);
    this.entries.set(key, value);
    return value;
  }

  diagnostics(): CacheDiagnostics {
    this.refresh();
    return { size: this.entries.size, hits: this.hitCount, misses: this.missCount, invalidations: this.invalidationCount };
  }

  /** Pri zmene `roadVersion` zahodí všetky záznamy. */
  private refresh(): void {
    const current = this.roads.roadVersion;
    if (current === this.version) return;
    this.entries.clear();
    this.version = current;
    this.invalidationCount += 1;
  }
}

export class PathCache {
  private readonly memo: RoadPairMemo<readonly number[] | null>;
  private readonly compute: (from: number, to: number) => readonly number[] | null;

  /**
   * @param pathfinder A* nad mriežkou sveta
   * @param roads zdroj `roadVersion` (svet); cache vzniká platná pre aktuálnu verziu
   */
  constructor(pathfinder: Pathfinder, roads: RoadVersionSource) {
    this.memo = new RoadPairMemo(pathfinder.cellCount, roads, 'PathCache.get');
    this.compute = (from, to) => pathfinder.findPath(from, to);
  }

  /**
   * Cesta z `from` do `to` ako `Pathfinder.findPath` (zmrazené pole indexov vrátane oboch koncov, alebo `null`).
   * Opakovaný dotaz pri rovnakej `roadVersion` vráti **to isté** pole. Index mimo mriežky → `RangeError`.
   */
  get(from: number, to: number): readonly number[] | null {
    return this.memo.get(from, to, this.compute);
  }

  diagnostics(): CacheDiagnostics {
    return this.memo.diagnostics();
  }
}
