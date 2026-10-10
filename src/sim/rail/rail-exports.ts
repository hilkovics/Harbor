/**
 * Export po koľaji (R6, ADR-043): `Contract.railShareBp` určuje, ktoré kontajnery bookingu prídu vlakom namiesto kamiónom. Označenie kontajnera `i` je čistá funkcia podielu (rovnomerné
 * rozloženie, bez ďalšieho `Rng`): kontajner je železničný, keď `⌊(i + 1) · podiel⌋ > ⌊i · podiel⌋`. Pri príchode vlaka na portál sa splatné železničné položky `arrivalPlan` zmenia na jednotky
 * (`CargoLedger.create` rovno v `in_train`, hmotnostná trieda `Rng.weighted` ako pri kamióne) a zaregistrujú na booking (`registerBookingArrival`). Kamióny železničnú položku
 * neobsluhujú (`isRailExportDue` — kým je železničná služba, položka čaká na vlak); bez služby sa položka správa ako kamiónová, takže po zrušení terminálu žiadny príchod nezanikne.
 */
import { WEIGHT_CLASSES, teuOf } from '../cargo/cargo-unit';
import type { Contract } from '../contracts/contract';
import { CONTRACT_STATE_TRAITS } from '../contracts/contract-fsm';
import { BASIS_POINTS } from '../economy/basis-points';
import { exportLabels } from '../trucks/export-trucks';
import { registerBookingArrival } from '../trucks/export-gate';
import type { World } from '../world/world';
import { findTrainSlot } from './train-cargo';
import type { Train } from './train';

/** Je kontajner `index` kontraktu s podielom `railShareBp` železničný? */
export function isRailExportIndex(railShareBp: number, index: number): boolean {
  return Math.floor(((index + 1) * railShareBp) / BASIS_POINTS) > Math.floor((index * railShareBp) / BASIS_POINTS);
}

/** Najbližšia položka plánu príchodov kontraktu je železničná a vo svete je železničná služba (kamión ju nesmie obslúžiť). */
export function isRailExportDue(world: World, contract: Contract): boolean {
  const booking = contract.booking;
  if (booking === null || contract.railShareBp === 0 || !world.hasRailService) return false;
  return isRailExportIndex(contract.railShareBp, contract.volumeUnits - booking.arrivalPlan.length);
}

/**
 * Vlak práve prišiel na portál: pre každý otvorený booking (vzostupne podľa id) postupne vyloží splatné železničné položky do voľných miest vlaku (vagóny od lokomotívy), kým položka nie je
 * kamiónová, nie je splatná alebo sa nezmestí. Vráti počet vytvorených jednotiek.
 */
export function loadRailExports(world: World, train: Train): number {
  const { tick } = world.clock;
  const shares = world.defs.logistics.exportFlow.weightClassShares;
  let created = 0;
  for (const contract of world.contractBook.openContracts.values()) {
    if (CONTRACT_STATE_TRAITS[contract.state].plan !== 'required') continue;
    const booking = contract.booking;
    if (booking === null || contract.railShareBp === 0) continue;
    for (let due = contract.nextArrivalTick; due !== undefined && due <= tick; due = contract.nextArrivalTick) {
      const index = contract.volumeUnits - booking.arrivalPlan.length;
      if (!isRailExportIndex(contract.railShareBp, index)) break;
      const sizeFt = contract.unitSizeFt(index);
      const slot = findTrainSlot(world.cargo, train, teuOf({ sizeFt }));
      if (slot === undefined) break;
      const labels = exportLabels(contract, booking.destinationPort, index, sizeFt, world.rng.weighted(WEIGHT_CLASSES, (item) => shares[item]));
      const unit = world.cargo.create(contract.cargoTypeId, { kind: 'in_train', trainId: train.id, slot }, contract.id, labels);
      contract.consumeArrival();
      world.hinterland.recordAdmitted('delivery', tick - due);
      registerBookingArrival(world, contract, unit, () => world.events.emit({ type: 'TrainExportArrived', contractId: contract.id, unitId: unit.id, trainId: train.id }));
      created += 1;
    }
  }
  return created;
}
