/**
 * Penalizácie a koniec kontraktu (T05-05, TDD; „Rozhodnutia orchestrátora" 1, 4, 6, 7): demurrage po
 * `berthAllowanceTicks` (za celé hodiny), late po `slaDeadlineTick` (za celé dni), `failed` po `failAfterDaysLate`,
 * vyrovnanie z hotovosti jednou transakciou `penalty` až pri `completed`/`failed`, XP pri oneskorenom dokončení.
 * Deterministické defy (`fixedContractDefs`: 12 TEU, SLA 2 dni, príchod +1 deň, odmena 540 000). Očakávané sumy:
 * demurrage 540 000 × 50 bp = 2 700 za hodinu, late 540 000 × 500 bp = 27 000 za deň.
 *
 * Predpoklady o API (nad rámec `contract-flow.test.ts`):
 *  D1 demurrage sa počíta od `ShipDocked` (tolerancia pol hodiny na začiatok státia), za každú celú hodinu nad
 *     `berthAllowanceTicks` vznikne jedna `PenaltyApplied { kind: 'demurrage', amountCents }`, udalosti idú po
 *     `ticksPerHour`; kým loď nie je vyložená a odplávaná, kontrakt ostáva `unloading` (loď s plným aprónom stojí);
 *  D2 late = jedna `PenaltyApplied { kind: 'late' }` za každý celý deň od `slaDeadlineTick` (elapsed, nie hranice
 *     `DayClosed`); pri `completed` s oneskorením `floor((completedTick − sla) / ticksPerDay)` dní;
 *  D3 `failed`, keď `daysLate > failAfterDaysLate`, teda najskôr tesne po `sla + 3 dni` a najneskôr `sla + 4 dni` (+ hodina);
 *  D4 penalizácie sa medzitým len sčítavajú v `penaltiesCents` (žiadna `MoneyChanged(penalty)`), z hotovosti idú jednou
 *     transakciou pri `completed`/`failed`; pri `failed` odmena prepadne (žiadna `contract_revenue`), XP sa nepripíše.
 */
import { describe, expect, it } from 'vitest';
import { placeLandsideCommand } from '../helpers/f4-layout';
import { emptyScenario, must } from '../helpers/harbor';
import {
  DEFS as BUNDLED_DEFS,
  FIXED_VOLUME,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  completedOf,
  contractById,
  demurrageStepCents,
  economyOf,
  events5,
  expectedXpGain,
  fixedContractDefs,
  lateStepCents,
  lostUnits,
  ofContract,
  portScenario,
  startContract,
  stateChain,
  tierOf,
  xpOf,
  type Run5,
  type StartedContract,
} from '../helpers/f5';
import type { World } from '@sim/world';
import { itR1Interim } from '../helpers/r1-interim';

const DEFS = fixedContractDefs();
const REWARD = 540_000;
const DEMURRAGE_STEP = demurrageStepCents(REWARD);
const LATE_STEP = lateStepCents(REWARD);
const ALLOWANCE = DEFS.ships.get('feeder').berthAllowanceTicks;
const FAIL_DAYS = DEFS.economy.failAfterDaysLate;
const RUN_TIMEOUT_MS = 300_000;
/** Tolerancia na začiatok státia lode pri kotvisku: pol hodiny. */
const DOCK_TOLERANCE = TICKS_PER_HOUR / 2;
/** Rozloženie prístavu bez brány: rampa je neprevádzková, jednotky po vyložení čakajú v skladoch. */
const NO_GATE = ['waiting_area', 'ramp'] as const;

const penaltyMoves = (run: Run5) => run.ofSim('MoneyChanged').filter((move) => move.event.reason === 'penalty');
const revenueMoves = (run: Run5) => run.ofSim('MoneyChanged').filter((move) => move.event.reason === 'contract_revenue');
const noViolations = (run: Run5): void => {
  for (const rule of ['cash_ledger', 'contract_fsm', 'contract_counters', 'pool_size', 'progress'] as const) expect(run.violationsOf(rule), rule).toEqual([]);
};

/** Spustí kontrakt v prístave bez brány a dobehne do stavu `exporting` s 12 jednotkami v skladoch. */
function startExporting(id: string, seed: number): StartedContract & { readonly slaDeadline: number } {
  const started = startContract({ id, seed, defs: DEFS, scenario: portScenario(id, seed, { landside: NO_GATE }) });
  const { world, run, contractId } = started;
  run.runUntil((w) => contractById(w, contractId).state === 'exporting' && w.cargo.countByKind('in_storage') === FIXED_VOLUME, 40_000);
  const slaDeadline = must(contractById(world, contractId).slaDeadlineTick, 'slaDeadlineTick');
  expect(world.clock.tick, 'vyloženie a uskladnenie musí skončiť pred SLA').toBeLessThan(slaDeadline);
  expect(world.cargo.exportedCount).toBe(0);
  return { ...started, slaDeadline };
}

