// T05-07: projekcia `world.contracts` do kariet `ContractsPanel` (názvy z defov, SLA okno, zánik ponuky, disabledReason).
import { describe, expect, it } from 'vitest';
import { AcceptContractCommand } from '@sim/commands';
import { offerClosingTick } from '@sim/contracts';
import { REASON_TEXT } from '@app/build-feedback';
import { acceptDisabledReason, contractCards, contractsTimeScale, nextOfferInTicks } from '@app/contract-cards';
import { createApp } from './app-fixtures';
import { createAppWithEconomy, firstOfferId, runDays, runTicks } from './contracts-fixtures';

describe('contractCards: ponuky po štarte hry', () => {
  it('prvý tick vytvorí `offersPerDay` ponúk; karty sú ponuky vzostupne podľa id', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    const cards = contractCards(app.world);
    expect(cards).toHaveLength(app.world.defs.economy.offersPerDay);
    expect(cards.every((card) => card.state === 'offered')).toBe(true);
    const ids = cards.map((card) => card.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('názvy nákladu a lode sú z defov, SLA okno = slaDays × ticksPerDay, zánik ponuky = uzávierka dňa', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    const { world } = app;
    const { ticksPerDay } = world.clock;
    for (const contract of world.contracts.values()) {
      const card = contractCards(world).find((candidate) => candidate.id === contract.id);
      expect(card).toBeDefined();
      const cargo = world.defs.cargoTypes.get(contract.cargoTypeId);
      expect(card).toMatchObject({
        state: 'offered',
        cargoCategory: cargo.category,
        cargoLabel: 'Kontajnery',
        unit: cargo.unitName,
        volumeUnits: contract.volumeUnits,
        rewardCents: contract.rewardCents,
        xpReward: contract.xpReward,
        shipClassId: contract.shipClassId,
        shipClassLabel: world.defs.ships.get(contract.shipClassId).displayName,
        slaWindowTicks: contract.slaDays * ticksPerDay,
        offerExpiresTick: offerClosingTick(contract.offerExpiresTick, ticksPerDay),
        unitsUnloaded: 0,
        unitsExported: 0,
        penaltiesCents: 0,
      });
      expect(card?.offerExpiresTick).toBeGreaterThanOrEqual(contract.offerExpiresTick);
      expect(card?.offerExpiresTick).toBe(Math.ceil(contract.offerExpiresTick / ticksPerDay) * ticksPerDay);
      expect(card).not.toHaveProperty('disabledReason');
      expect(card).not.toHaveProperty('slaDeadlineTick');
      expect(card).not.toHaveProperty('closedTick');
    }
  });

  it('`nextOfferInTicks` a mierka času idú zo simu (čas do najbližšej uzávierky dňa)', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    const { clock } = app.world;
    expect(nextOfferInTicks(app.world)).toBe(clock.ticksPerDay - clock.tick);
    expect(contractsTimeScale(app.world)).toEqual({ ticksPerHour: clock.ticksPerHour, ticksPerDay: clock.ticksPerDay, nowTick: clock.tick });
  });
});

describe('contractCards: prijatý kontrakt', () => {
  it('po AcceptContract má karta plán lode a SLA termín, ostáva medzi aktívnymi', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    const id = firstOfferId(app);
    app.bridge.dispatch(new AcceptContractCommand(id));
    app.loop.frame(app.loop.tickMs);
    const card = contractCards(app.world).find((candidate) => candidate.id === id);
    const contract = app.world.contracts.get(id as never);
    expect(card?.state).toBe('accepted');
    expect(card?.shipArrivalTick).toBe(contract?.shipArrivalTick);
    expect(card?.slaDeadlineTick).toBe(contract?.slaDeadlineTick);
    expect(card).not.toHaveProperty('disabledReason');
  });
});

describe('contractCards: disabledReason z validate(AcceptContract)', () => {
  it('ponuku nejde prijať po bankrote: text `REASON_TEXT.game_over` na každej ponuke, prijatý kontrakt dôvod nemá', () => {
    const app = createAppWithEconomy({ bankruptcyDays: 1 }, -1);
    app.loop.frame(app.loop.tickMs);
    const accepted = firstOfferId(app);
    app.bridge.dispatch(new AcceptContractCommand(accepted));
    app.loop.frame(app.loop.tickMs);
    expect(app.world.gameOver).toBe(false);
    for (const card of contractCards(app.world)) {
      if (card.state === 'offered') expect(card.disabledReason, `ponuka ${String(card.id)}`).toBeUndefined();
    }
    runDays(app, 1);
    expect(app.world.gameOver).toBe(true);
    const cards = contractCards(app.world);
    const offers = cards.filter((card) => card.state === 'offered');
    expect(offers.length).toBeGreaterThan(0);
    for (const card of offers) expect(card.disabledReason).toBe(REASON_TEXT.game_over);
    expect(cards.find((card) => card.id === accepted)).not.toHaveProperty('disabledReason');
  });

  it('`acceptDisabledReason`: mimo ponuky je vždy `undefined`', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    const id = firstOfferId(app);
    app.bridge.dispatch(new AcceptContractCommand(id));
    app.loop.frame(app.loop.tickMs);
    const contract = app.world.contracts.get(id as never);
    if (contract === undefined) throw new Error('kontrakt zmizol');
    expect(acceptDisabledReason(app.world, contract)).toBeUndefined();
  });
});

describe('contractCards: expirácia', () => {
  it('nevybraná ponuka zmizne z kariet, keď ju denná obnova expiruje', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    const first = contractCards(app.world).map((card) => card.id);
    runTicks(app, app.world.clock.ticksPerDay * app.world.defs.economy.offerExpiryDays + app.world.clock.ticksPerDay);
    const later = contractCards(app.world).map((card) => card.id);
    for (const id of first) expect(later).not.toContain(id);
    expect(later.length).toBeGreaterThan(0);
  });
});
