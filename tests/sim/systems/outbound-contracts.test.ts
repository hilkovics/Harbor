// Outbound joby podľa kontraktu (T05-04; rozhodnutie orchestrátora F5 č. 9; ADR-027): na rampu smú uskladnené jednotky
// kontraktov `exporting` (poradie podľa SLA), kontraktov `failed` a jednotky bez kontraktu; jednotky kontraktu, ktorý
// ešte vykladá, ostávajú v sklade a dispatcher ich ani nečíta. Deterministické defy `fixedContractDefs` (12 TEU, SLA
// 2 dni, príchod +1 deň), rozloženie F4 s 2 vozidlami (`portScenario`), audit po každom ticku (`Run5`).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractId } from '@sim/core';
import { createOutboundJobs } from '@sim/logistics';
import type { World } from '@sim/world';
import { placeLandsideCommand } from '../helpers/f4-layout';
import { must } from '../helpers/harbor';
import {
  FIXED_VOLUME,
  TICKS_PER_DAY,
  contractById,
  fixedContractDefs,
  lostUnits,
  portScenario,
  startContract,
  stateChain,
  type Run5,
} from '../helpers/f5';

const DEFS = fixedContractDefs();
const RUN_TIMEOUT_MS = 300_000;
/** Rozloženie bez brány: rampa je neprevádzková, jednotky po vyložení čakajú v skladoch. */
const NO_GATE = ['waiting_area', 'ramp'] as const;
const DEBUG_SHIP = { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: FIXED_VOLUME } as const;

const outboundJobs = (world: World, run: Run5, fromTick = 0) =>
  run.ofSim('JobCreated').filter((entry) => entry.tick >= fromTick && world.modules.get(entry.event.toModuleId)?.kind === 'ramp');

const noViolations = (run: Run5): void => {
  for (const rule of ['cash_ledger', 'contract_fsm', 'contract_counters', 'pool_size', 'progress'] as const) expect(run.violationsOf(rule), rule).toEqual([]);
};

describe('jednotky kontraktu, ktorý ešte vykladá (held)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('počas vykládky majú uskladnené jednotky kontraktu voľnú prevádzkovú rampu, ale job nedostanú a dispatcher ich nečíta', () => {
    const { world, run, contractId } = startContract({ id: 'f5_held', seed: 5401, defs: DEFS, fullAudit: true });
    run.runUntil((w) => contractById(w, contractId).state === 'unloading' && w.cargo.countByKind('in_storage') >= 2, 3 * TICKS_PER_DAY);
    const ramp = must(world.landsideModules.ramps[0], 'rampa');
    expect([world.isRampOperational(ramp), ramp.freeCount > 0]).toEqual([true, true]);
    expect(world.storedCargo.groupOf(contractId as ContractId)?.units.length).toBe(world.cargo.countByKind('in_storage'));
    expect(outboundJobs(world, run)).toEqual([]);

    const reads = vi.spyOn(world, 'jobOfUnit');
    createOutboundJobs(world);
    expect(reads).not.toHaveBeenCalled();
    expect(outboundJobs(world, run)).toEqual([]);

    run.runUntil((w) => contractById(w, contractId).state === 'exporting', 2 * TICKS_PER_DAY);
    const exportingAt = world.clock.tick;
    run.step();
    const created = outboundJobs(world, run);
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((entry) => entry.tick >= exportingAt)).toBe(true);
    noViolations(run);
  }, RUN_TIMEOUT_MS);
});

describe('jednotky zlyhaného kontraktu (failed) smú na rampu', () => {
  it('po zlyhaní a postavení brány sa náklad kontraktu vyvezie; kontrakt ostáva failed, bez výplaty, XP a ďalšej penalizácie', () => {
    const { world, run, contractId } = startContract({ id: 'f5_failed_export', seed: 5402, defs: DEFS, scenario: portScenario('f5_failed_export', 5402, { landside: NO_GATE }) });
    run.runUntil((w) => contractById(w, contractId).state === 'failed', 10 * TICKS_PER_DAY);
    expect(world.cargo.countByKind('in_storage')).toBe(FIXED_VOLUME);
    expect(world.cargo.exportedCount).toBe(0);
    const penalties = contractById(world, contractId).penaltiesCents;
    const moneyBefore = run.ofSim('MoneyChanged').filter((move) => move.event.reason === 'penalty' || move.event.reason === 'contract_revenue').length;

    const gateAt = world.clock.tick;
    run.send(placeLandsideCommand('gate'));
    run.runUntil((w) => w.cargo.exportedCount === FIXED_VOLUME, 2 * TICKS_PER_DAY);

    const created = outboundJobs(world, run, gateAt);
    expect(created).toHaveLength(FIXED_VOLUME);
    expect(created.every((entry) => entry.event.unitIds.every((unitId) => run.contractOfUnit(unitId) === contractId))).toBe(true);
    const c = contractById(world, contractId);
    expect(c.state).toBe('failed');
    expect(c.penaltiesCents).toBe(penalties);
    expect(stateChain(run.events, contractId)).toEqual(['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting', 'failed']);
    expect(run.of('ContractCompleted')).toEqual([]);
    expect(run.ofSim('MoneyChanged').filter((move) => move.event.reason === 'penalty' || move.event.reason === 'contract_revenue')).toHaveLength(moneyBefore);
    expect([world.xp, world.completedContracts]).toEqual([0, 0]);
    expect(lostUnits(world)).toBe(0);
    expect(world.storedCargo.size).toBe(0);
    noViolations(run);
  }, RUN_TIMEOUT_MS);
});

describe('poradie: kontrakt exporting pred staršími jednotkami bez kontraktu', () => {
  it('jednotky SpawnShipDebug (uskladnené skôr) dostanú outbound joby až po všetkých jednotkách kontraktu', () => {
    const seed = 5403;
    const scenario = portScenario('f5_null_after_sla', seed, { landside: NO_GATE, extra: [{ atTick: 0, command: DEBUG_SHIP }] });
    const { world, run, contractId } = startContract({ id: 'f5_null_after_sla', seed, defs: DEFS, scenario, fullAudit: true });
    run.runUntil((w) => contractById(w, contractId).state === 'exporting' && w.cargo.countByKind('in_storage') === 2 * FIXED_VOLUME, 3 * TICKS_PER_DAY);
    const firstStored = run.ofSim('CargoMoved').find((entry) => entry.event.to.kind === 'in_storage');
    expect(run.contractOfUnit(must(firstStored, 'prvé uskladnenie').event.unitId)).toBeNull();

    const gateAt = world.clock.tick;
    run.send(placeLandsideCommand('gate'));
    run.runUntil((w) => contractById(w, contractId).state === 'completed' && w.cargo.exportedCount === 2 * FIXED_VOLUME, 2 * TICKS_PER_DAY);

    const owners = outboundJobs(world, run, gateAt).map((entry) => run.contractOfUnit(must(entry.event.unitIds[0], 'jednotka jobu')));
    expect(owners).toEqual([...Array<number>(FIXED_VOLUME).fill(contractId), ...Array<null>(FIXED_VOLUME).fill(null)]);
    expect(lostUnits(world)).toBe(0);
    noViolations(run);
  }, RUN_TIMEOUT_MS);
});
