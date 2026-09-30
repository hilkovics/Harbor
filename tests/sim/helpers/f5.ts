/**
 * Pomocníci testov fázy 5 (T05-05, TDD): kontrakty, ekonomika a ledger, vertikálny rez.
 *
 * Píše sa proti „Spoločným rozhraniam" z `docs/tasks/phase-05.md` ešte pred T05-02..T05-04. Kde API v simu ešte nie je
 * (`world.economy`, `world.contracts`, `world.xp`, `world.completedContracts`, `world.tier`, `world.gameOver`, udalosti
 * `Contract*`, `PenaltyApplied`, `MonthlyReport`, `GameOver`), ide prístup cez úzke lokálne rozhrania nižšie a chýbajúce
 * API sa ohlási zrozumiteľnou chybou („chýba API: …") namiesto `TypeError` o `undefined`. Keď sa API zmení, upravuje sa
 * jediné miesto — tento súbor. Žiadne `@ts-*` komentáre ani `eslint-disable`.
 *
 * Očakávané hodnoty vzorcov (`expected*`) sa počítajú z defov, nie z implementácie:
 *  - peniaze sú celé centy, sadzby v bázických bodoch (`rateBp`, 1 bp = 1/10 000), zaokrúhľuje sa nadol;
 *  - `urgencyBp = 10 000 + ⌊urgencyFactorBp × (maxSla − sla) / maxSla⌋`, `maxSla` = najväčšie `slaDaysRange[1]` šablón;
 *  - `reward = ⌊volume × basePricePerUnitCents × urgencyBp / 10 000⌋`;
 *  - demurrage za celú hodinu = `⌊reward × demurrageBp / 10 000⌋`, late za celý deň = `⌊reward × lateBp / 10 000⌋`;
 *  - XP pri dokončení = `xpReward` (včas) alebo `round(xpReward × lateXpFactor)` (po SLA).
 *
 * `Run5` je náprotivok `Recorder4`: po **každom** ticku `assertCargoConservation(world)` (CLAUDE.md, pravidlo 2),
 * voliteľne nezávislý audit ledgera a jobov z F4, a k tomu invarianty peňazí (hotovosť = štart + Σ `MoneyChanged`,
 * každá zmena má záznam v ledgeri) a kontraktov (FSM podľa tabuľky, počítadlá jednotiek, veľkosť poolu, XP, tier).
 */
import shipsJson from '@data/defs/ships.json';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry, craneParams, storageParams } from '@sim/defs';
import type { LedgerCategory } from '@sim/economy';
import type { SimEvent } from '@sim/events';
import { World } from '@sim/world';
import { DEFS, MAP, RAW_DEFS } from '../world/world-fixtures';
import { auditJobsF4, auditLedgerF4 } from './f4';
import { f4Scenario, type F4Options } from './f4-layout';
import { cranesOf, type TimedEvent } from './harbor';
import { assertCargoConservation } from './invariants';
import { runScenario, type Scenario, type ScenarioEntry } from './scenario';
import { storageModulesOf } from './f3';

export { DEFS, MAP, RAW_DEFS };

// ---------------------------------------------------------------------------------------------------------
// Čas (z `time.json`, nie z implementácie)
// ---------------------------------------------------------------------------------------------------------

export const TICKS_PER_HOUR = 3600 / DEFS.time.tickGameSeconds;
export const TICKS_PER_DAY = 24 * TICKS_PER_HOUR;
export const DAYS_PER_MONTH = 30;
export const TICKS_PER_MONTH = DAYS_PER_MONTH * TICKS_PER_DAY;

// ---------------------------------------------------------------------------------------------------------
// Úzke lokálne rozhrania (Spoločné rozhrania z docs/tasks/phase-05.md)
// ---------------------------------------------------------------------------------------------------------

export const CONTRACT_STATES = ['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting', 'completed', 'failed', 'expired'] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

/** `Contract` z `src/sim/contracts` (T05-03) — len polia, ktoré testy čítajú. */
export interface ContractLike {
  readonly id: EntityId;
  readonly templateId: string;
  readonly cargoTypeId: string;
  readonly volumeUnits: number;
  readonly rewardCents: number;
  readonly xpReward: number;
  readonly offeredTick: number;
  readonly offerExpiresTick: number;
  readonly acceptedTick?: number;
  readonly shipClassId: string;
  readonly shipId?: EntityId;
  readonly shipArrivalTick?: number;
  readonly slaDeadlineTick?: number;
  readonly unitsUnloaded: number;
  readonly unitsExported: number;
  readonly penaltiesCents: number;
  readonly state: ContractState;
}

export interface LedgerEntryLike {
  readonly tick: number;
  readonly amountCents: number;
  readonly category: LedgerCategory;
  readonly refId?: string;
}

/** `DaySummary` (§9.2); `expenseCents` môže byť uložené ako kladná veľkosť, preto sa číta cez `Math.abs` (`expenseOf`). */
export interface DaySummaryLike {
  readonly day: number;
  readonly incomeCents: Readonly<Partial<Record<LedgerCategory, number>>>;
  readonly expenseCents: Readonly<Partial<Record<LedgerCategory, number>>>;
  readonly cashEndCents: number;
}

/** `MonthSummary` — predpoklad: rovnaké polia ako `DaySummary` (agregát mesiaca). */
export type MonthSummaryLike = DaySummaryLike;

