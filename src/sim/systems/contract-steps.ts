/**
 * Spoločné kroky kontraktov v kroku 2 (ARCHITECTURE §6, §9.1; ADR-026, ADR-032, ADR-034) — pomocníci, ktoré používajú tabuľky krokov
 * `ContractSystem` (import, export / repositioning) aj prekládky (`tranship-steps.ts`): stavy lode vzhľadom na kotvisko, SLA (late,
 * zlyhanie), demurrage, výplata a uzavretie bookingu (`closeBooking`), loď voyage kontraktu (`boardVoyageShip`). Samé svet
 * nemenia nad rámec kontraktu, knihy, hotovosti a udalostí daného kroku; `Rng` nespotrebúvajú.
 */
import type { Contract } from '../contracts/contract';
import {
  bookingFulfilmentUnits,
  bookingPayoutCents,
  bookingUnitsPenaltyCents,
  contractXpGain,
  demurrageStepCents,
  lateStepCents,
  unfulfilledBookingPenaltyCents,
  wholePeriods,
} from '../contracts/contract-terms';
import { loadingStopped } from '../logistics/voyage-cargo';
import { SHIP_STATE_TRAITS, type ShipState } from '../ships/ship-fsm';
import { spawnShip } from '../ships/spawn-ship';
import type { World } from '../world/world';

/**
 * Stavy lode, v ktorých už skončila nakládka — loď opustila kotvisko (`undocking`, `outbound`) alebo mapu; uzavretie export bookingu
 * (výplata pomerne k naloženým, penalizácie). `lashing` ešte nie: loď drží kotvisko, demurrage beží (ADR-032 bod 12–14).
 */
export const SHIP_LEFT_BERTH: { readonly [S in ShipState]: boolean } = Object.freeze({
  arriving: false,
  inbound: false,
  waiting_anchorage: false,
  berthing: false,
  docked: false,
  lashing: false,
  undocking: true,
  outbound: true,
  despawned: true,
});

/** Stavy lode, v ktorých už kotvila (stojí pri kotvisku alebo odchádza) — `ship_en_route → unloading`. */
export const SHIP_REACHED_BERTH: { readonly [S in ShipState]: boolean } = Object.freeze({
  arriving: false,
  inbound: false,
  waiting_anchorage: false,
  berthing: false,
  docked: true,
  lashing: true,
  undocking: true,
  outbound: true,
  despawned: true,
});

/** `refId` záznamu knihy pre kontrakt (ADR-025: `contract:<id>`). */
export function contractRefId(contract: Contract): string {
  return `contract:${String(contract.id)}`;
}

export type ContractStep = (contract: Contract, world: World) => void;

/** Loď kontraktu na mape, alebo `undefined` (ešte nevznikla alebo už odplávala). */
export function shipOf(world: World, contract: Contract) {
  return contract.shipId === undefined ? undefined : world.ships.get(contract.shipId);
}

/** Pripíše penalizáciu `amountCents` (aj 0 — celé obdobie uplynulo) a emituje `PenaltyApplied`. */
export function applyPenalty(world: World, contract: Contract, kind: 'demurrage' | 'late', amountCents: number): void {
  contract.penaltiesCents += amountCents;
  world.events.emit({ type: 'PenaltyApplied', contractId: contract.id, kind, amountCents });
}

/** Demurrage: celé hodiny nad `berthAllowanceTicks` od `dockedTick`, kým loď kontraktu stojí pri kotvisku. */
export function accrueDemurrage(world: World, contract: Contract): void {
  const ship = shipOf(world, contract);
  if (ship === undefined || !SHIP_STATE_TRAITS[ship.state].moored || contract.dockedTick === undefined) return;
  const allowance = world.defs.ships.get(contract.shipClassId).berthAllowanceTicks;
  const hours = wholePeriods(world.clock.tick, contract.dockedTick + allowance, world.clock.ticksPerHour);
  const step = demurrageStepCents(contract.rewardCents, world.defs.economy);
  while (contract.demurrageHours < hours) {
    contract.demurrageHours += 1;
    applyPenalty(world, contract, 'demurrage', step);
  }
}

/** Late: celé dni po `slaDeadlineTick`. */
export function accrueLate(world: World, contract: Contract): void {
  if (contract.slaDeadlineTick === undefined) return;
  const days = wholePeriods(world.clock.tick, contract.slaDeadlineTick, world.clock.ticksPerDay);
  const step = lateStepCents(contract.rewardCents, world.defs.economy);
  while (contract.lateDays < days) {
    contract.lateDays += 1;
    applyPenalty(world, contract, 'late', step);
  }
}

/** Strhne nasčítané penalizácie jednou transakciou (`penalty`), ak sú > 0. */
export function settlePenalties(world: World, contract: Contract): void {
  if (contract.penaltiesCents > 0) world.economy.post(-contract.penaltiesCents, 'penalty', contractRefId(contract));
}

