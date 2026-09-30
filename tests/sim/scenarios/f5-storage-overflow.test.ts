/**
 * Objem kontraktu nad kapacitu skladov (T05-11; nález Major z review T05-10; ADR-027 dodatok T05-11): prístav s jediným
 * dvorom (`container_yard_small`, 64 TEU) dostane kontrakt na 72 TEU. Pred opravou boli uskladnené jednotky kontraktu
 * počas vykládky `held` — sklad a apron sa zaplnili, loď blokovala kotvisko a kontrakt skončil `failed`. Teraz smú na
 * rampu už v stave `unloading` (`outbound = 'sla'`), takže sa sklad priebežne uvoľňuje a kontrakt sa dokončí.
 *
 * Objem 72 zaručuje šablóna s rozsahom [72, 72]: poistka poolu (objem ≤ kapacita skladov) dolnú hranicu šablóny
 * neporuší. Po každom ticku beží `assertCargoConservation` + audit ledgera a jobov z F4 + invarianty F5 (`Run5`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { storageParams } from '@sim/defs';
import type { World } from '@sim/world';
import { must } from '../helpers/harbor';
import {
  FIXED_TEMPLATE,
  TICKS_PER_DAY,
  contractById,
  defsWith,
  lostUnits,
  portScenario,
  startContract,
  stateChain,
  tickOfState,
  type Run5,
  type TemplateRaw,
} from '../helpers/f5';

const VOLUME = 72;
const SLA_DAYS = 5;
const OVERFLOW_TEMPLATE: TemplateRaw = { ...FIXED_TEMPLATE, id: 'overflow_feeder', volumeUnitsRange: [VOLUME, VOLUME], slaDaysRange: [SLA_DAYS, SLA_DAYS] };
const DEFS = defsWith({ templates: [OVERFLOW_TEMPLATE], economy: { arrivalDaysRange: [1, 1] } });
const YARD_CAPACITY = storageParams(DEFS.modules.get('container_yard_small')).capacityUnits;
const SEED = 5501;
const RUN_TIMEOUT_MS = 600_000;

describe('kontrakt s objemom nad kapacitu jediného skladu sa dokončí (export počas vykládky)', () => {
  let world: World;
  let run: Run5;
  let contractId: number;
  let maxStored = 0;
  let exportedWhileUnloading = 0;

  beforeAll(() => {
    const scenario = portScenario('f5_storage_overflow', SEED, { yards: ['near'] });
    ({ world, run, contractId } = startContract({ id: 'f5_storage_overflow', seed: SEED, defs: DEFS, scenario }));
    const deadline = world.clock.tick + (SLA_DAYS + 2) * TICKS_PER_DAY;
    while (world.clock.tick < deadline && contractById(world, contractId).state !== 'completed' && contractById(world, contractId).state !== 'failed') {
      run.step();
      maxStored = Math.max(maxStored, world.cargo.countByKind('in_storage'));
      const contract = contractById(world, contractId);
      if (contract.state === 'unloading') exportedWhileUnloading = Math.max(exportedWhileUnloading, contract.unitsExported);
    }
  }, RUN_TIMEOUT_MS);

  it('predpoklady: jediný dvor, objem kontraktu > kapacita skladov (poistka poolu nezníži objem pod min šablóny)', () => {
    const storages = [...world.modules.values()].filter((module) => module.storageCapacityUnits() > 0);
    expect(storages).toHaveLength(1);
    expect(storages[0].storageCapacityUnits()).toBe(YARD_CAPACITY);
    expect(contractById(world, contractId).volumeUnits).toBe(VOLUME);
    expect(VOLUME).toBeGreaterThan(YARD_CAPACITY);
  });

  it('kontrakt prejde hlavnou vetvou až do completed a exportuje celý objem', () => {
    expect(stateChain(run.events, contractId)).toEqual(['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting', 'completed']);
    const contract = contractById(world, contractId);
    expect(contract.unitsUnloaded).toBe(VOLUME);
    expect(contract.unitsExported).toBe(VOLUME);
    expect(world.cargo.exportedCount).toBe(VOLUME);
  });

  it('jednotky kontraktu odchádzajú na rampu už počas vykládky a sklad nikdy nepresiahne kapacitu', () => {
    expect(exportedWhileUnloading).toBeGreaterThan(0);
    expect(maxStored).toBeLessThanOrEqual(YARD_CAPACITY);
    const unloadingAt = must(tickOfState(run.events, contractId, 'unloading'), 'unloading');
    const exportingAt = must(tickOfState(run.events, contractId, 'exporting'), 'exporting');
    const firstToRamp = must(
      run.ofSim('CargoMoved').find((entry) => entry.event.to.kind === 'at_ramp'),
      'prvá jednotka na rampe',
    );
    expect(firstToRamp.tick).toBeGreaterThanOrEqual(unloadingAt);
    expect(firstToRamp.tick).toBeLessThan(exportingAt);
  });

  it('loď kontraktu odplávala (neblokuje kotvisko), lostUnits = 0 a invarianty držali po každom ticku', () => {
    const contract = contractById(world, contractId);
    expect(contract.shipId).toBeDefined();
    expect([...world.ships.values()].some((ship) => ship.id === contract.shipId)).toBe(false);
    expect(lostUnits(world)).toBe(0);
    expect(run.ticksChecked).toBe(world.clock.tick);
    for (const rule of ['cash_ledger', 'contract_fsm', 'contract_counters', 'pool_size', 'progress'] as const) {
      expect(run.violationsOf(rule), rule).toEqual([]);
    }
  });
});
