/**
 * Metriky skladov so stohmi (ADR-039 bod 6): `rehandles` (presuny kontajnerov nad cieľom), `rehandleStalls` (joby zrušené pre rehandling bez cieľa, TR2-06b), `moves` (výbery zo skladu = Σ `unitsOut`),
 * `rehandlesPerMove` (`rehandles / moves`, bez výberov `null`) a `yardTeuUsedPct` (obsadené TEU z kapacity všetkých blokov). Čistý dotaz nad modulmi.
 */
import { YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';

export interface YardMetrics {
  readonly rehandles: number;
  /** Joby zrušené, lebo rehandling nenašiel cieľ v bloku do `rehandleGiveUpTicks` (vozidlo sa uvoľnilo); zdravý beh má 0. */
  readonly rehandleStalls: number;
  readonly moves: number;
  readonly rehandlesPerMove: number | null;
  readonly usedTeu: number;
  readonly capacityTeu: number;
  /** Obsadené TEU v percentách kapacity všetkých blokov (0 bez blokov). */
  readonly yardTeuUsedPct: number;
}

const PERCENT = 100;

export function yardMetrics(world: Pick<World, 'modules'>): YardMetrics {
  let rehandles = 0;
  let rehandleStalls = 0;
  let moves = 0;
  let usedTeu = 0;
  let capacityTeu = 0;
  for (const module of world.modules.values()) {
    if (!(module instanceof YardBlock)) continue;
    rehandles += module.rehandles;
    rehandleStalls += module.rehandleStalls;
    moves += module.unitsOut;
    usedTeu += module.usedTeu;
    capacityTeu += module.capacityTeu;
  }
  return { rehandles, rehandleStalls, moves, rehandlesPerMove: moves === 0 ? null : rehandles / moves, usedTeu, capacityTeu, yardTeuUsedPct: capacityTeu === 0 ? 0 : (usedTeu * PERCENT) / capacityTeu };
}