export interface EconomyLike {
  readonly cashCents: number;
  post(amountCents: number, category: LedgerCategory, refId?: string): void;
  readonly entries: readonly LedgerEntryLike[];
  readonly daily: readonly DaySummaryLike[];
  readonly monthly: readonly MonthSummaryLike[];
  todayDeltaCents(): number;
  readonly daysNegative: number;
}

interface World5 {
  readonly contracts?: ReadonlyMap<EntityId, ContractLike>;
  readonly economy?: EconomyLike;
  readonly xp?: number;
  readonly completedContracts?: number;
  readonly tier?: number;
  readonly gameOver?: boolean;
}

const view5 = (world: World): World5 => world as unknown as World5;

function need<T>(value: T | undefined, api: string): T {
  if (value === undefined) throw new Error(`chýba API: ${api}`);
  return value;
}

/** `world.contracts` (T05-03) — všetky kontrakty vo všetkých stavoch, ktoré sim drží. */
export const contractsOf = (world: World): ReadonlyMap<EntityId, ContractLike> => need(view5(world).contracts, 'world.contracts (T05-03: Contract + World.contracts)');
/** `world.economy` (T05-02). */
export const economyOf = (world: World): EconomyLike => need(view5(world).economy, 'world.economy (T05-02: Economy + Ledger)');
/** Hotovosť sveta v centoch — jediný zdroj pravdy je `world.economy.cashCents` (T05-02). */
export const cashOf = (world: World): number => economyOf(world).cashCents;
export const xpOf = (world: World): number => need(view5(world).xp, 'world.xp (T05-03)');
export const completedOf = (world: World): number => need(view5(world).completedContracts, 'world.completedContracts (T05-03)');
export const tierOf = (world: World): number => need(view5(world).tier, 'world.tier (T05-03)');
export const gameOverOf = (world: World): boolean => need(view5(world).gameOver, 'world.gameOver (T05-04)');

/** Kontrakty v poradí id. */
export function contractList(world: World): ContractLike[] {
  return [...contractsOf(world).values()].sort((a, b) => a.id - b.id);
}

/** Kontrakty v danom stave v poradí id. */
export function contractsInState(world: World, state: ContractState): ContractLike[] {
  return contractList(world).filter((contract) => contract.state === state);
}

/** Otvorené ponuky (`offered`) v poradí id. */
export const offeredContracts = (world: World): ContractLike[] => contractsInState(world, 'offered');

/** Kontrakt podľa id; chyba s vysvetlením, ak ho sim nedrží. */
export function contractById(world: World, id: EntityId | number): ContractLike {
  const contract = contractsOf(world).get(id as EntityId);
  if (contract === undefined) throw new Error(`kontrakt ${String(id)} nie je vo world.contracts (ids: ${[...contractsOf(world).keys()].join(', ')})`);
  return contract;
}

/** Stav kontraktu; `expired` aj vtedy, keď ho sim po expirácii z mapy odstránil. */
export function stateOfContract(world: World, id: EntityId | number): ContractState | 'removed' {
  return contractsOf(world).get(id as EntityId)?.state ?? 'removed';
}

/** Stratené jednotky: vytvorené − živé − exportované (musí byť vždy 0). */
export function lostUnits(world: World): number {
  return world.cargo.createdCount - world.cargo.liveCount - world.cargo.exportedCount;
}

// ---------------------------------------------------------------------------------------------------------
// Udalosti F5 (v SimEvent pribudnú s T05-02..T05-04)
// ---------------------------------------------------------------------------------------------------------

export interface Event5Map {
  ContractOffered: { readonly contractId: EntityId };
  ContractAccepted: { readonly contractId: EntityId };
  ContractStateChanged: { readonly contractId: EntityId; readonly from: ContractState; readonly to: ContractState };
  ContractCompleted: { readonly contractId: EntityId; readonly rewardCents: number; readonly penaltiesCents: number; readonly xp: number; readonly onTime: boolean };
  ContractFailed: { readonly contractId: EntityId; readonly penaltiesCents: number };
  ContractExpired: { readonly contractId: EntityId; readonly reason: 'timeout' | 'declined' };
  PenaltyApplied: { readonly contractId: EntityId; readonly kind: 'demurrage' | 'late'; readonly amountCents: number };
  MonthlyReport: { readonly month: number; readonly summary: MonthSummaryLike };
  GameOver: { readonly reason: 'bankruptcy'; readonly day: number };
}
export type Event5Type = keyof Event5Map;
export type Event5<T extends Event5Type> = { readonly type: T } & Event5Map[T];

export interface Timed5<T extends Event5Type> {
  readonly tick: number;
  readonly hour: number;
  readonly event: Event5<T>;
}

/** Udalosti jedného typu F5 v poradí vzniku. */
export function events5<T extends Event5Type>(events: readonly TimedEvent[], type: T): Timed5<T>[] {
  const matching = events.filter((entry) => {
    const eventType: string = entry.event.type;
    return eventType === type;
  });
  return matching as unknown as Timed5<T>[];
}

/** Id kontraktov z udalostí `ContractOffered` v zozname udalostí jedného ticku. */
export function offeredIdsOf(tickEvents: readonly SimEvent[]): number[] {
  return tickEvents.filter((event) => event.type === ('ContractOffered' as string)).map((event) => (event as unknown as { contractId: number }).contractId);
}

/** Udalosti známych typov (`SimEvent`) s tickom. */
export function timed5<T extends SimEvent['type']>(events: readonly TimedEvent[], type: T): TimedEvent<Extract<SimEvent, { type: T }>>[] {
  return events.filter((entry): entry is TimedEvent<Extract<SimEvent, { type: T }>> => entry.event.type === type);
}

