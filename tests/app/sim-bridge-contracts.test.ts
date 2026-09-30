// T05-07: snapshot F5 (karty kontraktov, XP, tier, delta dňa, gameOver) a `REVISION_EVENTS` pre udalosti kontraktov.
import { describe, expect, it } from 'vitest';
import { AcceptContractCommand, DeclineContractCommand } from '@sim/commands';
import type { SimEventType } from '@sim/events';
import { REVISION_EVENTS } from '@app/sim-bridge';
import { createApp } from './app-fixtures';
import { createAppWithEconomy, firstOfferId, runDays, runTicks } from './contracts-fixtures';

describe('REVISION_EVENTS: kontrakty', () => {
  it('udalosti, ktoré menia karty kontraktov, zvyšujú revíziu', () => {
    const expected: SimEventType[] = [
      'ContractOffered',
      'ContractAccepted',
      'ContractStateChanged',
      'ContractCompleted',
      'ContractFailed',
      'ContractExpired',
      'PenaltyApplied',
      'GameOver',
    ];
    for (const type of expected) expect(REVISION_EVENTS.has(type), type).toBe(true);
  });

  it('DayClosedSummary a MonthlyReport revíziu nemenia (delta dňa sa číta zo sveta pri každom ticku)', () => {
    expect(REVISION_EVENTS.has('DayClosedSummary')).toBe(false);
    expect(REVISION_EVENTS.has('MonthlyReport')).toBe(false);
  });
});

describe('SimBridge.snapshot: F5', () => {
  it('na štarte: bez kontraktov, xp 0, tier 0, bez konca hry, mierka času zo sveta', () => {
    const { world, bridge } = createApp();
    const snapshot = bridge.snapshot();
    expect(snapshot).toMatchObject({
      contracts: [],
      xp: 0,
      tier: 0,
      completedContracts: 0,
      gameOver: false,
      dailyDeltaCents: 0,
      ticksPerHour: world.clock.ticksPerHour,
      ticksPerDay: world.clock.ticksPerDay,
    });
  });

  it('prvý tick prinesie ponuky; karty sa prepočítajú len pri zmene revízie', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    const first = app.bridge.snapshot();
    expect(first.contracts).toHaveLength(app.world.defs.economy.offersPerDay);
    expect(first.nextOfferInTicks).toBe(app.world.clock.ticksPerDay - app.world.clock.tick);
    app.loop.frame(app.loop.tickMs);
    const second = app.bridge.snapshot();
    expect(second.tick).toBe(first.tick + 1);
    expect(second.contracts).toBe(first.contracts); // tá istá referencia, kým sa revízia nezmení
  });

  it('prijatie a odmietnutie zmenia karty (stav `accepted`, odmietnutá ponuka zmizne)', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    const before = app.bridge.snapshot().contracts;
    const [acceptId, declineId] = before.map((card) => card.id as number);
    if (acceptId === undefined || declineId === undefined) throw new Error('chýbajú ponuky');
    app.bridge.dispatch(new AcceptContractCommand(acceptId));
    app.bridge.dispatch(new DeclineContractCommand(declineId));
    app.loop.frame(app.loop.tickMs);
    const after = app.bridge.snapshot().contracts;
    expect(after).not.toBe(before);
    expect(after.find((card) => card.id === acceptId)?.state).toBe('accepted');
    expect(after.find((card) => card.id === declineId)).toBeUndefined();
  });

  it('delta dňa je čistá zmena hotovosti od poslednej uzávierky (údržba a mzdy po uzávierke = záporná)', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    expect(app.bridge.snapshot().dailyDeltaCents).toBe(app.world.economy.todayDeltaCents());
    runDays(app, 1);
    const snapshot = app.bridge.snapshot();
    expect(snapshot.dailyDeltaCents).toBe(app.world.economy.todayDeltaCents());
    expect(snapshot.cashCents).toBe(app.world.cashCents);
    expect(snapshot.day).toBe(1);
  });

  it('xp, tier a completedContracts zrkadlia svet', () => {
    const app = createApp();
    runTicks(app, 3);
    const snapshot = app.bridge.snapshot();
    expect([snapshot.xp, snapshot.tier, snapshot.completedContracts]).toEqual([app.world.xp, app.world.tier, app.world.completedContracts]);
  });

  it('bankrot: `gameOver` v snapshote po udalosti GameOver a ponuky nejde prijať', () => {
    const app = createAppWithEconomy({ bankruptcyDays: 1 }, -1);
    app.loop.frame(app.loop.tickMs);
    expect(app.bridge.snapshot().gameOver).toBe(false);
    const offer = firstOfferId(app);
    runDays(app, 1);
    const snapshot = app.bridge.snapshot();
    expect(snapshot.gameOver).toBe(true);
    expect(app.bridge.validate(new AcceptContractCommand(offer))).toMatchObject({ ok: false, reasons: ['game_over'] });
  });
});
