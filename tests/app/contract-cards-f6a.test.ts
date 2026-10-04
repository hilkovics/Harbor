// T6A-07: projekcia export bookingu a roundtripu do kariet `ContractsPanel` (druh, voyage, booking, dôvody odmietnutia).
import { describe, expect, it } from 'vitest';
import { AcceptContractCommand } from '@sim/commands';
import type { World } from '@sim/world';
import { acceptDisabledReason, contractCards, cutoffLeadTicks } from '@app/contract-cards';
import { REASON_TEXT } from '@app/build-feedback';
import { createApp } from './app-fixtures';
import { createAppWithEconomy, runDays } from './contracts-fixtures';
import { acceptRoundtrip, addRoundtripOffer } from './f6a-fixtures';

describe('contractCards: druh a voyage', () => {
  it('každá karta nesie kind a voyageId; import-only voyage má id kontraktu', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    const cards = contractCards(app.world);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card).toMatchObject({ kind: 'import', voyageId: card.id });
      expect(card).not.toHaveProperty('booking');
    }
  });

  it('roundtrip ponuka: dve karty s rovnakou voyage, import bez bookingu, export s bookingom', () => {
    const { world } = createApp();
    const roundtrip = addRoundtripOffer(world);
    const cards = contractCards(world);
    expect(cards.map((card) => [card.id, card.kind, card.voyageId])).toEqual([
      [roundtrip.importContract.id, 'import', roundtrip.voyageId],
      [roundtrip.exportContract.id, 'export', roundtrip.voyageId],
    ]);
    const [importCard, exportCard] = cards;
    expect(importCard).not.toHaveProperty('booking');
    expect(exportCard).toMatchObject({
      state: 'offered',
      volumeUnits: 24,
      rewardCents: 96_000_000,
      shipClassLabel: 'Feeder',
      cargoLabel: 'Kontajnery',
      unit: 'TEU',
      booking: {
        destinationPort: 'Rotterdam',
        bookedUnits: 24,
        pendingArrivals: 0,
        arrivedUnits: 0,
        loadedUnits: 0,
        lastMinuteUnits: 0,
        rolledUnits: 0,
        returnedUnits: 0,
        heldUnits: 0,
      },
    });
    expect(exportCard?.booking).not.toHaveProperty('cutoffTick');
    expect(exportCard?.booking?.cutoffLeadTicks).toBe(12 * world.clock.ticksPerHour);
  });
});

describe('contractCards: booking prijatého exportu', () => {
  it('cut-off, plán príchodov a počítadlá idú z živého kontraktu; prijatý booking nesie konkrétny cut-off tick, nie odstup', () => {
    const { world } = createApp();
    const roundtrip = addRoundtripOffer(world);
    acceptRoundtrip(world, roundtrip, { arrivalIn: 2 * world.clock.ticksPerDay, cutoffBefore: 12 * world.clock.ticksPerHour, arrivalPlan: [100, 200, 300] });
    const { exportContract } = roundtrip;
    exportContract.recordArrival(77 as never, false);
    exportContract.recordArrival(78 as never, true);
    exportContract.heldUnits = 1;
    exportContract.loadedUnits = 1;
    exportContract.lastMinuteUnits = 1;
    exportContract.unitsExported = 0;
    const card = contractCards(world).find((candidate) => candidate.id === exportContract.id);
    expect(card?.state).toBe('accepted');
    expect(card?.booking).toEqual({
      destinationPort: 'Rotterdam',
      cutoffTick: exportContract.cutoffTick,
      bookedUnits: 24,
      pendingArrivals: 3,
      arrivedUnits: 2,
      loadedUnits: 1,
      lastMinuteUnits: 1,
      rolledUnits: 1,
      returnedUnits: 0,
      heldUnits: 1,
    });
    expect(card?.booking).not.toHaveProperty('cutoffLeadTicks');
    expect(card?.shipArrivalTick).toBe(exportContract.shipArrivalTick);
    expect(exportContract.cutoffTick).toBe((exportContract.shipArrivalTick ?? 0) - 12 * world.clock.ticksPerHour);
  });
});

describe('cutoffLeadTicks', () => {
  it('z `economy.cutoffHours` (12 h) × ticky za hodinu, rovnako ako plánovanie bookingu v sime', () => {
    const { world } = createApp();
    expect(world.defs.economy.cutoffHours).toBe(12);
    expect(cutoffLeadTicks(world)).toBe(12 * world.clock.ticksPerHour);
  });

  it('nezaokrúhlené hodiny sa zaokrúhlia ako v sime (`Math.round(cutoffHours × ticksPerHour)`)', () => {
    const fakeWorld = (cutoffHours: number): World => ({ defs: { economy: { cutoffHours } }, clock: { ticksPerHour: 360 } }) as unknown as World;
    expect(cutoffLeadTicks(fakeWorld(0.5))).toBe(180);
    expect(cutoffLeadTicks(fakeWorld(0.0015))).toBe(1);
  });
});

describe('acceptDisabledReason: export ponuka', () => {
  it('po bankrote má každá ponuka roundtripu dôvod z REASON_TEXT (karta ho ukáže cez disabledReason)', () => {
    const app = createAppWithEconomy({ bankruptcyDays: 1 }, -1);
    const roundtrip = addRoundtripOffer(app.world);
    runDays(app, 1);
    expect(app.world.gameOver).toBe(true);
    for (const contract of [roundtrip.importContract, roundtrip.exportContract]) {
      expect(contract.state).toBe('offered');
      expect(acceptDisabledReason(app.world, contract)).toBe(REASON_TEXT.game_over);
    }
    const cards = contractCards(app.world).filter((card) => card.voyageId === roundtrip.voyageId);
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.disabledReason === REASON_TEXT.game_over)).toBe(true);
  });

  it('prijatý kontrakt dôvod nemá; validácia príkazu na export ponuku je dosiahnuteľná', () => {
    const { world } = createApp();
    const roundtrip = addRoundtripOffer(world);
    expect(new AcceptContractCommand(roundtrip.exportContract.id).validate(world).reasons).not.toContain('unknown_contract');
    acceptRoundtrip(world, roundtrip);
    expect(acceptDisabledReason(world, roundtrip.exportContract)).toBeUndefined();
  });
});
