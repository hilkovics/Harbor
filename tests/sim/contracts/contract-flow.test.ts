/**
 * Životný cyklus kontraktu od prijatia po výplatu (T05-05, TDD; „Rozhodnutia orchestrátora" 4, 5, 6, 7, 9):
 * `offered → accepted → ship_en_route → unloading → exporting → completed`, spawn lode kontraktu v ticku príchodu,
 * počítadlá jednotiek, výplata `cash += reward − penalties` a XP. Deterministické defy (jedna šablóna 12 TEU, SLA 2 dni,
 * príchod presne 1 deň po prijatí, `fixedContractDefs`), rozloženie prístavu F4 s 2 vozidlami. Po každom ticku beží
 * `assertCargoConservation` + audit ledgera a jobov z F4 + invarianty F5 (`Run5`).
 *
 * Predpoklady o API:
 *  L1 loď kontraktu sa spawne cez rovnaký kód ako `SpawnShipDebug` (`ShipSpawned` s `units = volumeUnits`,
 *     `cargoTypeId` kontraktu, trieda `shipClassId`) v ticku `shipArrivalTick` (±1) a `contract.shipId` ukazuje na ňu;
 *  L2 `ship_en_route → unloading` pri `ShipDocked` (±1 tick), `unloading → exporting` najskôr po vyložení celého objemu
 *     a najneskôr v ticku `ShipDeparted`;
 *  L3 `unitsUnloaded` sa zvýši pri `on_ship → in_crane` alebo pri `→ on_apron` (akceptujú sa obe výklady), `unitsExported`
 *     pri `in_truck → exported`;
 *  L4 pri `completed`: jedna `MoneyChanged(contract_revenue) = +reward`, pri penalizáciách jedna `MoneyChanged(penalty) =
 *     −penaltiesCents` v tom istom ticku; `ContractCompleted { rewardCents, penaltiesCents, xp, onTime }`;
 *  L5 `onTime` = dokončené v ticku ≤ `slaDeadlineTick`; XP: `xpReward` včas, inak `round(xpReward × lateXpFactor)`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { World } from '@sim/world';
import { must } from '../helpers/harbor';
import {
  CONTRACT_MAIN_CHAIN,
  CONTRACT_TRANSITIONS,
  FIXED_ARRIVAL_DAYS,
  FIXED_SLA_DAYS,
  FIXED_VOLUME,
  TICKS_PER_DAY,
  cashOf,
  completedOf,
  contractById,
  economyOf,
  events5,
  fixedContractDefs,
  gameOverOf,
  lostUnits,
  startContract,
  stateChain,
  tickOfState,
  tierOf,
  xpOf,
  type Run5,
} from '../helpers/f5';

const DEFS = fixedContractDefs();
const REWARD = 540_000;
const MAX_TICKS = 60_000;
const SETTLE_TICKS = 500;
const RUN_TIMEOUT_MS = 300_000;

describe('kontrakt od prijatia po výplatu (12 TEU, SLA 2 dni, príchod +1 deň)', () => {
  let world: World;
  let run: Run5;
  let contractId: number;
  let completedAt: number;
  let cashBeforeAccept: number;

  beforeAll(() => {
    const started = startContract({ id: 'f5_flow', seed: 5101, defs: DEFS, fullAudit: true });
    world = started.world;
    run = started.run;
    contractId = started.contractId;
    cashBeforeAccept = cashOf(world);
    run.runUntil((w) => contractById(w, contractId).state === 'completed', MAX_TICKS);
    completedAt = world.clock.tick;
    run.runTo(completedAt + SETTLE_TICKS);
  }, RUN_TIMEOUT_MS);

  const contract = () => contractById(world, contractId);
  const own = <T extends { readonly event: { readonly contractId: number } }>(entries: readonly T[]): T[] => entries.filter((entry) => entry.event.contractId === contractId);

  it('stavy idú presne po hlavnej vetve a každý prechod je v tabuľke FSM', () => {
    const chain = stateChain(run.events, contractId);
    expect(chain).toEqual(CONTRACT_MAIN_CHAIN);
    for (let i = 1; i < chain.length; i++) expect(CONTRACT_TRANSITIONS[chain[i - 1]]).toContain(chain[i]);
    expect(contract().state).toBe('completed');
    expect(completedAt).toBeLessThanOrEqual(MAX_TICKS);
  });

  it('invarianty: konzervácia po každom ticku, audit ledgera a jobov, peniaze a kontrakty bez porušenia, lostUnits = 0', () => {
    expect(run.ticksChecked).toBe(world.clock.tick);
    for (const rule of ['cash_ledger', 'contract_fsm', 'contract_counters', 'pool_size', 'progress'] as const) {
      expect(run.violationsOf(rule), rule).toEqual([]);
    }
    expect(lostUnits(world)).toBe(0);
    expect(world.cargo.liveCount).toBe(0);
    expect(world.cargo.exportedCount).toBe(FIXED_VOLUME);
    expect(events5(run.events, 'GameOver')).toEqual([]);
    expect(gameOverOf(world)).toBe(false);
    expect(run.ofSim('CommandRejected')).toEqual([]);
  });

  it('prijatie: ContractAccepted v ticku aplikácie príkazu, acceptedTick a plán lode (príchod +1 deň, SLA +2 dni po príchode)', () => {
    expect(own(run.of('ContractAccepted'))).toHaveLength(1);
    const c = contract();
    const accepted = must(c.acceptedTick, 'acceptedTick');
    expect(must(c.shipArrivalTick, 'shipArrivalTick') - accepted).toBeGreaterThanOrEqual(FIXED_ARRIVAL_DAYS * TICKS_PER_DAY - 1);
    expect(must(c.shipArrivalTick, 'shipArrivalTick') - accepted).toBeLessThanOrEqual(FIXED_ARRIVAL_DAYS * TICKS_PER_DAY + 1);
    expect(must(c.slaDeadlineTick, 'slaDeadlineTick')).toBe(must(c.shipArrivalTick, 'shipArrivalTick') + FIXED_SLA_DAYS * TICKS_PER_DAY);
    expect(c.rewardCents).toBe(REWARD);
    expect(c.xpReward).toBe(FIXED_VOLUME);
  });

  it('loď kontraktu vznikne v ticku príchodu (±1): ShipSpawned s 12 TEU, trieda feeder; contract.shipId ukazuje na ňu; žiadny SpawnShipDebug', () => {
    const spawned = run.ofSim('ShipSpawned');
    expect(spawned).toHaveLength(1);
    const ship = must(spawned[0], 'ShipSpawned');
    const c = contract();
    expect(ship.event.units).toBe(FIXED_VOLUME);
    expect(ship.event.classId).toBe(c.shipClassId);
    expect(ship.event.classId).toBe('feeder');
    expect(ship.event.cargoTypeId).toBe(c.cargoTypeId);
    expect(c.shipId).toBe(ship.event.shipId);
    expect(Math.abs(ship.tick - must(c.shipArrivalTick, 'shipArrivalTick'))).toBeLessThanOrEqual(1);
    expect(Math.abs(must(tickOfState(run.events, contractId, 'ship_en_route'), 'ship_en_route') - ship.tick)).toBeLessThanOrEqual(1);
    // všetky jednotky lode patria kontraktu
    const owners = new Set(
      run
        .ofSim('CargoMoved')
        .filter((entry) => entry.event.from.kind === 'on_ship')
        .map((entry) => run.contractOfUnit(entry.event.unitId)),
    );
    expect([...owners]).toEqual([contractId]);
  });

  it('ship_en_route → unloading pri ShipDocked (±1); unloading → exporting po vyložení všetkých 12 jednotiek, najneskôr v ShipDeparted', () => {
    const c = contract();
    const docked = run.ofSim('ShipDocked').find((entry) => entry.event.shipId === c.shipId);
    const departed = run.ofSim('ShipDeparted').find((entry) => entry.event.shipId === c.shipId);
    expect(Math.abs(must(tickOfState(run.events, contractId, 'unloading'), 'unloading') - must(docked, 'ShipDocked').tick)).toBeLessThanOrEqual(1);

    const lastOffShip = Math.max(
      ...run
        .ofSim('CargoMoved')
        .filter((entry) => entry.event.from.kind === 'on_ship')
        .map((entry) => entry.tick),
    );
    const exportingAt = must(tickOfState(run.events, contractId, 'exporting'), 'exporting');
    expect(exportingAt).toBeGreaterThanOrEqual(lastOffShip);
    expect(exportingAt).toBeLessThanOrEqual(must(departed, 'ShipDeparted').tick);
    expect(c.unitsUnloaded).toBe(FIXED_VOLUME);
  });

  it('dispatcher: jednotky kontraktu smú na rampu už počas vykládky (outbound sla od unloading, ADR-027 dodatok), nikdy pred ňou', () => {
    const unloadingAt = must(tickOfState(run.events, contractId, 'unloading'), 'unloading');
    const toRamp = run.ofSim('CargoMoved').filter((entry) => entry.event.to.kind === 'at_ramp');
    expect(toRamp).toHaveLength(FIXED_VOLUME);
    for (const entry of toRamp) {
      expect(run.contractOfUnit(entry.event.unitId)).toBe(contractId);
      expect(entry.tick, `jednotka ${String(entry.event.unitId)} na rampe`).toBeGreaterThanOrEqual(unloadingAt);
    }
    const outboundJobs = run.ofSim('JobCreated').filter((entry) => world.modules.get(entry.event.toModuleId)?.kind === 'ramp');
    for (const entry of outboundJobs) expect(entry.tick).toBeGreaterThanOrEqual(unloadingAt);
  });

  it('počítadlá: unitsUnloaded = unitsExported = volumeUnits = 12 a zodpovedajú CargoMoved', () => {
    const c = contract();
    expect(c.unitsUnloaded).toBe(FIXED_VOLUME);
    expect(c.unitsExported).toBe(FIXED_VOLUME);
    expect(run.countersOf(contractId).exported).toBe(FIXED_VOLUME);
    const lastExport = Math.max(
      ...run
        .ofSim('CargoMoved')
        .filter((entry) => entry.event.to.kind === 'exported')
        .map((entry) => entry.tick),
    );
    expect(completedAt).toBeGreaterThanOrEqual(lastExport);
    expect(completedAt).toBeLessThanOrEqual(lastExport + 1);
  });

  it('výplata: ContractCompleted (reward 540 000, penalizácie 0, onTime, XP 12) a jediná MoneyChanged(contract_revenue) +540 000', () => {
    const done = own(run.of('ContractCompleted'));
    expect(done).toHaveLength(1);
    const entry = must(done[0], 'ContractCompleted');
    expect(entry.tick).toBe(completedAt);
    expect(entry.event.rewardCents).toBe(REWARD);
    expect(entry.event.penaltiesCents).toBe(0);
    expect(entry.event.onTime).toBe(true);
    expect(entry.event.xp).toBe(FIXED_VOLUME);
    expect(completedAt).toBeLessThanOrEqual(must(contract().slaDeadlineTick, 'slaDeadlineTick'));

    const revenue = run.ofSim('MoneyChanged').filter((move) => move.event.reason === 'contract_revenue');
    expect(revenue.map((move) => [move.tick, move.event.deltaCents])).toEqual([[completedAt, REWARD]]);
    expect(run.ofSim('MoneyChanged').filter((move) => move.event.reason === 'penalty')).toEqual([]);
    const ledger = economyOf(world).entries.filter((row) => row.category === 'contract_revenue');
    expect(ledger.map((row) => row.amountCents)).toEqual([REWARD]);
    if (ledger[0].refId !== undefined) expect(ledger[0].refId).toContain(String(contractId));
  });

  it('žiadne penalizácie: bez PenaltyApplied, penaltiesCents 0 (vyloženie do berthAllowanceTicks, export pred SLA)', () => {
    expect(own(run.of('PenaltyApplied'))).toEqual([]);
    expect(contract().penaltiesCents).toBe(0);
  });

  it('XP, počet dokončených a tier: xp = 12 (včas), completedContracts = 1, tier 0', () => {
    expect(xpOf(world)).toBe(FIXED_VOLUME);
    expect(completedOf(world)).toBe(1);
    expect(tierOf(world)).toBe(0);
  });

  it('hotovosť: štart − CAPEX prístavu − údržba a mzdy + 540 000 (MoneyChanged sedí s ledgerom po každom ticku)', () => {
    const moves = run.ofSim('MoneyChanged');
    const byReason = (reason: string): number => moves.filter((move) => move.event.reason === reason).reduce((sum, move) => sum + move.event.deltaCents, 0);
    const total = moves.reduce((sum, move) => sum + move.event.deltaCents, 0);
    expect(cashOf(world)).toBe(DEFS.economy.startingCashCents + total);
    expect(byReason('contract_revenue')).toBe(REWARD);
    expect(byReason('road_capex')).toBeLessThan(0);
    expect(byReason('module_capex')).toBeLessThan(0);
    expect(byReason('vehicle_capex')).toBeLessThan(0);
    // AcceptContract je zadarmo: hotovosť pred prijatím = štart − CAPEX z ticku 0 (údržba ešte nie je)
    expect(cashBeforeAccept).toBe(DEFS.economy.startingCashCents + byReason('road_capex') + byReason('module_capex') + byReason('vehicle_capex'));
  });

  it('po dokončení sa nič nehýbe: ďalších 500 tickov bez zmeny stavu kontraktu, bez ďalších penalizácií a výplat', () => {
    expect(run.of('ContractCompleted')).toHaveLength(1);
    expect(run.of('ContractFailed')).toEqual([]);
    expect(stateChain(run.events, contractId).at(-1)).toBe('completed');
    expect(world.clock.tick).toBe(completedAt + SETTLE_TICKS);
  });
});
