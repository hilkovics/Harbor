/**
 * Prijatie a odmietnutie booking ponuky (F6a, T6A-04, ADR-032 bod 1 a 6): príkazy pôsobia na skupinu ponuky (všetky
 * `offered` kontrakty jednej voyage), plán lode je spoločný (`exportArrivalDaysRange` pri exporte, `arrivalDaysRange` pri
 * importe), export booking dostane cut-off a plán príchodov kamiónov z jediného `Rng` v okne pred cut-off.
 */
import { describe, expect, it } from 'vitest';
import { ImportContract } from '@sim/contracts';
import { Rng } from '@sim/core/rng';
import {
  F6A_CUTOFF_HOURS,
  F6A_WINDOW_DAYS,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  acceptCommand,
  contractOf,
  exportWorld,
  f6aDefs,
  offerBooking,
  send,
} from '../helpers/f6a';

const CUTOFF_TICKS = F6A_CUTOFF_HOURS * TICKS_PER_HOUR;
const declineCommand = (contractId: number) => ({ type: 'DeclineContract', contractId });

describe('AcceptContract — skupina ponuky', () => {
  it('roundtrip: prijatie exportu prijme aj import tej istej voyage, zdieľajú príchod lode', () => {
    const world = exportWorld();
    const offer = offerBooking(world, { kind: 'roundtrip', booked: 12, importUnits: 6 });
    const imp = offer.importContract!;
    const exp = offer.exportContract;
    expect(exp.voyageId).toBe(imp.voyageId);
    const events = send(world, acceptCommand(exp.id));
    expect(imp.state).toBe('accepted');
    expect(exp.state).toBe('accepted');
    expect(imp.shipArrivalTick).toBe(exp.shipArrivalTick);
    expect(imp.acceptedTick).toBe(exp.acceptedTick);
    expect(events.filter((event) => event.type === 'ContractAccepted').map((event) => event.type === 'ContractAccepted' && event.contractId)).toEqual([imp.id, exp.id]);
    expect(events.filter((event) => event.type === 'ContractStateChanged').map((event) => event.type === 'ContractStateChanged' && event.to)).toEqual(['accepted', 'accepted']);
    // SLA každého kontraktu od príchodu lode podľa jeho `slaDays`.
    expect(imp.slaDeadlineTick).toBe((imp.shipArrivalTick as number) + imp.slaDays * TICKS_PER_DAY);
    expect(exp.slaDeadlineTick).toBe((exp.shipArrivalTick as number) + exp.slaDays * TICKS_PER_DAY);
  });

  it('prijatie importu roundtripu (nižšie id) prijme aj export a naplánuje jeho príchody', () => {
    const world = exportWorld();
    const offer = offerBooking(world, { kind: 'roundtrip' });
    send(world, acceptCommand(offer.importContract!.id));
    expect(offer.exportContract.state).toBe('accepted');
    expect(offer.exportContract.booking.cutoffTick).toBeDefined();
    expect(offer.exportContract.booking.arrivalPlan).toHaveLength(12);
  });

  it('export-only booking je skupina o jednom kontrakte; iné ponuky ostávajú ponukami', () => {
    const world = exportWorld();
    const first = offerBooking(world, { kind: 'export' });
    const second = offerBooking(world, { kind: 'export' });
    send(world, acceptCommand(first.exportContract.id));
    expect(first.exportContract.state).toBe('accepted');
    expect(second.exportContract.state).toBe('offered');
    expect(second.exportContract.booking.cutoffTick).toBeUndefined();
    expect(second.exportContract.booking.arrivalPlan).toEqual([]);
  });

  it('príchod lode skupiny s exportom: jeden ťah rng.range(exportArrivalDaysRange) × ticksPerDay (celé dni → presne)', () => {
    const world = exportWorld();
    const offer = offerBooking(world, { kind: 'export' });
    const tick = world.clock.tick;
    send(world, acceptCommand(offer.exportContract.id));
    expect(offer.exportContract.acceptedTick).toBe(tick);
    expect(offer.exportContract.shipArrivalTick).toBe(tick + TICKS_PER_DAY);
  });

  it('import ponuka: ako vo F5 — jeden ťah arrivalDaysRange (nie exportArrivalDaysRange) a žiadny booking', () => {
    const world = exportWorld({ defs: f6aDefs({ economy: { arrivalDaysRange: [1.5, 1.5], exportArrivalDaysRange: [3, 3] } }) });
    const book = world.contractBook;
    const contract = new ImportContract({
      id: book.allocateId(),
      voyageId: book.allocateVoyageId(),
      templateId: 'container_feeder_standard',
      cargoTypeId: 'container_teu',
      volumeUnits: 10,
      slaDays: 3,
      rewardCents: 1_000_000,
      xpReward: 10,
      offeredTick: world.clock.tick,
      offerExpiresTick: world.clock.tick + 2 * TICKS_PER_DAY,
      shipClassId: 'feeder',
      lineId: 'blue_anchor',
    });
    book.add(contract);
    const tick = world.clock.tick;
    const before = world.rng.getState();
    send(world, acceptCommand(contract.id));
    expect(contract.shipArrivalTick).toBe(tick + Math.round(1.5 * TICKS_PER_DAY));
    expect(contract.booking).toBeNull();
    // Práve jeden ťah `Rng` (žiadny plán príchodov).
    const twin = Rng.fromState(before);
    twin.next();
    expect(world.rng.getState()).toEqual(twin.getState());
  });

  it('prijatý kontrakt sa už prijať nedá (contract_not_offered) a neznámy kontrakt je unknown_contract', () => {
    const world = exportWorld();
    const offer = offerBooking(world, { kind: 'export' });
    send(world, acceptCommand(offer.exportContract.id));
    const again = send(world, acceptCommand(offer.exportContract.id));
    expect(again).toEqual([{ type: 'CommandRejected', commandType: 'AcceptContract', reasons: ['contract_not_offered'] }]);
    expect(send(world, acceptCommand(9999))).toEqual([{ type: 'CommandRejected', commandType: 'AcceptContract', reasons: ['unknown_contract'] }]);
  });
});

