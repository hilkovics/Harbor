/**
 * ContractSystem — krok 2 ticku (ARCHITECTURE §6, §9.1; docs/tasks/phase-05.md rozhodnutia 4–8; ADR-026): spawn lodí
 * prijatých kontraktov, sledovanie lode, SLA, penalizácie, dokončenie, zlyhanie, expirácia ponúk a doplnenie poolu.
 *
 * Poradie v kroku: (1) neukončené kontrakty vzostupne podľa id, každý jeden krok podľa druhu a stavu z tabuľky
 * `CONTRACT_STEPS` (nie switch; export booking ADR-032 — kroky dopĺňa T6A-04); (2) **denná obnova poolu** pri `DayClosed`: ponuky s `offerExpiresTick ≤ tick`
 * vzostupne podľa id → `expired` + `ContractExpired { reason: 'timeout' }` (kniha ich zabudne) a potom doplnenie do
 * `offersPerDay`; (3) pri štarte hry (`GAME_START_TICK`, prvý tick po `World.create`) len doplnenie — a rovnako
 * v prvom ticku po načítaní save uloženého pred prvým tickom (kniha ešte nepridelila žiadne id,
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
 *   `VgmHoldReleased`;
 * - potom opravy prázdnych kontajnerov v depách (F6c, ADR-034; `EmptyDepotService`): skončené opravy (`EmptyRepaired`, poplatok
 *   `maintenance_repair`) a nové opravy poškodených jednotiek (`EmptyRepairStarted`).
 * - `exporting`: keď loď opustí kotvisko (`undocking` a ďalej, alebo už nie je na mape) → `closeBooking`: penalizácie
 *   `BookingPenaltyApplied` (last minute, rolled, nesplnený booking), `completed` s výplatou pomerne k naloženým (ak naložená
 *   ≥ 1 jednotka), inak `failed` (ADR-032 bod 14); inak SLA ako import.
 *
 * **Repositioning prázdnych a prekládka** (F6c, ADR-034 + dodatok T6C-03): repositioning (`empty_repositioning`) je export booking bez cut-off — jeho kroky
 * sú kroky exportu (`EXPORT_CONTRACT_STEPS`; loď voyage príde, pri kotvisku nakladá prázdne z depa, booking sa uzavrie pri jej odchode pomerne
 * k naloženým); prekládka má vlastné kroky `TRANSHIP_CONTRACT_STEPS` (`tranship-steps.ts`: loď A, vykládka, loď B, zmeškanie, záchrana, predaj).
 * Spoločné pomocné kroky (SLA, demurrage, `closeBooking`, loď voyage) sú v `contract-steps.ts`. Ponuky nových druhov dopĺňa `refillRepositioning` a `refillTranship`
 * (len pri `DayClosed`, po booking ponukách a len v prístave s depom prázdnych).
 *
 * **Pool ponúk:** import ponuky dopĺňa `refillPool` (`economy.offersPerDay` skupín, pri štarte hry aj pri DayClosed),
 * booking ponuky `refillBookings` (`economy.bookingOffersPerDay` skupín) **len pri DayClosed** a po import ponukách — prvé
 * naplnenie poolu a ťah príchodu pri prijatí v ticku 1 ostávajú bitovo rovnaké ako vo F5 (ADR-032 bod 1).
 */
import { capacityHintFrom, drawBookingOffer, drawOffer, drawRepositioningOffer, drawTranshipOffer, portCapacityOf, type OfferContext } from '../contracts/contract-pool';
import type { Contract } from '../contracts/contract';
import type { ContractKind, ContractState } from '../contracts/contract-fsm';
import type { HoldEntry } from '../cargo/hold-index';
import type { ClockBoundaries } from '../core/sim-clock';
import { EmptyDepotService } from '../logistics/empty-depot-service';
import { hasEmptyDepot } from '../logistics/empty-stock';
import { loadingInFlight, loadingStopped } from '../logistics/voyage-cargo';
import { YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';
import {
  SHIP_LEFT_BERTH,
  SHIP_REACHED_BERTH,
  accrueDemurrage,
  accrueLate,
  boardVoyageShip,
  closeBooking,
  complete,
  contractRefId,
  failIfOverdue,
  idle,
  shipOf,
  type ContractStep,
} from './contract-steps';
import { TRANSHIP_CONTRACT_STEPS } from './tranship-steps';

export { contractRefId };

/** Prvý tick hry (po `World.create` na ticku 0 ho krok 1 posunie na 1): štart hry = prvé naplnenie poolu. */
export const GAME_START_TICK = 1;

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
    // Lehota po SLA uplynula počas nakládky: booking sa neskončí ako `failed` s nákladom na palube (výplata a vrátenie nenaložených
    // by sa preskočili). Nové joby nakládky sa už nezačínajú (`loadingStopped`), rozbehnutá nakládka sa dokončí a potom sa booking
    // uzavrie ako pri odchode lode — pomerná výplata, `failed` len bez naloženej jednotky; loď odíde (`dockedVerdict`) a export na
    // palube je `shipped`.
    if (loadingStopped(world, contract) && !loadingInFlight(world, contract, ship)) closeBooking(world, contract);
  },
  completed: idle,
  failed: idle,
  expired: idle,
};