/** Udalosti jedného kontraktu (podľa `contractId`), typ F5. */
export type ContractEvent5Type = Exclude<Event5Type, 'MonthlyReport' | 'GameOver'>;
export const ofContract = <T extends ContractEvent5Type>(events: readonly Timed5<T>[], contractId: EntityId | number): Timed5<T>[] =>
  events.filter((entry) => (entry.event.contractId as number) === (contractId as number));

// ---------------------------------------------------------------------------------------------------------
// FSM kontraktu (rozhodnutie orchestrátora 4)
// ---------------------------------------------------------------------------------------------------------

/**
 * Povolené prechody: `offered → accepted → ship_en_route → unloading → exporting → completed`; odbočky `failed` z
 * `ship_en_route`/`unloading`/`exporting` (po SLA + `failAfterDaysLate`) a `offered → expired` (timeout aj decline).
 */
export const CONTRACT_TRANSITIONS: Readonly<Record<ContractState, readonly ContractState[]>> = {
  offered: ['accepted', 'expired'],
  accepted: ['ship_en_route'],
  ship_en_route: ['unloading', 'failed'],
  unloading: ['exporting', 'failed'],
  exporting: ['completed', 'failed'],
  completed: [],
  failed: [],
  expired: [],
};

/** Hlavná vetva bez odbočiek. */
export const CONTRACT_MAIN_CHAIN: readonly ContractState[] = ['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting', 'completed'];

/** Stavy kontraktu za sebou (začína `offered`) podľa `ContractStateChanged`. */
export function stateChain(events: readonly TimedEvent[], contractId: EntityId | number): ContractState[] {
  const chain: ContractState[] = ['offered'];
  for (const entry of ofContract(events5(events, 'ContractStateChanged'), contractId)) chain.push(entry.event.to);
  return chain;
}

/** Tick, v ktorom kontrakt prešiel do stavu `to` (`undefined`, ak nikdy). */
export function tickOfState(events: readonly TimedEvent[], contractId: EntityId | number, to: ContractState): number | undefined {
  return ofContract(events5(events, 'ContractStateChanged'), contractId).find((entry) => entry.event.to === to)?.tick;
}

// ---------------------------------------------------------------------------------------------------------
// Vzorce z defov (nie z implementácie)
// ---------------------------------------------------------------------------------------------------------

export const BASIS_POINTS = 10_000;

/** Sadzba (podiel) v bázických bodoch: `0.005 → 50`. */
export const rateBp = (rate: number): number => Math.round(rate * BASIS_POINTS);

/** Najväčšie `slaDaysRange[1]` cez všetky šablóny (`maxSlaDays` vzorca urgency). */
export const maxSlaDaysOf = (defs: DefRegistry = DEFS): number => Math.max(...defs.contractTemplates.items.map((template) => template.slaDaysRange[1]));

/** Urgency v bázických bodoch: `10 000 + ⌊urgencyFactorBp × (maxSla − sla) / maxSla⌋`. */
export function urgencyBp(slaDays: number, defs: DefRegistry = DEFS): number {
  const max = maxSlaDaysOf(defs);
  return BASIS_POINTS + Math.floor((rateBp(defs.economy.urgencyFactor) * (max - slaDays)) / max);
}

/** Odmena: `⌊volume × basePricePerUnitCents × urgencyBp / 10 000⌋`. */
export function expectedRewardCents(cargoTypeId: string, volume: number, slaDays: number, defs: DefRegistry = DEFS): number {
  const price = defs.cargoTypes.get(cargoTypeId).basePricePerUnitCents;
  return Math.floor((volume * price * urgencyBp(slaDays, defs)) / BASIS_POINTS);
}

/** Demurrage za jednu celú hodinu nad `berthAllowanceTicks`. */
export const demurrageStepCents = (rewardCents: number, defs: DefRegistry = DEFS): number =>
  Math.floor((rewardCents * rateBp(defs.economy.demurrageRateOfRewardPerHour)) / BASIS_POINTS);

/** Late penalty za jeden celý deň po `slaDeadlineTick`. */
export const lateStepCents = (rewardCents: number, defs: DefRegistry = DEFS): number =>
  Math.floor((rewardCents * rateBp(defs.economy.latePenaltyRateOfRewardPerDay)) / BASIS_POINTS);

/** `xpReward = volume × xpPerUnit × xpMultiplier`. */
export const expectedXpReward = (cargoTypeId: string, volume: number, defs: DefRegistry = DEFS): number =>
  volume * defs.cargoTypes.get(cargoTypeId).xpPerUnit * defs.economy.xpMultiplier;

/** Prírastok XP pri dokončení: `xpReward` včas, inak `round(xpReward × lateXpFactor)`. */
export const expectedXpGain = (xpReward: number, onTime: boolean, defs: DefRegistry = DEFS): number =>
  onTime ? xpReward : Math.round(xpReward * defs.economy.lateXpFactor);

/** Kapacita lode šablóny (najmenšia zo `shipClassIds`). */
export const smallestShipCapacity = (shipClassIds: readonly string[], defs: DefRegistry = DEFS): number =>
  Math.min(...shipClassIds.map((id) => defs.ships.get(id).capacityUnits));

/**
 * `capacityHint = max(minCapacityHint, min(berthCapacityPerDay, storageCapacity))`; `berthCapacityPerDay` = Σ žeriavov
 * `ticksPerDay / cycleTicks`, `storageCapacity` = Σ `capacityUnits` skladov.
 */
