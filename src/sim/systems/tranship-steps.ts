/**
 * Kroky stavov prekládky loď A → terminál → loď B (F6c, ADR-034 bod 11 + dodatok T6C-03; `ContractSystem`, krok 2). Prekládka je export
 * booking s doplnkami (`TranshipContract`): loď A (voyage kontraktu) privezie jednotky `tranship` a vykládajú sa ako import, jednotky ležia
 * v sklade zoskupene podľa kontraktu a nakladajú sa na loď B (voyage `outVoyageId`), ktorá príde `transhipGapDaysRange` po lodi A. Jednotky
 * **nikdy neprejdú bránou** — loď → sklad → loď. Tabuľka krokov `TRANSHIP_CONTRACT_STEPS` (nie switch):
 *
 * - `accepted`: v ticku príchodu lode A spawn lode s `volumeUnits` jednotkami `tranship` (`boardVoyageShip`, `Contract.spawnLabels`) → `ship_en_route`.
 * - `ship_en_route`: loď A pri kotvisku (alebo už odchádza) → `dockedTick`, `unloading`; SLA ako import.
 * - `unloading`: demurrage lode A, SLA; celý objem vyložený (`unitsUnloaded ≥ volumeUnits`) → `exporting` („čaká na loď B / nakladá sa“).
 * - `exporting`: (a) **loď B**: v ticku `outArrivalTick` vznikne (kontrakt ju spawne s 0 jednotkami), alebo — po záchrane na voyage inej lode
 *   linky — prevezme loď tej voyage (`trackShipB`); platí vo všetkých stavoch po prijatí, takže loď B môže prísť skôr, než sa loď A vyloží;
 *   (b) **B odplávala** (`SHIP_LEFT_BERTH`, alebo zmizla z mapy): všetko naložené → uzavretie bookingu ako export (`closeBooking`: výplata
 *   `⌊reward × naložené / bookované⌋`, XP pomerne, penalizácia za nesplnený booking); inak **zmeškané** jednotky (`volume − naložené`):
 *   `BookingPenaltyApplied kind 'rolled'` v sadzbe `transhipMissedRateOfReward`, `TranshipMissed` a `rescueDeadlineTick = tick +
 *   transhipRescueDays × ticksPerDay`; (c) **záchrana**: kým beží lehota, hľadá sa ďalšia voyage tej istej linky (kontrakt v `accepted`, ktorého príchod
 *   lode je po `tick` a najneskôr v lehote, ten istý druh nákladu): nájdená → `outVoyageId` sa prepíše (`ContractBook.redirectTranship`,
 *   `TranshipRescued`), jednotky ostávajú v sklade; po lehote bez záchrany **predané**: `TranshipSold` a uzavretie kontraktu — uzavretý kontrakt
 *   púšťa zvyšné jednotky na rampu (`outbound = 'free'`), kamión ich odvezie (`in_storage → … → exported`, nič sa neteleportuje).
 *   Po lehote zlyhania SLA (`loadingStopped`) sa kontrakt uzavrie rovnako ako predaj, keď loď B nenakladá.
 * Demurrage lode B sa neúčtuje (loď B nemá vlastný kontrakt; zjednodušenie, dodatok ADR-034).
 */
import { TranshipContract, type Contract } from '../contracts/contract';
import { ContractError } from '../contracts/contract-error';
import type { ContractState } from '../contracts/contract-fsm';
import { bookingUnitsPenaltyCents } from '../contracts/contract-terms';
import { loadingInFlight, loadingStopped } from '../logistics/voyage-cargo';
import { spawnShip } from '../ships/spawn-ship';
import type { World } from '../world/world';
import {
  SHIP_LEFT_BERTH,
  SHIP_REACHED_BERTH,
  accrueDemurrage,
  accrueLate,
  boardVoyageShip,
  closeBooking,
  failIfOverdue,
  idle,
  shipOf,
  type ContractStep,
} from './contract-steps';

/** Kontrakt kroku prekládky ako `TranshipContract` (iný druh v tabuľke krokov prekládky je chyba programu). */
function transhipOf(contract: Contract): TranshipContract {
  if (!(contract instanceof TranshipContract)) throw new ContractError('invalid_input', `${contract.label}: kroky prekládky dostal kontrakt druhu '${contract.kind}'`);
  return contract;
}

/** Jednotky prekládky, ktoré neboli naložené ani predané: `volume − naložené − predané` (na termináli alebo ešte na lodi A). */
function remainingUnits(leg: TranshipContract): number {
  return leg.volumeUnits - leg.loadedUnits - leg.unitsExported;
}