describe('plán príchodov exportu (ADR-032 bod 6)', () => {
  it('cut-off = príchod lode − round(cutoffHours × ticksPerHour); plán má toľko príchodov, koľko je bookované, neklesajúco', () => {
    const world = exportWorld();
    const offer = offerBooking(world, { kind: 'export', booked: 20 });
    send(world, acceptCommand(offer.exportContract.id));
    const booking = offer.exportContract.booking;
    expect(booking.cutoffTick).toBe((offer.exportContract.shipArrivalTick as number) - CUTOFF_TICKS);
    expect(booking.arrivalPlan).toHaveLength(20);
    expect([...booking.arrivalPlan].sort((a, b) => a - b)).toEqual(booking.arrivalPlan);
  });

  it('príchody ležia v okne [max(prijatie + 1, príchod lode − okno), cut-off]', () => {
    const world = exportWorld();
    const offer = offerBooking(world, { kind: 'export', booked: 36 });
    const tick = world.clock.tick;
    send(world, acceptCommand(offer.exportContract.id));
    const { arrivalPlan, cutoffTick } = offer.exportContract.booking;
    const arrival = offer.exportContract.shipArrivalTick as number;
    const windowStart = Math.max(tick + 1, arrival - F6A_WINDOW_DAYS * TICKS_PER_DAY);
    expect(windowStart).toBe(tick + 1);
    for (const planned of arrivalPlan) {
      expect(planned).toBeGreaterThanOrEqual(windowStart);
      expect(planned).toBeLessThanOrEqual(cutoffTick as number);
    }
  });

  it('okno širšie než čas do príchodu sa zreže na prijatie + 1 (nič pred prijatím)', () => {
    const world = exportWorld({ defs: f6aDefs({ exportFlow: { arrivalWindowDays: 5 } }) });
    const offer = offerBooking(world, { kind: 'export', booked: 30 });
    const tick = world.clock.tick;
    send(world, acceptCommand(offer.exportContract.id));
    const { arrivalPlan } = offer.exportContract.booking;
    expect(Math.min(...arrivalPlan)).toBeGreaterThanOrEqual(tick + 1);
  });

  it('spotreba Rng: najprv ťah príchodu lode, potom `booked` ťahov rng.int(windowStart, cutoff) a plán je ich zoradenie', () => {
    const world = exportWorld();
    const offer = offerBooking(world, { kind: 'export', booked: 15 });
    const tick = world.clock.tick;
    const twin = Rng.fromState(world.rng.getState());
    send(world, acceptCommand(offer.exportContract.id));
    const arrival = tick + Math.max(1, Math.round(twin.range(1, 1) * TICKS_PER_DAY));
    const cutoff = arrival - CUTOFF_TICKS;
    const windowStart = Math.max(tick + 1, arrival - F6A_WINDOW_DAYS * TICKS_PER_DAY);
    const drawn = Array.from({ length: 15 }, () => twin.int(windowStart, cutoff)).sort((a, b) => a - b);
    expect(offer.exportContract.booking.arrivalPlan).toEqual(drawn);
    expect(world.rng.getState()).toEqual(twin.getState());
  });

  it('dve prijatia za sebou: plány sú z toho istého prúdu, druhé nasleduje za prvým (rovnaký prúd → rovnaké plány)', () => {
    const run = (): number[][] => {
      const world = exportWorld();
      const a = offerBooking(world, { kind: 'export', booked: 5 });
      const b = offerBooking(world, { kind: 'export', booked: 5 });
      send(world, acceptCommand(a.exportContract.id));
      send(world, acceptCommand(b.exportContract.id));
      return [[...a.exportContract.booking.arrivalPlan], [...b.exportContract.booking.arrivalPlan]];
    };
    const first = run();
    expect(run()).toEqual(first);
    expect(first[0]).not.toEqual(first[1]);
  });

  it('ponuka nemá cut-off ani plán; po prijatí ich má a stav zodpovedá `accepted`', () => {
    const world = exportWorld();
    const offer = offerBooking(world, { kind: 'export' });
    expect(offer.exportContract.booking).toMatchObject({ cutoffTick: undefined, arrivalPlan: [], arrivedUnits: 0 });
    send(world, acceptCommand(offer.exportContract.id));
    expect(contractOf(world, offer.exportContract.id).state).toBe('accepted');
    expect(world.contractBook.voyage(offer.voyageId)).toMatchObject({ destinationPort: 'Hamburg', cutoffTick: offer.exportContract.booking.cutoffTick });
  });
});

