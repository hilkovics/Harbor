/**
 * `AcceptContract` overí pripravenosť pozemnej strany pri export / roundtrip bookingu (F6a, ADR-032; vzor `berthReadiness`,
 * ADR-031): bez rampy kategórie, bez prevádzkovej rampy (brána, stojisko, cesta) alebo bez skladu dosiahnuteľného z rampy by
 * kamióny s exportom nevznikli a booking by skončil penalizáciou. Import ponuky sa nekontrolujú. Validácia svet nemení.
 */
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import { ImportContract } from '@sim/contracts';
import type { ContractId, VoyageId } from '@sim/core';
import { stateHash } from '@sim/world';
import { acceptCommand, exportWorld, offerBooking, TICKS_PER_DAY } from '../helpers/f6a';

const reasonsOf = (world: ReturnType<typeof exportWorld>, contractId: number): readonly string[] => commandFromJSON(acceptCommand(contractId)).validate(world).reasons;

describe('AcceptContract: pripravenosť pozemnej strany exportu (ADR-032)', () => {
  it('úplný prístav (brána, stojisko, rampa, sklady, cesty): export aj roundtrip sa dajú prijať', () => {
    const world = exportWorld();
    const exportOnly = offerBooking(world, { kind: 'export' });
    const roundtrip = offerBooking(world, { kind: 'roundtrip' });
    expect(reasonsOf(world, exportOnly.exportContract.id)).toEqual([]);
    expect(reasonsOf(world, roundtrip.exportContract.id)).toEqual([]);
    expect(reasonsOf(world, roundtrip.importContract!.id)).toEqual([]);
  });

  it('bez rampy kategórie: no_ramp_for_category (export aj roundtrip, aj cez import kontrakt skupiny)', () => {
    const world = exportWorld({ landside: ['gate', 'waiting_area'] });
    const exportOnly = offerBooking(world, { kind: 'export' });
    const roundtrip = offerBooking(world, { kind: 'roundtrip' });
    expect(reasonsOf(world, exportOnly.exportContract.id)).toEqual(['no_ramp_for_category']);
    expect(reasonsOf(world, roundtrip.exportContract.id)).toEqual(['no_ramp_for_category']);
    expect(reasonsOf(world, roundtrip.importContract!.id)).toEqual(['no_ramp_for_category']);
  });

  it('rampa bez brány alebo bez stojiska nie je prevádzková: ramp_inoperative', () => {
    for (const landside of [['waiting_area', 'ramp'], ['gate', 'ramp']] as const) {
      const world = exportWorld({ landside });
      const offer = offerBooking(world, { kind: 'export' });
      expect(reasonsOf(world, offer.exportContract.id), landside.join('+')).toEqual(['ramp_inoperative']);
    }
  });

  it('prerušená cesta od portálu k bráne: ramp_inoperative', () => {
    const world = exportWorld({ omitRoadCells: [{ x: 44, y: 33 }] });
    const offer = offerBooking(world, { kind: 'export' });
    expect(reasonsOf(world, offer.exportContract.id)).toEqual(['ramp_inoperative']);
  });

  it('bez skladu kategórie dosiahnuteľného z rampy: no_storage_for_category', () => {
    const world = exportWorld({ yards: [] });
    const offer = offerBooking(world, { kind: 'roundtrip' });
    expect(reasonsOf(world, offer.exportContract.id)).toEqual(['no_storage_for_category']);
  });

  it('import ponuka sa pozemnou stranou neposudzuje (aj bez rampy a skladov)', () => {
    const world = exportWorld({ landside: [], yards: [] });
    const book = world.contractBook;
    const tick = world.clock.tick;
    const voyageId = book.allocateVoyageId();
    const offer = new ImportContract({
      id: book.allocateId() as ContractId,
      voyageId: voyageId as VoyageId,
      templateId: 'container_feeder_import',
      cargoTypeId: 'container_teu',
      volumeUnits: 6,
      slaDays: 3,
      rewardCents: 1_000_000,
      xpReward: 10,
      offeredTick: tick,
      offerExpiresTick: tick + 2 * TICKS_PER_DAY,
      shipClassId: 'feeder',
      lineId: 'blue_anchor',
    });
    book.add(offer);
    expect(reasonsOf(world, offer.id)).toEqual([]);
  });

  it('odmietnutie pri aplikácii = CommandRejected, ponuka ostane v offered; validate svet nemení', () => {
    const world = exportWorld({ landside: ['gate', 'waiting_area'] });
    const offer = offerBooking(world, { kind: 'roundtrip' });
    const before = stateHash(world);
    world.enqueue(commandFromJSON(acceptCommand(offer.exportContract.id)));
    const events = world.applyPending();
    expect(events).toEqual([{ type: 'CommandRejected', commandType: 'AcceptContract', reasons: ['no_ramp_for_category'] }]);
    expect(offer.exportContract.state).toBe('offered');
    expect(offer.importContract!.state).toBe('offered');
    expect(stateHash(world)).toBe(before);
  });
});