/**
 * Loď B (od `outArrivalTick`): ak jej voyage patrí aj iný kontrakt (záchrana na voyage inej lode linky), počká, kým jej loď vznikne, a prevezme ju
 * (`outShipId`); ak ide o vlastnú voyage prekládky (jediný kontrakt), spawne ju s 0 jednotkami — loď B nesie náklad len z nakládky.
 */
function trackShipB(world: World, leg: TranshipContract): void {
  if (leg.outShipId !== undefined || leg.outArrivalTick === undefined || world.clock.tick < leg.outArrivalTick) return;
  let mateWithoutShip = false;
  for (const mate of world.contractBook.voyageContracts(leg.outVoyageId)) {
    if (mate === leg) continue;
    const ship = mate.shipOnVoyage(leg.outVoyageId);
    if (ship !== undefined) {
      leg.outShipId = ship;
      return;
    }
    mateWithoutShip = true;
  }
  if (mateWithoutShip) return;
  leg.outShipId = spawnShip(world, { shipClassId: leg.shipClassId, cargoTypeId: leg.cargoTypeId, units: 0, contractId: leg.id, labels: null }).id;
}

/** Odplávala loď B (opustila kotvisko, alebo už nie je na mape)? Kým loď B nevznikla, nie. */
function shipBDeparted(world: World, leg: TranshipContract): boolean {
  if (leg.outShipId === undefined) return false;
  const ship = world.ships.get(leg.outShipId);
  return ship === undefined || SHIP_LEFT_BERTH[ship.state];
}

/** Beží na lodi B nakládka prekládky (job nakládky, jednotka na aprone, žeriav v cykle)? Po lehote zlyhania čaká uzavretie na jej koniec. */
function shipBLoading(world: World, leg: TranshipContract): boolean {
  const ship = leg.outShipId === undefined ? undefined : world.ships.get(leg.outShipId);
  return ship !== undefined && loadingInFlight(world, leg, ship);
}

/** Zmeškané jednotky bez záchrany odchádzajú kamiónom ako „predané“ (`TranshipSold`); uzavretie kontraktu ich púšťa na rampu. */
function announceSold(world: World, leg: TranshipContract, units: number): void {
  if (units > 0) world.events.emit({ type: 'TranshipSold', contractId: leg.id, units });
}

/** Predaj zvyšných jednotiek a uzavretie kontraktu (`closeBooking` — pomerná výplata podľa naložených, `failed` bez naloženej jednotky). */
function sellAndClose(world: World, leg: TranshipContract): void {
  announceSold(world, leg, remainingUnits(leg));
  closeBooking(world, leg);
}

/**
 * Loď B odplávala bez `units` jednotiek: penalizácia `⌊reward × transhipMissedRateOfReward × units / booked⌋` (`BookingPenaltyApplied 'rolled'`,
 * z hotovosti pri uzavretí), `TranshipMissed` a lehota záchrany `transhipRescueDays`.
 */
function missShipB(world: World, leg: TranshipContract, units: number): void {
  const { economy } = world.defs;
  const amountCents = bookingUnitsPenaltyCents(leg.rewardCents, leg.volumeUnits, units, economy.transhipMissedRateOfReward);
  leg.penaltiesCents += amountCents;
  world.events.emit({ type: 'BookingPenaltyApplied', contractId: leg.id, kind: 'rolled', units, amountCents });
  world.events.emit({ type: 'TranshipMissed', contractId: leg.id, units, outVoyageId: leg.outVoyageId });
  leg.rescueDeadlineTick = world.clock.tick + Math.round(economy.transhipRescueDays * world.clock.ticksPerDay);
}

/**
 * Ďalšia voyage tej istej linky pre zmeškanú prekládku: kontrakt v `accepted` (loď ešte nevznikla) inej voyage než lode A, rovnaký druh nákladu,
 * s plánovaným príchodom lode po `tick` a najneskôr v `rescueDeadlineTick`; najskorší príchod, pri zhode menšie id kontraktu. Bez nej `undefined`.
 */
function rescueCandidate(world: World, leg: TranshipContract, deadline: number): Contract | undefined {
  const { tick } = world.clock;
  const category = world.defs.cargoTypes.get(leg.cargoTypeId).category;
  let best: Contract | undefined;
  for (const other of world.contractBook.openContracts.values()) {
    if (other === leg || other.state !== 'accepted' || other.lineId !== leg.lineId || other.voyageId === leg.voyageId) continue;
    const arrival = other.shipArrivalTick;
    if (arrival === undefined || arrival <= tick || arrival > deadline) continue;
    if (world.defs.cargoTypes.get(other.cargoTypeId).category !== category) continue;
    if (best === undefined || arrival < (best.shipArrivalTick as number)) best = other;
  }
  return best;
}