/** `exporting → completed`: výplata, penalizácie, XP, počítadlo dokončených a `ContractCompleted`. */
export function complete(world: World, contract: Contract): void {
  const onTime = contract.slaDeadlineTick !== undefined && world.clock.tick <= contract.slaDeadlineTick;
  world.contractBook.changeState(contract, 'completed');
  world.economy.post(contract.rewardCents, 'contract_revenue', contractRefId(contract));
  settlePenalties(world, contract);
  const xp = contractXpGain(contract.xpReward, onTime, world.defs.economy.lateXpFactor);
  world.contractBook.recordCompletion(xp);
  world.events.emit({ type: 'ContractCompleted', contractId: contract.id, rewardCents: contract.rewardCents, penaltiesCents: contract.penaltiesCents, xp, onTime });
}

/**
 * Uzavretie export bookingu, keď loď opustila kotvisko (ADR-032 bod 14): penalizácie podľa počítadiel (`BookingPenaltyApplied`
 * pre last minute, rolled — prijaté a nenaložené, vrátené odosielateľovi — a nesplnený booking), potom pri ≥ 1 naloženej jednotke
 * `completed` s výplatou `⌊reward × naložené / bookované⌋` a XP pomerne k naloženým, inak `failed`. Hotovosť sa strhne jednou
 * transakciou (ADR-026); od uzavretia smú nenaložené jednotky v sklade na rampu (`outbound` = `free`, vrátenie odosielateľovi).
 */
export function closeBooking(world: World, contract: Contract): void {
  const booking = contract.booking;
  if (booking === null) return;
  const { economy } = world.defs;
  const booked = contract.volumeUnits;
  const loaded = booking.loadedUnits;
  const reward = contract.rewardCents;
  const penalties: readonly { readonly kind: 'last_minute' | 'rolled' | 'unfulfilled'; readonly units: number; readonly amountCents: number }[] = [
    { kind: 'last_minute', units: booking.lastMinuteUnits, amountCents: bookingUnitsPenaltyCents(reward, booked, booking.lastMinuteUnits, economy.lastMinuteExportRateOfReward) },
    { kind: 'rolled', units: contract.rolledAtClose, amountCents: bookingUnitsPenaltyCents(reward, booked, contract.rolledAtClose, economy.rolledExportRateOfReward) },
    {
      kind: 'unfulfilled',
      units: loaded < bookingFulfilmentUnits(booked, economy) ? booked - loaded : 0,
      amountCents: loaded < bookingFulfilmentUnits(booked, economy) ? unfulfilledBookingPenaltyCents(reward, economy) : 0,
    },
  ];
  for (const penalty of penalties) {
    if (penalty.units <= 0) continue;
    contract.penaltiesCents += penalty.amountCents;
    world.events.emit({ type: 'BookingPenaltyApplied', contractId: contract.id, kind: penalty.kind, units: penalty.units, amountCents: penalty.amountCents });
  }
  if (loaded === 0) {
    world.contractBook.changeState(contract, 'failed');
    settlePenalties(world, contract);
    world.events.emit({ type: 'ContractFailed', contractId: contract.id, penaltiesCents: contract.penaltiesCents });
    return;
  }
  const payout = bookingPayoutCents(reward, loaded, booked);
  const onTime = contract.slaDeadlineTick !== undefined && world.clock.tick <= contract.slaDeadlineTick;
  world.contractBook.changeState(contract, 'completed');
  world.economy.post(payout, 'contract_revenue', contractRefId(contract));
  settlePenalties(world, contract);
  const xp = contractXpGain((contract.xpReward * loaded) / booked, onTime, economy.lateXpFactor);
  world.contractBook.recordCompletion(xp);
  world.events.emit({ type: 'ContractCompleted', contractId: contract.id, rewardCents: payout, penaltiesCents: contract.penaltiesCents, xp, onTime });
}

/** Zlyhanie po `failAfterDaysLate` dňoch meškania; `true` = kontrakt zlyhal. */
export function failIfOverdue(world: World, contract: Contract): boolean {
  if (!loadingStopped(world, contract)) return false;
  world.contractBook.changeState(contract, 'failed');
  settlePenalties(world, contract);
  world.events.emit({ type: 'ContractFailed', contractId: contract.id, penaltiesCents: contract.penaltiesCents });
  return true;
}

/**
 * Loď voyage kontraktu `contract` (`accepted → ship_en_route`): loď, ktorú už spawnol kontrakt tej istej voyage v tomto
 * ticku (roundtrip: import s nižším id), inak nová loď s `spawnUnits` jednotkami kontraktu (import `volumeUnits`, export
 * 0) a `voyageId` (ADR-032 bod 1). Spoločné pre import aj export kroky `accepted`.
 */
export function boardVoyageShip(world: World, contract: Contract): void {
  for (const mate of world.contractBook.voyageContracts(contract.voyageId)) {
    // `shipOnVoyage` (nie `shipId`): prekládka preadresovaná na túto voyage (záchrana) má vlastnú loď A, ktorá loďou tejto voyage nie je.
    const mateShip = mate === contract ? undefined : mate.shipOnVoyage(contract.voyageId);
    if (mateShip !== undefined) {
      contract.shipId = mateShip;
      return;
    }
  }
  const ship = spawnShip(world, {
    shipClassId: contract.shipClassId,
    cargoTypeId: contract.cargoTypeId,
    units: contract.spawnUnits,
    contractId: contract.id,
    labels: contract.spawnLabels,
  });
  contract.shipId = ship.id;
}

export const idle: ContractStep = () => undefined;
