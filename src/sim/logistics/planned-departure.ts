/**
 * Plánovaný čas odchodu jednotky zo skladu (`plannedDepartureTick`, ADR-039 bod 8) — odvodená hodnota (nie je v save): čistá funkcia
 * štítkov jednotky, kontraktov a hodín, takže obnovený svet plánuje rovnako ako pôvodný. Plánovač stohov (`yard-planner.ts`) podľa nej ukladá
 * skôr odchádzajúce navrch.
 *
 * - **export:** príchod lode voyage + poradie stowage (`STOWAGE_WEIGHT_RANK`, ťažké skôr);
 * - **prekládka:** príchod lode B (`outArrivalTick`), kým nie je známy, `Infinity`;
 * - **import:** odhad `shipArrivalTick + logistics.importDwellEstimateHours`, obmedzený SLA (skutočné termíny odvozu prídu v R4); jednotky jedného
 *   príchodu sa líšia poradím vykládky (id), preto menšie id odchádza skôr;
 * - **prázdne:** `Infinity` (FIFO podľa linky);
 * - jednotka, ktorá už má job zo skladu, odchádza teraz.
 */
import { STOWAGE_WEIGHT_RANK } from '../cargo/stowage';
import type { CargoUnit } from '../cargo/cargo-unit';
import { TranshipContract } from '../contracts/contract';
import type { World } from '../world/world';

/**
 * Váha id jednotky v čase odchodu importu (poradie vykládky): tak malá, aby nikdy neprekročila rozdiel jedného ticku pri rozumnom počte jednotiek —
 * len usporiada jednotky s rovnakým odhadom.
 */
export const IMPORT_ORDER_TICKS_PER_ID = 1e-6;

/** Plánovaný odchod jednotky (tick herných hodín; `Infinity` = bez termínu). */
export function plannedDepartureTick(world: Pick<World, 'clock' | 'contractBook' | 'defs' | 'jobOfUnit'>, unit: CargoUnit): number {
  const job = world.jobOfUnit(unit.id);
  if (job !== undefined && job.from.kind === 'in_storage') return world.clock.tick;
  const contract = unit.contractId === null ? undefined : world.contractBook.get(unit.contractId);
  switch (unit.direction) {
    case 'export': {
      const arrival = unit.voyageId === null ? undefined : contract?.arrivalOnVoyage(unit.voyageId);
      return arrival === undefined ? Infinity : arrival + STOWAGE_WEIGHT_RANK[unit.weightClass];
    }
    case 'tranship':
      return contract instanceof TranshipContract ? (contract.arrivalOnVoyage(contract.outVoyageId) ?? Infinity) : Infinity;
    case 'import': {
      const arrival = contract?.shipArrivalTick;
      if (arrival === undefined) return Infinity;
      const estimate = arrival + world.defs.logistics.importDwellEstimateHours * world.clock.ticksPerHour;
      return Math.min(estimate, contract?.slaDeadlineTick ?? Infinity) + unit.id * IMPORT_ORDER_TICKS_PER_ID;
    }
    case 'empty':
      return Infinity;
  }
}
