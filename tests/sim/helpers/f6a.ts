/**
 * Pomocníci testov fázy 6a (T6A-04, ADR-032): svet s prístavom (cesty, depo, dva dvory, brána, stojisko, rampa, vozidlá —
 * rozloženie F4 `f4-layout.ts`) a priamo vložené booking ponuky, ktoré sa prijmú príkazom `AcceptContract`. Pool je
 * v týchto svetoch vypnutý (`offersPerDay: 0`, `bookingOffersPerDay: 0`), takže ponuky, ich id a `Rng` prúd riadi test.
 *
 * Skrátené defy (`f6aDefs`): príchod lode presne 1 deň po prijatí (`exportArrivalDaysRange [1, 1]`), okno príchodov exportu
 * 1 deň, cut-off 12 h pred príchodom → príchody kamiónov v okne `[prijatie + 1, prijatie + 4 320]` ticku.
 */
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import { ExportContract, ImportContract, type Contract } from '@sim/contracts';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { World } from '@sim/world';
import { MAP, RAW_DEFS } from '../world/world-fixtures';
import { f4Scenario, type F4Options } from './f4-layout';

export { MAP, RAW_DEFS };

export const TICKS_PER_HOUR = 3600 / (RAW_DEFS.time.tickGameSeconds as number);
export const TICKS_PER_DAY = 24 * TICKS_PER_HOUR;

/** Hodnoty skrátených defov exportu (viď hlavička). */
export const F6A_ARRIVAL_DAYS = 1;
export const F6A_WINDOW_DAYS = 1;
export const F6A_CUTOFF_HOURS = 12;

