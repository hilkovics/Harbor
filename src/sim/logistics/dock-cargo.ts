/**
 * Čo na docku rampy čaká na kamión (ADR-032 bod 13): jednotka `at_ramp` je buď **náklad na odvoz** (pickup — import,
 * alebo export vrátený odosielateľovi po uzavretí bookingu; počíta sa do pripravených jednotiek docku, nárokov kamiónov
 * a nakládky), alebo **export na prijatie** (jednotku práve vyložil kamión s exportom a čaká na vozidlo do skladu
 * — `Contract.outbound === 'held'`, kým booking beží). Pripravené jednotky docku a `LoadingRamp.firstUnitAt` počítajú
 * len náklad na odvoz; kapacita docku (staging miesta) počíta oboje.
 *
 * Rozhodnutie je odvodené z kontraktu jednotky (nie z novej polohy ani štítku) — rovnaké pre originál aj obnovený svet.
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import type { Contract } from '../contracts/contract';
import type { ContractId, EntityId } from '../core/entity-id';

/** Čítanie kontraktov (`ContractBook.get`). */
export interface ContractLookup {
  get(id: ContractId): Contract | undefined;
}

/** Test „jednotka na docku čaká na kamión" (`DockStaging`, `ModuleInit.pickupCargo`). */
export type PickupCargoTest = (unit: CargoUnit) => boolean;

/** Má jednotka aktívny job (`World.jobOfUnit`)? Bez nej (predvolene) sa job nezohľadňuje. */
export type HasJobTest = (unitId: EntityId) => boolean;

const NO_JOB: HasJobTest = () => false;

/**
 * Je jednotka `at_ramp` náklad na odvoz kamiónom? Import vždy; export, kým jeho booking beží (`outbound === 'held'`),
 * nie — čaká na vozidlo do skladu. Export s aktívnym jobom (`hasJob`, napr. `at_ramp → in_storage` rozbehnutý pred uzavretím
 * bookingu) nie je náklad na odvoz ani po uzavretí bookingu — dock ho odvezie vozidlo, takže naň nesmie mať nárok pickup kamión
 * (T6A-09b). Jednotka bez kontraktu alebo s kontraktom mimo knihy sa odváža (ako vo F4).
 */
export function isPickupCargo(contracts: ContractLookup, unit: CargoUnit, hasJob: HasJobTest = NO_JOB): boolean {
  if (unit.direction === 'import' || unit.contractId === null) return true;
  const contract = contracts.get(unit.contractId);
  if (contract !== undefined && contract.outbound === 'held') return false;
  return !hasJob(unit.id);
}
