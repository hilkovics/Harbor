/**
 * ContractSystem — krok 2 ticku (ARCHITECTURE §6, §9.1; docs/tasks/phase-05.md rozhodnutia 4–8; ADR-026): spawn lodí
 * prijatých kontraktov, sledovanie lode, SLA, penalizácie, dokončenie, zlyhanie, expirácia ponúk a doplnenie poolu.
 *
 * Poradie v kroku: (1) neukončené kontrakty vzostupne podľa id, každý jeden krok podľa stavu z tabuľky
 * `CONTRACT_STEPS` (nie switch); (2) **denná obnova poolu** pri `DayClosed`: ponuky s `offerExpiresTick ≤ tick`
 * vzostupne podľa id → `expired` + `ContractExpired { reason: 'timeout' }` (kniha ich zabudne) a potom doplnenie do
 * `offersPerDay`; (3) pri štarte hry (`GAME_START_TICK`, prvý tick po `World.create`) len doplnenie. Ponuka teda zanikne
 * v prvej uzávierke dňa v čase `offerExpiresTick` alebo po ňom (najneskôr o deň) a jej miesto hneď zaberie nová — tabuľa
 * ponúk sa mení raz denne (ponuky z polnoci expirujú presne v `offerExpiresTick`, prvá dávka zo štartu v najbližšej
 * polnoci po ňom, `offerClosingTick`). Pool sa nedopĺňa inokedy — ani po načítaní starého save (migrácia v4 → v5), ani
 * po `DeclineContract`.
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
 */
import { capacityHintFrom, drawOffer, portCapacityOf } from '../contracts/contract-pool';
import type { Contract } from '../contracts/contract';
import type { ContractState } from '../contracts/contract-fsm';
import { contractXpGain, demurrageStepCents, lateStepCents, wholePeriods } from '../contracts/contract-terms';
import type { ClockBoundaries } from '../core/sim-clock';
import { SHIP_STATE_TRAITS, type ShipState } from '../ships/ship-fsm';
import { spawnShip } from '../ships/spawn-ship';
import type { World } from '../world/world';

/** Prvý tick hry (po `World.create` na ticku 0 ho krok 1 posunie na 1): štart hry = prvé naplnenie poolu. */
export const GAME_START_TICK = 1;

/** Stavy lode, v ktorých už kotvila (stojí pri kotvisku alebo odchádza) — `ship_en_route → unloading`. */
const SHIP_REACHED_BERTH: { readonly [S in ShipState]: boolean } = Object.freeze({
  arriving: false,
  inbound: false,
  waiting_anchorage: false,
  berthing: false,
  docked: true,
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

const CONTRACT_STEPS: { readonly [S in ContractState]: ContractStep } = {
  offered: () => undefined,
  accepted: (contract, world) => {
    if (contract.shipArrivalTick === undefined || world.clock.tick < contract.shipArrivalTick) return;
    const ship = spawnShip(world, { shipClassId: contract.shipClassId, cargoTypeId: contract.cargoTypeId, units: contract.volumeUnits, contractId: contract.id });
    contract.shipId = ship.id;
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

  /** Krok 2 (viď hlavička súboru). */
  tick(world: World, closed: ClockBoundaries): void {
    const open = snapshotOpen(world, this.open);
    for (let i = 0; i < open.length; i++) {
      const contract = open[i];
      CONTRACT_STEPS[contract.state](contract, world);
    }
    if (closed.dayClosed) expireOffers(world, open);
    open.length = 0;
    if (closed.dayClosed || world.clock.tick === GAME_START_TICK) refillPool(world);
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

/** Doplní pool do `offersPerDay` ponúk (poradie a spotreba `Rng`: `drawOffer`); každá nová ponuka `ContractOffered`. */
export function refillPool(world: World): void {
  const { defs, clock, contractBook: book } = world;
  const missing = defs.economy.offersPerDay - book.offeredCount;
  if (missing <= 0) return;
  const capacity = portCapacityOf(world.modules.values(), world.stats, clock.ticksPerDay);
  const context = {
    defs,
    rng: world.rng,
    tick: clock.tick,
    ticksPerDay: clock.ticksPerDay,
    tier: book.tier(defs.economy.contractsPerTier),
    capacityHint: capacityHintFrom(capacity, defs.economy.minCapacityHint),
    storageCapacity: capacity.storageCapacity,
    nextId: () => book.allocateId(),
  };
  for (let i = 0; i < missing; i++) {
    const offer = drawOffer(context);
    if (offer === null) return;
    book.add(offer);
    world.events.emit({ type: 'ContractOffered', contractId: offer.id });
  }
}
