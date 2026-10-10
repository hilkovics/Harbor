/**
 * Metriky železnice (R6, ADR-043 TR6-02): čistý dotaz nad svetom, počítadlá sú v `Rail.counters` (save).
 *
 * - `railImportSharePct` = jednotky importu, ktoré odišli vlakom / všetky jednotky importu, ktoré opustili prístav (vlakom aj kamiónom; `ImportContract.unitsExported`) × 100; bez odvozu `null`;
 * - `trainDelayMin` = priemerné oneskorenie príchodu vlaka oproti cestovnému poriadku (herné minúty); bez vlakov `null`;
 * - `trainTurnaroundMin` = priemerný obrat vlaka (vznik na portáli → odchod cez portál, herné minúty); bez odídeného vlaka `null`.
 */
import type { World } from '../world/world';

export interface RailMetrics {
  readonly trainsSpawned: number;
  readonly trainsDeparted: number;
  readonly importUnitsByTrain: number;
  readonly importUnitsExported: number;
  readonly railImportSharePct: number | null;
  readonly trainDelayMin: number | null;
  readonly trainTurnaroundMin: number | null;
}

const PERCENT = 100;

export function railMetrics(world: Pick<World, 'rail' | 'clock' | 'contractBook'>): RailMetrics {
  const { counters } = world.rail;
  let exported = 0;
  for (const contract of world.contractBook.contracts.values()) if (contract.kind === 'import') exported += contract.unitsExported;
  const { ticksPerMinute } = world.clock;
  return {
    trainsSpawned: counters.trainsSpawned,
    trainsDeparted: counters.trainsDeparted,
    importUnitsByTrain: counters.importUnitsByTrain,
    importUnitsExported: exported,
    railImportSharePct: exported === 0 ? null : (counters.importUnitsByTrain * PERCENT) / exported,
    trainDelayMin: counters.trainsSpawned === 0 ? null : counters.delayTicksTotal / counters.trainsSpawned / ticksPerMinute,
    trainTurnaroundMin: counters.trainsDeparted === 0 ? null : counters.turnaroundTicksTotal / counters.trainsDeparted / ticksPerMinute,
  };
}
