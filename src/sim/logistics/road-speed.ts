/**
 * Rýchlosť a cena buniek podľa typu cesty (ARCHITECTURE §7.4, §7.6; docs/tasks/phase-03.md rozhodnutie 12; ADR-020).
 *
 * - **Rýchlostný faktor** úseku `A → B` = `speedFactor` typu **cieľovej** bunky `B` (`speedFactor`), takže vozidlo
 *   na úseku do jednopruhovej bunky ide `speedCellsPerTick × 0,7`.
 * - **Cena vstupu** do bunky v A* = `BASE_CELL_COST / speedFactor` (`cellCost`) — rovnaká bunka ako pri rýchlosti,
 *   preto cena cesty = čas jazdy × `speedCellsPerTick` (presne až na prenos zvyšku kroku medzi úsekmi) a A* hľadá
 *   najrýchlejšiu cestu. `speedFactor ≤ 1` (schéma, `DefRegistry`) drží cenu ≥ `BASE_CELL_COST`.
 * Hodnoty sa predpočítajú raz z defu do tabuľky podľa typu; funkcie sú polia so šípkami (odovzdávajú sa bez `bind`
 * a bez alokácie na volanie). Pri dvojpruhovej ceste (`speedFactor` 1) je cena presne 1 a faktor presne 1, takže siete
 * bez nových typov dávajú bitovo rovnaké cesty aj pohyb ako pred T03-18.
 */
import type { RoadKindDef } from '../defs/types';
import { ROAD_KINDS, type RoadKind } from '../grid/road-kind';
import { BASE_CELL_COST, type CellCostFn, type RoadGraph } from './pathfinder';

/** Rýchlostný faktor bunky s daným indexom (násobok `speedCellsPerTick` na úseku, ktorý do nej vchádza). */
export type SpeedFactorFn = (index: number) => number;

/** Faktor bez vplyvu typu cesty (testy pohybu mimo sveta). */
export const UNIT_SPEED_FACTOR: SpeedFactorFn = () => 1;

export class RoadSpeeds {
  /** `speedFactor` typu cesty bunky (pre bunku bez cesty podľa normalizovaného typu — pohyb ide len po cestách). */
  readonly speedFactor: SpeedFactorFn;
  /** Cena vstupu do bunky pre A* = `BASE_CELL_COST / speedFactor`. */
  readonly cellCost: CellCostFn;

  /**
   * @param grid mriežka sveta (typ cesty sa číta pri každom volaní — prestavba sa prejaví hneď)
   * @param kinds `infrastructure.roadKinds` (overené `DefRegistry`: `0 < speedFactor ≤ 1`)
   */
  constructor(grid: RoadGraph, kinds: Readonly<Record<RoadKind, Readonly<RoadKindDef>>>) {
    const factors = {} as Record<RoadKind, number>;
    const costs = {} as Record<RoadKind, number>;
    for (const kind of ROAD_KINDS) {
      const factor = kinds[kind].speedFactor;
      if (!(factor > 0 && factor <= 1)) throw new RangeError(`RoadSpeeds: speedFactor typu '${kind}' musí byť v (0, 1], dostal ${String(factor)}`);
      factors[kind] = factor;
      costs[kind] = BASE_CELL_COST / factor;
    }
    this.speedFactor = (index) => factors[grid.atIndex(index).roadKind];
    this.cellCost = (index) => costs[grid.atIndex(index).roadKind];
  }
}
