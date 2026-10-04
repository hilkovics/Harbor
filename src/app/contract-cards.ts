/**
 * Karty kontraktov pre `ContractsPanel` (T05-07): čistá projekcia `world.contracts` do `ContractCardData[]` z `@ui`.
 *
 * - Názvy nákladu (kategória → `CARGO_CATEGORY_TEXT`, kapitalizované) a jednotka (`unitName`) sú z defov nákladu,
 *   názov triedy lode je `displayName` z `ships.json`.
 * - `offerExpiresTick` je skutočný tick zániku ponuky (`offerClosingTick`: pool sa obnovuje raz denne), `slaWindowTicks`
 *   je `slaDays × ticksPerDay`.
 * - `disabledReason` (len ponuka) je text prvého dôvodu z `validate` príkazu `AcceptContract` (`REASON_TEXT`, pri repositioningu
 *   a prekládke `KIND_REASON_TEXT`), takže UI neduplikuje pravidlá simu (dnes: `game_over`, pozemná strana, žeriav).
 * - Poradie: ponuky a prebiehajúce vzostupne podľa id, história (splnené / zlyhané) od najnovšej.
 * - F6a (ADR-032): karta nesie `kind` a `voyageId` (panel zoskupí kontrakty jednej voyage do spoločnej karty roundtripu),
 *   export booking aj `booking` (cieľ, cut-off, dovezené / naložené, zadržané VGM, rolled, vrátené, zostávajúce príchody).
 *   `disabledReason` má každý kontrakt ponuky osobitne (panel ukáže prvý dôvod zo skupiny).
 * - F6c (T6C-05, ADR-034): karta nesie `line` (linka z `lines.json`: názov a token farby), druh `empty_repositioning` /
 *   `tranship` s vlastným tvarom — repositioning `availableEmpties` (dostupné prázdne linky v prístave, `terminalEmptySplit`),
 *   prekládka `tranship` (plavba lode B, príchod B alebo rozstup príchodu pre ponuku, lehota záchrany zmeškanej prekládky).
 */
import { AcceptContractCommand, type ValidationReason } from '@sim/commands';
import { offerClosingTick, type Contract, type ContractKind, type ExportBooking, type TranshipLeg } from '@sim/contracts';
import { terminalEmptySplit, type LineStatusSplit, type World } from '@sim/world';
import type { ContractBookingData, ContractCardData, ContractLineData, ContractTranshipData, ContractsTimeScale } from '@ui/contracts-panel';
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

/** Pozemná strana repositioningu a prekládky: kontrola `AcceptContract` je rovnaká ako pri exporte, text dôvodu je pre druh vecný. */
function landsideReasonText(noun: string): Readonly<Partial<Record<ValidationReason, string>>> {
  return {
    no_ramp_for_category: `Pre ${noun} chýba rampa na tento náklad`,
    ramp_inoperative: `Pre ${noun} nie je prevádzková rampa (brána, stojisko, cesta)`,
  };
}

/**
 * Texty dôvodov odmietnutia špecifické pre druh kontraktu (nad rámec `REASON_TEXT`; tabuľka, nie switch): repositioning potrebuje
 * depo prázdnych (sim použil `no_storage_for_category`, ADR-034 bod 10), prekládka sklad na vyloženú prekládku.
 */
export const KIND_REASON_TEXT: Readonly<Partial<Record<ContractKind, Readonly<Partial<Record<ValidationReason, string>>>>>> = {
  empty_repositioning: {
    ...landsideReasonText('výdaj prázdnych'),
    no_storage_for_category: 'Chýba depo prázdnych kontajnerov (postav depo prázdnych pri rampe)',
  },
  tranship: {
    ...landsideReasonText('prekládku'),
    no_storage_for_category: 'Pre prekládku nie je dosiahnuteľný sklad na tento náklad',
  },
};

/** Text dôvodu odmietnutia pre druh kontraktu (špecifický, inak všeobecný z `REASON_TEXT`). */
export function reasonText(kind: ContractKind, reason: ValidationReason): string {
  return KIND_REASON_TEXT[kind]?.[reason] ?? REASON_TEXT[reason];
}

/** Text dôvodu, prečo sa ponuku nedá prijať; `undefined`, ak sa dá (alebo nejde o ponuku). */
export function acceptDisabledReason(world: World, contract: Contract): string | undefined {
  if (contract.state !== 'offered') return undefined;
  const verdict = new AcceptContractCommand(contract.id).validate(world);
  const reason = verdict.reasons[0];
  return verdict.ok || reason === undefined ? undefined : reasonText(contract.kind, reason);
}

