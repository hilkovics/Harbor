/**
 * Booking ponuky v poole (F6a, T6A-04, ADR-032 bod 1 a 14): `drawBookingOffer` (export, roundtrip), skupiny ponúk
 * v knihe (`offeredGroups`, `offeredOfVoyage`), doplnenie len pri `DayClosed` po import ponukách a pool, ktorý import-only
 * svet nezmení (prvé naplnenie a ťah príchodu v ticku 1 ostávajú bitovo rovnaké).
 */
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import { drawBookingOffer, drawContainerCount, drawOffer, type OfferContext } from '@sim/contracts';
import { Rng } from '@sim/core/rng';
import type { ContractId, VoyageId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import { World } from '@sim/world';
import { MAP, RAW_DEFS, TICKS_PER_DAY } from '../helpers/f6a';
import { DEFS as BUNDLED } from '../world/world-fixtures';

/** Kontext ponuky nad bundled defmi s vlastnými postupnosťami id (test nepotrebuje svet). */
function contextOf(defs: DefRegistry, seed: number, overrides: Partial<OfferContext> = {}): { context: OfferContext; rng: Rng; ids: () => number } {
  const rng = new Rng(seed);
  let nextId = 1;
  let nextVoyage = 1;
  const context: OfferContext = {
    defs,
    rng,
    tick: 8640,
    ticksPerDay: TICKS_PER_DAY,
    tier: 0,
    capacityHint: 60,
    storageCapacity: 128,
    nextId: () => nextId++ as ContractId,
    nextVoyageId: () => nextVoyage++ as VoyageId,
    ...overrides,
  };
  return { context, rng, ids: () => nextId };
}

const only = (defs: DefRegistry, id: string): DefRegistry =>
  DefRegistry.fromRaw({
    ...RAW_DEFS,
    contract_templates: { ...RAW_DEFS.contract_templates, items: RAW_DEFS.contract_templates.items.filter((item) => item.id === id) },
  });

describe('drawBookingOffer', () => {
  it('roundtrip: import (id n) a export (id n + 1) s jednou voyage, triedou lode, SLA a ponukou rovnakého trvania', () => {
    const defs = only(BUNDLED, 'container_feeder_roundtrip');
    const { context } = contextOf(defs, 11);
    const group = drawBookingOffer(context);
    expect(group.map((contract) => [contract.kind, contract.id])).toEqual([['import', 1], ['export', 2]]);
    const [imp, exp] = group;
    expect(imp.voyageId).toBe(exp.voyageId);
    expect(imp.shipClassId).toBe(exp.shipClassId);
    expect(imp.slaDays).toBe(exp.slaDays);
    expect(imp.offeredTick).toBe(exp.offeredTick);
    expect(imp.offerExpiresTick).toBe(exp.offerExpiresTick);
    expect(imp.templateId).toBe('container_feeder_roundtrip');
    expect(exp.booking?.destinationPort).toMatch(/^(Rotterdam|Hamburg|Gdańsk)$/);
    expect(imp.booking).toBeNull();
    const [importMin, importMax] = defs.contractTemplates.get('container_feeder_roundtrip').volumeUnitsRange;
    const [exportMin, exportMax] = defs.contractTemplates.get('container_feeder_roundtrip').exportVolumeUnitsRange as readonly [number, number];
    expect(imp.volumeUnits).toBeGreaterThanOrEqual(importMin);
    expect(imp.volumeUnits).toBeLessThanOrEqual(importMax);
    expect(exp.volumeUnits).toBeGreaterThanOrEqual(exportMin);
    expect(exp.volumeUnits).toBeLessThanOrEqual(exportMax);
  });

  it('export: jeden kontrakt s vlastnou voyage; objem z volumeUnitsRange šablóny', () => {
    const defs = only(BUNDLED, 'container_feeder_export');
    const { context } = contextOf(defs, 12);
    const group = drawBookingOffer(context);
    expect(group).toHaveLength(1);
    const [exp] = group;
    expect(exp.kind).toBe('export');
    expect(exp.voyageId).toBe(1);
    const [min, max] = defs.contractTemplates.get('container_feeder_export').volumeUnitsRange;
    expect(exp.volumeUnits).toBeGreaterThanOrEqual(min);
    expect(exp.volumeUnits).toBeLessThanOrEqual(max);
  });

  it('odmena exportu = ⌊booked × exportPricePerUnitCents × urgency / 10 000⌋; import roundtripu z basePricePerUnitCents', () => {
    const defs = only(BUNDLED, 'container_feeder_roundtrip');
    for (let seed = 1; seed <= 20; seed++) {
      const { context } = contextOf(defs, seed);
      const [imp, exp] = drawBookingOffer(context);
      // maxSlaDays = najväčšie slaDaysRange[1] cez šablóny defov (tu jediná šablóna roundtripu: 5).
      const maxSla = Math.max(...defs.contractTemplates.items.map((template) => template.slaDaysRange[1]));
      const urgency = 10_000 + Math.floor((6000 * (maxSla - imp.slaDays)) / maxSla);
      // Odmena a XP idú z TEU (ADR-039), nie z počtu kontajnerov.
      expect(exp.rewardCents).toBe(Math.floor((exp.volumeTeu * 40_000 * urgency) / 10_000));
      expect(imp.rewardCents).toBe(Math.floor((imp.volumeTeu * 45_000 * urgency) / 10_000));
      expect(exp.xpReward).toBe(exp.volumeTeu);
    }
  });

  it('spotreba Rng: šablóna (weighted), loď (pick), mierka (range), SLA (int), cieľový prístav (pick)', () => {
    const defs = BUNDLED;
    const { context, rng } = contextOf(defs, 13);
    const twin = Rng.fromState(rng.getState());
    const group = drawBookingOffer(context);
    const eligible = defs.contractTemplates.items.filter((template) => template.kind === 'export' || template.kind === 'roundtrip');
    const template = twin.weighted(eligible, (item) => item.weight);
    twin.pick(template.shipClassIds);
    twin.range(...defs.economy.volumeScaleRange);
    const sla = twin.int(template.slaDaysRange[0], template.slaDaysRange[1]);
    const port = twin.pick(template.destinationPorts as readonly string[]);
    // Zmes veľkostí (ADR-039): po ťahoch ponuky jeden `chance` na kontajner každého kontraktu skupiny v poradí vzniku (import, potom export).
    for (const contract of group) expect(drawContainerCount(twin, contract.volumeTeu, template.sizeMix ?? 0)).toBe(contract.volumeUnits);
    expect(group[0].templateId).toBe(template.id);
    expect(group[0].slaDays).toBe(sla);
    expect(group.at(-1)?.booking?.destinationPort).toBe(port);
    expect(rng.getState()).toEqual(twin.getState());
  });

  it('bez šablóny pre tier: prázdne pole a Rng sa nespotrebuje', () => {
    const items = RAW_DEFS.contract_templates.items.map((item) => (item.kind === 'import' ? item : { ...item, minTier: 3 }));
    const defs = DefRegistry.fromRaw({ ...RAW_DEFS, contract_templates: { ...RAW_DEFS.contract_templates, items } });
    const { context, rng } = contextOf(defs, 14);
    const before = rng.getState();
    expect(drawBookingOffer(context)).toEqual([]);
    expect(rng.getState()).toEqual(before);
  });

  it('import ponuka (drawOffer) ťahá len zo šablón druhu import — pri rovnakom Rng rovnako ako bez booking šablón', () => {
    const importOnly = DefRegistry.fromRaw({
      ...RAW_DEFS,
      contract_templates: { ...RAW_DEFS.contract_templates, items: RAW_DEFS.contract_templates.items.filter((item) => item.kind === 'import') },
    });
    for (let seed = 1; seed <= 25; seed++) {
      const a = contextOf(BUNDLED, seed);
      const b = contextOf(importOnly, seed);
      const offerA = drawOffer(a.context);
      const offerB = drawOffer(b.context);
      expect(offerA?.toState()).toEqual(offerB?.toState());
      expect(a.rng.getState()).toEqual(b.rng.getState());
      expect(offerA?.kind).toBe('import');
    }
  });
});

describe('ContractBook — skupiny ponúk', () => {
  it('offeredGroups počíta import a booking skupiny (roundtrip = jedna skupina o dvoch kontraktoch)', () => {
    const world = World.create(BUNDLED, MAP, 5005);
    const book = world.contractBook;
    expect(book.offeredGroups()).toEqual({ import: 0, booking: 0, repositioning: 0, tranship: 0 });
    const { context } = contextOf(only(BUNDLED, 'container_feeder_roundtrip'), 21, { nextId: () => book.allocateId(), nextVoyageId: () => book.allocateVoyageId() });
    for (const contract of drawBookingOffer(context)) book.add(contract);
    const importContext = contextOf(only(BUNDLED, 'container_feeder_export'), 22, { nextId: () => book.allocateId(), nextVoyageId: () => book.allocateVoyageId() }).context;
    for (const contract of drawBookingOffer(importContext)) book.add(contract);
    expect(book.offeredCount).toBe(3);
    expect(book.offeredGroups()).toEqual({ import: 0, booking: 2, repositioning: 0, tranship: 0 });
    const plain = drawOffer(contextOf(BUNDLED, 23, { nextId: () => book.allocateId(), nextVoyageId: () => book.allocateVoyageId() }).context);
    book.add(plain as NonNullable<typeof plain>);
    expect(book.offeredGroups()).toEqual({ import: 1, booking: 2, repositioning: 0, tranship: 0 });
  });

  it('offeredOfVoyage vráti kópiu ponúk voyage vzostupne podľa id a len stav offered', () => {
    const world = World.create(BUNDLED, MAP, 5005);
    const book = world.contractBook;
    const { context } = contextOf(only(BUNDLED, 'container_feeder_roundtrip'), 24, { nextId: () => book.allocateId(), nextVoyageId: () => book.allocateVoyageId() });
    const group = drawBookingOffer(context);
    for (const contract of group) book.add(contract);
    const offered = book.offeredOfVoyage(group[0].voyageId);
    expect(offered.map((contract) => contract.id)).toEqual(group.map((contract) => contract.id));
    expect(offered).not.toBe(book.voyageContracts(group[0].voyageId));
    book.changeState(group[0], 'expired');
    expect(book.offeredOfVoyage(group[0].voyageId).map((contract) => contract.id)).toEqual([group[1].id]);
    expect(book.offeredOfVoyage(9999 as VoyageId)).toEqual([]);
  });
});

describe('pool: booking ponuky pri DayClosed', () => {
  it('pri štarte hry (tick 1) len import ponuky; booking ponuky až pri prvom DayClosed, po import ponukách', () => {
    const world = World.create(BUNDLED, MAP, 5005);
    const start = world.tick();
    expect(start.filter((event) => event.type === 'ContractOffered')).toHaveLength(BUNDLED.economy.offersPerDay);
    expect(world.contractBook.offeredGroups()).toEqual({ import: BUNDLED.economy.offersPerDay, booking: 0, repositioning: 0, tranship: 0 });
    while (world.clock.tick < TICKS_PER_DAY - 1) world.tick();
    expect(world.contractBook.offeredGroups().booking).toBe(0);
    const events = world.tick();
    const offered = events.filter((event): event is Extract<typeof event, { type: 'ContractOffered' }> => event.type === 'ContractOffered');
    expect(offered.length).toBeGreaterThanOrEqual(BUNDLED.economy.bookingOffersPerDay);
    expect(world.contractBook.offeredGroups()).toEqual({ import: BUNDLED.economy.offersPerDay, booking: BUNDLED.economy.bookingOffersPerDay, repositioning: 0, tranship: 0 });
    // Ponuky vznikli vzostupne podľa id a patria booking šablónam.
    expect(offered.map((event) => event.contractId)).toEqual([...offered.map((event) => event.contractId)].sort((a, b) => a - b));
    for (const event of offered) {
      const contract = world.contracts.get(event.contractId);
      expect(world.contractBook.voyageContracts(contract!.voyageId).some((mate) => mate.kind === 'export')).toBe(true);
    }
  });

  it('prvé naplnenie poolu a ťah príchodu pri prijatí v ticku 1 sú bitovo rovnaké ako bez booking ponúk', () => {
    const noBookings = DefRegistry.fromRaw({ ...RAW_DEFS, economy: { ...RAW_DEFS.economy, bookingOffersPerDay: 0 } });
    const run = (defs: DefRegistry): { cash: number; rng: unknown; contracts: unknown } => {
      const world = World.create(defs, MAP, 5005);
      world.tick();
      const first = [...world.contracts.values()][0];
      world.enqueue(commandFromJSON({ type: 'AcceptContract', contractId: first.id }));
      world.tick();
      return { cash: world.cashCents, rng: world.rng.getState(), contracts: world.contractBook.getState().contracts };
    };
    expect(run(BUNDLED)).toEqual(run(noBookings));
  });

  it('pool nikdy nepresiahne offersPerDay import a bookingOffersPerDay booking skupín; expirované skupiny sa dopĺňajú', () => {
    const world = World.create(BUNDLED, MAP, 5005);
    let maxBooking = 0;
    let maxImport = 0;
    for (let tick = 0; tick < 6 * TICKS_PER_DAY; tick++) {
      world.tick();
      const groups = world.contractBook.offeredGroups();
      maxBooking = Math.max(maxBooking, groups.booking);
      maxImport = Math.max(maxImport, groups.import);
    }
    expect(maxImport).toBe(BUNDLED.economy.offersPerDay);
    expect(maxBooking).toBe(BUNDLED.economy.bookingOffersPerDay);
    // Booking ponuky expirovali (po 2 dňoch) a pool ich doplnil novými: id kontraktov presiahlo prvú dávku.
    expect(world.contractBook.getState().nextVoyageId).toBeGreaterThan(BUNDLED.economy.offersPerDay + BUNDLED.economy.bookingOffersPerDay + 1);
  });

  it('bookingOffersPerDay = 0: žiadne booking ponuky a Rng prúd rovnaký ako pred F6a (import-only svet)', () => {
    const none = DefRegistry.fromRaw({ ...RAW_DEFS, economy: { ...RAW_DEFS.economy, bookingOffersPerDay: 0 } });
    const world = World.create(none, MAP, 5005);
    for (let tick = 0; tick < 3 * TICKS_PER_DAY; tick++) world.tick();
    for (const contract of world.contracts.values()) expect(contract.kind).toBe('import');
    expect(world.contractBook.offeredGroups().booking).toBe(0);
  });
});
