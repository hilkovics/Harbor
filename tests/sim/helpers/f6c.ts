/**
 * Pomocníci testov fázy 6c (T6C-02, ADR-034): svet s prístavom F4 (`exportWorld`) a depom prázdnych na mieste blízkeho dvora, ručné
 * vloženie prázdneho kontajnera do skladu (ledger, bez kamióna a vozidla), prijatý import a ťahanie sveta po udalostiach.
 *
 * Defy: `f6cDefs` = `f6aDefs` (bez ponúk poolu, príchod lode 1 deň po prijatí) s vlastným `emptyFlow` — testy si pripnú pravdepodobnosti
 * (`emptyReturnRate`, `damageChance`, `emptyPickupRate` na 0 alebo 1), takže `Rng` nerozhoduje o tom, čo sa overuje.
 */
import { EMPTY_WEIGHT_CLASS, type CargoUnitLabelsInput } from '@sim/cargo';
import { EmptyRepositioningContract, ExportContract, ImportContract, TranshipContract } from '@sim/contracts';
import type { EntityId } from '@sim/core';
import type { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { EmptyDepot, StorageModule, TruckGate } from '@sim/modules';
import type { World } from '@sim/world';
import { acceptCommand, exportWorld, f6aDefs, send, TICKS_PER_DAY, TICKS_PER_HOUR, type ExportWorldOptions, type F6aDefsOptions } from './f6a';

export { TICKS_PER_DAY, TICKS_PER_HOUR };

/** Pravdepodobnosti a trvania `emptyFlow` pre testy: nič sa nelosuje (rate 0 / 1), kratké časy. */
export const NO_RANDOM_EMPTY_FLOW: Readonly<Record<string, unknown>> = Object.freeze({
  emptyReturnRate: 1,
  damageChance: 0,
  emptyPickupRate: 0,
  hinterlandDaysRange: [1, 1],
  emptyPickupLeadHoursRange: [4, 4],
  repairHours: 6,
  emptyPickupMaxWaitHours: 6,
});

/** Defy F6c: `f6aDefs` s `emptyFlow` = `NO_RANDOM_EMPTY_FLOW` + prepisy. */
export function f6cDefs(overrides: F6aDefsOptions = {}): DefRegistry {
  return f6aDefs({ ...overrides, emptyFlow: { ...NO_RANDOM_EMPTY_FLOW, ...overrides.emptyFlow } });
}

/** Západné pole rozloženia `f4-layout` (40, 23) rot 270 — na tomto mieste stojí depo prázdnych. */
export const DEPOT_ORIGIN = { x: 40, y: 23, rotation: 270 } as const;

export interface EmptyWorldOptions extends Omit<ExportWorldOptions, 'yards' | 'extra'> {
  /** Postaví depo prázdnych na `DEPOT_ORIGIN` (predvolene áno). */
  readonly depot?: boolean;
  /** Postaví ďaleký dvor (predvolene áno; bez neho nie je kam uložiť import ani fallback prázdneho). */
  readonly farYard?: boolean;
}

/** Svet F4 s ďalekým dvorom a depom prázdnych (id modulov: berth 1, žeriav 2, depo vozidiel 3, dvory 4 a 5 (alebo len ďaleký 4), brány, depo prázdnych posledné). */
export function emptyWorld(options: EmptyWorldOptions = {}): World {
  const { depot = true, farYard = true, ...rest } = options;
  const extra = depot ? [{ atTick: 0, command: { type: 'PlaceModule' as const, defId: 'empty_depot', x: DEPOT_ORIGIN.x, y: DEPOT_ORIGIN.y, rotation: DEPOT_ORIGIN.rotation } }] : [];
  return exportWorld({ defs: f6cDefs(), ...rest, yards: farYard ? ['far'] : [], extra });
}

/** Depo prázdnych sveta (prvé); chýba → chyba testu. */
export function depotOf(world: World): EmptyDepot {
  for (const module of world.modules.values()) if (module instanceof EmptyDepot) return module;
  throw new Error('svet nemá depo prázdnych');
}

/** Prvý vstupný pruh brány sveta (zdroj lístka návratu); chýba → chyba testu. */
export function gateInOf(world: World): TruckGate {
  for (const module of world.modules.values()) if (module instanceof TruckGate && module.direction === 'in') return module;
  throw new Error('svet nemá vstupný pruh brány');
}

/** Štítky prázdneho kontajnera linky. */
export const emptyLabelsOf = (lineId: string): CargoUnitLabelsInput => ({ direction: 'empty', voyageId: null, lineId, destinationPort: null, weightClass: EMPTY_WEIGHT_CLASS });

/**
 * Vloží do skladu `storage` prázdny kontajner linky `lineId` tak, ako by ho uložilo vozidlo (ledger: `in_truck →
 * in_vehicle → in_storage`, rezervácia a `commit` slotu), bez kamióna, vozidla a udalostí kontroly; voliteľne mu nastaví stav kvality.
 */
export function putEmpty(world: World, storage: StorageModule, lineId: string, status: 'available' | 'damaged' | 'in_repair' = 'available'): EntityId {
  const unit = world.cargo.create('container_teu', { kind: 'in_truck', truckId: 800 as EntityId }, null, emptyLabelsOf(lineId));
  const slot = storage.reserve();
  world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: 802 as EntityId });
  world.cargo.move(unit.id, { kind: 'in_storage', moduleId: storage.id, slot });
  storage.commit(slot, unit.id);
  if (status === 'damaged') world.cargo.setStatus(unit.id, 'damaged', null);
  if (status === 'in_repair') world.cargo.setStatus(unit.id, 'in_repair', world.clock.tick + 1_000);
  return unit.id;
}