describe('sadzby z defov (stráž pre očakávané sumy)', () => {
  it('odmena 540 000: demurrage 2 700 za hodinu, late 27 000 za deň, fail po 3 dňoch, povolenie kotviska 2 dni', () => {
    expect(DEMURRAGE_STEP).toBe(2_700);
    expect(LATE_STEP).toBe(27_000);
    expect(FAIL_DAYS).toBe(3);
    expect(ALLOWANCE).toBe(2 * TICKS_PER_DAY);
    expect(BUNDLED_DEFS.economy.failAfterDaysLate).toBe(FAIL_DAYS);
  });
});

describe('demurrage: loď stojí pri kotvisku nad berthAllowanceTicks', () => {
  it('loď bez skladu (apron sa zaplní, žeriav blokuje) stojí dlhšie ako povolenie: penalizácia 2 700 za každú celú hodinu, bez peňazí z hotovosti', () => {
    const { world, run, contractId } = startContract({ id: 'f5_demurrage', seed: 5102, defs: DEFS, scenario: emptyScenario('f5_demurrage', 5102) });
    const shipDocked = (w: World): boolean => run.ofSim('ShipDocked').some((entry) => entry.event.shipId === contractById(w, contractId).shipId);
    run.runUntil(shipDocked, 4 * TICKS_PER_DAY);
    const dockedAt = must(
      run.ofSim('ShipDocked').find((entry) => entry.event.shipId === contractById(world, contractId).shipId),
      'ShipDocked',
    ).tick;
    const hoursOver = 10;
    const until = dockedAt + ALLOWANCE + hoursOver * TICKS_PER_HOUR + TICKS_PER_HOUR / 2;
    run.runTo(until);

    // Predpoklad scenára: žeriav zablokovaný plným apronom, kontrakt sa vykladá, nič sa neexportuje.
    expect(run.ofSim('CraneBlocked').length).toBeGreaterThan(0);
    const contract = contractById(world, contractId);
    expect(contract.state).toBe('unloading');
    expect(contract.unitsUnloaded).toBeLessThan(FIXED_VOLUME);

    const demurrage = ofContract(run.of('PenaltyApplied'), contractId).filter((entry) => entry.event.kind === 'demurrage');
    expect(demurrage.length).toBeGreaterThanOrEqual(hoursOver - 1);
    expect(demurrage.length).toBeLessThanOrEqual(hoursOver + 1);
    for (const entry of demurrage) expect(entry.event.amountCents).toBe(DEMURRAGE_STEP);
    expect(demurrage[0].tick).toBeGreaterThanOrEqual(dockedAt + ALLOWANCE - DOCK_TOLERANCE);
    expect(demurrage[0].tick).toBeLessThanOrEqual(dockedAt + ALLOWANCE + 2 * TICKS_PER_HOUR);
    for (let i = 1; i < demurrage.length; i++) expect(demurrage[i].tick - demurrage[i - 1].tick, `odstup ${String(i)}`).toBe(TICKS_PER_HOUR);

    // v okne (lod pri kotvisku ~ 0,5 dňa po SLA) ešte nie je celý deň po termíne: žiadna late penalizácia
    expect(ofContract(run.of('PenaltyApplied'), contractId).filter((entry) => entry.event.kind === 'late')).toEqual([]);

    expect(contract.penaltiesCents).toBe(demurrage.length * DEMURRAGE_STEP);
    expect(penaltyMoves(run)).toEqual([]);
    expect(economyOf(world).entries.filter((entry) => entry.category === 'penalty')).toEqual([]);
    expect(run.ofSim('MoneyChanged').filter((move) => move.tick > 2 && move.event.reason !== 'maintenance' && move.event.reason !== 'wages')).toEqual([]);
    noViolations(run);
    expect(run.ticksChecked).toBe(world.clock.tick);
  }, RUN_TIMEOUT_MS);

  it('pred vypršaním povolenia (loď stojí kratšie ako berthAllowanceTicks) žiadny demurrage nevznikne', () => {
    const { world, run, contractId } = startContract({ id: 'f5_demurrage_none', seed: 5103, defs: DEFS, scenario: emptyScenario('f5_demurrage_none', 5103) });
    const shipDocked = (w: World): boolean => run.ofSim('ShipDocked').some((entry) => entry.event.shipId === contractById(w, contractId).shipId);
    run.runUntil(shipDocked, 4 * TICKS_PER_DAY);
    const dockedAt = must(run.ofSim('ShipDocked').find((entry) => entry.event.shipId === contractById(world, contractId).shipId), 'ShipDocked').tick;
    run.runTo(dockedAt + ALLOWANCE - 2 * TICKS_PER_HOUR);
    expect(ofContract(run.of('PenaltyApplied'), contractId)).toEqual([]);
    expect(contractById(world, contractId).penaltiesCents).toBe(0);
    noViolations(run);
  }, RUN_TIMEOUT_MS);
});