export function capacityHintOf(world: World): number {
  const berthPerDay = cranesOf(world).reduce((sum, crane) => sum + Math.floor(TICKS_PER_DAY / craneParams(crane.def).cycleTicks), 0);
  const storage = storageModulesOf(world).reduce((sum, module) => sum + storageParams(module.def).capacityUnits, 0);
  return Math.max(world.defs.economy.minCapacityHint, Math.min(berthPerDay, storage));
}

/** Hranice objemu ponuky šablóny pri danom `capacityHint`: `clamp(round(scale × hint), volumeUnitsRange)` a `≤` kapacita lode. */
export function volumeBounds(templateId: string, hint: number, defs: DefRegistry = DEFS): { readonly min: number; readonly max: number } {
  const template = defs.contractTemplates.get(templateId);
  const cap = Math.min(template.volumeUnitsRange[1], smallestShipCapacity(template.shipClassIds, defs));
  const clamp = (value: number): number => Math.min(cap, Math.max(template.volumeUnitsRange[0], value));
  return { min: clamp(Math.round(defs.economy.volumeScaleRange[0] * hint)), max: clamp(Math.round(defs.economy.volumeScaleRange[1] * hint)) };
}

/** Súčet kladných veľkostí položiek `Partial<Record<…>>` v jednej kategórii (vstup môže byť záporný — číta sa `Math.abs`). */
export const expenseOf = (summary: DaySummaryLike, category: LedgerCategory): number => Math.abs(summary.expenseCents[category] ?? 0);
export const incomeOf = (summary: DaySummaryLike, category: LedgerCategory): number => Math.abs(summary.incomeCents[category] ?? 0);
const sumMagnitudes = (record: Readonly<Partial<Record<LedgerCategory, number>>>): number => Object.values(record).reduce<number>((sum, value) => sum + Math.abs(value), 0);
/** `Σ income − Σ expense` jedného súhrnu. */
export const netOf = (summary: DaySummaryLike): number => sumMagnitudes(summary.incomeCents) - sumMagnitudes(summary.expenseCents);

/** Denná údržba: Σ `maintenancePerDayCents` všetkých postavených modulov vrátane starter modulov. */
export function expectedMaintenanceCents(world: World): number {
  return [...world.modules.values()].reduce((sum, module) => sum + module.def.maintenancePerDayCents, 0);
}

/** Denné mzdy: Σ `wagePerDayCents` vozidiel a žeriavov. */
export function expectedWagesCents(world: World): number {
  const vehicles = [...world.vehicles.values()].reduce((sum, vehicle) => sum + vehicle.def.wagePerDayCents, 0);
  const cranes = cranesOf(world).reduce((sum, crane) => sum + craneParams(crane.def).wagePerDayCents, 0);
  return vehicles + cranes;
}

// ---------------------------------------------------------------------------------------------------------
// Príkazy a pomocníci nad svetom
// ---------------------------------------------------------------------------------------------------------

/** Dôvody, prečo by `validate` odmietol príkaz z JSON; prázdne pole = platný. */
export function commandReasons(world: World, command: SerializedCommand): readonly string[] {
  return commandFromJSON(command).validate(world).reasons;
}

/** `n` tickov nad `world` s `assertCargoConservation` po každom; vráti všetky udalosti. */
export function tickWorld(world: World, ticks: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...world.tick());
    assertCargoConservation(world);
  }
  return events;
}

/** Súčty ledgera podľa kategórie (so znamienkom). */
export function sumByCategory(entries: readonly LedgerEntryLike[]): Partial<Record<LedgerCategory, number>> {
  const sums: Partial<Record<LedgerCategory, number>> = {};
  for (const entry of entries) sums[entry.category] = (sums[entry.category] ?? 0) + entry.amountCents;
  return sums;
}

export const acceptContract = (contractId: number): SerializedCommand => ({ type: 'AcceptContract', contractId });
export const declineContract = (contractId: number): SerializedCommand => ({ type: 'DeclineContract', contractId });

// ---------------------------------------------------------------------------------------------------------
// Syntetické defy
// ---------------------------------------------------------------------------------------------------------

export interface TemplateRaw {
  readonly id: string;
  readonly cargoTypeId: string;
  readonly volumeUnitsRange: readonly [number, number];
  readonly slaDaysRange: readonly [number, number];
  readonly shipClassIds: readonly string[];
  readonly weight: number;
  readonly minTier: number;
}

export interface DefOverrides {
  /** Prepíše polia `economy.json`. */
  readonly economy?: Readonly<Record<string, unknown>>;
  /** Nahradí zoznam šablón. */
  readonly templates?: readonly TemplateRaw[];
  /** Prepíše polia jednej lodnej triedy (`ships.json`). */
  readonly ship?: { readonly id: string; readonly fields: Readonly<Record<string, unknown>> };
}

export function defsWith(overrides: DefOverrides): DefRegistry {
  const ships =
    overrides.ship === undefined
      ? shipsJson
      : { ...shipsJson, items: shipsJson.items.map((item) => (item.id === overrides.ship?.id ? { ...item, ...overrides.ship.fields } : item)) };
  return DefRegistry.fromRaw({
    ...RAW_DEFS,
    economy: { ...RAW_DEFS.economy, ...overrides.economy },
    contract_templates: { ...RAW_DEFS.contract_templates, ...(overrides.templates === undefined ? {} : { items: overrides.templates }) },
    ships,
  });
}

