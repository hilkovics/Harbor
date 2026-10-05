// Outbound joby podľa kontraktu (T05-04, T05-11; rozhodnutie orchestrátora F5 č. 9; ADR-027 s dodatkom): na rampu smú
// uskladnené jednotky kontraktov `unloading` a `exporting` (poradie podľa SLA), kontraktov `failed` a jednotky bez
// kontraktu. Deterministické defy `fixedContractDefs` (12 TEU, SLA 2 dni, príchod +1 deň), rozloženie F4 s 2 vozidlami
// (`portScenario`), audit po každom ticku (`Run5`).
import { describe, expect, it, vi } from 'vitest';
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
  tickOfState,
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

describe('jednotky kontraktu, ktorý ešte vykladá (outbound sla, ADR-027 dodatok T05-11)', () => {
  it('počas vykládky dostanú uskladnené jednotky kontraktu outbound joby na voľnú prevádzkovú rampu, skôr než kontrakt prejde do exporting', () => {
    const { world, run, contractId } = startContract({ id: 'f5_unloading_sla', seed: 5401, defs: DEFS, fullAudit: true });
    run.runUntil((w) => contractById(w, contractId).state === 'unloading' && outboundJobs(w, run).length > 0, 3 * TICKS_PER_DAY);
    const firstJob = must(outboundJobs(world, run)[0], 'prvý outbound job');
    expect(contractById(world, contractId).state).toBe('unloading');
    expect(contractById(world, contractId).unitsUnloaded).toBeLessThan(FIXED_VOLUME);
    expect(firstJob.event.unitIds.every((unitId) => run.contractOfUnit(unitId) === contractId)).toBe(true);

    run.runUntil((w) => contractById(w, contractId).state === 'completed', 3 * TICKS_PER_DAY);
    const exportingAt = must(tickOfState(run.events, contractId, 'exporting'), 'exporting');
    expect(firstJob.tick).toBeLessThan(exportingAt);
    expect(stateChain(run.events, contractId)).toEqual(['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting', 'completed']);
    expect(contractById(world, contractId).unitsExported).toBe(FIXED_VOLUME);
    expect(lostUnits(world)).toBe(0);
    noViolations(run);
  }, RUN_TIMEOUT_MS);

  it('dispatcher nečíta jednotky kontraktu bez voľnej prevádzkovej rampy (bez brány joby nevzniknú)', () => {
    const scenario = portScenario('f5_unloading_no_gate', 5404, { landside: NO_GATE });
    const { world, run, contractId } = startContract({ id: 'f5_unloading_no_gate', seed: 5404, defs: DEFS, scenario });
    run.runUntil((w) => contractById(w, contractId).state === 'unloading' && w.cargo.countByKind('in_storage') >= 2, 3 * TICKS_PER_DAY);
    const reads = vi.spyOn(world, 'jobOfUnit');
    createOutboundJobs(world);
    expect(reads).not.toHaveBeenCalled();
    expect(outboundJobs(world, run)).toEqual([]);
    reads.mockRestore();
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
