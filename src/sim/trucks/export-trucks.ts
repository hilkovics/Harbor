/**
 * Kamióny s exportom (F6a, ADR-032 bod 6; F6d, ADR-035): vjazd **delivery** kamiónov podľa plánu príchodov bookingov (krok 8, po výdaji prázdnych).
 * Každá položka plánu (`Contract.nextArrivalTick ≤ tick`) je kamión, ktorý čaká vo vnútrozemí (`trucks/hinterland.ts`); vjazd dostane s rezerváciou
 * (`tryAdmitDelivery`: blok so zaručeným miestom a token TP / státia) a vznikne naložený jednou jednotkou
 * (`CargoLedger.create` v `in_truck`, hmotnostná trieda `Rng.weighted` podľa `exportFlow.weightClassShares`, štítky z kontraktu) na road portáli;
 * kamión ide k bráne, prejde ňou (`ExportArrived`) a na TP bloku ho obslúži stroj bloku alebo straddle carrier (`systems/landside-system.ts`).
 *
 * Kontrakty vzostupne podľa id, každý sa vybaví celý (všetky splatné položky spredu, neklesajúco podľa `dueTick`, kým ho niečo nezastaví) skôr než ďalší — FIFO naprieč bookingmi to nie je. Bez bloku, tokenu alebo bez road
 * portálu položka počká (ďalší tick) — plán sa spotrebuje až po vzniku kamióna, takže žiadny príchod nezanikne; čakanie vpusteného kamióna
 * (`tick − dueTick`) sa zapíše do `Hinterland`. Kontrakt, ktorý sa medzitým uzavrel, plán odnesie so sebou.
 */
import { DEFAULT_CONTAINER_LABELS, WEIGHT_CLASSES, type CargoUnitLabels } from '../cargo/cargo-unit';
import type { Contract } from '../contracts/contract';
import { CONTRACT_STATE_TRAITS } from '../contracts/contract-fsm';
import type { World } from '../world/world';
import { isRailExportDue } from '../rail/rail-exports';
import { tryAdmitDelivery, type AdmissionOutcome } from './hinterland-entry';

/** Štítky jednotky exportu: hmotnostná trieda `weightClass`, štítky z kontraktu a bookingu. */
export function exportLabels(contract: Contract, destinationPort: string, index: number, sizeFt: CargoUnitLabels['sizeFt'], weightClass: CargoUnitLabels['weightClass']): CargoUnitLabels {
  return { direction: 'export', voyageId: contract.voyageId, lineId: contract.lineId, destinationPort, weightClass, ...DEFAULT_CONTAINER_LABELS, sizeFt, containerType: contract.unitContainerType(index), oog: contract.unitIsOog(index) };
}

/**
 * Pokus o vjazd kamióna s exportom pre najbližšiu položku plánu kontraktu (booking po prijatí, `booking !== null`). Skutočná jednotka vznikne až pri skutočnom vjazde — kamión čakajúci
 * vo vnútrozemí nealokuje nič (T6D-05b); `Rng` (hmotnostná trieda) sa spotrebuje pri vzniku jednotky ako doteraz.
 */
function admitExportTruck(world: World, contract: Contract): AdmissionOutcome {
  const booking = contract.booking;
  if (booking === null) return 'waiting';
  const shares = world.defs.logistics.exportFlow.weightClassShares;
  // Veľkosť kontajnera, ktorý kamión privezie: `volumeUnits − arrivalPlan.length`-ty kontajnerov bookingu (ADR-039); plán sa spotrebuje až po vjazde.
  const index = contract.volumeUnits - booking.arrivalPlan.length;
  const sizeFt = contract.unitSizeFt(index);
  return tryAdmitDelivery(world, 'export', {
    typeId: contract.cargoTypeId,
    contractId: contract.id,
    probe: exportLabels(contract, booking.destinationPort, index, sizeFt, 'medium'),
    final: () => exportLabels(contract, booking.destinationPort, index, sizeFt, world.rng.weighted(WEIGHT_CLASSES, (item) => shares[item])),
  });
}

/** Krok 8, časť vjazd exportu (viď hlavička). */
export function admitExportTrucks(world: World): void {
  const { tick } = world.clock;
  for (const contract of world.contractBook.openContracts.values()) {
    // Booking po prijatí (plán je nastavený); ponuka ho nemá a uzavretý kontrakt už nie je medzi otvorenými.
    if (CONTRACT_STATE_TRAITS[contract.state].plan !== 'required') continue;
    for (let due = contract.nextArrivalTick; due !== undefined && due <= tick; due = contract.nextArrivalTick) {
      // Železničná položka (R6, ADR-043) čaká na vlak, kým je železničná služba; kamión ju neobslúži.
      if (isRailExportDue(world, contract)) break;
      if (admitExportTruck(world, contract) !== 'admitted') break;
      world.hinterland.recordAdmitted('delivery', tick - due);
      contract.consumeArrival();
    }
  }
}