describe('late: export po slaDeadlineTick, ešte pred failAfterDaysLate', () => {
  itR1Interim('dokončenie 1,25 dňa po SLA: jedna late penalizácia 27 000, výplata 540 000 a strhnutie 27 000 jednou transakciou, XP × 0,5', () => {
    const { world, run, contractId, slaDeadline } = startExporting('f5_late_one_day', 5104);
    run.runTo(slaDeadline + Math.floor(1.25 * TICKS_PER_DAY));
    expect(contractById(world, contractId).state).toBe('exporting');
    expect(world.cargo.exportedCount).toBe(0);
    // kým je kontrakt po termíne, no menej než celý deň, žiadna penalizácia; potom presne jedna
    const xpBefore = xpOf(world);
    run.send(placeLandsideCommand('gate'));
    run.runUntil((w) => contractById(w, contractId).state === 'completed', 30_000);
    const completedAt = world.clock.tick;
    run.runTo(completedAt + 300);

    const daysLate = Math.floor((completedAt - slaDeadline) / TICKS_PER_DAY);
    expect(daysLate, 'scenár je navrhnutý na presne 1 celý deň po SLA').toBe(1);
    const late = ofContract(run.of('PenaltyApplied'), contractId);
    expect(late.map((entry) => entry.event.kind)).toEqual(['late']);
    expect(late[0].event.amountCents).toBe(LATE_STEP);
    expect(late[0].tick).toBeGreaterThanOrEqual(slaDeadline + TICKS_PER_DAY);

    const contract = contractById(world, contractId);
    expect(contract.penaltiesCents).toBe(LATE_STEP);
    const done = must(ofContract(run.of('ContractCompleted'), contractId)[0], 'ContractCompleted');
    expect([done.event.rewardCents, done.event.penaltiesCents, done.event.onTime]).toEqual([REWARD, LATE_STEP, false]);
    expect(done.event.xp).toBe(expectedXpGain(contract.xpReward, false, DEFS));
    expect(done.event.xp).toBe(6);

    // jedna výplata a jedna penalizácia v ticku dokončenia; pred ním sa z hotovosti nič nestrhlo
    expect(revenueMoves(run).map((move) => [move.tick, move.event.deltaCents])).toEqual([[done.tick, REWARD]]);
    expect(penaltyMoves(run).map((move) => [move.tick, move.event.deltaCents])).toEqual([[done.tick, -LATE_STEP]]);
    const gained = run
      .ofSim('MoneyChanged')
      .filter((move) => move.event.reason === 'contract_revenue' || move.event.reason === 'penalty')
      .reduce((sum, move) => sum + move.event.deltaCents, 0);
    expect(gained).toBe(REWARD - LATE_STEP);

    expect(xpOf(world) - xpBefore).toBe(6);
    expect(completedOf(world)).toBe(1);
    expect(tierOf(world)).toBe(0);
    expect(stateChain(run.events, contractId)).toEqual(['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting', 'completed']);
    expect(lostUnits(world)).toBe(0);
    noViolations(run);
    expect(run.ticksChecked).toBe(world.clock.tick);
  }, RUN_TIMEOUT_MS);

  itR1Interim('dokončenie hneď po termíne (menej než celý deň): bez late penalizácie, plná odmena, ale onTime = false a XP × 0,5', () => {
    const { world, run, contractId, slaDeadline } = startExporting('f5_late_zero_days', 5105);
    run.runTo(slaDeadline + 432);
    expect(contractById(world, contractId).state).toBe('exporting');
    run.send(placeLandsideCommand('gate'));
    run.runUntil((w) => contractById(w, contractId).state === 'completed', 20_000);
    const completedAt = world.clock.tick;
    expect(completedAt - slaDeadline, 'scenár je navrhnutý na dokončenie do jedného dňa po SLA').toBeLessThan(TICKS_PER_DAY);

    expect(ofContract(run.of('PenaltyApplied'), contractId)).toEqual([]);
    expect(penaltyMoves(run)).toEqual([]);
    const done = must(ofContract(run.of('ContractCompleted'), contractId)[0], 'ContractCompleted');
    expect([done.event.rewardCents, done.event.penaltiesCents, done.event.onTime, done.event.xp]).toEqual([REWARD, 0, false, 6]);
    expect(revenueMoves(run).map((move) => move.event.deltaCents)).toEqual([REWARD]);
    expect(xpOf(world)).toBe(6);
    expect(completedOf(world)).toBe(1);
    noViolations(run);
  }, RUN_TIMEOUT_MS);
});

