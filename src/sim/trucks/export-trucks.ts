/**
 * Kamióny s exportom (F6a, ADR-032 bod 6; F6d, ADR-035): vjazd **delivery** kamiónov podľa plánu príchodov bookingov (krok 8, po výdaji prázdnych).
 * Každá položka plánu (`Contract.nextArrivalTick ≤ tick`) je kamión, ktorý čaká vo vnútrozemí (`trucks/hinterland.ts`); vjazd dostane s rezerváciou
 * (`planDeliveryAdmission`: bay nad kvótou pre odvoz, dock a sklad so zaručeným miestom na vyloženie) a vznikne naložený jednou jednotkou
 * (`CargoLedger.create` v `in_truck`, hmotnostná trieda `Rng.weighted` podľa `exportFlow.weightClassShares`, štítky z kontraktu) na road portáli;
 * kamión ide k bráne, prejde ňou (`ExportArrived`), počká v stojisku a vyloží na dock rampy (`systems/landside-system.ts`).
 *
 * Kontrakty vzostupne podľa id, každý sa vybaví celý (všetky splatné položky spredu, neklesajúco podľa `dueTick`, kým ho niečo nezastaví) skôr než ďalší — FIFO naprieč bookingmi to nie je. Bez prevádzkovej rampy kategórie nákladu, bez rezervácie alebo bez road
 * portálu položka počká (ďalší tick) — plán sa spotrebuje až po vzniku kamióna, takže žiadny príchod nezanikne; čakanie vpusteného kamióna
 * (`tick − dueTick`) sa zapíše do `Hinterland`. Kontrakt, ktorý sa medzitým uzavrel, plán odnesie so sebou.
 */
import { DEFAULT_CONTAINER_LABELS, WEIGHT_CLASSES } from '../cargo/cargo-unit';
import type { Contract } from '../contracts/contract';
import { CONTRACT_STATE_TRAITS } from '../contracts/contract-fsm';
import type { EntityId } from '../core/entity-id';
import type { World } from '../world/world';
import { planDeliveryAdmission, spawnDelivery, type AdmissionOutcome } from './hinterland-entry';

/**
 * Pokus o vjazd kamióna s exportom pre najbližšiu položku plánu kontraktu (booking po prijatí, `booking !== null`). Nakladač jednotky (closure) vznikne až
 * pri skutočnom vjazde — kamión čakajúci vo vnútrozemí nealokuje nič (T6D-05b); `Rng` sa spotrebuje pri vzniku jednotky ako doteraz.
 */
function admitExportTruck(world: World, contract: Contract, portal: number): AdmissionOutcome {
  const booking = contract.booking;
  if (booking === null) return 'waiting';
  const outcome = planDeliveryAdmission(world, 'export', world.defs.cargoTypes.get(contract.cargoTypeId).category);
  if (outcome !== 'admitted') return outcome;
  const shares = world.defs.logistics.exportFlow.weightClassShares;
  // Veľkosť kontajnera, ktorý kamión privezie: `volumeUnits − arrivalPlan.length`-ty kontajnerov bookingu (ADR-039); plán sa spotrebuje až po vjazde.
  const sizeFt = contract.unitSizeFt(contract.volumeUnits - booking.arrivalPlan.length);
  spawnDelivery(world, portal, (truck) => {
    const weightClass = world.rng.weighted(WEIGHT_CLASSES, (item) => shares[item]);
    world.cargo.create(contract.cargoTypeId, { kind: 'in_truck', truckId: truck.id as EntityId }, contract.id, {
      direction: 'export',
      voyageId: contract.voyageId,
      lineId: contract.lineId,
      destinationPort: booking.destinationPort,
      weightClass,
      ...DEFAULT_CONTAINER_LABELS,
      sizeFt,
    });
  });
  return 'admitted';
}

/** Krok 8, časť vjazd exportu (viď hlavička). */
export function admitExportTrucks(world: World, portal: number): void {
  const { tick } = world.clock;
  for (const contract of world.contractBook.openContracts.values()) {
    // Booking po prijatí (plán je nastavený); ponuka ho nemá a uzavretý kontrakt už nie je medzi otvorenými.
    if (CONTRACT_STATE_TRAITS[contract.state].plan !== 'required') continue;
    for (let due = contract.nextArrivalTick; due !== undefined && due <= tick; due = contract.nextArrivalTick) {
      if (admitExportTruck(world, contract, portal) !== 'admitted') break;
      world.hinterland.recordAdmitted('delivery', tick - due);
      contract.consumeArrival();
    }
  }
}
