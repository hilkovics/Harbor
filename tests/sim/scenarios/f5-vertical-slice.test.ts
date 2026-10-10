/**
 * Vertikálny rez M1 (T05-05, TDD): `data/scenarios/vertical_slice.json` — rozloženie F4 (cesty, dvory, depo + 2 vozidlá,
 * brána, stojisko, rampa), bez `SpawnShipDebug`, `AcceptContract` prvej ponuky a beh 60 000 tickov: kontrakt je
 * `completed` včas, `lostUnits 0`. Golden report `tests/sim/__golden__/vertical_slice.json`
 * (`cashEnd`, `exportedUnits`, `onTimeRate`, `contractsCompleted`, `xp`) sa porovná s behom; súbor vygeneruje T05-04
 * (`pnpm simrun data/scenarios/vertical_slice.json --ticks 60000 --report`), bez neho test zlyhá s návodom.
 *
 * Id kontraktu v súbore scenára je 1 (`SLICE_CONTRACT_ID`, T05-04): kontrakty majú vlastnú postupnosť id (ADR-026 bod 4),
 * odhad T05-05 (11 z `world.ids`) neplatil. Test „cieľ AcceptContract je najnižšie id ponuky“ to stráži.
 *
 * Predpoklady o API sú v hlavičkách `contract-*.test.ts`; tu navyše:
 *  V1 `AcceptContract` ticku `SLICE_ACCEPT_TICK` sa aplikuje, keď pool už existuje (plní sa najneskôr v prvom ticku);
 *  V2 uložený stav je verzia 5 a obnova (aj uprostred kontraktu) dá rovnaký svet a rovnaké ďalšie udalosti.
 */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import { WORLD_STATE_VERSION, World, type WorldState } from '@sim/world';
import { must } from '../helpers/harbor';
import { PORT_MAP } from '../world/world-fixtures';
import { REPO_ROOT, loadScenarioFile, runScenario, stateHash } from '../helpers/scenario';
import {
  CONTRACT_MAIN_CHAIN,
  DEFS,
  Run5,
  SLICE_ACCEPT_TICK,
  SLICE_SEED,
  SLICE_TICKS,
  TICKS_PER_DAY,
  cashOf,
  completedOf,
  contractById,
  contractList,
  contractsOf,
  contractsProjection,
  economyOf,
  economyProjection,
  events5,
  gameOverOf,
  lostUnits,
  offeredContracts,
  stateChain,
  tickOfState,
  tierOf,
  verticalSliceScenario,
  xpOf,
  type ContractLike,
} from '../helpers/f5';
import { hashState } from '../world/world-fixtures';

const GOLDEN_PATH = `${REPO_ROOT}tests/sim/__golden__/vertical_slice.json`;
const RUN_TIMEOUT_MS = 600_000;
const SAMPLE_EVERY = 1_000;
/** Po dokončení kontraktu sa beh ešte predĺži: nič sa už nesmie pohnúť a výsledok musí byť rovnaký po obnove. */
const AFTER_COMPLETION_TICKS = 2_000;

const scenario = loadScenarioFile('vertical_slice');
const acceptEntry = must(
  scenario.commands.find((entry) => entry.command.type === 'AcceptContract'),
  'AcceptContract v scenári vertical_slice',
);
const CONTRACT_ID = Number(acceptEntry.command['contractId']);

// ---------------------------------------------------------------------------------------------------------
// Scenár ako dáta
// ---------------------------------------------------------------------------------------------------------

