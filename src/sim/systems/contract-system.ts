/**
 * ContractSystem — krok 2 ticku (ARCHITECTURE §6, §9.1; docs/tasks/phase-05.md rozhodnutia 4–8; ADR-026): spawn lodí
 * prijatých kontraktov, sledovanie lode, SLA, penalizácie, dokončenie, zlyhanie, expirácia ponúk a doplnenie poolu.
 *
 * Poradie v kroku: (1) neukončené kontrakty vzostupne podľa id, každý jeden krok podľa druhu a stavu z tabuľky
 * `CONTRACT_STEPS` (nie switch; export booking ADR-032 — kroky dopĺňa T6A-04); (2) **denná obnova poolu** pri `DayClosed`: ponuky s `offerExpiresTick ≤ tick`
 * vzostupne podľa id → `expired` + `ContractExpired { reason: 'timeout' }` (kniha ich zabudne) a potom doplnenie do
 * `offersPerDay`; (3) pri štarte hry (`GAME_START_TICK`, prvý tick po `World.create`) len doplnenie — a rovnako
 * v prvom ticku po načítaní save spred kontraktov (v1–v4: kniha po migrácii ešte nepridelila žiadne id,
 * `ContractBook.untouched`; T06-07). Obnova save `Rng` nespotrebuje, pool sa doplní až v kroku 2 a podmienka je
 * odvodená zo save, takže ju neprekazí ani uloženie pred prvým tickom. Pokus pre nedotknutú knihu je jeden na
 * inštanciu systému (T06-08b): bez šablóny pre tier 0 kniha ostane `untouched` a ďalší pokus príde až s `DayClosed`
 * (predtým v každom ticku). Príznak nie je stav simulácie — neúspešný pokus nič nezmení a `Rng` nespotrebuje
 * (`drawOffer` vráti `null` pred prvým ťahom), takže po načítaní save ho prvý tick zopakuje bez vplyvu. Ponuka teda zanikne
 * v prvej uzávierke dňa v čase `offerExpiresTick` alebo po ňom (najneskôr o deň) a jej miesto hneď zaberie nová — tabuľa
 * ponúk sa mení raz denne (ponuky z polnoci expirujú presne v `offerExpiresTick`, prvá dávka zo štartu v najbližšej
 * polnoci po ňom, `offerClosingTick`). Pool sa nedopĺňa inokedy — ani po `DeclineContract`.
 *
 * Kroky stavov (všetko v celých tickoch, `tick` = `clock.tick` po kroku 1):
 * - `offered`: nič (expiráciu rieši denná obnova poolu).
 * - `accepted`: `tick ≥ shipArrivalTick` → `spawnShip` (spoločný kód so `SpawnShipDebug`) s `volumeUnits` jednotkami
 *   `contractId`, `shipId` a `accepted → ship_en_route`. Loď sa pohne v kroku 3 toho istého ticku.
 * - `ship_en_route`: SLA (nižšie); loď kontraktu stojí pri kotvisku alebo ho už opúšťa (`docked` alebo neskorší stav
 *   lode na mape; loď kontraktu v `ship_en_route` je podľa invariantu kroku 12 vždy na mape) → `dockedTick = tick`
 *   a `→ unloading`. Krok 2 predchádza kroku 3, takže `dockedTick` je tick po `ShipDocked` — od neho beží
 *   `berthAllowanceTicks` (odchýlka jedného ticku v prospech hráča, zdôvodnenie ADR-026).
 * - `unloading`: demurrage — kým loď stojí pri kotvisku, každá celá hodina nad `berthAllowanceTicks` od `dockedTick`
 *   pripíše `PenaltyApplied { kind: 'demurrage' }`; SLA; `unitsUnloaded ≥ volumeUnits` → `exporting` (loď v tej chvíli
 *   už nemá náklad kontraktu a odpláva v kroku 3 toho istého ticku — najneskôr pri odchode lode). Uskladnené jednotky
 *   kontraktu smú na rampu už počas vykládky (`outbound = 'sla'`, ADR-027 dodatok T05-11), takže `unitsExported` môže
 *   rásť už v tomto stave; dokončenie však rozhoduje až `exporting`.
 * - `exporting`: SLA; `unitsExported ≥ volumeUnits` → `completed`: `economy.post(+reward, 'contract_revenue',
 *   'contract:<id>')`, pri penalizáciách `post(−penalties, 'penalty', 'contract:<id>')`, XP `round(xpReward × (včas ? 1 :
 *   lateXpFactor))`, `completedContracts += 1` a `ContractCompleted`; včas = `tick ≤ slaDeadlineTick`.
 * - SLA (stavy s `slaRunning`): každý celý deň po `slaDeadlineTick` pripíše `PenaltyApplied { kind: 'late' }`; keď
 *   `tick − slaDeadlineTick > failAfterDaysLate × ticksPerDay` a kontrakt nie je dokončený → `failed`, jediný
 *   `post(−penalties, 'penalty', …)` a `ContractFailed` (odmena prepadá, XP nie).
 * Penalizácie sa strhávajú z hotovosti jednou transakciou až pri `completed`/`failed` (rozhodnutie 6). V ticku sa najprv
 * pripíšu penalizácie, potom sa rozhodne o dokončení a nakoniec o zlyhaní — dokončenie v ticku, keď by kontrakt zlyhal,
 * má prednosť.
 *
 * **Export booking** (F6a, ADR-032; kroky `EXPORT_CONTRACT_STEPS`):
 * - `accepted`: v ticku príchodu lode voyage kontrakt prevezme loď voyage (ak ju už spawnol import kontrakt roundtripu
 *   s nižším id), inak spawne loď s 0 jednotkami (export-only voyage) → `ship_en_route`;
 * - `ship_en_route`: SLA; loď pri kotvisku (alebo už odchádza) → `dockedTick`, `exporting` („Exportuje sa": nakládka);
 * - `exporting`: demurrage (loď stojí pri kotvisku nad `berthAllowanceTicks`), SLA;
 * - vo všetkých stavoch po prijatí: `CutoffWarning` v ticku `cutoffTick − round(cutoffWarningHours × ticksPerHour)` a
 *   `CutoffPassed` v ticku `cutoffTick` (bezstavovo podľa ticku);
 * - po všetkých kontraktoch uvoľnenie VGM hold: jednotky s `untilTick ≤ tick` vzostupne podľa (`untilTick`, id) →
 *   `VgmHoldReleased`.
 * - `exporting`: keď loď opustí kotvisko (`undocking` a ďalej, alebo už nie je na mape) → `closeBooking`: penalizácie
 *   `BookingPenaltyApplied` (last minute, rolled, nesplnený booking), `completed` s výplatou pomerne k naloženým (ak naložená
 *   ≥ 1 jednotka), inak `failed` (ADR-032 bod 14); inak SLA ako import.
 *
 * **Pool ponúk:** import ponuky dopĺňa `refillPool` (`economy.offersPerDay` skupín, pri štarte hry aj pri DayClosed),
 * booking ponuky `refillBookings` (`economy.bookingOffersPerDay` skupín) **len pri DayClosed** a po import ponukách — prvé
 * naplnenie poolu a ťah príchodu pri prijatí v ticku 1 ostávajú bitovo rovnaké ako vo F5 (ADR-032 bod 1).
 */
