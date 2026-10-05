/**
 * Ponuky F6c v poole a v knihe (T6C-03, ADR-034 bod 9–11 + dodatok): `drawRepositioningOffer` (vlastná voyage, alebo export + repositioning jednej
 * voyage), `drawTranshipOffer` (voyage lode A a B), doplnenie poolu len pri `DayClosed` po booking ponukách a **len v prístave s depom prázdnych**
 * (svet bez depa ostáva bitovo rovnaký), `ContractBook.redirectTranship`, `cargoMoved` prázdnych a `hasOpenExports` pre nové druhy.
 */
import { describe, expect, it } from 'vitest';
import {
  ContractBook,
  EmptyRepositioningContract,
  ExportContract,
  TEMPLATE_GROUP_KINDS,
  TranshipContract,
  drawRepositioningOffer,
  drawTranshipOffer,
  eligibleTemplates,
  type OfferContext,
} from '@sim/contracts';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import { Rng } from '@sim/core/rng';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { EMPTY_WEIGHT_CLASS, type CargoUnit } from '@sim/cargo';
import { exportWorld, RAW_DEFS, send, TICKS_PER_DAY, tickEvents } from '../helpers/f6a';
import { depotOf, emptyWorld, f6cDefs, offerRepositioning, offerTranship } from '../helpers/f6c';
import { DEFS as BUNDLED } from '../world/world-fixtures';

function contextOf(defs: DefRegistry, seed: number, tier = 0): { context: OfferContext; rng: Rng } {
  const rng = new Rng(seed);
  let nextId = 1;
  let nextVoyage = 1;
  return {
    rng,
    context: {
      defs,
      rng,
      tick: 8640,
      ticksPerDay: TICKS_PER_DAY,
      tier,
      capacityHint: 60,
      storageCapacity: 128,
      nextId: () => nextId++ as ContractId,
      nextVoyageId: () => nextVoyage++ as VoyageId,
    },
  };
}

const only = (id: string): DefRegistry =>
  DefRegistry.fromRaw({ ...RAW_DEFS, contract_templates: { ...RAW_DEFS.contract_templates, items: RAW_DEFS.contract_templates.items.filter((item) => item.id === id) } });

describe('TEMPLATE_GROUP_KINDS a eligibleTemplates — skupiny F6c', () => {
  it('repositioning a tranship majú vlastnú skupinu; import a booking skupina ich nezahŕňa', () => {
    expect([...TEMPLATE_GROUP_KINDS.repositioning]).toEqual(['empty_repositioning']);
    expect([...TEMPLATE_GROUP_KINDS.tranship]).toEqual(['tranship']);
    expect(eligibleTemplates(BUNDLED.contractTemplates.items, 0, 'repositioning').map((item) => item.id)).toEqual(['container_feeder_repositioning', 'container_feeder_export_repositioning']);
    expect(eligibleTemplates(BUNDLED.contractTemplates.items, 0, 'tranship').map((item) => item.id)).toEqual(['container_feeder_tranship']);
  });
});

describe('drawRepositioningOffer', () => {
  it('šablóna bez exportu: jeden kontrakt repositioningu s vlastnou voyage, linkou podľa voyage a odmenou z repositioningPricePerUnitCents', () => {
    const defs = only('container_feeder_repositioning');
    for (let seed = 1; seed <= 20; seed++) {
      const { context } = contextOf(defs, seed);
      const group = drawRepositioningOffer(context);
      expect(group).toHaveLength(1);
      const [repo] = group;
      expect(repo).toBeInstanceOf(EmptyRepositioningContract);
      expect(repo.kind).toBe('empty_repositioning');
      expect(repo.voyageId).toBe(1);
      expect(repo.lineId).toBe('blue_anchor');
      const [min, max] = defs.contractTemplates.get('container_feeder_repositioning').volumeUnitsRange;
      expect(repo.volumeUnits).toBeGreaterThanOrEqual(min);
      expect(repo.volumeUnits).toBeLessThanOrEqual(max);
      const maxSla = Math.max(...defs.contractTemplates.items.map((template) => template.slaDaysRange[1]));
      const urgency = 10_000 + Math.floor((6000 * (maxSla - repo.slaDays)) / maxSla);
      expect(repo.rewardCents).toBe(Math.floor((repo.volumeUnits * 12_000 * urgency) / 10_000));
      expect(repo.booking?.destinationPort).toMatch(/^(Rotterdam|Hamburg|Gdańsk)$/);
    }
  });

  it('šablóna s exportVolumeUnitsRange: export (id n) a repositioning (id n + 1) na jednej voyage, rovnaká linka, loď a SLA', () => {
    const { context } = contextOf(only('container_feeder_export_repositioning'), 5);
    const group = drawRepositioningOffer(context);
    expect(group.map((contract) => [contract.kind, contract.id])).toEqual([['export', 1], ['empty_repositioning', 2]]);
    const [exp, repo] = group;
    expect(exp).toBeInstanceOf(ExportContract);
    expect(exp.voyageId).toBe(repo.voyageId);
    expect(exp.lineId).toBe(repo.lineId);
    expect(exp.shipClassId).toBe(repo.shipClassId);
    expect(exp.slaDays).toBe(repo.slaDays);
    expect(exp.booking?.destinationPort).toBe(repo.booking?.destinationPort);
    expect(exp.volumeUnits).toBeGreaterThanOrEqual(12);
    expect(exp.volumeUnits).toBeLessThanOrEqual(36);
    expect(repo.volumeUnits).toBeGreaterThanOrEqual(12);
    expect(repo.volumeUnits).toBeLessThanOrEqual(24);
  });

  it('bez vhodnej šablóny (minTier vyšší než tier) vráti prázdne pole a nespotrebuje Rng', () => {
    const defs = DefRegistry.fromRaw({
      ...RAW_DEFS,
      contract_templates: { ...RAW_DEFS.contract_templates, items: RAW_DEFS.contract_templates.items.map((item) => (item.kind === 'empty_repositioning' ? { ...item, minTier: 3 } : item)) },
    });
    const { context, rng } = contextOf(defs, 5);
    const before = rng.getState();
    expect(drawRepositioningOffer(context)).toEqual([]);
    expect(rng.getState()).toEqual(before);
  });
});