/** Jediná šablóna s pevným objemom 12 TEU a SLA 2 dni (feeder): ponuky sú rovnaké, urgency = 1 (`maxSla` = 2). */
export const FIXED_TEMPLATE: TemplateRaw = {
  id: 'fixed_feeder',
  cargoTypeId: 'container_teu',
  volumeUnitsRange: [12, 12],
  slaDaysRange: [2, 2],
  shipClassIds: ['feeder'],
  weight: 1,
  minTier: 0,
};
export const FIXED_VOLUME = 12;
export const FIXED_SLA_DAYS = 2;
/** Príchod lode presne 1 deň po prijatí (`arrivalDaysRange [1, 1]`). */
export const FIXED_ARRIVAL_DAYS = 1;

/** Defy s jednou pevnou šablónou a pevným príchodom lode — deterministický kontrakt bez závislosti od `Rng`. */
export function fixedContractDefs(economy: Readonly<Record<string, unknown>> = {}, extra: Omit<DefOverrides, 'economy' | 'templates'> = {}): DefRegistry {
  return defsWith({ ...extra, templates: [FIXED_TEMPLATE], economy: { arrivalDaysRange: [FIXED_ARRIVAL_DAYS, FIXED_ARRIVAL_DAYS], ...economy } });
}

// ---------------------------------------------------------------------------------------------------------
// Scenáre a svety
// ---------------------------------------------------------------------------------------------------------

/** Dve vozidlá ako vo vertikálnom reze (rozhodnutie zadania T05-05). */
export const SLICE_VEHICLES: readonly string[] = ['straddle_carrier', 'straddle_carrier'];
export const SLICE_SEED = 5005;
/** Tick príkazu `AcceptContract` vo `vertical_slice.json`: pool existuje po prvom ticku najneskôr (pozri T05-04, otvorený bod). */
export const SLICE_ACCEPT_TICK = 1;
export const SLICE_TICKS = 60_000;
/**
 * Id prvej ponuky vo `vertical_slice` (T05-04): kontrakty majú vlastnú postupnosť id od 1 (ADR-026 bod 4), nie
 * `world.ids`, takže odhad T05-05 (11 = po 6 moduloch a 2 vozidlách) neplatí. Test `f5-vertical-slice` ho overuje.
 */
export const SLICE_CONTRACT_ID = 1;

/** Rozloženie prístavu F4 (cesty, dvory, depo, brána, stojisko, rampa) bez lode; `units` sa nikdy nepoužije. */
export function portScenario(id: string, seed: number, options: Omit<F4Options, 'units'> = {}): Scenario {
  return f4Scenario(id, seed, { vehicles: SLICE_VEHICLES, ...options });
}

/** `vertical_slice.json` = rozloženie F4 s 2 vozidlami, bez `SpawnShipDebug`, `AcceptContract` prvej ponuky. */
export function verticalSliceScenario(contractId: number, acceptTick: number = SLICE_ACCEPT_TICK): Scenario {
  const accept: ScenarioEntry = { atTick: acceptTick, command: acceptContract(contractId) };
  return portScenario('vertical_slice', SLICE_SEED, { extra: [accept] });
}

/** Nový svet po prvom ticku — pool ponúk existuje najneskôr po ňom (plní sa pri štarte hry). */
export function worldWithPool(defs: DefRegistry = DEFS, seed: number = SLICE_SEED): World {
  const world = World.create(defs, MAP, seed);
  world.tick();
  return world;
}

/** Prvý seed z `1…limit`, pre ktorý `predicate(world)` platí po prvom ticku (deterministické hľadanie seedu s ponukami). */
export function findSeed(create: (seed: number) => World, predicate: (world: World) => boolean, limit = 60): number {
  for (let seed = 1; seed <= limit; seed++) {
    const world = create(seed);
    world.tick();
    if (predicate(world)) return seed;
  }
  throw new Error(`findSeed: žiadny seed 1…${String(limit)} nevyhovuje podmienke`);
}

// ---------------------------------------------------------------------------------------------------------
// Záznam behu s invariantmi
// ---------------------------------------------------------------------------------------------------------

export type Rule5 = 'cash_ledger' | 'contract_fsm' | 'contract_counters' | 'pool_size' | 'progress';

export interface Violation5 {
  readonly rule: Rule5;
  readonly message: string;
}

export interface Run5Options {
  /** Nezávislý audit ledgera nákladu a jobov z F4 po každom ticku (drahší; pre dlhé behy vypnúť). */
  readonly fullAudit?: boolean;
  /** Krížová kontrola počítadiel kontraktov proti `CargoMoved` (nemá zmysel pre svet obnovený zo savu). */
  readonly checkCounters?: boolean;
  /** Hák po každom ticku (po invariantoch); môže volať `run.send`. */
  readonly onTick?: (run: Run5, tickEvents: readonly SimEvent[]) => void;
}

interface UnitCounters {
  leftShip: number;
  onApron: number;
  exported: number;
  leftShipPrev: number;
  onApronPrev: number;
  exportedPrev: number;
}

/**
 * Záznam behu nad jedným `World`: udalosti s tickom, po každom ticku `assertCargoConservation` a invarianty F5
 * (`violations`; prázdne pole = držali po každom ticku). Beh sa dá viackrát predĺžiť a medzi tým poslať príkaz.
 */
export class Run5 {
  readonly events: TimedEvent[] = [];
  readonly violations: Violation5[] = [];
  ticksChecked = 0;