/** Import kontrakt linky `lineId` vložený do knihy a prijatý príkazom `AcceptContract` (loď príde podľa `arrivalDaysRange`). */
export function acceptedImport(world: World, lineId: string, units = 4): { readonly contractId: number; readonly events: readonly SimEvent[] } {
  const book = world.contractBook;
  const tick = world.clock.tick;
  const contract = new ImportContract({
    id: book.allocateId(),
    voyageId: book.allocateVoyageId(),
    lineId,
    templateId: 'container_feeder_standard',
    cargoTypeId: 'container_teu',
    volumeUnits: units,
    slaDays: 4,
    rewardCents: 1_000_000,
    xpReward: 5,
    offeredTick: tick,
    offerExpiresTick: tick + 2 * TICKS_PER_DAY,
    shipClassId: 'feeder',
  });
  book.add(contract);
  return { contractId: contract.id, events: send(world, acceptCommand(contract.id)) };
}

/** Odtikne `ticks` tickov a vráti udalosti s tickom, v ktorom vznikli. */
export function run(world: World, ticks: number): { readonly tick: number; readonly event: SimEvent }[] {
  const out: { tick: number; event: SimEvent }[] = [];
  for (let i = 0; i < ticks; i++) for (const event of world.tick()) out.push({ tick: world.clock.tick, event });
  return out;
}

/** Tickuje, kým neplatí `done` (najviac `maxTicks`); nesplnená podmienka → `Error`. Vráti udalosti s tickami. */
export function runUntil(world: World, done: (world: World) => boolean, maxTicks: number, label = 'podmienka'): { readonly tick: number; readonly event: SimEvent }[] {
  const out: { tick: number; event: SimEvent }[] = [];
  for (let i = 0; i < maxTicks && !done(world); i++) for (const event of world.tick()) out.push({ tick: world.clock.tick, event });
  if (!done(world)) throw new Error(`${label} nenastala do ${String(maxTicks)} tickov (tick ${String(world.clock.tick)})`);
  return out;
}

/** Udalosti jedného typu bez ticku. */
export function eventsOf<T extends SimEvent['type']>(events: readonly { readonly event: SimEvent }[], type: T): Extract<SimEvent, { type: T }>[] {
  return events.map((entry) => entry.event).filter((event): event is Extract<SimEvent, { type: T }> => event.type === type);
}