describe('drawTranshipOffer', () => {
  it('jeden kontrakt prekládky: voyage lode A a hneď po nej voyage lode B, odmena z transhipPricePerUnitCents, linka podľa voyage A', () => {
    const defs = only('container_feeder_tranship');
    for (let seed = 1; seed <= 20; seed++) {
      const { context } = contextOf(defs, seed);
      const group = drawTranshipOffer(context);
      expect(group).toHaveLength(1);
      const [leg] = group as [TranshipContract];
      expect(leg).toBeInstanceOf(TranshipContract);
      expect(leg.voyageId).toBe(1);
      expect(leg.outVoyageId).toBe(2);
      expect(leg.voyageIds).toEqual([1, 2]);
      expect(leg.lineId).toBe('blue_anchor');
      const maxSla = Math.max(...defs.contractTemplates.items.map((template) => template.slaDaysRange[1]));
      const urgency = 10_000 + Math.floor((6000 * (maxSla - leg.slaDays)) / maxSla);
      expect(leg.rewardCents).toBe(Math.floor((leg.volumeUnits * 28_000 * urgency) / 10_000));
      expect(leg.state).toBe('offered');
    }
  });
});

describe('pool — doplnenie ponúk F6c pri DayClosed len v prístave s depom prázdnych', () => {
  /** Defy s pool ponukami F6c (1 + 1 denne), bez import a booking ponúk, aby sa ponuky F6c dali sledovať. */
  const poolDefs = () => f6cDefs({ economy: { repositioningOffersPerDay: 1, transhipOffersPerDay: 1 } });

  function offeredAfterDay(world: ReturnType<typeof emptyWorld>): readonly string[] {
    const events: SimEvent[] = [];
    for (let i = 0; i < TICKS_PER_DAY + 2; i++) events.push(...world.tick());
    expect(events.some((event) => event.type === 'DayClosed')).toBe(true);
    return [...world.contractBook.openContracts.values()].filter((contract) => contract.state === 'offered').map((contract) => contract.kind);
  }

  it('s depom: po prvej polnoci jedna ponuka repositioningu a jedna prekládky; ďalšia polnoc ich nezdvojí (skupiny sa doplnia len do počtu za deň)', () => {
    const world = emptyWorld({ defs: poolDefs() });
    const kinds = offeredAfterDay(world);
    expect(kinds.filter((kind) => kind === 'tranship')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'empty_repositioning').length).toBeGreaterThanOrEqual(1);
    const groups = world.contractBook.offeredGroups();
    expect(groups.repositioning).toBe(1);
    expect(groups.tranship).toBe(1);
    for (let i = 0; i < TICKS_PER_DAY; i++) world.tick();
    expect(world.contractBook.offeredGroups()).toMatchObject({ repositioning: 1, tranship: 1 });
  });

  it('bez depa: nič sa neponúka a Rng sa nespotrebuje (rovnaký stav ako svet s vypnutými ponukami F6c)', () => {
    const withOffers = emptyWorld({ defs: poolDefs(), depot: false });
    const without = emptyWorld({ defs: f6cDefs({ economy: { repositioningOffersPerDay: 0, transhipOffersPerDay: 0 } }), depot: false });
    expect(offeredAfterDay(withOffers)).toEqual([]);
    expect(offeredAfterDay(without)).toEqual([]);
    expect(withOffers.rng.getState()).toEqual(without.rng.getState());
  });

  it('po zbúraní depa sa nové ponuky F6c neťahajú: existujúce expirujú a pool ostane bez nich', () => {
    const world = emptyWorld({ defs: poolDefs() });
    offeredAfterDay(world);
    expect(world.contractBook.offeredGroups()).toMatchObject({ repositioning: 1, tranship: 1 });
    const removed = send(world, { type: 'RemoveModule', moduleId: depotOf(world).id });
    expect(removed.some((event) => event.type === 'ModuleRemoved')).toBe(true);
    tickEvents(world, 3 * TICKS_PER_DAY);
    expect(world.contractBook.offeredGroups()).toMatchObject({ repositioning: 0, tranship: 0 });
  });
});