describe('DeclineContract — skupina ponuky', () => {
  it('roundtrip: odmietnutie jedného kontraktu zruší obe ponuky (expired, declined) a kniha ich zabudne', () => {
    const world = exportWorld();
    const offer = offerBooking(world, { kind: 'roundtrip' });
    const keep = offerBooking(world, { kind: 'export' });
    const before = world.rng.getState();
    const events = send(world, declineCommand(offer.exportContract.id));
    expect(events.filter((event) => event.type === 'ContractExpired')).toEqual([
      { type: 'ContractExpired', contractId: offer.importContract!.id, reason: 'declined' },
      { type: 'ContractExpired', contractId: offer.exportContract.id, reason: 'declined' },
    ]);
    expect(world.contracts.has(offer.importContract!.id)).toBe(false);
    expect(world.contracts.has(offer.exportContract.id)).toBe(false);
    expect(world.contractBook.voyageContracts(offer.voyageId)).toHaveLength(0);
    expect(keep.exportContract.state).toBe('offered');
    // Odmietnutie nespotrebuje `Rng`.
    expect(world.rng.getState()).toEqual(before);
  });

  it('odmietnutie importu roundtripu zruší aj export', () => {
    const world = exportWorld();
    const offer = offerBooking(world, { kind: 'roundtrip' });
    send(world, declineCommand(offer.importContract!.id));
    expect(world.contracts.has(offer.exportContract.id)).toBe(false);
  });
});