export interface F6aDefsOptions {
  /** Prepíše polia `economy.json`. */
  readonly economy?: Readonly<Record<string, unknown>>;
  /** Prepíše polia `logistics.json` → `exportFlow`. */
  readonly exportFlow?: Readonly<Record<string, unknown>>;
  /** Prepíše polia lodnej triedy (`ships.json`). */
  readonly ship?: { readonly id: string; readonly fields: Readonly<Record<string, unknown>> };
  /** Prepíše `params` modulov podľa id defu (napr. `truck_waiting_area: { bays: 1 }`). */
  readonly moduleParams?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * Defy pre svety exportu: bez ponúk poolu (`offersPerDay` 0, `bookingOffersPerDay` 0), príchod lode 1 deň po prijatí,
 * okno príchodov 1 deň (viď hlavička). `overrides` prepíšu čokoľvek z toho.
 */
export function f6aDefs(overrides: F6aDefsOptions = {}): DefRegistry {
  const ships =
    overrides.ship === undefined
      ? RAW_DEFS.ships
      : { ...RAW_DEFS.ships, items: RAW_DEFS.ships.items.map((item) => (item.id === overrides.ship?.id ? { ...item, ...overrides.ship.fields } : item)) };
  const modules = {
    ...RAW_DEFS.modules,
    items: RAW_DEFS.modules.items.map((item) => (overrides.moduleParams?.[item.id] === undefined ? item : { ...item, params: { ...item.params, ...overrides.moduleParams[item.id] } })),
  };
  return DefRegistry.fromRaw({
    ...RAW_DEFS,
    ships,
    modules,
    economy: {
      ...RAW_DEFS.economy,
      offersPerDay: 0,
      bookingOffersPerDay: 0,
      exportArrivalDaysRange: [F6A_ARRIVAL_DAYS, F6A_ARRIVAL_DAYS],
      cutoffHours: F6A_CUTOFF_HOURS,
      ...overrides.economy,
    },
    logistics: { ...RAW_DEFS.logistics, exportFlow: { ...RAW_DEFS.logistics.exportFlow, arrivalWindowDays: F6A_WINDOW_DAYS, ...overrides.exportFlow } },
  });
}

export interface ExportWorldOptions extends Pick<F4Options, 'vehicles' | 'landside' | 'yards' | 'omitRoadCells' | 'extra'> {
  readonly defs?: DefRegistry;
  readonly seed?: number;
  /** Zapne krok 12 (invarianty sveta po každom ticku); predvolene áno. */
  readonly checkInvariants?: boolean;
}

/** Dve vozidlá ako vo vertikálnom reze. */
export const TWO_STRADDLES: readonly string[] = ['straddle_carrier', 'straddle_carrier'];

/** Svet s prístavom F4 (cesty, depo, dva dvory, brána, stojisko, rampa) a vozidlami; príkazy tick 0 sú aplikované. */
export function exportWorld(options: ExportWorldOptions = {}): World {
  const { defs = f6aDefs(), seed = 6006, vehicles = TWO_STRADDLES, checkInvariants = true } = options;
  const scenario = f4Scenario('f6a_export', seed, { vehicles, landside: options.landside, yards: options.yards, omitRoadCells: options.omitRoadCells, extra: options.extra });
  const world = World.create(defs, MAP, seed, { checkInvariants });
  for (const entry of scenario.commands) world.enqueue(commandFromJSON(entry.command));
  world.applyPending();
  return world;
}

export interface BookingOptions {
  readonly kind: 'export' | 'roundtrip';
  /** Bookované TEU exportu (predvolene 12). */
  readonly booked?: number;
  /** Import TEU roundtripu (predvolene 6). */
  readonly importUnits?: number;
  readonly destinationPort?: string;
  readonly slaDays?: number;
}

export interface OfferedBooking {
  readonly voyageId: VoyageId;
  readonly importContract: ImportContract | undefined;
  readonly exportContract: ExportContract;
}

/** Vloží do knihy ponuku bookingu (export, alebo roundtrip = import + export jednej voyage); id z postupností knihy. */
export function offerBooking(world: World, options: BookingOptions): OfferedBooking {
  const { kind, booked = 12, importUnits = 6, destinationPort = 'Hamburg', slaDays = 3 } = options;
  const book = world.contractBook;
  const tick = world.clock.tick;
  const terms = { slaDays, rewardCents: 1_000_000, xpReward: 10, offeredTick: tick, offerExpiresTick: tick + 2 * TICKS_PER_DAY, shipClassId: 'feeder', cargoTypeId: 'container_teu' };
  const voyageId = book.allocateVoyageId();
  let importContract: ImportContract | undefined;
  if (kind === 'roundtrip') {
    importContract = new ImportContract({ ...terms, id: book.allocateId(), voyageId, templateId: 'container_feeder_roundtrip', volumeUnits: importUnits });
    book.add(importContract);
  }
  const exportContract = new ExportContract({
    ...terms,
    id: book.allocateId(),
    voyageId,
    templateId: kind === 'roundtrip' ? 'container_feeder_roundtrip' : 'container_feeder_export',
    volumeUnits: booked,
    destinationPort,
  });
  book.add(exportContract);
  return { voyageId, importContract, exportContract };
}

/** Serializovaný príkaz `AcceptContract`. */
export const acceptCommand = (contractId: number): SerializedCommand => ({ type: 'AcceptContract', contractId });

/** Aplikuje príkaz hneď (bez posunu času) a vráti jeho udalosti. */
export function send(world: World, command: SerializedCommand): readonly SimEvent[] {
  world.enqueue(commandFromJSON(command));
  return world.applyPending();
}

/**
 * Prijme ponuku skupiny bez kontroly pripravenosti pozemnej strany (`AcceptContract.validate` ju pri exporte vyžaduje,
 * ADR-032): účinok `apply` — plán lode, cut-off a príchody — sa vykoná priamo. Pre testy lode a hodín v svete bez rampy.
 */
export function acceptUnchecked(world: World, contractId: number): readonly SimEvent[] {
  const command = commandFromJSON(acceptCommand(contractId)) as unknown as { applyTo(world: World, offer: Contract): void };
  command.applyTo(world, contractOf(world, contractId));
  return world.applyPending();
}

/**
 * Ponuku vloží a prijme jedným príkazom `AcceptContract` (skupina voyage); vráti ponuku a udalosti prijatia. Svet bez rampy
 * (`landside: []`) ponuku prijme bez kontroly pripravenosti (`acceptUnchecked`) — testy lode a hodín bez pozemnej časti.
 */
export function acceptedBooking(world: World, options: BookingOptions): OfferedBooking & { readonly events: readonly SimEvent[] } {
  const offer = offerBooking(world, options);
  const events = world.landsideModules.ramps.length === 0 ? acceptUnchecked(world, offer.exportContract.id) : send(world, acceptCommand(offer.exportContract.id));
  return { ...offer, events };
}

/** Odtikne `ticks` tickov a vráti udalosti s tickom, v ktorom vznikli. */
export function tickEvents(world: World, ticks: number): { readonly tick: number; readonly event: SimEvent }[] {
  const out: { tick: number; event: SimEvent }[] = [];
  for (let i = 0; i < ticks; i++) {
    for (const event of world.tick()) out.push({ tick: world.clock.tick, event });
  }
  return out;
}

/** Tickuje, kým neplatí `predicate` (najviac `maxTicks`); vráti udalosti s tickami. Nesplnená podmienka → `Error`. */
export function tickUntil(world: World, predicate: (world: World) => boolean, maxTicks: number): { readonly tick: number; readonly event: SimEvent }[] {
  const out: { tick: number; event: SimEvent }[] = [];
  for (let i = 0; i < maxTicks; i++) {
    if (predicate(world)) return out;
    for (const event of world.tick()) out.push({ tick: world.clock.tick, event });
  }
  if (predicate(world)) return out;
  throw new Error(`podmienka nenastala do ${String(maxTicks)} tickov (tick ${String(world.clock.tick)})`);
}

/** Udalosti jedného typu (zachová poradie a tick). */
export function ofType<T extends SimEvent['type']>(events: readonly { readonly tick: number; readonly event: SimEvent }[], type: T): { readonly tick: number; readonly event: Extract<SimEvent, { type: T }> }[] {
  return events.filter((entry): entry is { tick: number; event: Extract<SimEvent, { type: T }> } => entry.event.type === type);
}

/** Jednotky exportu (smer `export`) v ledgeri podľa polohy: `kind → počet`. */
export function exportUnitsByLocation(world: World): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const state of world.cargo.getState().units) {
    if (state.direction !== 'export') continue;
    counts[state.location.kind] = (counts[state.location.kind] ?? 0) + 1;
  }
  return counts;
}

