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
import type { ContractId } from '../core/entity-id';

/** Čítanie kontraktov (`ContractBook.get`). */
export interface ContractLookup {
  get(id: ContractId): Contract | undefined;
}

/** Test „jednotka na docku čaká na kamión" (`DockStaging`, `ModuleInit.pickupCargo`). */
export type PickupCargoTest = (unit: CargoUnit) => boolean;

/**
 * Je jednotka `at_ramp` náklad na odvoz kamiónom? Import vždy; export, kým jeho booking beží (`outbound === 'held'`),
 * nie — čaká na vozidlo do skladu. Jednotka bez kontraktu alebo s kontraktom mimo knihy sa odváža (ako vo F4).
 */
export function isPickupCargo(contracts: ContractLookup, unit: CargoUnit): boolean {
  if (unit.direction === 'import' || unit.contractId === null) return true;
  const contract = contracts.get(unit.contractId);
  return contract === undefined || contract.outbound !== 'held';
}