  private cash: number;
  private xp: number;
  private completedBaseline: number;
  private completedSeen = 0;
  private wasGameOver: boolean;
  private readonly tracked = new Map<number, ContractState>();
  private readonly unitContract = new Map<number, number | null>();
  private readonly counters = new Map<number, UnitCounters>();

  constructor(
    readonly world: World,
    readonly scenario: Scenario,
    private readonly options: Run5Options = {},
  ) {
    this.cash = cashOf(world);
    this.xp = xpOf(world);
    this.completedBaseline = completedOf(world);
    this.wasGameOver = gameOverOf(world);
    for (const contract of contractsOf(world).values()) this.tracked.set(contract.id, contract.state);
    this.refreshUnits();
  }

  /** Pošle serializovaný príkaz; aplikuje sa na začiatku ďalšieho ticku. */
  send(command: SerializedCommand): void {
    this.world.enqueue(commandFromJSON(command));
  }

  /** Jeden tick s celým záznamom a invariantmi. */
  step(): void {
    const before = this.world.clock.tick;
    runScenario(this.world, this.scenario, before + 1, { afterTick: (world, tickEvents) => this.observe(world, tickEvents) });
  }

  /** Behá po absolútny tick `untilTick`; skončí skôr pri `stopWhen(world)` alebo po `GameOver` (sim sa potom netickuje). */
  runTo(untilTick: number, stopWhen?: (world: World) => boolean): void {
    while (this.world.clock.tick < untilTick && !gameOverOf(this.world)) {
      this.step();
      if (stopWhen?.(this.world) === true) return;
    }
  }

  /** Behá po jednom ticku, kým `predicate(world)` nie je splnený (kontrola pred každým tickom); inak chyba. */
  runUntil(predicate: (world: World) => boolean, maxTicks: number): void {
    const limit = this.world.clock.tick + maxTicks;
    while (!predicate(this.world)) {
      if (this.world.clock.tick >= limit) {
        throw new Error(`runUntil: podmienka nenastala do ${String(maxTicks)} tickov (tick ${String(this.world.clock.tick)})`);
      }
      if (gameOverOf(this.world)) throw new Error(`runUntil: GameOver v ticku ${String(this.world.clock.tick)} skôr, než nastala podmienka`);
      this.step();
    }
  }

  /** Najnižšie id ponuky (`offered`) alebo chyba; pošle `AcceptContract` a vráti id. */
  acceptLowestOffer(): number {
    const first = offeredContracts(this.world)[0];
    if (first === undefined) throw new Error(`acceptLowestOffer: pool je prázdny (tick ${String(this.world.clock.tick)})`);
    this.send(acceptContract(first.id));
    return first.id;
  }

  /** Správy porušení jedného pravidla. */
  violationsOf(rule: Rule5): string[] {
    return this.violations.filter((violation) => violation.rule === rule).map((violation) => violation.message);
  }

  /** Udalosti F5 jedného typu. */
  of<T extends Event5Type>(type: T): Timed5<T>[] {
    return events5(this.events, type);
  }

  /** Udalosti `SimEvent` jedného typu. */
  ofSim<T extends SimEvent['type']>(type: T): TimedEvent<Extract<SimEvent, { type: T }>>[] {
    return timed5(this.events, type);
  }

  /** Počet jednotiek kontraktu, ktoré už opustili loď / ležia na aprone (alebo ďalej) / sú exportované — podľa `CargoMoved`. */
  countersOf(contractId: EntityId | number): { readonly leftShip: number; readonly onApron: number; readonly exported: number } {
    const entry = this.counters.get(contractId as number);
    return { leftShip: entry?.leftShip ?? 0, onApron: entry?.onApron ?? 0, exported: entry?.exported ?? 0 };
  }

  /** Kontrakt, ku ktorému patrí jednotka (`null` = bez kontraktu); `undefined`, ak jednotku záznam nezaznamenal. */
  contractOfUnit(unitId: EntityId | number): number | null | undefined {
    return this.unitContract.get(unitId as number);
  }

  /** Po priamom volaní `world.economy.post(…)` mimo behu: prevezme aktuálnu hotovosť ako základ kontroly. */
  resyncCash(): void {
    this.cash = cashOf(this.world);
  }

  private refreshUnits(): void {
    for (const unit of this.world.cargo.getState().units) this.unitContract.set(unit.id, unit.contractId);
  }

  private counter(contractId: number): UnitCounters {
    let entry = this.counters.get(contractId);
    if (entry === undefined) {
      entry = { leftShip: 0, onApron: 0, exported: 0, leftShipPrev: 0, onApronPrev: 0, exportedPrev: 0 };
      this.counters.set(contractId, entry);
    }
    return entry;
  }

  private violate(rule: Rule5, message: string): void {
    this.violations.push({ rule, message: `tick ${String(this.world.clock.tick)}: ${message}` });
  }

  private observe(world: World, tickEvents: readonly SimEvent[]): void {
    assertCargoConservation(world);
    if (this.options.fullAudit === true) {
      auditLedgerF4(world);
      auditJobsF4(world);
    }
    const tick = world.clock.tick;
    // `TickAdvanced` sa nezaznamenáva (jedna udalosť na tick, nenesie informáciu navyše a nafukuje dlhé behy).
    for (const event of tickEvents) if (event.type !== 'TickAdvanced') this.events.push({ tick, hour: world.clock.gameHour, event });
    const typed = tickEvents.map((event) => ({ type: event.type as string, event }));

    this.trackUnits(tickEvents);
    this.checkMoney(world, tickEvents);
    this.checkContracts(world, typed);
    this.checkProgress(world, typed);
    this.ticksChecked += 1;
    this.options.onTick?.(this, tickEvents);
  }