/** Linka kontraktu (názov a token farby z `lines.json`); neznáme `lineId` (nemalo by nastať) sa ukáže pod svojím id so šedou farbou. */
export function contractLine(world: World, lineId: string): ContractLineData {
  const { lines } = world.defs;
  if (!lines.has(lineId)) return { id: lineId, label: lineId, colorToken: '' };
  const line = lines.get(lineId);
  return { id: line.id, label: line.displayName, colorToken: line.colorToken };
}

/**
 * Odstup cut-off od príchodu lode v tickoch (`economy.cutoffHours` × ticky za hodinu; rovnaké zaokrúhlenie ako pri
 * plánovaní bookingu v `Contract.accept`). Ponuka s ním ukáže „Cut-off 12 h pred príchodom lode“.
 */
export function cutoffLeadTicks(world: World): number {
  return Math.round(world.defs.economy.cutoffHours * world.clock.ticksPerHour);
}

/** Booking export-podobného kontraktu pre kartu; `cutoffLeadTicks` len pred prijatím exportu (potom je cut-off konkrétny tick). */
function bookingData(world: World, contract: Contract, booking: ExportBooking): ContractBookingData {
  // Repositioning a prekládka cut-off nemajú (ADR-034): ani odstup, ani tick.
  const cutoff =
    booking.cutoffTick !== undefined ? { cutoffTick: booking.cutoffTick } : contract.kind === 'export' ? { cutoffLeadTicks: cutoffLeadTicks(world) } : {};
  return {
    destinationPort: booking.destinationPort,
    ...cutoff,
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

/** Rozstup príchodu lode B po lodi A v tickoch `[min, max]` (`economy.transhipGapDaysRange`) — pre ponuku, ktorá ešte nemá plán. */
function transhipGapTicks(world: World): readonly [number, number] {
  const [minDays, maxDays] = world.defs.economy.transhipGapDaysRange;
  const { ticksPerDay } = world.clock;
  return [Math.round(minDays * ticksPerDay), Math.round(maxDays * ticksPerDay)];
}

/** Trasa prekládky pre kartu: plavba lode B a jej príchod (po prijatí) alebo rozstup (ponuka); lehota záchrany zmeškanej prekládky. */
function transhipData(world: World, leg: TranshipLeg): ContractTranshipData {
  return {
    outVoyageId: leg.outVoyageId,
    ...(leg.outArrivalTick === undefined ? { outGapTicks: transhipGapTicks(world) } : { outArrivalTick: leg.outArrivalTick }),
    ...(leg.rescueDeadlineTick === undefined ? {} : { rescueDeadlineTick: leg.rescueDeadlineTick }),
  };
}

/** Dostupné prázdne kontajnery linky (stav `available`) v prístave z celoprístavného rozdelenia. */
function availableOf(split: readonly LineStatusSplit[], lineId: string): number {
  return split.find((line) => line.lineId === lineId)?.available ?? 0;
}

/**
 * Karta jedného kontraktu (viď hlavička súboru). `emptySplit` = uskladnené prázdne celého prístavu (`terminalEmptySplit`); `contractCards`
 * ho počíta raz pre všetky karty repositioningu, samostatné volanie ho dopočíta.
 */
export function contractCard(world: World, contract: Contract, emptySplit?: readonly LineStatusSplit[]): ContractCardData {
  const { defs, clock } = world;
  const cargo = defs.cargoTypes.get(contract.cargoTypeId);
  const ship = defs.ships.get(contract.shipClassId);
  const disabledReason = acceptDisabledReason(world, contract);
  const { booking, tranship } = contract;
  const repositioning = contract.kind === 'empty_repositioning' && !isClosed(contract);
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
    line: contractLine(world, contract.lineId),
    ...(disabledReason === undefined ? {} : { disabledReason }),
    ...(booking === null ? {} : { booking: bookingData(world, contract, booking) }),
    ...(tranship === null ? {} : { tranship: transhipData(world, tranship) }),
    ...(repositioning ? { availableEmpties: availableOf(emptySplit ?? terminalEmptySplit(world), contract.lineId) } : {}),
  };
}

/** Karty všetkých kontraktov sveta v poradí z hlavičky súboru. */
export function contractCards(world: World): readonly ContractCardData[] {
  const open: Contract[] = [];
  const closed: Contract[] = [];
  for (const contract of world.contracts.values()) (isClosed(contract) ? closed : open).push(contract);
  // História od najnovšej (uzavretie, potom id); `world.contracts` ide vzostupne podľa id, takže `open` netreba radiť.
  closed.sort((a, b) => (b.closedTick ?? 0) - (a.closedTick ?? 0) || b.id - a.id);
  // Rozdelenie prázdnych je O(živé jednotky): len ak je otvorený repositioning, a raz pre všetky karty.
  const emptySplit = open.some((contract) => contract.kind === 'empty_repositioning') ? terminalEmptySplit(world) : undefined;
  return Object.freeze([...open, ...closed].map((contract) => contractCard(world, contract, emptySplit)));
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
