/**
 * Dispatcher krok 2 podľa kontraktu (T05-05, TDD; „Rozhodnutia orchestrátora" 9): outbound joby vznikajú len pre
 * jednotky kontraktu v stave `exporting`, v poradí `slaDeadlineTick` vzostupne, potom id kontraktu, potom FIFO.
 *
 * Scenár: dva kontrakty (rýchly `fast_run` SLA 2 dni, pomalý `slow_run` SLA 5 dní, po 12 TEU), prijaté v jednom ticku,
 * pomalý prvý a s nižším id. Prístav má bránu a stojisko, ale rampu postavím až vtedy, keď sú obe partie vyložené a
 * uskladnené — vtedy súťažia o rampu naraz. FIFO aj id by uprednostnili pomalý kontrakt, SLA rýchly.
 *
 * Predpoklady o API: `JobCreated` outbound (cieľ = rampa) nesie `unitIds` jednotiek jedného kontraktu; poradie
 * `JobCreated` udalostí je poradie priorít dispatchera (ADR-018: joby vznikajú v poradí kandidátov).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { World } from '@sim/world';
import { placeLandsideCommand } from '../helpers/f4-layout';
import { must } from '../helpers/harbor';
import {
  FIXED_TEMPLATE,
  FIXED_VOLUME,
  MAP,
  Run5,
  acceptContract,
  contractById,
  defsWith,
  findSeed,
  lostUnits,
  offeredContracts,
  portScenario,
  stateChain,
  tickOfState,
  urgencyBp,
  type TemplateRaw,
} from '../helpers/f5';

const FAST: TemplateRaw = { ...FIXED_TEMPLATE, id: 'fast_run', slaDaysRange: [2, 2] };
const SLOW: TemplateRaw = { ...FIXED_TEMPLATE, id: 'slow_run', slaDaysRange: [5, 5] };
const DEFS = defsWith({ templates: [FAST, SLOW], economy: { arrivalDaysRange: [1, 1] } });
const RUN_TIMEOUT_MS = 300_000;

describe('SLA priorita outbound jobov: rýchly kontrakt (SLA 2 dni) pred pomalým (SLA 5 dní), hoci pomalý je starší a má nižšie id', () => {
  let run: Run5;
  let world: World;
  let fastId: number;
  let slowId: number;
  let rampPlacedAt: number;

  beforeAll(() => {
    // Seed, kde je najnižšie id pomalej ponuky menšie než najvyššie id rýchlej (poradie id ≠ poradie SLA).
    const seed = findSeed(
      (s) => World.create(DEFS, MAP, s),
      (w) => {
        const offers = offeredContracts(w);
        const slow = offers.find((offer) => offer.templateId === 'slow_run');
        const fast = offers.filter((offer) => offer.templateId === 'fast_run').at(-1);
        return slow !== undefined && fast !== undefined && slow.id < fast.id;
      },
    );
    world = World.create(DEFS, MAP, seed);
    run = new Run5(world, portScenario('f5_sla_priority', seed, { landside: ['gate', 'waiting_area'] }), { fullAudit: true });
    run.runTo(1);
    const offers = offeredContracts(world);
    const slow = must(offers.find((offer) => offer.templateId === 'slow_run'), 'ponuka slow_run');
    const fast = must(offers.filter((offer) => offer.templateId === 'fast_run').at(-1), 'ponuka fast_run');
    slowId = slow.id;
    fastId = fast.id;
    run.send(acceptContract(slowId));
    run.send(acceptContract(fastId));
    run.runUntil(
      (w) =>
        contractById(w, slowId).state === 'exporting' &&
        contractById(w, fastId).state === 'exporting' &&
        w.cargo.countByKind('in_storage') === 2 * FIXED_VOLUME,
      60_000,
    );
    run.send(placeLandsideCommand('ramp'));
    rampPlacedAt = world.clock.tick;
    run.runUntil((w) => contractById(w, slowId).state === 'completed' && contractById(w, fastId).state === 'completed', 60_000);
  }, RUN_TIMEOUT_MS);

  it('predpoklady scenára: pomalý kontrakt má nižšie id a neskorší termín; rýchly má vyššiu odmenu za jednotku (urgency)', () => {
    const slow = contractById(world, slowId);
    const fast = contractById(world, fastId);
    expect(slowId).toBeLessThan(fastId);
    expect(must(slow.slaDeadlineTick, 'sla slow')).toBeGreaterThan(must(fast.slaDeadlineTick, 'sla fast'));
    expect(fast.rewardCents / fast.volumeUnits).toBeGreaterThan(slow.rewardCents / slow.volumeUnits);
    expect(urgencyBp(2, DEFS)).toBeGreaterThan(urgencyBp(5, DEFS));
  });

  it('obe partie boli pred postavením rampy vyložené a uskladnené (kontrakty exporting, nič sa neexportovalo)', () => {
    expect(rampPlacedAt).toBeGreaterThan(0);
    for (const id of [slowId, fastId]) {
      const chain = stateChain(run.events, id);
      expect(chain.slice(0, 5)).toEqual(['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting']);
      expect(must(tickOfState(run.events, id, 'exporting'), 'exporting')).toBeLessThanOrEqual(rampPlacedAt);
    }
    const exportedBefore = run.ofSim('CargoMoved').filter((entry) => entry.event.to.kind === 'exported' && entry.tick <= rampPlacedAt);
    expect(exportedBefore).toEqual([]);
  });

  it('outbound joby vznikajú najprv pre všetkých 12 jednotiek rýchleho kontraktu, až potom pre pomalý (bez prekladania)', () => {
    const outbound = run
      .ofSim('JobCreated')
      .filter((entry) => entry.tick >= rampPlacedAt && world.modules.get(entry.event.toModuleId)?.kind === 'ramp');
    expect(outbound.length).toBe(2 * FIXED_VOLUME);
    const contractsInOrder = outbound.map((entry) => {
      const owners = new Set(entry.event.unitIds.map((unitId) => run.contractOfUnit(unitId)));
      expect(owners.size, `job ${String(entry.event.jobId)} mieša kontrakty`).toBe(1);
      return [...owners][0];
    });
    expect(contractsInOrder).toEqual([...Array<number>(FIXED_VOLUME).fill(fastId), ...Array<number>(FIXED_VOLUME).fill(slowId)]);
  });

  it('rýchly kontrakt sa dokončí skôr (alebo naraz) ako pomalý a oba sú completed s 12 exportovanými jednotkami', () => {
    const fastDone = must(tickOfState(run.events, fastId, 'completed'), 'fast completed');
    const slowDone = must(tickOfState(run.events, slowId, 'completed'), 'slow completed');
    expect(fastDone).toBeLessThanOrEqual(slowDone);
    for (const id of [fastId, slowId]) {
      expect(contractById(world, id).unitsExported).toBe(FIXED_VOLUME);
      expect(run.countersOf(id).exported).toBe(FIXED_VOLUME);
    }
    expect(world.cargo.exportedCount).toBe(2 * FIXED_VOLUME);
  });

  it('invarianty po každom ticku (konzervácia, audit ledgera a jobov, peniaze, kontrakty), lostUnits = 0', () => {
    expect(run.ticksChecked).toBe(world.clock.tick);
    for (const rule of ['cash_ledger', 'contract_fsm', 'contract_counters', 'pool_size', 'progress'] as const) {
      expect(run.violationsOf(rule), rule).toEqual([]);
    }
    expect(lostUnits(world)).toBe(0);
  });
});