/** Záchrana (viď hlavička súboru): preadresuje prekládku na voyage `rescue` a ohlási `TranshipRescued`. */
function rescueOnto(world: World, leg: TranshipContract, rescue: Contract, units: number): void {
  world.contractBook.redirectTranship(leg, rescue.voyageId, rescue.shipArrivalTick as number, undefined);
  world.events.emit({ type: 'TranshipRescued', contractId: leg.id, units, outVoyageId: rescue.voyageId });
}

/**
 * Lehota záchrany beží: nájdi ďalšiu voyage linky (záchrana), alebo po lehote jednotky predaj a uzavri kontrakt. K záchrane dôjde až keď
 * zmeškaná loď B zmizla z mapy: kým je na mape, drží naložené jednotky prekládky (`isOutboundOnShip` ich rozpoznáva podľa `outShipId`, ktorý
 * záchrana prepisuje) a pri odchode ich pošle ako `shipped`.
 */
function awaitRescue(world: World, leg: TranshipContract): void {
  const deadline = leg.rescueDeadlineTick as number;
  const boardGone = leg.outShipId === undefined || !world.ships.has(leg.outShipId);
  const rescue = boardGone ? rescueCandidate(world, leg, deadline) : undefined;
  if (rescue !== undefined) rescueOnto(world, leg, rescue, remainingUnits(leg));
  else if (world.clock.tick >= deadline) sellAndClose(world, leg);
}

/** Loď B odplávala: všetko naložené → uzavretie bookingu, inak zmeškané jednotky (penalizácia, lehota) a hneď pokus o záchranu. */
function settleShipB(world: World, leg: TranshipContract): void {
  if (shipBLoading(world, leg)) return;
  const units = remainingUnits(leg);
  if (units <= 0) {
    closeBooking(world, leg);
    return;
  }
  missShipB(world, leg, units);
  awaitRescue(world, leg);
}

/** Po lehote zlyhania SLA jednotky na termináli odídu predané (`TranshipSold`) skôr, než `failIfOverdue` kontrakt zlyhá (vo vykladacích stavoch). */
function failOverdue(world: World, leg: TranshipContract): void {
  if (loadingStopped(world, leg)) announceSold(world, leg, leg.arrivedUnits - leg.loadedUnits - leg.unitsExported);
  failIfOverdue(world, leg);
}

/** Kroky stavov prekládky (viď hlavička súboru). */
export const TRANSHIP_CONTRACT_STEPS: { readonly [S in ContractState]: ContractStep } = {
  offered: idle,
  accepted: (contract, world) => {
    if (contract.shipArrivalTick === undefined || world.clock.tick < contract.shipArrivalTick) return;
    boardVoyageShip(world, contract);
    world.contractBook.changeState(contract, 'ship_en_route');
  },
  ship_en_route: (contract, world) => {
    const leg = transhipOf(contract);
    trackShipB(world, leg);
    accrueLate(world, contract);
    const ship = shipOf(world, contract);
    if (ship !== undefined && SHIP_REACHED_BERTH[ship.state]) {
      contract.dockedTick = world.clock.tick;
      world.contractBook.changeState(contract, 'unloading');
      return;
    }
    failOverdue(world, leg);
  },
  unloading: (contract, world) => {
    const leg = transhipOf(contract);
    trackShipB(world, leg);
    accrueDemurrage(world, contract);
    accrueLate(world, contract);
    if (contract.unitsUnloaded >= contract.volumeUnits) {
      world.contractBook.changeState(contract, 'exporting');
      return;
    }
    failOverdue(world, leg);
  },
  exporting: (contract, world) => {
    const leg = transhipOf(contract);
    trackShipB(world, leg);
    accrueLate(world, contract);
    if (leg.rescueDeadlineTick !== undefined) {
      awaitRescue(world, leg);
      return;
    }
    if (shipBDeparted(world, leg)) {
      settleShipB(world, leg);
      return;
    }
    // Lehota zlyhania SLA: loď B nenakladá (nič v ceste) → predaj zvyšku a pomerné uzavretie, ako pri exporte po lehote.
    if (loadingStopped(world, leg) && !shipBLoading(world, leg)) sellAndClose(world, leg);
  },
  completed: idle,
  failed: idle,
  expired: idle,
};