/** Id jednotiek exportu kontraktu v ledgeri (vzostupne). */
export function exportUnitIds(world: World, contractId: ContractId | number): EntityId[] {
  return world.cargo
    .getState()
    .units.filter((unit) => unit.direction === 'export' && unit.contractId === contractId)
    .map((unit) => unit.id)
    .sort((a, b) => a - b);
}

/** Kontrakt z knihy alebo chyba testu. */
export function contractOf(world: World, id: ContractId | number): Contract {
  const contract = world.contracts.get(id as ContractId);
  if (contract === undefined) throw new Error(`kontrakt #${String(id)} nie je v knihe`);
  return contract;
}

/** Stratené jednotky: vytvorené − živé − exportované − odplávané (musí byť vždy 0). */
export function lostUnits(world: World): number {
  return world.cargo.createdCount - world.cargo.liveCount - world.cargo.exportedCount - world.cargo.shippedCount;
}

// ---------------------------------------------------------------------------------------------------------
// Nakládka exportu (T6A-05, ADR-032 bod 8–14, ADR-033)
// ---------------------------------------------------------------------------------------------------------

/** Defy s režimom odovzdávania `under_hook` a bufferom `craneBufferSlots` na žeriav (`f6aDefs` + `moduleParams` kotviska). */
export function hookDefs(craneBufferSlots = 1, overrides: F6aDefsOptions = {}): DefRegistry {
  return f6aDefs({
    ...overrides,
    moduleParams: { ...overrides.moduleParams, berth_standard: { ...overrides.moduleParams?.['berth_standard'], handoverMode: 'under_hook', craneBufferSlots } },
  });
}

/** Defy s režimom `apron` (predvolené `f6aDefs` nad pripnutými `RAW_DEFS`) — pomenované pre čitateľnosť testov. */
export function apronDefs(overrides: F6aDefsOptions = {}): DefRegistry {
  return f6aDefs(overrides);
}

export interface LoadingOptions extends BookingOptions {
  /** Svet (predvolene `exportWorld({ defs })`). */
  readonly world?: World;
  readonly defs?: DefRegistry;
  readonly vehicles?: readonly string[];
  /** Plán príchodov kamiónov: ticky **od prijatia** (vzostupne); predvolene náhodne z `Rng`. */
  readonly arrivals?: readonly number[];
}

export interface LoadingRun {
  readonly world: World;
  readonly offer: OfferedBooking & { readonly events: readonly SimEvent[] };
  /** Tick prijatia bookingu. */
  readonly acceptedTick: number;
  /** Tick príchodu lode (`shipArrivalTick`). */
  readonly arrivalTick: number;
  /** Tick cut-off. */
  readonly cutoffTick: number;
}

/** Svet s prístavom, prijatý booking a (voliteľne) pevný plán príchodov kamiónov. Nič netickuje. */
export function startLoading(options: LoadingOptions): LoadingRun {
  const world = options.world ?? exportWorld({ defs: options.defs, vehicles: options.vehicles });
  const offer = acceptedBooking(world, options);
  const { exportContract } = offer;
  const acceptedTick = exportContract.acceptedTick as number;
  if (options.arrivals !== undefined) {
    (exportContract.booking.arrivalPlan as number[]).splice(0, exportContract.booking.arrivalPlan.length, ...options.arrivals.map((offset) => acceptedTick + offset));
  }
  return { world, offer, acceptedTick, arrivalTick: exportContract.shipArrivalTick as number, cutoffTick: exportContract.booking.cutoffTick as number };
}

/** Tickuje (so `afterTick` po každom ticku) do odchodu lode a uzavretia bookingu (`ShipDeparted`), najviac `maxTicks`. */
export function runUntilDeparted(world: World, maxTicks: number, afterTick?: (world: World) => void): { readonly tick: number; readonly event: SimEvent }[] {
  const out: { tick: number; event: SimEvent }[] = [];
  let departed = false;
  for (let i = 0; i < maxTicks && !departed; i++) {
    for (const event of world.tick()) {
      out.push({ tick: world.clock.tick, event });
      if (event.type === 'ShipDeparted') departed = true;
    }
    afterTick?.(world);
  }
  if (!departed) throw new Error(`loď neodišla do ${String(maxTicks)} tickov (tick ${String(world.clock.tick)})`);
  return out;
}