/** Prázdne kontajnery (smer `empty`) v ledgeri podľa polohy: `kind → počet`. */
export function emptiesByLocation(world: World): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const state of world.cargo.getState().units) {
    if (state.direction === 'empty') counts[state.location.kind] = (counts[state.location.kind] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------------------
// Repositioning prázdnych a prekládka (T6C-03, ADR-034): ručne vložené ponuky a ťahanie sveta po udalostiach
// ---------------------------------------------------------------------------------------------------------

/** Spoločné podmienky ručne vloženej ponuky F6c (odmena 1 000 000, SLA 3 dni, loď `feeder`, linka `blue_anchor`). */
function f6cTerms(world: World, lineId: string, slaDays: number) {
  const tick = world.clock.tick;
  return {
    slaDays,
    rewardCents: 1_000_000,
    xpReward: 10,
    offeredTick: tick,
    offerExpiresTick: tick + 2 * TICKS_PER_DAY,
    shipClassId: 'feeder',
    cargoTypeId: 'container_teu',
    lineId,
  };
}

export interface RepositioningOptions {
  /** Bookované prázdne (predvolene 4). */
  readonly booked?: number;
  readonly lineId?: string;
  readonly slaDays?: number;
  readonly destinationPort?: string;
  /** Spolu s exportom jednej voyage: bookované TEU exportu (export kontrakt má nižšie id než repositioning); predvolene bez exportu. */
  readonly withExport?: number;
}

/** Vloží do knihy ponuku repositioningu prázdnych linky (vlastná voyage, alebo spolu s exportom jednej voyage); vráti kontrakt repositioningu. */
export function offerRepositioning(world: World, options: RepositioningOptions = {}): EmptyRepositioningContract {
  const { booked = 4, lineId = 'blue_anchor', slaDays = 3, destinationPort = 'Hamburg', withExport } = options;
  const book = world.contractBook;
  const voyageId = book.allocateVoyageId();
  if (withExport !== undefined) {
    book.add(
      new ExportContract({
        ...f6cTerms(world, lineId, slaDays),
        id: book.allocateId(),
        voyageId,
        templateId: 'container_feeder_export_repositioning',
        volumeUnits: withExport,
        destinationPort,
      }),
    );
  }
  const contract = new EmptyRepositioningContract({
    ...f6cTerms(world, lineId, slaDays),
    id: book.allocateId(),
    voyageId,
    templateId: 'container_feeder_repositioning',
    volumeUnits: booked,
    destinationPort,
  });
  book.add(contract);
  return contract;
}

export interface TranshipOptions {
  /** Prekladané TEU (predvolene 4). */
  readonly units?: number;
  readonly lineId?: string;
  readonly slaDays?: number;
  readonly destinationPort?: string;
}

/** Vloží do knihy ponuku prekládky (voyage lode A a voyage lode B); vráti kontrakt. */
export function offerTranship(world: World, options: TranshipOptions = {}): TranshipContract {
  const { units = 4, lineId = 'blue_anchor', slaDays = 3, destinationPort = 'Hamburg' } = options;
  const book = world.contractBook;
  const contract = new TranshipContract({
    ...f6cTerms(world, lineId, slaDays),
    id: book.allocateId(),
    voyageId: book.allocateVoyageId(),
    outVoyageId: book.allocateVoyageId(),
    templateId: 'container_feeder_tranship',
    volumeUnits: units,
    destinationPort,
  });
  book.add(contract);
  return contract;
}

/** Plní depo prázdnymi linky `lineId` (`putEmpty`); vráti id jednotiek. */
export function stockDepot(world: World, lineId: string, count: number, status: 'available' | 'damaged' | 'in_repair' = 'available'): EntityId[] {
  const depot = depotOf(world);
  return Array.from({ length: count }, () => putEmpty(world, depot, lineId, status));
}

/** Stratené jednotky: vytvorené − živé − exportované − odplávané (musí byť vždy 0). */
export function lost(world: World): number {
  return world.cargo.createdCount - world.cargo.liveCount - world.cargo.exportedCount - world.cargo.shippedCount;
}
