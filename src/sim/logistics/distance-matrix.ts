/**
 * DistanceMatrix — lazy matica cien ciest medzi bunkami (ARCHITECTURE §7.3 bod 1, §7.4; rozhodnutie orchestrátora
 * F3 č. 5 a 6). Uzly sú vonkajšie bunky konektorov modulov (`World.connectorCells`) a polohy vozidiel; hodnota sa
 * spočíta pri prvom dotaze a pamätá sa do zmeny `roadVersion`.
 *
 * Cena = `Pathfinder.routeCost` cesty z `PathCache` (review T03-13, ADR-021): tá istá postupnosť sčítaní ako `g` v A*,
 * takže výsledok je bitovo rovný `findCost` (ADR-020), a dvojicu, ktorú dispatcher zmeria a vozidlo potom prejde
 * (bunka vozidla → prístupová bunka zdroja, apron → sklad), hľadá po zmene ciest **jeden** A* namiesto dvoch.
 *
 * Vzdialenosť = cena najlacnejšej cesty (`unitCellCost` → počet krokov = dĺžka cesty − 1; vo svete 1 / `speedFactor`
 * typu cesty za bunku, ADR-020), bez cesty `Infinity`. Dvojica je usporiadaná (`from → to`): jednosmerky, cena podľa
 * cieľovej bunky (typ cesty, penalizácia F11) ju robia nesymetrickou.
 * Rovnako ako `PathCache` je to čisté memo — nie je stav simulácie a do save nepatrí.
 */
import type { CacheDiagnostics, PathCache, RoadVersionSource } from './path-cache';
import { RoadPairMemo } from './path-cache';

export class DistanceMatrix {
  private readonly memo: RoadPairMemo<number>;
  private readonly compute: (from: number, to: number) => number;

  /**
   * @param paths cache ciest sveta (cena sa počíta z jej ciest jej `pathfinder`-om)
   * @param roads zdroj `roadVersion` (svet)
   */
  constructor(paths: PathCache, roads: RoadVersionSource) {
    const { pathfinder } = paths;
    this.memo = new RoadPairMemo(pathfinder.cellCount, roads, 'DistanceMatrix.distance');
    this.compute = (from, to) => {
      const path = paths.get(from, to);
      return path === null ? Infinity : pathfinder.routeCost(path);
    };
  }

  /** Cena cesty z `from` do `to` (0 pre tú istú cestnú bunku, `Infinity` bez cesty). Index mimo mriežky → `RangeError`. */
  distance(from: number, to: number): number {
    return this.memo.get(from, to, this.compute);
  }

  diagnostics(): CacheDiagnostics {
    return this.memo.diagnostics();
  }
}