describe('scenár vertical_slice: súbor', () => {
  it('má tvar { id, seed, map, commands }, seed 5005, mapu harbor_01', () => {
    expect(Object.keys(scenario).sort()).toEqual(['commands', 'id', 'map', 'seed']);
    expect(scenario.id).toBe('vertical_slice');
    expect(scenario.seed).toBe(SLICE_SEED);
    expect(scenario.map).toBe('data/maps/harbor_01.json');
  });

  it('je zhodný s rozložením `f4-layout` (8 úsekov ciest, 5 modulov, 2 vozidlá) + AcceptContract; bez SpawnShipDebug', () => {
    expect(scenario).toEqual(verticalSliceScenario(CONTRACT_ID, acceptEntry.atTick));
    const types = scenario.commands.map((entry) => entry.command.type);
    expect(types).toEqual([...Array<string>(8).fill('PlaceRoad'), ...Array<string>(5).fill('PlaceModule'), 'BuyVehicle', 'BuyVehicle', 'AcceptContract']);
    expect(types).not.toContain('SpawnShipDebug');
    expect(scenario.commands.filter((entry) => entry.command.type === 'BuyVehicle').map((entry) => entry.command['vehicleDefId'])).toEqual([
      'straddle_carrier',
      'straddle_carrier',
    ]);
    expect(acceptEntry.atTick).toBe(SLICE_ACCEPT_TICK);
    expect(scenario.commands.filter((entry) => entry.atTick === 0)).toHaveLength(scenario.commands.length - 1);
  });

  it('každý príkaz prežije commandFromJSON → toJSON bez zmeny', () => {
    for (const { command } of scenario.commands) expect(commandFromJSON(command).toJSON()).toEqual(command);
  });

  it('cieľ AcceptContract je práve najnižšie id ponuky v ticku prijatia (prvá ponuka)', () => {
    const world = World.create(DEFS, PORT_MAP, scenario.seed);
    runScenario(world, scenario, acceptEntry.atTick);
    const first = must(offeredContracts(world)[0], 'prvá ponuka poolu');
    expect(CONTRACT_ID, `vertical_slice.json má AcceptContract ${String(CONTRACT_ID)}, ale prvá ponuka má id ${String(first.id)} (T05-04: oprav id v scenári)`).toBe(first.id);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Beh 60 000 tickov s auditom po každom ticku + zhromažďovanie sond pre save/load a determinizmus
// ---------------------------------------------------------------------------------------------------------

interface Fork {
  readonly name: string;
  readonly tick: number;
  readonly saved: WorldState;
  readonly hash: string;
  readonly eventsBefore: number;
  readonly contracts: string;
  readonly economy: string;
}

interface Checkpoint {
  readonly tick: number;
  readonly hash: string;
  readonly contracts: string;
  readonly economy: string;
}

interface Probe {
  readonly name: string;
  readonly when: (world: World, contract: ContractLike) => boolean;
}

const PROBES: readonly Probe[] = [
  { name: 'pred príchodom lode (accepted)', when: (world, c) => c.state === 'accepted' && world.clock.tick >= 100 },
  { name: 'loď na ceste (ship_en_route)', when: (_world, c) => c.state === 'ship_en_route' },
  { name: 'uprostred vykládky (unloading, 0 < unitsUnloaded < objem)', when: (_world, c) => c.state === 'unloading' && c.unitsUnloaded > 0 && c.unitsUnloaded < c.volumeUnits },
  {
    name: 'uprostred exportu (náklad v kamióne)',
    when: (world, c) => (c.state === 'exporting' || c.state === 'unloading') && c.unitsExported < c.volumeUnits && world.cargo.countByKind('in_truck') > 0,
  },
  { name: 'po prvej uzávierke dňa', when: (world) => economyOf(world).daily.length === 1 },
  { name: 'po dokončení (completed)', when: (_world, c) => c.state === 'completed' },
];

/** Súbežný odtlačok udalostí a stavu: každých `SAMPLE_EVERY` tickov `tick:hashUdalostí:hashStavu`. */
class Sampler {
  readonly samples: string[] = [];
  private eventHash = 0x811c9dc5;

  observe(world: World, tickEvents: readonly unknown[]): void {
    for (const event of tickEvents) {
      const text = JSON.stringify(event);
      for (let i = 0; i < text.length; i++) this.eventHash = Math.imul(this.eventHash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
    if (world.clock.tick % SAMPLE_EVERY === 0) {
      this.samples.push(`${String(world.clock.tick)}:${this.eventHash.toString(16)}:${hashState(world.serialize())}`);
    }
  }
}

describe('scenár vertical_slice: beh 60 000 tickov', () => {
  let world: World;
  let run: Run5;
  let forks: Fork[];
  let checkpoint: Checkpoint;
  let sampler: Sampler;
  let completedAt: number;

  beforeAll(() => {
    world = World.create(DEFS, PORT_MAP, scenario.seed);
    forks = [];
    sampler = new Sampler();
    const taken = new Set<string>();
    let checkpointTick = Infinity;
    let checkpointValue: Checkpoint | undefined;
    run = new Run5(world, scenario, {
      fullAudit: true,
      onTick: (self, tickEvents) => {
        sampler.observe(world, tickEvents);
        const contract = contractList(world).find((c) => c.id === CONTRACT_ID);
        if (contract === undefined) return;
        for (const probe of PROBES) {
          if (taken.has(probe.name) || !probe.when(world, contract)) continue;
          taken.add(probe.name);
          forks.push({
            name: probe.name,
            tick: world.clock.tick,
            saved: JSON.parse(JSON.stringify(world.serialize())) as WorldState,
            hash: stateHash(world),
            eventsBefore: self.events.length,
            contracts: JSON.stringify(contractsProjection(world)),
            economy: JSON.stringify(economyProjection(world)),
          });
        }
        if (contract.state === 'completed' && checkpointTick === Infinity) checkpointTick = world.clock.tick + AFTER_COMPLETION_TICKS;
        if (world.clock.tick === checkpointTick) {
          checkpointValue = { tick: checkpointTick, hash: stateHash(world), contracts: JSON.stringify(contractsProjection(world)), economy: JSON.stringify(economyProjection(world)) };
        }
      },
    });
    run.runTo(SLICE_TICKS);
    completedAt = must(tickOfState(run.events, CONTRACT_ID, 'completed'), 'ContractCompleted v behu (tickOfState completed)');
    checkpoint = must(checkpointValue, 'kontrolný bod po dokončení');
  }, RUN_TIMEOUT_MS);

  const contract = () => contractById(world, CONTRACT_ID);

  it('kontrakt je completed včas: hlavná vetva FSM, dokončenie pred slaDeadlineTick, ContractCompleted.onTime = true', () => {
    expect(world.clock.tick).toBe(SLICE_TICKS);
    expect(contract().state).toBe('completed');
    expect(stateChain(run.events, CONTRACT_ID)).toEqual(CONTRACT_MAIN_CHAIN);
    expect(completedAt).toBeLessThanOrEqual(must(contract().slaDeadlineTick, 'slaDeadlineTick'));
    const done = events5(run.events, 'ContractCompleted').filter((entry) => entry.event.contractId === CONTRACT_ID);
    expect(done).toHaveLength(1);
    expect(must(done[0], 'ContractCompleted').event.onTime).toBe(true);
    expect(must(done[0], 'ContractCompleted').event.penaltiesCents).toBe(0);
    expect(must(done[0], 'ContractCompleted').event.rewardCents).toBe(contract().rewardCents);
  });

  it('lostUnits = 0, všetok náklad kontraktu je exported a na mape nič nezostalo; loď kontraktu je jediná loď hry (bez SpawnShipDebug)', () => {
    const c = contract();
    expect(lostUnits(world)).toBe(0);
    expect(world.cargo.createdCount).toBe(c.volumeUnits);
    expect(world.cargo.exportedCount).toBe(c.volumeUnits);
    expect(world.cargo.liveCount).toBe(0);
    expect([c.unitsUnloaded, c.unitsExported]).toEqual([c.volumeUnits, c.volumeUnits]);
    const spawned = run.ofSim('ShipSpawned');
    expect(spawned).toHaveLength(1);
    expect(must(spawned[0], 'ShipSpawned').event.shipId).toBe(c.shipId);
    expect(must(spawned[0], 'ShipSpawned').event.units).toBe(c.volumeUnits);
    expect(run.ofSim('CommandRejected')).toEqual([]);
  });

  it('výplata: cash += reward − penalties (0), XP = xpReward, completedContracts 1, tier 0, hra nie je GameOver', () => {
    const c = contract();
    const revenue = run.ofSim('MoneyChanged').filter((move) => move.event.reason === 'contract_revenue');
    expect(revenue.map((move) => move.event.deltaCents)).toEqual([c.rewardCents]);
    expect(run.ofSim('MoneyChanged').filter((move) => move.event.reason === 'penalty')).toEqual([]);
    expect(xpOf(world)).toBe(c.xpReward);
    expect(completedOf(world)).toBe(1);
    expect(tierOf(world)).toBe(0);
    expect(gameOverOf(world)).toBe(false);
    expect(events5(run.events, 'GameOver')).toEqual([]);
    const total = run.ofSim('MoneyChanged').reduce((sum, move) => sum + move.event.deltaCents, 0);
    expect(cashOf(world)).toBe(DEFS.economy.startingCashCents + total);
  });

  it('pool pokračuje: denne sa dopĺňa a nikdy nemá viac než offersPerDay ponúk; neprijaté ponuky expirujú', () => {
    expect(offeredContracts(world).length).toBeLessThanOrEqual(DEFS.economy.offersPerDay);
    const offeredTicks = events5(run.events, 'ContractOffered').map((entry) => entry.tick);
    expect(offeredTicks.filter((tick) => tick > 1).every((tick) => tick % TICKS_PER_DAY === 0)).toBe(true);
    expect(events5(run.events, 'ContractExpired').every((entry) => entry.event.reason === 'timeout')).toBe(true);
    expect(events5(run.events, 'ContractExpired').length).toBeGreaterThan(0);
    for (const other of contractsOf(world).values()) {
      if (other.id !== CONTRACT_ID) expect(['offered', 'expired']).toContain(other.state);
    }
  });

  it('denné uzávierky: údržba a mzdy každý deň, súhrny sedia s hotovosťou, hotovosť nikdy nie je záporná', () => {
    const daily = economyOf(world).daily;
    expect(daily).toHaveLength(Math.floor(SLICE_TICKS / TICKS_PER_DAY));
    expect(economyOf(world).daysNegative).toBe(0);
    expect(cashOf(world)).toBeGreaterThan(0);
    const sumAt = (reason: string, tick: number): number =>
      run
        .ofSim('MoneyChanged')
        .filter((move) => move.tick === tick && move.event.reason === reason)
        .reduce((sum, move) => sum + move.event.deltaCents, 0);
    for (let day = 1; day <= daily.length; day++) {
      expect(sumAt('maintenance', day * TICKS_PER_DAY), `údržba, deň ${String(day)}`).toBe(-293_000);
      expect(sumAt('wages', day * TICKS_PER_DAY), `mzdy, deň ${String(day)}`).toBe(-91_000);
    }
    expect(run.ofSim('MoneyChanged').filter((move) => (move.event.reason === 'maintenance' || move.event.reason === 'wages') && move.tick % TICKS_PER_DAY !== 0)).toEqual([]);
  });

  it('invarianty po každom ticku: konzervácia + audit ledgera a jobov (fullAudit), peniaze, kontrakty, pool, XP a tier', () => {
    expect(run.ticksChecked).toBe(SLICE_TICKS);
    for (const rule of ['cash_ledger', 'contract_fsm', 'contract_counters', 'pool_size', 'progress'] as const) {
      expect(run.violationsOf(rule), rule).toEqual([]);
    }
    expect(() => world.cargo.assertConservation()).not.toThrow();
    expect(() => world.assertInvariants()).not.toThrow();
  });

  // -------------------------------------------------------------------------------------------------------
  // Golden report
  // -------------------------------------------------------------------------------------------------------

  it('golden report tests/sim/__golden__/vertical_slice.json sa zhoduje s behom (cashEnd, exportedUnits, onTimeRate, contractsCompleted, xp)', () => {
    expect(
      existsSync(GOLDEN_PATH),
      'chýba golden report tests/sim/__golden__/vertical_slice.json — vygeneruje T05-04: pnpm simrun data/scenarios/vertical_slice.json --ticks 60000 --report',
    ).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(golden).sort()).toEqual(['cashEnd', 'contractsCompleted', 'exportedUnits', 'onTimeRate', 'xp']);

    const completed = events5(run.events, 'ContractCompleted');
    const report = {
      cashEnd: cashOf(world),
      exportedUnits: world.cargo.exportedCount,
      onTimeRate: completed.length === 0 ? null : completed.filter((entry) => entry.event.onTime).length / completed.length,
      contractsCompleted: completedOf(world),
      xp: xpOf(world),
    };
    expect(report).toEqual(golden);
    expect(golden['contractsCompleted']).toBeGreaterThanOrEqual(1);
    expect(golden['onTimeRate']).toBe(1);
  });

  // -------------------------------------------------------------------------------------------------------
  // Determinizmus a save/load
  // -------------------------------------------------------------------------------------------------------

  it('determinizmus: druhý beh s rovnakým seedom a príkazmi dá rovnaký odtlačok udalostí aj stavu každých 1 000 tickov', () => {
    const world2 = World.create(DEFS, PORT_MAP, scenario.seed);
    const sampler2 = new Sampler();
    const run2 = new Run5(world2, scenario, { onTick: (_self, tickEvents) => sampler2.observe(world2, tickEvents) });
    run2.runTo(SLICE_TICKS);
    expect(sampler.samples).toHaveLength(SLICE_TICKS / SAMPLE_EVERY);
    expect(sampler2.samples).toEqual(sampler.samples);
    expect(stateHash(world2)).toBe(stateHash(world));
    expect(run2.events.length).toBe(run.events.length);
  }, RUN_TIMEOUT_MS);

  it('sondy save/load pokryli všetky fázy kontraktu (pred príchodom, na ceste, vykládka, export, uzávierka dňa, po dokončení)', () => {
    expect(forks.map((fork) => fork.name).sort()).toEqual(PROBES.map((probe) => probe.name).sort());
  });

  it('uložený stav má aktuálnu verziu a je čistý JSON; obnova dá rovnaký stav, kontrakty a ekonomiku v každej fáze', () => {
    for (const fork of forks) {
      expect(fork.saved.version, fork.name).toBe(WORLD_STATE_VERSION);
      expect(JSON.parse(JSON.stringify(fork.saved)), fork.name).toEqual(fork.saved);
      const clone = World.deserialize(DEFS, PORT_MAP, JSON.parse(JSON.stringify(fork.saved)) as WorldState);
      expect(stateHash(clone), fork.name).toBe(fork.hash);
      expect(clone.clock.tick, fork.name).toBe(fork.tick);
      expect(JSON.stringify(contractsProjection(clone)), fork.name).toBe(fork.contracts);
      expect(JSON.stringify(economyProjection(clone)), fork.name).toBe(fork.economy);
      expect(() => clone.assertInvariants(), fork.name).not.toThrow();
    }
  });

  it('obnovený svet dobehne do rovnakého stavu a rovnakých udalostí ako pôvodný (audit po každom ticku), lostUnits 0', () => {
    for (const fork of forks) {
      const clone = World.deserialize(DEFS, PORT_MAP, JSON.parse(JSON.stringify(fork.saved)) as WorldState);
      const forked = new Run5(clone, scenario, { checkCounters: false });
      forked.runTo(checkpoint.tick);
      expect(clone.clock.tick, fork.name).toBe(checkpoint.tick);
      expect(stateHash(clone), fork.name).toBe(checkpoint.hash);
      expect(JSON.stringify(contractsProjection(clone)), fork.name).toBe(checkpoint.contracts);
      expect(JSON.stringify(economyProjection(clone)), fork.name).toBe(checkpoint.economy);
      expect(lostUnits(clone), fork.name).toBe(0);
      expect(clone.cargo.exportedCount, fork.name).toBe(world.cargo.exportedCount);
      const expected = run.events.slice(fork.eventsBefore).filter((entry) => entry.tick <= checkpoint.tick).map((entry) => JSON.stringify(entry));
      expect(forked.events.map((entry) => JSON.stringify(entry)), fork.name).toEqual(expected);
      for (const rule of ['cash_ledger', 'contract_fsm', 'pool_size', 'progress'] as const) expect(forked.violationsOf(rule), `${fork.name}: ${rule}`).toEqual([]);
    }
  }, RUN_TIMEOUT_MS);
});
