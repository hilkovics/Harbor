/**
 * R2 / TR2-01 (ADR-039): TEU v kontraktoch a lodiach — veľkosti jednotiek z kontraktu (loď, kamión s exportom), výplata a penalizácie za TEU,
 * kapacita lode v TEU (nakládka aj invariant), save roundtrip kontraktu s TEU počítadlami a dedenie veľkosti prázdneho kontajnera.
 * Svet = prístav F4 (`exportWorld`), booking sa prijíma príkazom, príchody kamiónov sú pevné (`arrivals`), hmotnostná trieda je vždy `medium`.
 */
import { describe, expect, it } from 'vitest';
import { teuOf, type CargoUnit } from '@sim/cargo';
import { Contract, ExportContract, ImportContract, unitSizeFt } from '@sim/contracts';
import { bookingFulfilmentUnits, bookingPayoutCents, bookingUnitsPenaltyCents } from '@sim/contracts/contract-terms';
import type { EntityId } from '@sim/core';
import { EmptyFlow } from '@sim/logistics';
import { World, type WorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { apronDefs, ofType, runUntilDeparted, startLoading, tickUntil } from '../helpers/f6a';

const LOAD_TIMEOUT = 40_000;
const MEDIUM_ONLY = { weightClassShares: { light: 0, medium: 1, heavy: 0 } };

/** Jednotky na lodi / v ledgeri podľa predikátu, vzostupne podľa id. */
const unitsWhere = (world: World, predicate: (unit: CargoUnit) => boolean): CargoUnit[] => [...world.cargo.liveUnits()].filter(predicate).sort((a, b) => a.id - b.id);

describe('veľkosť jednotiek z kontraktu', () => {
  it('loď importu privezie kontajnery s veľkosťami unitSizeFt(i) a súčtom TEU = volumeTeu', () => {
    const defs = apronDefs({ exportFlow: MEDIUM_ONLY });
    const { world, offer } = startLoading({ defs, kind: 'roundtrip', booked: 4, bookedTeu: 6, importUnits: 4, importTeu: 6, arrivals: [] });
    const imported = offer.importContract as ImportContract;
    tickUntil(world, () => imported.shipId !== undefined, 20_000);
    const aboard = unitsWhere(world, (unit) => unit.direction === 'import' && unit.contractId === imported.id);
    expect(aboard).toHaveLength(4);
    expect(aboard.map((unit) => unit.sizeFt)).toEqual([0, 1, 2, 3].map((i) => unitSizeFt(i, 4, 6)));
    expect(aboard.map((unit) => unit.sizeFt)).toEqual([20, 40, 20, 40]);
    expect(aboard.reduce((sum, unit) => sum + teuOf(unit), 0)).toBe(imported.volumeTeu);
    expect(world.cargo.teuAt('on_ship', imported.shipId as EntityId)).toBe(6);
    expect(aboard.every((unit) => unit.containerType === 'dry' && !unit.oog)).toBe(true);
  });

  it('kamióny s exportom privezú kontajnery v poradí plánu: i-ty príchod má veľkosť unitSizeFt(i) kontraktu', () => {
    const defs = apronDefs({ exportFlow: MEDIUM_ONLY });
    const { world, offer } = startLoading({ defs, kind: 'export', booked: 6, bookedTeu: 9, arrivals: [10, 20, 30, 40, 50, 60] });
    const contract = offer.exportContract;
    // Plán sa spotrebúva až po vzniku kamióna s jednotkou: po vyčerpaní plánu existuje všetkých 6 jednotiek (ešte žiadna neodplávala).
    tickUntil(world, () => contract.booking.arrivalPlan.length === 0, 8_000);
    const created = unitsWhere(world, (unit) => unit.contractId === contract.id).map((unit) => unit.sizeFt);
    expect(created).toEqual([0, 1, 2, 3, 4, 5].map((i) => unitSizeFt(i, 6, 9)));
    expect(created).toEqual([20, 40, 20, 40, 20, 40]);
  });
});

describe('výplata a penalizácie za TEU (ADR-039)', () => {
  it('booking 6 kontajnerov / 9 TEU: 40′ prišiel po lashingu → rolled a vrátený; výplata pomerne k naloženým TEU (7 z 9), nie k počtu kontajnerov (5 zo 6)', () => {
    // Poradie veľkostí 20, 40, 20, 40, 20, 40; posledný (40′) príde až po začiatku lashingu (papiere predĺžia lashing, viď export-loading.test.ts).
    const defs = apronDefs({ ship: { id: 'feeder', fields: { paperworkTicks: 3000 } }, exportFlow: MEDIUM_ONLY });
    const { world, offer } = startLoading({ defs, kind: 'export', booked: 6, bookedTeu: 9, arrivals: [10, 20, 30, 40, 50, 8640 + 2400] });
    const events = runUntilDeparted(world, LOAD_TIMEOUT);
    const contract = offer.exportContract;
    const reward = contract.rewardCents;
    expect(contract.state).toBe('completed');
    expect([contract.booking.loadedUnits, contract.booking.loadedTeu]).toEqual([5, 7]);
    expect([contract.booking.arrivedUnits, contract.booking.arrivedTeu]).toEqual([6, 9]);
    // Rolled = prijaté a nenaložené: jeden kontajner = 2 TEU; nesplnený booking: 7 TEU < ⌈0,9 × 9⌉ = 9.
    expect(bookingFulfilmentUnits(9, world.defs.economy)).toBe(9);
    const penalties = ofType(events, 'BookingPenaltyApplied').map((entry) => entry.event);
    expect(penalties).toEqual([
      { type: 'BookingPenaltyApplied', contractId: contract.id, kind: 'rolled', units: 1, amountCents: bookingUnitsPenaltyCents(reward, 9, 2, world.defs.economy.rolledExportRateOfReward) },
      { type: 'BookingPenaltyApplied', contractId: contract.id, kind: 'unfulfilled', units: 1, amountCents: Math.floor(reward * world.defs.economy.unfulfilledBookingRateOfReward) },
    ]);
    const completed = ofType(events, 'ContractCompleted')[0].event;
    expect(completed.rewardCents).toBe(bookingPayoutCents(reward, 7, 9));
    expect(completed.rewardCents).toBe(Math.floor((reward * 7) / 9));
    expect(completed.rewardCents).not.toBe(Math.floor((reward * 5) / 6));
    expect(completed.penaltiesCents).toBe(penalties.reduce((sum, entry) => sum + (entry.type === 'BookingPenaltyApplied' ? entry.amountCents : 0), 0));
    // Vrátený kontajner (40′) odíde kamiónom; nič sa nestratí.
    tickUntil(world, (w) => w.cargo.exportedCount === 1, 20_000);
    expect(contract.booking.returnedUnits).toBe(1);
  });

  it('všetko naložené: plná odmena aj pri zmesi veľkostí; last minute penalizácia je pomerná k TEU last minute jednotiek', () => {
    const cutoff = 4320;
    // Dva posledné príchody po cut-off: indexy 4 a 5 → 20′ a 40′ → 3 TEU z 9.
    const defs = apronDefs({ exportFlow: MEDIUM_ONLY });
    const { world, offer } = startLoading({ defs, kind: 'export', booked: 6, bookedTeu: 9, arrivals: [10, 20, 30, 40, cutoff + 200, cutoff + 400] });
    const events = runUntilDeparted(world, LOAD_TIMEOUT);
    const contract = offer.exportContract;
    expect([contract.booking.loadedUnits, contract.booking.loadedTeu]).toEqual([6, 9]);
    expect([contract.booking.lastMinuteUnits, contract.booking.lastMinuteTeu]).toEqual([2, 3]);
    const expected = bookingUnitsPenaltyCents(contract.rewardCents, 9, 3, world.defs.economy.lastMinuteExportRateOfReward);
    expect(ofType(events, 'BookingPenaltyApplied').map((entry) => entry.event)).toEqual([
      { type: 'BookingPenaltyApplied', contractId: contract.id, kind: 'last_minute', units: 2, amountCents: expected },
    ]);
    expect(ofType(events, 'ContractCompleted')[0].event).toMatchObject({ rewardCents: contract.rewardCents, penaltiesCents: expected });
  });
});

describe('kapacita lode v TEU (ADR-039)', () => {
  // Najmenšia kapacita lodí šablón je 96 (`volumeUnitsRange[1]`), preto test používa feeder s capacityUnits 96 a objemy blízke kapacite.
  const FEEDER_96 = { id: 'feeder', fields: { capacityUnits: 96 } };
  const EARLY_20 = Array.from({ length: 20 }, (_, i) => 10 * (i + 1));

  it('roundtrip: import 48 kontajnerov / 90 TEU + export 20 / 36 TEU na lodi s 96 TEU — na palube nikdy viac než 96 TEU (počtom by sa vošlo oveľa viac), všetko sa naloží', () => {
    const defs = apronDefs({ ship: FEEDER_96, exportFlow: MEDIUM_ONLY });
    const { world, offer } = startLoading({ defs, kind: 'roundtrip', booked: 20, bookedTeu: 36, importUnits: 48, importTeu: 90, arrivals: EARLY_20 });
    let maxTeu = 0;
    let maxUnits = 0;
    runUntilDeparted(world, LOAD_TIMEOUT * 2, () => {
      for (const ship of world.ships.values()) {
        maxTeu = Math.max(maxTeu, world.cargo.teuAt('on_ship', ship.id));
        maxUnits = Math.max(maxUnits, world.cargo.countAt('on_ship', ship.id));
      }
    });
    expect(maxTeu).toBeLessThanOrEqual(96);
    expect(maxTeu).toBeGreaterThanOrEqual(90);
    expect(maxUnits).toBeLessThan(96);
    expect(offer.exportContract.state).toBe('completed');
    expect([offer.exportContract.booking.loadedUnits, offer.exportContract.booking.loadedTeu]).toEqual([20, 36]);
    expect(world.cargo.shippedCount).toBe(20);
  });

  it('invariant sveta: viac než capacityUnits TEU na palube je porušenie (40′ sa počíta za 2), aj keď je počet jednotiek ďaleko pod kapacitou', () => {
    const defs = apronDefs({ ship: FEEDER_96 });
    const { world, offer } = startLoading({ defs, kind: 'roundtrip', booked: 4, bookedTeu: 6, importUnits: 4, importTeu: 6, arrivals: [] });
    const imported = offer.importContract as ImportContract;
    tickUntil(world, () => imported.shipId !== undefined, 20_000);
    const shipId = imported.shipId as EntityId;
    const labels = { direction: 'import' as const, voyageId: imported.voyageId, lineId: imported.lineId, destinationPort: null, weightClass: 'medium' as const };
    const add = (sizeFt: 20 | 40): void => {
      world.cargo.create('container_teu', { kind: 'on_ship', shipId }, imported.id, { ...labels, sizeFt });
    };
    expect(world.cargo.teuAt('on_ship', shipId)).toBe(6);
    for (let i = 0; i < 45; i++) add(40);
    // 6 + 90 = 96 TEU v 49 jednotkách: presne kapacita.
    expect(world.cargo.teuAt('on_ship', shipId)).toBe(96);
    expect(findWorldViolation(world)).not.toMatch(/capacityUnits 96 TEU/);
    add(20);
    expect(findWorldViolation(world)).toMatch(/97 TEU v 50 jednotkách \(capacityUnits 96 TEU\)/);
  });
});

describe('save: kontrakt s TEU', () => {
  it('toState → fromState zachová volumeTeu aj TEU počítadlá; svet po behu sa serializuje a obnoví rovnako', () => {
    const defs = apronDefs({ exportFlow: MEDIUM_ONLY });
    const { world, offer } = startLoading({ defs, kind: 'export', booked: 6, bookedTeu: 9, arrivals: [10, 20, 30, 40, 50, 60] });
    tickUntil(world, () => offer.exportContract.booking.loadedUnits >= 3, LOAD_TIMEOUT);
    const contract = offer.exportContract;
    expect(contract.volumeTeu).toBe(9);
    expect(contract.booking.loadedTeu).toBeGreaterThanOrEqual(3);
    const state = contract.toState();
    expect(state).toMatchObject({ volumeUnits: 6, volumeTeu: 9 });
    expect(state.booking).toMatchObject({ arrivedTeu: contract.booking.arrivedTeu, loadedTeu: contract.booking.loadedTeu, lastMinuteTeu: contract.booking.lastMinuteTeu });
    const restored = Contract.fromState(JSON.parse(JSON.stringify(state)) as typeof state);
    expect(restored).toBeInstanceOf(ExportContract);
    expect(restored.toState()).toEqual(state);
    const saved = JSON.parse(JSON.stringify(world.serialize())) as WorldState;
    const loaded = World.deserialize(defs, world.map, saved);
    expect(JSON.stringify(loaded.serialize())).toBe(JSON.stringify(saved));
  });

  it('kontrakt s volumeTeu mimo rozsahu volumeUnits … 2 × volumeUnits sa nevytvorí', () => {
    const { offer } = startLoading({ defs: apronDefs(), kind: 'export', booked: 4, arrivals: [] });
    const terms = { ...offer.exportContract.toState(), id: 99 as never, voyageId: 98 as never, destinationPort: 'Hamburg' };
    expect(() => new ExportContract({ ...terms, volumeTeu: 3 })).toThrow(/volumeTeu/);
    expect(() => new ExportContract({ ...terms, volumeTeu: 9 })).toThrow(/volumeTeu/);
    expect(new ExportContract({ ...terms, volumeTeu: 8 }).volumeTeu).toBe(8);
    expect(new ExportContract({ ...terms }).volumeTeu).toBe(4);
  });
});

describe('prázdny kontajner pri návrate dedí veľkosť importu', () => {
  it('plán návratu nesie sizeFt a zostáva v getState (save)', () => {
    const flow = new EmptyFlow();
    flow.scheduleReturn(100, 'blue_anchor', 40);
    flow.scheduleReturn(50, 'golden_wave', 20);
    flow.scheduleReturn(70, 'blue_anchor');
    expect(flow.returnPlan.map((entry) => [entry.dueTick, entry.sizeFt])).toEqual([[50, 20], [70, 20], [100, 40]]);
    expect(EmptyFlow.fromState(JSON.parse(JSON.stringify(flow.getState())) as ReturnType<EmptyFlow['getState']>).getState()).toEqual(flow.getState());
  });
});