  private trackUnits(tickEvents: readonly SimEvent[]): void {
    for (const entry of this.counters.values()) {
      entry.leftShipPrev = entry.leftShip;
      entry.onApronPrev = entry.onApron;
      entry.exportedPrev = entry.exported;
    }
    if (tickEvents.some((event) => event.type === 'ShipSpawned')) this.refreshUnits();
    for (const event of tickEvents) {
      if (event.type !== 'CargoMoved') continue;
      const contractId = this.unitContract.get(event.unitId);
      if (contractId === undefined || contractId === null) continue;
      const entry = this.counter(contractId);
      if (event.from.kind === 'on_ship') entry.leftShip += 1;
      if (event.to.kind === 'on_apron') entry.onApron += 1;
      if (event.to.kind === 'exported') entry.exported += 1;
    }
  }

  /** Hotovosť = predošlá hotovosť + Σ `MoneyChanged`; reťaz `cashCents` v udalostiach sedí; každá zmena má záznam v ledgeri. */
  private checkMoney(world: World, tickEvents: readonly SimEvent[]): void {
    const economy = economyOf(world);
    let running = this.cash;
    const moves = tickEvents.filter((event): event is Extract<SimEvent, { type: 'MoneyChanged' }> => event.type === 'MoneyChanged');
    for (const move of moves) {
      running += move.deltaCents;
      if (move.cashCents !== running) this.violate('cash_ledger', `MoneyChanged.cashCents = ${String(move.cashCents)}, očakávané ${String(running)} (${move.reason})`);
    }
    if (!Number.isSafeInteger(economy.cashCents)) this.violate('cash_ledger', `hotovosť nie je celé číslo: ${String(economy.cashCents)}`);
    if (economy.cashCents !== running) {
      this.violate('cash_ledger', `hotovosť ${String(economy.cashCents)} ≠ predošlá + Σ MoneyChanged = ${String(running)} (zmena hotovosti mimo Economy.post?)`);
    }
    const nonZero = moves.filter((move) => move.deltaCents !== 0);
    if (nonZero.length > 0) {
      // Nulové zmeny sa v ledgeri môžu, ale nemusia zapisovať: porovnáva sa poradie nenulových záznamov na konci ledgera.
      const expected = nonZero.map((move) => `${String(move.deltaCents)}/${move.reason}`);
      const describe = (entries: readonly LedgerEntryLike[]): string[] =>
        entries.filter((entry) => entry.amountCents !== 0).map((entry) => `${String(entry.amountCents)}/${entry.category}`);
      const withZeros = describe(economy.entries.slice(Math.max(0, economy.entries.length - moves.length)));
      const withoutZeros = describe(economy.entries.slice(Math.max(0, economy.entries.length - nonZero.length)));
      const same = (a: readonly string[]): boolean => a.length === expected.length && a.every((value, index) => value === expected[index]);
      if (!same(withZeros) && !same(withoutZeros)) {
        this.violate('cash_ledger', `záznamy ledgera [${withoutZeros.join(', ')}] nezodpovedajú MoneyChanged [${expected.join(', ')}]`);
      }
    }
    this.cash = economy.cashCents;
  }

