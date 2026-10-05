/**
 * Využitie apronu po smeroch (F6a, ADR-032 bod 10): rezerva `apronReserveSlots` chráni opačný smer — kým má loď pri kotvisku
 * import na vykládku aj export na nakládku, každý smer (uložené + rezervované) smie obsadiť najviac `apronSlots −
 * apronReserveSlots` slotov. Čisté dotazy nad ledgerom, apronom a žeriavmi kotviska; svet nemenia. Používa ich žeriav
 * (`crane-handover.ts`, vykládka na apron) aj dispatcher (`export-load.ts`, nakládka na apron a pod hákom).
 */
import { BerthModule } from '../modules/berth-module';
import { CraneModule } from '../modules/crane-module';
import type { Ship } from '../ships/ship';
import type { World } from '../world/world';
import { importAboard, isOutboundOnShip, pendingExportUnits } from './voyage-cargo';

/**
 * Využitie apronu vykládkou: jednotky na vykládku (import, prekládka z lode A — nie náklad na nakládku lode kotviska) na aprone + sloty
 * rezervované žeriavmi kotviska (vykládka).
 */
export function importApronUsage(world: World, berth: BerthModule): number {
  let used = 0;
  const count = world.cargo.countAt('on_apron', berth.id);
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('on_apron', berth.id, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit !== undefined && !isOutboundOnShip(world, unit, berth.dockedShipId)) used += 1;
  }
  for (const craneId of berth.craneIds) {
    const crane = world.modules.get(craneId);
    if (crane instanceof CraneModule && crane.reservedSlot !== null) used += 1;
  }
  return used;
}

/**
 * Využitie apronu nakládkou: jednotky na nakládku (export, prázdne, prekládka čakajúca na loď kotviska) na aprone + sloty rezervované jobmi
 * nakládky (rezervácie apronu mimo žeriavov).
 */
export function exportApronUsage(world: World, berth: BerthModule): number {
  let used = 0;
  const count = world.cargo.countAt('on_apron', berth.id);
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('on_apron', berth.id, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit !== undefined && isOutboundOnShip(world, unit, berth.dockedShipId)) used += 1;
  }
  let craneReserved = 0;
  for (const craneId of berth.craneIds) {
    const crane = world.modules.get(craneId);
    if (crane instanceof CraneModule && crane.reservedSlot !== null) craneReserved += 1;
  }
  return used + berth.apron.reservedCount - craneReserved;
}

/**
 * Smie sa na aprone obsadiť ďalší slot jedným smerom? Kým má loď import na vykládku aj export na nakládku (`bothDirections`),
 * každý smer smie obsadiť najviac `apronSlots − apronReserveSlots` slotov (ADR-032 bod 10); inak celý apron.
 */
export function apronDirectionCap(berth: BerthModule, bothDirections: boolean): number {
  return bothDirections ? berth.params.apronSlots - berth.params.apronReserveSlots : berth.params.apronSlots;
}

/** Loď má import na palube aj export čakajúci na nakládku (smerový limit apronu). */
export function bothDirections(world: World, ship: Ship): boolean {
  return world.contractBook.hasOpenExports && importAboard(world, ship.id) > 0 && pendingExportUnits(world, ship.id) > 0;
}
