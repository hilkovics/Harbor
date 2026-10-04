/**
 * Karty kontraktov pre `ContractsPanel` (T05-07): čistá projekcia `world.contracts` do `ContractCardData[]` z `@ui`.
 *
 * - Názvy nákladu (kategória → `CARGO_CATEGORY_TEXT`, kapitalizované) a jednotka (`unitName`) sú z defov nákladu,
 *   názov triedy lode je `displayName` z `ships.json`.
 * - `offerExpiresTick` je skutočný tick zániku ponuky (`offerClosingTick`: pool sa obnovuje raz denne), `slaWindowTicks`
 *   je `slaDays × ticksPerDay`.
 * - `disabledReason` (len ponuka) je text prvého dôvodu z `validate` príkazu `AcceptContract` (`REASON_TEXT`), takže UI
 *   neduplikuje pravidlá simu (dnes: `game_over`).
 * - Poradie: ponuky a prebiehajúce vzostupne podľa id, história (splnené / zlyhané) od najnovšej.
 * - F6a (ADR-032): karta nesie `kind` a `voyageId` (panel zoskupí kontrakty jednej voyage do spoločnej karty roundtripu),
 *   export booking aj `booking` (cieľ, cut-off, dovezené / naložené, zadržané VGM, rolled, vrátené, zostávajúce príchody).
 *   `disabledReason` má každý kontrakt ponuky osobitne (panel ukáže prvý dôvod zo skupiny).
 */
import { AcceptContractCommand } from '@sim/commands';
import { offerClosingTick, type Contract, type ExportBooking } from '@sim/contracts';
import type { World } from '@sim/world';
import type { ContractBookingData, ContractCardData, ContractsTimeScale } from '@ui/contracts-panel';
import { REASON_TEXT } from './build-feedback';
import { CARGO_CATEGORY_TEXT } from './toast-center';

/** Prvé písmeno veľké (`kontajnery` → `Kontajnery`). */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Uzavretý kontrakt (záložka História). */
function isClosed(contract: Contract): boolean {
  return contract.state === 'completed' || contract.state === 'failed' || contract.state === 'expired';
}

/** Text dôvodu, prečo sa ponuku nedá prijať; `undefined`, ak sa dá (alebo nejde o ponuku). */
export function acceptDisabledReason(world: World, contract: Contract): string | undefined {
  if (contract.state !== 'offered') return undefined;
  const verdict = new AcceptContractCommand(contract.id).validate(world);
  const reason = verdict.reasons[0];
  return verdict.ok || reason === undefined ? undefined : REASON_TEXT[reason];
}

/**
 * Odstup cut-off od príchodu lode v tickoch (`economy.cutoffHours` × ticky za hodinu; rovnaké zaokrúhlenie ako pri
 * plánovaní bookingu v `Contract.accept`). Ponuka s ním ukáže „Cut-off 12 h pred príchodom lode“.
 */
export function cutoffLeadTicks(world: World): number {
  return Math.round(world.defs.economy.cutoffHours * world.clock.ticksPerHour);
}

/** Booking export kontraktu pre kartu; `cutoffLeadTicks` len pred prijatím (potom je cut-off konkrétny tick). */
function bookingData(world: World, booking: ExportBooking): ContractBookingData {
  return {
    destinationPort: booking.destinationPort,
    ...(booking.cutoffTick === undefined ? { cutoffLeadTicks: cutoffLeadTicks(world) } : { cutoffTick: booking.cutoffTick }),
    bookedUnits: booking.bookedUnits,
    pendingArrivals: booking.arrivalPlan.length,
    arrivedUnits: booking.arrivedUnits,
    loadedUnits: booking.loadedUnits,
    lastMinuteUnits: booking.lastMinuteUnits,
    rolledUnits: booking.rolledUnits,
    returnedUnits: booking.returnedUnits,
    heldUnits: booking.heldUnits,
  };
}

/** Karta jedného kontraktu (viď hlavička súboru). */
export function contractCard(world: World, contract: Contract): ContractCardData {
  const { defs, clock } = world;
  const cargo = defs.cargoTypes.get(contract.cargoTypeId);
  const ship = defs.ships.get(contract.shipClassId);
  const disabledReason = acceptDisabledReason(world, contract);
  const { booking } = contract;
  return {
    id: contract.id,
    kind: contract.kind,
    voyageId: contract.voyageId,
    state: contract.state,
    cargoCategory: cargo.category,
    cargoLabel: capitalize(CARGO_CATEGORY_TEXT[cargo.category].cargo),
    unit: cargo.unitName,
    volumeUnits: contract.volumeUnits,
    rewardCents: contract.rewardCents,
    xpReward: contract.xpReward,
    shipClassId: contract.shipClassId,
    shipClassLabel: ship.displayName,
    offerExpiresTick: offerClosingTick(contract.offerExpiresTick, clock.ticksPerDay),
    slaWindowTicks: contract.slaDays * clock.ticksPerDay,
    ...(contract.slaDeadlineTick === undefined ? {} : { slaDeadlineTick: contract.slaDeadlineTick }),
    ...(contract.shipArrivalTick === undefined ? {} : { shipArrivalTick: contract.shipArrivalTick }),
    ...(contract.closedTick === undefined ? {} : { closedTick: contract.closedTick }),
    unitsUnloaded: contract.unitsUnloaded,
    unitsExported: contract.unitsExported,
    penaltiesCents: contract.penaltiesCents,
    ...(disabledReason === undefined ? {} : { disabledReason }),
    ...(booking === null ? {} : { booking: bookingData(world, booking) }),
  };
}

/** Karty všetkých kontraktov sveta v poradí z hlavičky súboru. */
export function contractCards(world: World): readonly ContractCardData[] {
  const open: Contract[] = [];
  const closed: Contract[] = [];
  for (const contract of world.contracts.values()) (isClosed(contract) ? closed : open).push(contract);
  // História od najnovšej (uzavretie, potom id); `world.contracts` ide vzostupne podľa id, takže `open` netreba radiť.
  closed.sort((a, b) => (b.closedTick ?? 0) - (a.closedTick ?? 0) || b.id - a.id);
  return Object.freeze([...open, ...closed].map((contract) => contractCard(world, contract)));
}

/** Za koľko tickov sa obnoví pool ponúk (najbližšia uzávierka dňa; v ticku uzávierky celý deň). */
export function nextOfferInTicks(world: World): number {
  const { ticksPerDay, tick } = world.clock;
  return ticksPerDay - (tick % ticksPerDay);
}

/** Mierka času pre panel z hodín sveta. */
export function contractsTimeScale(world: World): ContractsTimeScale {
  const { ticksPerHour, ticksPerDay, tick } = world.clock;
  return { ticksPerHour, ticksPerDay, nowTick: tick };
}