  private checkContracts(world: World, typed: readonly { type: string; event: SimEvent }[]): void {
    for (const { type, event } of typed) {
      if (type === 'ContractOffered') this.tracked.set(anyContractId(event), 'offered');
      if (type !== 'ContractStateChanged') continue;
      const change = event as unknown as Event5<'ContractStateChanged'>;
      const known = this.tracked.get(change.contractId);
      if (known === undefined) this.violate('contract_fsm', `ContractStateChanged pre neznámy kontrakt ${String(change.contractId)}`);
      else if (known !== change.from) this.violate('contract_fsm', `kontrakt ${String(change.contractId)}: udalosť ${change.from} → ${change.to}, ale predošlý stav bol ${known}`);
      if (!CONTRACT_TRANSITIONS[change.from].includes(change.to)) this.violate('contract_fsm', `kontrakt ${String(change.contractId)}: ${change.from} → ${change.to} nie je povolený prechod`);
      this.tracked.set(change.contractId, change.to);
    }

    let offered = 0;
    const checkCounters = this.options.checkCounters !== false;
    for (const contract of contractsOf(world).values()) {
      const label = `kontrakt ${String(contract.id)} (${contract.state})`;
      if (contract.state === 'offered') offered += 1;
      if (this.tracked.get(contract.id) !== contract.state) this.violate('contract_fsm', `${label}: stav podľa udalostí ${this.tracked.get(contract.id) ?? 'žiadny'}`);
      if (!Number.isSafeInteger(contract.rewardCents) || contract.rewardCents <= 0) this.violate('contract_counters', `${label}: rewardCents = ${String(contract.rewardCents)}`);
      if (!Number.isSafeInteger(contract.penaltiesCents) || contract.penaltiesCents < 0) this.violate('contract_counters', `${label}: penaltiesCents = ${String(contract.penaltiesCents)}`);
      if (contract.unitsUnloaded < 0 || contract.unitsUnloaded > contract.volumeUnits) this.violate('contract_counters', `${label}: unitsUnloaded = ${String(contract.unitsUnloaded)}`);
      if (contract.unitsExported < 0 || contract.unitsExported > contract.unitsUnloaded) {
        this.violate('contract_counters', `${label}: unitsExported = ${String(contract.unitsExported)} > unitsUnloaded = ${String(contract.unitsUnloaded)}`);
      }
      if (contract.state === 'exporting' && contract.unitsUnloaded !== contract.volumeUnits) this.violate('contract_counters', `${label}: exporting, ale unitsUnloaded = ${String(contract.unitsUnloaded)}`);
      if (contract.state === 'completed' && contract.unitsExported !== contract.volumeUnits) this.violate('contract_counters', `${label}: completed, ale unitsExported = ${String(contract.unitsExported)}`);
      if (contract.state === 'offered' && (contract.acceptedTick !== undefined || contract.shipId !== undefined)) this.violate('contract_fsm', `${label}: ponuka má acceptedTick/shipId`);
      if (!checkCounters) continue;
      const seen = this.counters.get(contract.id);
      const exportedOk = contract.unitsExported === (seen?.exported ?? 0) || contract.unitsExported === (seen?.exportedPrev ?? 0);
      if (!exportedOk) {
        this.violate('contract_counters', `${label}: unitsExported = ${String(contract.unitsExported)}, CargoMoved(exported) = ${String(seen?.exported ?? 0)}`);
      }
      const plausible = [seen?.leftShip ?? 0, seen?.onApron ?? 0, seen?.leftShipPrev ?? 0, seen?.onApronPrev ?? 0];
      if (!plausible.includes(contract.unitsUnloaded)) {
        this.violate('contract_counters', `${label}: unitsUnloaded = ${String(contract.unitsUnloaded)}, CargoMoved: opustili loď ${String(seen?.leftShip ?? 0)}, na aprone ${String(seen?.onApron ?? 0)}`);
      }
    }
    const perDay = world.defs.economy.offersPerDay;
    if (offered > perDay) this.violate('pool_size', `${String(offered)} ponúk > offersPerDay ${String(perDay)}`);
  }

  private checkProgress(world: World, typed: readonly { type: string; event: SimEvent }[]): void {
    this.completedSeen += typed.filter(({ type }) => type === 'ContractCompleted').length;
    const completed = completedOf(world);
    if (completed !== this.completedBaseline + this.completedSeen) {
      this.violate('progress', `completedContracts = ${String(completed)}, ContractCompleted udalostí ${String(this.completedSeen)} (+ základ ${String(this.completedBaseline)})`);
    }
    const expectedTier = Math.floor(completed / world.defs.economy.contractsPerTier);
    if (tierOf(world) !== expectedTier) this.violate('progress', `tier = ${String(tierOf(world))}, očakávané ${String(expectedTier)}`);
    if (xpOf(world) < this.xp) this.violate('progress', `XP kleslo z ${String(this.xp)} na ${String(xpOf(world))}`);
    this.xp = xpOf(world);
    const over = gameOverOf(world);
    if (this.wasGameOver && !over) this.violate('progress', 'gameOver sa vrátil z true na false');
    this.wasGameOver = over;
  }
}

function anyContractId(event: SimEvent): number {
  return (event as unknown as { contractId: number }).contractId;
}

/** Zoznam ticku a stavu všetkých kontraktov vo forme, ktorá sa dá porovnať medzi behmi (save/load, determinizmus). */
export function contractsProjection(world: World): unknown[] {
  return contractList(world).map((c) => [
    c.id,
    c.state,
    c.templateId,
    c.volumeUnits,
    c.rewardCents,
    c.xpReward,
    c.offeredTick,
    c.offerExpiresTick,
    c.acceptedTick ?? null,
    c.shipId ?? null,
    c.shipArrivalTick ?? null,
    c.slaDeadlineTick ?? null,
    c.unitsUnloaded,
    c.unitsExported,
    c.penaltiesCents,
  ]);
}

/** Stav ekonomiky a postupu, ktorý sa musí po save/load zhodovať. */
export function economyProjection(world: World): unknown {
  const economy = economyOf(world);
  return {
    cash: economy.cashCents,
    daysNegative: economy.daysNegative,
    entries: economy.entries.length,
    daily: economy.daily.length,
    monthly: economy.monthly.length,
    xp: xpOf(world),
    completed: completedOf(world),
    tier: tierOf(world),
    gameOver: gameOverOf(world),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Rozbeh kontraktu
// ---------------------------------------------------------------------------------------------------------

export interface StartContractOptions {
  readonly id: string;
  readonly seed: number;
  readonly defs?: DefRegistry;
  /** Predvolene rozloženie F4 s 2 vozidlami (`portScenario`). */
  readonly scenario?: Scenario;
  readonly fullAudit?: boolean;
}

export interface StartedContract {
  readonly world: World;
  readonly run: Run5;
  readonly contractId: number;
}

/**
 * Nový svet, prvý tick (pool existuje) a prijatie ponuky s najnižším id; po návrate je kontrakt `accepted`
 * (príkaz sa aplikoval v druhom ticku).
 */
export function startContract(options: StartContractOptions): StartedContract {
  const { id, seed, defs = DEFS, fullAudit = false } = options;
  const world = World.create(defs, MAP, seed);
  const run = new Run5(world, options.scenario ?? portScenario(id, seed), { fullAudit });
  run.runTo(1);
  const contractId = run.acceptLowestOffer();
  run.step();
  return { world, run, contractId };
}
