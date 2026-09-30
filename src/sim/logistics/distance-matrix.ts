/**
 * DistanceMatrix — lazy matica cien ciest medzi bunkami (ARCHITECTURE §7.3 bod 1, §7.4; rozhodnutie orchestrátora
 * F3 č. 5 a 6). Uzly sú vonkajšie bunky konektorov modulov (`World.connectorCells`) a polohy vozidiel; hodnota sa
 * spočíta pri prvom dotaze (`Pathfinder.findCost`, bez alokácie cesty) a pamätá sa do zmeny `roadVersion`.
 *
 * Vzdialenosť = cena najlacnejšej cesty (`unitCellCost` → počet krokov = dĺžka cesty − 1; vo svete 1 / `speedFactor`
 * typu cesty za bunku, ADR-020), bez cesty `Infinity`. Dvojica je usporiadaná (`from → to`): jednosmerky, cena podľa
 * cieľovej bunky (typ cesty, penalizácia F11) ju robia nesymetrickou.
 * Rovnako ako `PathCache` je to čisté memo — nie je stav simulácie a do save nepatrí.
 */
import type { CacheDiagnostics, RoadVersionSource } from './path-cache';
import { RoadPairMemo } from './path-cache';
import type { Pathfinder } from './pathfinder';

export class DistanceMatrix {
  private readonly memo: RoadPairMemo<number>;
  private readonly compute: (from: number, to: number) => number;

  /**
   * @param pathfinder A* nad mriežkou sveta
   * @param roads zdroj `roadVersion` (svet)
   */
  constructor(pathfinder: Pathfinder, roads: RoadVersionSource) {
    this.memo = new RoadPairMemo(pathfinder.cellCount, roads, 'DistanceMatrix.distance');
    this.compute = (from, to) => pathfinder.findCost(from, to);
  }

  /** Cena cesty z `from` do `to` (0 pre tú istú cestnú bunku, `Infinity` bez cesty). Index mimo mriežky → `RangeError`. */
  distance(from: number, to: number): number {
    return this.memo.get(from, to, this.compute);
  }

  diagnostics(): CacheDiagnostics {
    return this.memo.diagnostics();
  }
}