describe('fail: export sa nestihne ani do failAfterDaysLate dní po SLA', () => {
  it('kontrakt zlyhá po viac než 3 dňoch po termíne: penalizácie 27 000 za deň sa strhnú jednou transakciou, odmena prepadne, XP sa nepripíše', () => {
    const { world, run, contractId, slaDeadline } = startExporting('f5_fail', 5106);
    run.runTo(slaDeadline + FAIL_DAYS * TICKS_PER_DAY);
    // presne 3 dni po termíne ešte nie je „viac než 3 dni“
    expect(contractById(world, contractId).state).toBe('exporting');
    expect(run.of('ContractFailed')).toEqual([]);

    run.runUntil((w) => contractById(w, contractId).state === 'failed', 2 * TICKS_PER_DAY);
    const failedAt = world.clock.tick;
    expect(failedAt).toBeGreaterThanOrEqual(slaDeadline + FAIL_DAYS * TICKS_PER_DAY + 1);
    expect(failedAt).toBeLessThanOrEqual(slaDeadline + (FAIL_DAYS + 1) * TICKS_PER_DAY + TICKS_PER_HOUR);

    const late = ofContract(run.of('PenaltyApplied'), contractId);
    expect(late.every((entry) => entry.event.kind === 'late')).toBe(true);
    expect(late.length).toBeGreaterThanOrEqual(FAIL_DAYS);
    expect(late.length).toBeLessThanOrEqual(FAIL_DAYS + 1);
    for (const entry of late) expect(entry.event.amountCents).toBe(LATE_STEP);
    for (let i = 1; i < late.length; i++) expect(late[i].tick - late[i - 1].tick, `odstup ${String(i)}`).toBe(TICKS_PER_DAY);
    expect(late[0].tick).toBeGreaterThanOrEqual(slaDeadline + TICKS_PER_DAY);

    const penalties = late.length * LATE_STEP;
    const contract = contractById(world, contractId);
    expect(contract.penaltiesCents).toBe(penalties);
    const failed = must(ofContract(run.of('ContractFailed'), contractId)[0], 'ContractFailed');
    expect(failed.tick).toBe(failedAt);
    expect(failed.event.penaltiesCents).toBe(penalties);

    expect(penaltyMoves(run).map((move) => [move.tick, move.event.deltaCents])).toEqual([[failedAt, -penalties]]);
    expect(economyOf(world).entries.filter((entry) => entry.category === 'penalty').map((entry) => entry.amountCents)).toEqual([-penalties]);
    expect(revenueMoves(run)).toEqual([]);
    expect(run.of('ContractCompleted')).toEqual([]);
    expect(xpOf(world)).toBe(0);
    expect(completedOf(world)).toBe(0);
    expect(tierOf(world)).toBe(0);
    expect(stateChain(run.events, contractId)).toEqual(['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting', 'failed']);
    noViolations(run);
  }, RUN_TIMEOUT_MS);

  it('po zlyhaní už nevznikajú ďalšie penalizácie, výplaty ani opakované zlyhanie a náklad sa nestratí (2 dni navyše)', () => {
    const { world, run, contractId, slaDeadline } = startExporting('f5_fail_after', 5107);
    run.runTo(slaDeadline + (FAIL_DAYS + 1) * TICKS_PER_DAY + TICKS_PER_HOUR);
    expect(contractById(world, contractId).state).toBe('failed');
    const penaltiesAtFail = contractById(world, contractId).penaltiesCents;
    const eventsAtFail = events5(run.events, 'PenaltyApplied').length;
    run.runTo(world.clock.tick + 2 * TICKS_PER_DAY);

    expect(contractById(world, contractId).state).toBe('failed');
    expect(contractById(world, contractId).penaltiesCents).toBe(penaltiesAtFail);
    expect(events5(run.events, 'PenaltyApplied')).toHaveLength(eventsAtFail);
    expect(run.of('ContractFailed')).toHaveLength(1);
    expect(penaltyMoves(run)).toHaveLength(1);
    expect(revenueMoves(run)).toEqual([]);
    expect(lostUnits(world)).toBe(0);
    expect(world.cargo.liveCount + world.cargo.exportedCount).toBe(FIXED_VOLUME);
    noViolations(run);
  }, RUN_TIMEOUT_MS);
});
