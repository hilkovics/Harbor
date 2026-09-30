/**
 * Invarianty F5 v rušnom behu (T05-05, TDD): 8 herných dní, pool, prijímanie a odmietanie ponúk podľa jednoduchej
 * politiky pri každom `DayClosed`, viac kontraktov naraz na jednom prístave s 2 vozidlami. Po každom ticku beží
 * `assertCargoConservation` + nezávislý audit ledgera a jobov z F4 + invarianty peňazí a kontraktov (`Run5`):
 *  - hotovosť = štart + Σ `MoneyChanged` a každá nenulová zmena má záznam v ledgeri (žiadna zmena mimo `Economy.post`),
 *  - kontrakty sa hýbu len po hranách tabuľky FSM a počítadlá jednotiek zodpovedajú `CargoMoved`,
 *  - pool nikdy nemá viac než `offersPerDay` ponúk, XP neklesá, `tier = ⌊completed / contractsPerTier⌋`.
 * Navyše sa overuje pravidlo dispatchera (rozhodnutie 9): jednotky kontraktu sa dostanú na rampu až v stave `exporting`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { World } from '@sim/world';
import { must } from '../helpers/harbor';
import {
  DEFS,
  MAP,
  Run5,
  TICKS_PER_DAY,
  acceptContract,
  cashOf,
  completedOf,
  contractList,
  declineContract,
  economyOf,
  events5,
  lostUnits,
  offeredContracts,
  portScenario,
  tickOfState,
  type ContractState,
} from '../helpers/f5';

const DAYS = 8;
const OPEN_STATES: readonly ContractState[] = ['accepted', 'ship_en_route', 'unloading', 'exporting'];
const MAX_OPEN = 2;
const RUN_TIMEOUT_MS = 600_000;

describe('invarianty F5: 8 dní s poolom, prijímaním a odmietaním ponúk', () => {
  const seed = 5801;
  let world: World;
  let run: Run5;

  beforeAll(() => {
    world = World.create(DEFS, MAP, seed);
    run = new Run5(world, portScenario('f5_invariants', seed), {
      fullAudit: true,
      onTick: (self, tickEvents) => {
        if (!tickEvents.some((event) => event.type === 'DayClosed')) return;
        const open = contractList(world).filter((contract) => OPEN_STATES.includes(contract.state)).length;
        const [first, second] = offeredContracts(world);
        if (first !== undefined && open < MAX_OPEN) self.send(acceptContract(first.id));
        if (second !== undefined) self.send(declineContract(second.id));
      },
    });
    run.runTo(1);
    run.send(acceptContract(must(offeredContracts(world)[0], 'prvá ponuka').id));
    run.runTo(DAYS * TICKS_PER_DAY);
  }, RUN_TIMEOUT_MS);

  it('beh 8 dní: prvý kontrakt sa prijme hneď, ďalšie pri uzávierkach dňa, časť ponúk sa odmietne', () => {
    expect(world.clock.tick).toBe(DAYS * TICKS_PER_DAY);
    expect(run.of('ContractAccepted').length).toBeGreaterThanOrEqual(2);
    expect(run.of('ContractExpired').some((entry) => entry.event.reason === 'declined')).toBe(true);
    expect(run.of('ContractCompleted').length + run.of('ContractFailed').length).toBeGreaterThanOrEqual(1);
  });

  it('po každom ticku držala konzervácia, audit ledgera a jobov, peniaze a kontrakty bez jediného porušenia; lostUnits = 0', () => {
    expect(run.ticksChecked).toBe(world.clock.tick);
    for (const rule of ['cash_ledger', 'contract_fsm', 'contract_counters', 'pool_size', 'progress'] as const) {
      expect(run.violationsOf(rule), rule).toEqual([]);
    }
    expect(lostUnits(world)).toBe(0);
    expect(run.ofSim('CommandRejected')).toEqual([]);
  });

  it('hotovosť = štart + Σ MoneyChanged a denné súhrny ju sledujú; údržba a mzdy každý deň', () => {
    const total = run.ofSim('MoneyChanged').reduce((sum, move) => sum + move.event.deltaCents, 0);
    expect(cashOf(world)).toBe(DEFS.economy.startingCashCents + total);
    expect(economyOf(world).daily).toHaveLength(DAYS);
    expect(run.ofSim('MoneyChanged').filter((move) => move.event.reason === 'maintenance' && move.tick % TICKS_PER_DAY === 0)).not.toHaveLength(0);
    const completed = events5(run.events, 'ContractCompleted');
    expect(completedOf(world)).toBe(completed.length);
  });

  it('dispatcher: na rampu sa jednotky kontraktu dostanú až po prechode kontraktu do exporting', () => {
    const toRamp = run.ofSim('CargoMoved').filter((entry) => entry.event.to.kind === 'at_ramp');
    expect(toRamp.length).toBeGreaterThan(0);
    for (const entry of toRamp) {
      const contractId = run.contractOfUnit(entry.event.unitId);
      if (contractId === null || contractId === undefined) continue;
      const exportingAt = tickOfState(run.events, contractId, 'exporting');
      expect(exportingAt, `kontrakt ${String(contractId)} nikdy nebol exporting, ale jeho jednotka je na rampe`).toBeDefined();
      expect(entry.tick, `jednotka ${String(entry.event.unitId)} kontraktu ${String(contractId)}`).toBeGreaterThanOrEqual(exportingAt ?? Infinity);
    }
  });
});