describe('ContractBook — voyage B prekládky, redirectTranship a hasOpenExports', () => {
  const world = () => exportWorld({ defs: f6cDefs() });

  it('prekládka je v indexe pod voyage A aj B; redirectTranship ju presunie pod novú voyage (vzostupne podľa id) a odstráni zo starej', () => {
    const w = world();
    const book = w.contractBook;
    const leg = offerTranship(w, { units: 3 });
    const mate = offerTranship(w, { units: 2 });
    expect(book.voyageContracts(leg.outVoyageId).map((c) => c.id)).toEqual([leg.id]);
    // záchrana na voyage A druhej prekládky (leg má nižšie id než mate → zaradí sa pred ňu)
    const oldOutVoyage = leg.outVoyageId;
    book.redirectTranship(leg, mate.voyageId, 99_999, undefined);
    expect(leg.outVoyageId).toBe(mate.voyageId);
    expect(leg.outArrivalTick).toBe(99_999);
    expect(leg.rescueDeadlineTick).toBeUndefined();
    expect(book.voyageContracts(mate.voyageId).map((c) => c.id)).toEqual([leg.id, mate.id]);
    expect(book.voyageContracts(leg.voyageId).map((c) => c.id)).toEqual([leg.id]);
    // pôvodná voyage B zanikla (nemá kontrakt)
    expect(book.voyage(oldOutVoyage)).toBeUndefined();
    expect(book.voyage(mate.voyageId)?.contracts.map((c) => c.id)).toEqual([leg.id, mate.id]);
  });

  it('redirectTranship odmietne neznámu voyage a vlastnú voyage lode A; kontrakt mimo knihy', () => {
    const w = world();
    const leg = offerTranship(w);
    expect(() => w.contractBook.redirectTranship(leg, leg.voyageId, 5, undefined)).toThrow(/nemožno preadresovať/);
    expect(() => w.contractBook.redirectTranship(leg, 9_999 as VoyageId, 5, undefined)).toThrow(/nemožno preadresovať/);
    const other = new ContractBook({ events: { emit: () => undefined }, clock: { tick: 0 } });
    expect(() => other.redirectTranship(leg, 2 as VoyageId, 5, undefined)).toThrow(/nie je v knihe/);
  });

  it('hasOpenExports platí pre repositioning aj prekládku (booking kontrakty), po ich uzavretí klesne', () => {
    const w = world();
    expect(w.contractBook.hasOpenExports).toBe(false);
    const repo = offerRepositioning(w);
    expect(w.contractBook.hasOpenExports).toBe(true);
    w.contractBook.changeState(repo, 'expired');
    expect(w.contractBook.hasOpenExports).toBe(false);
    const leg = offerTranship(w);
    expect(w.contractBook.hasOpenExports).toBe(true);
    w.contractBook.changeState(leg, 'expired');
    expect(w.contractBook.hasOpenExports).toBe(false);
  });

  it('prázdny naložený na loď počíta booking repositioningu tej lode a linky; iná loď alebo iná linka sa nepočíta', () => {
    const w = emptyWorld({ defs: f6cDefs() });
    const repo = offerRepositioning(w, { booked: 3, lineId: 'blue_anchor' });
    repo.shipId = 77 as EntityId;
    (repo as unknown as { arrivedUnits: number }).arrivedUnits = 3;
    const unit = (lineId: string, id: number): CargoUnit =>
      ({ id: id as EntityId, typeId: 'container_teu', contractId: null, voyageId: null, lineId, direction: 'empty', destinationPort: null, weightClass: EMPTY_WEIGHT_CLASS, hold: null, status: 'available', repairUntilTick: null, quantity: 1, location: { kind: 'in_crane', craneId: 5 as EntityId } }) as CargoUnit;
    const book = w.contractBook;
    // booking v `offered` (nie je ani prijatý) — počíta sa len neukončený s loďou; test volá háčik priamo
    book.cargoMoved(unit('blue_anchor', 1), { kind: 'on_ship', shipId: 78 as EntityId });
    expect(repo.loadedUnits).toBe(0);
    book.cargoMoved(unit('northern_star', 2), { kind: 'on_ship', shipId: 77 as EntityId });
    expect(repo.loadedUnits).toBe(0);
    book.cargoMoved(unit('blue_anchor', 3), { kind: 'on_ship', shipId: 77 as EntityId });
    expect(repo.loadedUnits).toBe(1);
    // iný presun prázdneho (výdaj kamiónom) booking nezmení
    book.cargoMoved(unit('blue_anchor', 4), { kind: 'exported' });
    expect(repo.loadedUnits).toBe(1);
  });
});