/**
 * Kroky podľa druhu kontraktu (tabuľka, nie switch). Repositioning prázdnych je export booking bez cut-off (loď voyage príde,
 * pri kotvisku nakladá a booking sa uzavrie pri jej odchode — kroky exportu sú pre neho správne), prekládka má vlastné kroky.
 */
const CONTRACT_STEPS: { readonly [K in ContractKind]: { readonly [S in ContractState]: ContractStep } } = {
  import: IMPORT_CONTRACT_STEPS,
  export: EXPORT_CONTRACT_STEPS,
  empty_repositioning: EXPORT_CONTRACT_STEPS,
  tranship: TRANSHIP_CONTRACT_STEPS,
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
  /** Opravy prázdnych kontajnerov v depách (F6c, ADR-034); cache zoznamu dep, nie stav simulácie. */
  private readonly depots = new EmptyDepotService();
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
    this.depots.tick(world);
    if (closed.dayClosed) expireOffers(world, open);
    open.length = 0;
    if (closed.dayClosed || world.clock.tick === GAME_START_TICK || (world.contractBook.untouched && !this.refilled)) {
      this.refilled = true;
      refillPool(world);
    }
    if (closed.dayClosed) {
      refillBookings(world);
      refillRepositioning(world);
      refillTranship(world);
    }
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
    poweredSupply: [...world.modules.values()].some((module) => module instanceof YardBlock && module.hasSockets),
    railSupply: world.hasRailService,
    oogSupply: [...world.modules.values()].some((module) => module instanceof YardBlock && module.acceptsOog),
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

/** Ponuky `group` (jedna skupina kontraktov jednej voyage za ťah `draw`) do `target` skupín; každý nový kontrakt `ContractOffered`. */
function refillGroups(world: World, missing: number, draw: (context: OfferContext) => Contract[]): void {
  if (missing <= 0) return;
  const context = offerContextOf(world);
  for (let i = 0; i < missing; i++) {
    const group = draw(context);
    if (group.length === 0) return;
    for (const offer of group) {
      world.contractBook.add(offer);
      world.events.emit({ type: 'ContractOffered', contractId: offer.id });
    }
  }
}

/**
 * Doplní pool ponúk repositioningu prázdnych do `repositioningOffersPerDay` skupín (ADR-034): len pri `DayClosed`, po booking ponukách a
 * **len v prístave s depom prázdnych** (bez depa by ponuka nešla prijať — `no_storage_for_category` — a `Rng` by sa zbytočne spotreboval; svet
 * bez depa ostáva bitovo rovnaký ako vo F6a). Spotreba `Rng`: `drawRepositioningOffer`.
 */
export function refillRepositioning(world: World): void {
  if (!hasEmptyDepot(world)) return;
  refillGroups(world, world.defs.economy.repositioningOffersPerDay - world.contractBook.offeredGroups().repositioning, drawRepositioningOffer);
}

/**
 * Doplní pool ponúk prekládky do `transhipOffersPerDay` skupín (ADR-034): ako `refillRepositioning` len pri `DayClosed`, po ponukách repositioningu
 * a v prístave s depom prázdnych (spúšťač obsahu F6c, dodatok T6C-03). Spotreba `Rng`: `drawTranshipOffer`.
 */
export function refillTranship(world: World): void {
  if (!hasEmptyDepot(world)) return;
  refillGroups(world, world.defs.economy.transhipOffersPerDay - world.contractBook.offeredGroups().tranship, drawTranshipOffer);
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