import { capacityHintFrom, drawBookingOffer, drawOffer, portCapacityOf, type OfferContext } from '../contracts/contract-pool';
import type { Contract } from '../contracts/contract';
import type { ContractKind, ContractState } from '../contracts/contract-fsm';
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
import type { HoldEntry } from '../cargo/hold-index';
import type { ClockBoundaries } from '../core/sim-clock';
import { SHIP_STATE_TRAITS, type ShipState } from '../ships/ship-fsm';
import { spawnShip } from '../ships/spawn-ship';
import type { World } from '../world/world';

/** Prvý tick hry (po `World.create` na ticku 0 ho krok 1 posunie na 1): štart hry = prvé naplnenie poolu. */
export const GAME_START_TICK = 1;

/**
 * Stavy lode, v ktorých už skončila nakládka — loď opustila kotvisko (`undocking`, `outbound`) alebo mapu; uzavretie export bookingu
 * (výplata pomerne k naloženým, penalizácie). `lashing` ešte nie: loď drží kotvisko, demurrage beží (ADR-032 bod 12–14).
 */
const SHIP_LEFT_BERTH: { readonly [S in ShipState]: boolean } = Object.freeze({
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
const SHIP_REACHED_BERTH: { readonly [S in ShipState]: boolean } = Object.freeze({
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

type ContractStep = (contract: Contract, world: World) => void;

/** Loď kontraktu na mape, alebo `undefined` (ešte nevznikla alebo už odplávala). */
function shipOf(world: World, contract: Contract) {
  return contract.shipId === undefined ? undefined : world.ships.get(contract.shipId);
}

/** Pripíše penalizáciu `amountCents` (aj 0 — celé obdobie uplynulo) a emituje `PenaltyApplied`. */
function applyPenalty(world: World, contract: Contract, kind: 'demurrage' | 'late', amountCents: number): void {
  contract.penaltiesCents += amountCents;
  world.events.emit({ type: 'PenaltyApplied', contractId: contract.id, kind, amountCents });
}

/** Demurrage: celé hodiny nad `berthAllowanceTicks` od `dockedTick`, kým loď kontraktu stojí pri kotvisku. */
function accrueDemurrage(world: World, contract: Contract): void {
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
function accrueLate(world: World, contract: Contract): void {
  if (contract.slaDeadlineTick === undefined) return;
  const days = wholePeriods(world.clock.tick, contract.slaDeadlineTick, world.clock.ticksPerDay);
  const step = lateStepCents(contract.rewardCents, world.defs.economy);
  while (contract.lateDays < days) {
    contract.lateDays += 1;
    applyPenalty(world, contract, 'late', step);
  }
}

/** Strhne nasčítané penalizácie jednou transakciou (`penalty`), ak sú > 0. */
function settlePenalties(world: World, contract: Contract): void {
  if (contract.penaltiesCents > 0) world.economy.post(-contract.penaltiesCents, 'penalty', contractRefId(contract));
}

/** `exporting → completed`: výplata, penalizácie, XP, počítadlo dokončených a `ContractCompleted`. */
function complete(world: World, contract: Contract): void {
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
function closeBooking(world: World, contract: Contract): void {
  const booking = contract.booking;
  if (booking === null) return;
  const { economy } = world.defs;
  const booked = contract.volumeUnits;
  const loaded = booking.loadedUnits;
  const reward = contract.rewardCents;
  const penalties: readonly { readonly kind: 'last_minute' | 'rolled' | 'unfulfilled'; readonly units: number; readonly amountCents: number }[] = [
    { kind: 'last_minute', units: booking.lastMinuteUnits, amountCents: bookingUnitsPenaltyCents(reward, booked, booking.lastMinuteUnits, economy.lastMinuteExportRateOfReward) },
    {
      kind: 'rolled',
      units: Math.max(0, booking.arrivedUnits - loaded),
      amountCents: bookingUnitsPenaltyCents(reward, booked, Math.max(0, booking.arrivedUnits - loaded), economy.rolledExportRateOfReward),
    },
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
function failIfOverdue(world: World, contract: Contract): boolean {
  if (contract.slaDeadlineTick === undefined) return false;
  const limit = world.defs.economy.failAfterDaysLate * world.clock.ticksPerDay;
  if (world.clock.tick - contract.slaDeadlineTick <= limit) return false;
  world.contractBook.changeState(contract, 'failed');
  settlePenalties(world, contract);
  world.events.emit({ type: 'ContractFailed', contractId: contract.id, penaltiesCents: contract.penaltiesCents });
  return true;
}

/** Kroky stavov **import** kontraktu (F5, ADR-026). */
const IMPORT_CONTRACT_STEPS: { readonly [S in ContractState]: ContractStep } = {
  offered: () => undefined,
  accepted: (contract, world) => {
    if (contract.shipArrivalTick === undefined || world.clock.tick < contract.shipArrivalTick) return;
    boardVoyageShip(world, contract);
    world.contractBook.changeState(contract, 'ship_en_route');
  },
  ship_en_route: (contract, world) => {
    accrueLate(world, contract);
    const ship = shipOf(world, contract);
    // Loď kontraktu v `ship_en_route` je vždy na mape (invariant kroku 12 `checkContracts`): odísť môže až po vyložení,
    // ktoré začne kotvením — a to krok 2 zachytí v nasledujúcom ticku skôr, ako sa loď stihne vyložiť.
    if (ship !== undefined && SHIP_REACHED_BERTH[ship.state]) {
      contract.dockedTick = world.clock.tick;
      world.contractBook.changeState(contract, 'unloading');
      return;
    }
    failIfOverdue(world, contract);
  },
  unloading: (contract, world) => {
    accrueDemurrage(world, contract);
    accrueLate(world, contract);
    if (contract.unitsUnloaded >= contract.volumeUnits) {
      world.contractBook.changeState(contract, 'exporting');
      return;
    }
    failIfOverdue(world, contract);
  },
  exporting: (contract, world) => {
    accrueLate(world, contract);
    if (contract.unitsExported >= contract.volumeUnits) {
      complete(world, contract);
      return;
    }
    failIfOverdue(world, contract);
  },
  completed: () => undefined,
  failed: () => undefined,
  expired: () => undefined,
};

/**
 * Loď voyage kontraktu `contract` (`accepted → ship_en_route`): loď, ktorú už spawnol kontrakt tej istej voyage v tomto
 * ticku (roundtrip: import s nižším id), inak nová loď s `spawnUnits` jednotkami kontraktu (import `volumeUnits`, export
 * 0) a `voyageId` (ADR-032 bod 1). Spoločné pre import aj export kroky `accepted`.
 */
function boardVoyageShip(world: World, contract: Contract): void {
  for (const mate of world.contractBook.voyageContracts(contract.voyageId)) {
    if (mate !== contract && mate.shipId !== undefined) {
      contract.shipId = mate.shipId;
      return;
    }
  }
  const ship = spawnShip(world, {
    shipClassId: contract.shipClassId,
    cargoTypeId: contract.cargoTypeId,
    units: contract.spawnUnits,
    contractId: contract.id,
    voyageId: contract.voyageId,
  });
  contract.shipId = ship.id;
}

/** `CutoffWarning` a `CutoffPassed` bezstavovo podľa ticku (viď hlavička); kontrakt bez cut-off (import) nič. */
function trackCutoff(world: World, contract: Contract): void {
  const booking = contract.booking;
  if (booking === null || booking.cutoffTick === undefined) return;
  const { tick, ticksPerHour } = world.clock;
  const warning = booking.cutoffTick - Math.round(world.defs.economy.cutoffWarningHours * ticksPerHour);
  if (tick === warning) world.events.emit({ type: 'CutoffWarning', contractId: contract.id, cutoffTick: booking.cutoffTick });
  if (tick === booking.cutoffTick) {
    world.events.emit({ type: 'CutoffPassed', contractId: contract.id, arrivedUnits: booking.arrivedUnits, bookedUnits: booking.bookedUnits });
  }
}

const idle: ContractStep = () => undefined;

/**
 * Kroky stavov **export** bookingu (ADR-032; viď hlavička súboru). Uzavretie bookingu pri odchode lode dodá T6A-05.
 */
const EXPORT_CONTRACT_STEPS: { readonly [S in ContractState]: ContractStep } = {
  offered: idle,
  accepted: (contract, world) => {
    trackCutoff(world, contract);
    if (contract.shipArrivalTick === undefined || world.clock.tick < contract.shipArrivalTick) return;
    boardVoyageShip(world, contract);
    world.contractBook.changeState(contract, 'ship_en_route');
  },
  ship_en_route: (contract, world) => {
    trackCutoff(world, contract);
    accrueLate(world, contract);
    const ship = shipOf(world, contract);
    if (ship !== undefined && SHIP_REACHED_BERTH[ship.state]) {
      contract.dockedTick = world.clock.tick;
      world.contractBook.changeState(contract, 'exporting');
      return;
    }
    failIfOverdue(world, contract);
  },
  unloading: idle,
  exporting: (contract, world) => {
    trackCutoff(world, contract);
    accrueDemurrage(world, contract);
    accrueLate(world, contract);
    const ship = shipOf(world, contract);
    if (ship === undefined || SHIP_LEFT_BERTH[ship.state]) {
      closeBooking(world, contract);
      return;
    }
    failIfOverdue(world, contract);
  },
  completed: idle,
  failed: idle,
  expired: idle,
};

/** Kroky podľa druhu kontraktu (tabuľka, nie switch). */
const CONTRACT_STEPS: { readonly [K in ContractKind]: { readonly [S in ContractState]: ContractStep } } = {
  import: IMPORT_CONTRACT_STEPS,
  export: EXPORT_CONTRACT_STEPS,
};

/**
 * Neukončené kontrakty vzostupne podľa id do znovupoužiteľného poľa `into` (najprv ho vyprázdni). Snímka je nutná:
 * prechody do konečného stavu mažú kontrakt z prebiehajúcich počas prechodu.
 */
function snapshotOpen(world: World, into: Contract[]): Contract[] {
  into.length = 0;
  for (const contract of world.contractBook.openContracts.values()) into.push(contract);
  return into;
}

export class ContractSystem {
  /** Znovupoužiteľná snímka neukončených kontraktov (hot path bez alokácie; nie je stav simulácie). */
  private readonly open: Contract[] = [];
  /** Doplnenie poolu už v tejto inštancii prebehlo (pokus pre nedotknutú knihu len raz; viď hlavička, T06-08b). */
  private refilled = false;

  /** Krok 2 (viď hlavička súboru). */
  tick(world: World, closed: ClockBoundaries): void {
    const open = snapshotOpen(world, this.open);
    for (let i = 0; i < open.length; i++) {
      const contract = open[i];
      CONTRACT_STEPS[contract.kind][contract.state](contract, world);
    }
    releaseVgmHolds(world);
    if (closed.dayClosed) expireOffers(world, open);
    open.length = 0;
    if (closed.dayClosed || world.clock.tick === GAME_START_TICK || (world.contractBook.untouched && !this.refilled)) {
      this.refilled = true;
      refillPool(world);
    }
    if (closed.dayClosed) refillBookings(world);
  }
}

/**
 * Ponuky s `offerExpiresTick ≤ tick` vzostupne podľa id → `expired` + `ContractExpired { reason: 'timeout' }`.
 * `scratch` = znovupoužiteľné pole na snímku neukončených kontraktov (bez neho nové).
 */
export function expireOffers(world: World, scratch: Contract[] = []): void {
  const book = world.contractBook;
  const { tick } = world.clock;
  const open = snapshotOpen(world, scratch);
  for (let i = 0; i < open.length; i++) {
    const contract = open[i];
    if (contract.state !== 'offered' || tick < contract.offerExpiresTick) continue;
    book.changeState(contract, 'expired');
    world.events.emit({ type: 'ContractExpired', contractId: contract.id, reason: 'timeout' });
  }
}

/** Kontext ponuky pre `drawOffer` / `drawBookingOffer` z aktuálneho stavu sveta (kapacity prístavu, tier, id z knihy). */
function offerContextOf(world: World): OfferContext {
  const { defs, clock, contractBook: book } = world;
  const capacity = portCapacityOf(world.modules.values(), world.stats, clock.ticksPerDay);
  return {
    defs,
    rng: world.rng,
    tick: clock.tick,
    ticksPerDay: clock.ticksPerDay,
    tier: book.tier(defs.economy.contractsPerTier),
    capacityHint: capacityHintFrom(capacity, defs.economy.minCapacityHint),
    storageCapacity: capacity.storageCapacity,
    nextId: () => book.allocateId(),
    nextVoyageId: () => book.allocateVoyageId(),
  };
}

/**
 * Doplní pool import ponúk do `offersPerDay` skupín (poradie a spotreba `Rng`: `drawOffer`); každá nová ponuka
 * `ContractOffered`. Booking ponuky (skupiny s exportom) sa nepočítajú — dopĺňa ich `refillBookings`.
 */
export function refillPool(world: World): void {
  const { defs, contractBook: book } = world;
  const missing = defs.economy.offersPerDay - book.offeredGroups().import;
  if (missing <= 0) return;
  const context = offerContextOf(world);
  for (let i = 0; i < missing; i++) {
    const offer = drawOffer(context);
    if (offer === null) return;
    book.add(offer);
    world.events.emit({ type: 'ContractOffered', contractId: offer.id });
  }
}

/**
 * Doplní pool booking ponúk do `bookingOffersPerDay` skupín (ADR-032 bod 1): skupina = export booking alebo roundtrip
 * (import + export jednej voyage, kontrakty vzostupne podľa id, každý `ContractOffered`). Spotreba `Rng`: `drawBookingOffer`.
 * Volá ju krok 2 po `refillPool` a len pri `DayClosed`.
 */
export function refillBookings(world: World): void {
  const { defs, contractBook: book } = world;
  const missing = defs.economy.bookingOffersPerDay - book.offeredGroups().booking;
  if (missing <= 0) return;
  const context = offerContextOf(world);
  for (let i = 0; i < missing; i++) {
    const group = drawBookingOffer(context);
    if (group.length === 0) return;
    for (const offer of group) {
      book.add(offer);
      world.events.emit({ type: 'ContractOffered', contractId: offer.id });
    }
  }
}

/** Zoznam splatných VGM hold sa berie do znovupoužiteľného poľa (hot path bez alokácie; nie je stav simulácie). */
const DUE_HOLDS: HoldEntry[] = [];

/**
 * Uvoľní VGM hold jednotiek, ktorým `untilTick ≤ tick` (`HoldIndex.takeDue`, vzostupne podľa `untilTick`, potom id):
 * `CargoLedger.setHold(unit, null)`, počítadlo `heldUnits` kontraktu a `VgmHoldReleased`. Jednotka, ktorá medzitým
 * opustila mapu (vrátenie odosielateľovi), alebo už nemá tento hold, sa preskočí.
 */
function releaseVgmHolds(world: World): void {
  world.holdIndex.takeDue(world.clock.tick, DUE_HOLDS);
  for (const entry of DUE_HOLDS) {
    const unit = world.cargo.get(entry.unitId);
    if (unit === undefined || unit.hold === null || unit.hold.untilTick !== entry.untilTick || unit.contractId === null) continue;
    world.cargo.setHold(unit.id, null);
    world.contractBook.get(unit.contractId)?.recordHold(-1);
    world.events.emit({ type: 'VgmHoldReleased', contractId: unit.contractId, unitId: unit.id });
  }
  DUE_HOLDS.length = 0;
}
