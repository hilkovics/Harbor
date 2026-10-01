/**
 * `ContractSystem` — krok 2 (T05-03, ADR-026): kedy sa pool dopĺňa, `capacityHint` z háčikov modulov, poradie udalostí
 * a účtovanie pri dokončení, demurrage len počas státia lode, zlyhanie ešte na ceste a počítadlá po zlyhaní.
 */
import { describe, expect, it, vi } from 'vitest';
import { capacityHintOf, offerVolumeUnits, type Contract } from '@sim/contracts';
import type { ContractId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { ContractSystem, GAME_START_TICK, MIN_CRANE_PHASE_TICKS, expireOffers, refillPool } from '@sim/systems';
import { World } from '@sim/world';
import { emptyScenario, must } from '../helpers/harbor';
import { runScenario } from '../helpers/scenario';
import {
  FIXED_TEMPLATE,
  FIXED_VOLUME,
  MAP,
  RAW_DEFS,
  TICKS_PER_DAY,
  contractById,
  defsWith,
  demurrageStepCents,
  fixedContractDefs,
  offeredContracts,
  portScenario,
  startContract,
  worldWithPool,
} from '../helpers/f5';

const RUN_TIMEOUT_MS = 300_000;

describe('pool: kedy sa dopĺňa', () => {
  it('prvé naplnenie v GAME_START_TICK = 1 (nie v World.create), potom len pri DayClosed; plný pool refillPool nezmení', () => {
    const defs = fixedContractDefs();
    const world = World.create(defs, MAP, 5601);
    expect(world.contracts.size).toBe(0);
    expect(GAME_START_TICK).toBe(1);
    world.tick();
    expect(offeredContracts(world)).toHaveLength(defs.economy.offersPerDay);
    const before = JSON.stringify(world.serialize());
    refillPool(world);
    expect(world.events.pending).toBe(0);
    expect(JSON.stringify(world.serialize())).toBe(before);
  });

  it('ponuky zo štartu (expirácia 17 281) zaniknú v uzávierke 25 920 a v tom istom ticku ich nahradí nová dávka', () => {
    const defs = fixedContractDefs();
    const world = worldWithPool(defs, 5602);
    const first = offeredContracts(world).map((offer) => offer.id);
    const expiredAt: number[] = [];
    const offeredAt: number[] = [];
    while (world.clock.tick < 3 * TICKS_PER_DAY) {
      for (const event of world.tick()) {
        if (event.type === 'ContractExpired') expiredAt.push(world.clock.tick);
        if (event.type === 'ContractOffered') offeredAt.push(world.clock.tick);
      }
    }
    expect(expiredAt).toEqual(Array<number>(first.length).fill(3 * TICKS_PER_DAY));
    expect(offeredAt).toEqual(Array<number>(first.length).fill(3 * TICKS_PER_DAY));
    expect(offeredContracts(world).map((offer) => offer.id)).toEqual(first.map((id) => id + first.length));
  }, RUN_TIMEOUT_MS);
});

describe('capacityHint z háčikov modulov (pravidlo 7)', () => {
  it('prázdny prístav: žeriav 8 640 / 12 = 720 za deň, sklady 0 → minCapacityHint; F4 s 2 dvormi po 64 → 128', () => {
    const defs = fixedContractDefs();
    const bare = World.create(defs, MAP, 5603);
    const modules = [...bare.modules.values()];
    expect(modules.map((module) => module.dailyUnloadUnits(bare.stats, TICKS_PER_DAY))).toEqual(modules.map((module) => (module.kind === 'crane' ? 720 : 0)));
    expect(modules.map((module) => module.storageCapacityUnits())).toEqual(modules.map(() => 0));
    expect(capacityHintOf(bare.modules.values(), bare.stats, TICKS_PER_DAY, defs.economy.minCapacityHint)).toBe(defs.economy.minCapacityHint);

    const port = World.create(defs, MAP, 5603);
    runScenario(port, portScenario('f5_hint', 5603), 1);
    expect(capacityHintOf(port.modules.values(), port.stats, TICKS_PER_DAY, defs.economy.minCapacityHint)).toBe(128);
  });
});

describe('žeriav: vykládka za deň pre capacityHint (T05-11)', () => {
  it.each([
    [0.4, 2 * MIN_CRANE_PHASE_TICKS], // pod najkratším cyklom → dve fázy po MIN_CRANE_PHASE_TICKS
    [1, 2 * MIN_CRANE_PHASE_TICKS],
    [2, 2],
    [12, 12],
    [12.4, 12],
  ] as const)('cycleTicks %d → ⌊ticksPerDay / %d⌋', (cycleTicks, cycle) => {
    const world = World.create(fixedContractDefs(), MAP, 5610);
    const crane = must([...world.modules.values()].find((module) => module.kind === 'crane'), 'žeriav');
    const stats = { resolve: () => cycleTicks };
    expect(crane.dailyUnloadUnits(stats, TICKS_PER_DAY)).toBe(Math.floor(TICKS_PER_DAY / cycle));
  });
});

describe('poistka objemu ponuky: objem ≤ kapacita skladov, ale ≥ min šablóny (T05-11, ADR-027 dodatok)', () => {
  it.each([
    // [scale, hint, range, ship, storage, očakávaný objem]
    [1.2, 64, [24, 96], 120, 64, 64], // 77 → strop kapacity skladov
    [1.2, 64, [72, 72], 120, 64, 72], // min šablóny má prednosť pred poistkou
    [0.4, 64, [24, 96], 120, 64, 26], // pod kapacitou sa nemení
    [1.2, 24, [24, 96], 120, 0, 29], // bez skladov poistka neplatí
    [1.2, 128, [24, 96], 120, 128, 96], // max šablóny
    [1.2, 300, [60, 240], 120, 500, 120], // kapacita lode
  ] as const)('scale %d × hint %d, rozsah %j, loď %d, sklady %d → %d', (scale, hint, range, ship, storage, expected) => {
    expect(offerVolumeUnits(scale, hint, range, ship, storage)).toBe(expected);
  });

  it('pool v prístave s jediným dvorom (64): ponuky šablóny [24, 96] pri mierke 1,2 majú 64, šablóny [72, 72] majú 72', () => {
    const wide = { ...FIXED_TEMPLATE, id: 'wide_feeder', volumeUnitsRange: [24, 96] as const };
    const big = { ...FIXED_TEMPLATE, id: 'big_feeder', volumeUnitsRange: [72, 72] as const };
    const defs = defsWith({ templates: [wide, big], economy: { volumeScaleRange: [1.2, 1.2] } });
    const world = World.create(defs, MAP, 5607);
    runScenario(world, portScenario('f5_volume_guard', 5607, { yards: ['near'] }), 1);
    const offers = offeredContracts(world);
    expect(offers.length).toBe(defs.economy.offersPerDay);
    for (const offer of offers) expect(offer.volumeUnits, offer.templateId).toBe(offer.templateId === 'big_feeder' ? 72 : 64);
  });
});

describe('krok 2: snímka neukončených kontraktov a loď kontraktu', () => {
  const NO_BOUNDARIES = { hourClosed: false, dayClosed: false, monthClosed: false } as const;

  it('ship_en_route bez lode na mape (porušenie invariantu) neprejde do unloading; s loďou pri kotvisku áno', () => {
    const { world, run, contractId } = startContract({ id: 'f5_missing_ship', seed: 5608, defs: fixedContractDefs() });
    run.runUntil((w) => {
      const c = contractById(w, contractId);
      const ship = [...w.ships.values()].find((candidate) => candidate.id === c.shipId);
      return c.state === 'ship_en_route' && ship?.state === 'docked';
    }, 3 * TICKS_PER_DAY);
    const system = new ContractSystem();
    const lookup = vi.spyOn(world.ships, 'get').mockReturnValue(undefined);
    system.tick(world, NO_BOUNDARIES);
    expect(contractById(world, contractId).state).toBe('ship_en_route');
    lookup.mockRestore();
    system.tick(world, NO_BOUNDARIES);
    expect(contractById(world, contractId).state).toBe('unloading');
  }, RUN_TIMEOUT_MS);

  it('expireOffers so znovupoužiteľným poľom: pole sa naplní snímkou neukončených kontraktov a expirujú len ponuky po termíne', () => {
    const world = worldWithPool(fixedContractDefs(), 5609);
    const scratch: Contract[] = [];
    expireOffers(world, scratch);
    expect(scratch.map((contract) => contract.id)).toEqual(offeredContracts(world).map((offer) => offer.id));
    expect(world.events.pending).toBe(0);
  });
});

describe('dokončenie: poradie udalostí a kniha', () => {
  it('v ticku dokončenia: ContractStateChanged exporting → completed, MoneyChanged(contract_revenue), ContractCompleted; refId contract:<id>', () => {
    const { world, run, contractId } = startContract({ id: 'f5_completion_order', seed: 5604, defs: fixedContractDefs() });
    run.runUntil((w) => contractById(w, contractId).state === 'completed', 30_000);
    const tick = world.clock.tick;
    const own = run.events.filter((entry) => entry.tick === tick && ['ContractStateChanged', 'MoneyChanged', 'ContractCompleted'].includes(entry.event.type));
    expect(own.map((entry) => entry.event.type)).toEqual(['ContractStateChanged', 'MoneyChanged', 'ContractCompleted']);
    const revenue = must(world.economy.entries.find((entry) => entry.category === 'contract_revenue'), 'contract_revenue');
    expect([revenue.tick, revenue.amountCents, revenue.refId]).toEqual([tick, 540_000, `contract:${String(contractId)}`]);
    expect([world.xp, world.completedContracts, world.tier]).toEqual([FIXED_VOLUME, 1, 0]);
  }, RUN_TIMEOUT_MS);
});

describe('demurrage len počas státia lode', () => {
  /**
   * Minútové ticky (`tickGameSeconds` 60 → hodina = 60 tickov) a povolenie kotviska 1 hodina: vykládka 12 TEU v prístave
   * F4 trvá niekoľko herných hodín, takže demurrage vznikne a po odchode lode musí prestať.
   */
  const defs = DefRegistry.fromRaw({
    ...RAW_DEFS,
    time: { ...RAW_DEFS.time, tickGameSeconds: 60 },
    economy: { ...RAW_DEFS.economy, arrivalDaysRange: [1, 1] },
    contract_templates: { ...RAW_DEFS.contract_templates, items: [FIXED_TEMPLATE] },
    ships: { ...RAW_DEFS.ships, items: RAW_DEFS.ships.items.map((item) => (item.id === 'feeder' ? { ...item, berthAllowanceTicks: 60 } : item)) },
  });

  it('demurrage za každú celú hodinu od dockedTick + povolenie, kým loď stojí; po ShipUndocked už nie', () => {
    const { world, run, contractId } = startContract({ id: 'f5_demurrage_stop', seed: 5605, defs });
    const hour = world.clock.ticksPerHour;
    expect(hour).toBe(60);
    run.runUntil((w) => contractById(w, contractId).state === 'exporting', 30_000);
    run.runTo(world.clock.tick + 3 * hour);
    const contract = must(world.contracts.get(contractId as ContractId), 'kontrakt');
    const undocked = must(run.ofSim('ShipUndocked').find((entry) => entry.event.shipId === contract.shipId), 'ShipUndocked').tick;
    const docked = must(run.ofSim('ShipDocked').find((entry) => entry.event.shipId === contract.shipId), 'ShipDocked').tick;
    const demurrage = run.of('PenaltyApplied').filter((entry) => entry.event.kind === 'demurrage');
    // krok 2 vidí loď pri kotvisku od ticku po ShipDocked (dockedTick) po tick ShipUndocked (krok 3 toho ticku ju odvedie)
    expect(contract.dockedTick).toBe(docked + 1);
    const expected = Math.floor((undocked - (docked + 1) - 60) / hour);
    expect(expected).toBeGreaterThan(0);
    expect(demurrage).toHaveLength(expected);
    const step = demurrageStepCents(contract.rewardCents, defs);
    for (const entry of demurrage) expect(entry.event.amountCents).toBe(step);
    expect(Math.max(...demurrage.map((entry) => entry.tick))).toBeLessThanOrEqual(undocked);
    expect([contract.demurrageHours, contract.penaltiesCents]).toEqual([expected, expected * step]);
    expect(run.violations).toEqual([]);
  }, RUN_TIMEOUT_MS);
});

describe('zlyhanie ešte na ceste', () => {
  it('pomalá loď: kontrakt zlyhá v ship_en_route po SLA + 3 dňoch + 1 tick, jediná transakcia penalty, bez výplaty a XP; loď pláva ďalej', () => {
    const defs = fixedContractDefs({}, { ship: { id: 'feeder', fields: { speedCellsPerTick: 0.0001 } } });
    const world = World.create(defs, MAP, 5606);
    const events: SimEvent[] = [];
    runScenario(world, emptyScenario('f5_fail_en_route', 5606), 1);
    const offer = must(offeredContracts(world)[0], 'ponuka');
    runScenario(world, { ...emptyScenario('f5_fail_en_route', 5606), commands: [{ atTick: 1, command: { type: 'AcceptContract', contractId: offer.id } }] }, 2);
    const sla = must(contractById(world, offer.id).slaDeadlineTick, 'slaDeadlineTick');
    const failAt = sla + defs.economy.failAfterDaysLate * TICKS_PER_DAY + 1;
    while (world.clock.tick < failAt) events.push(...world.tick());
    const contract = must(world.contracts.get(Number(offer.id) as ContractId), 'kontrakt');
    expect(contract.state).toBe('failed');
    expect(contract.closedTick).toBe(failAt);
    expect(contract.dockedTick).toBeUndefined();
    expect(contract.lateDays).toBe(defs.economy.failAfterDaysLate);
    const failed = events.filter((event) => event.type === 'ContractFailed');
    expect(failed).toEqual([{ type: 'ContractFailed', contractId: offer.id, penaltiesCents: contract.penaltiesCents }]);
    const moves = events.filter((event) => event.type === 'MoneyChanged' && (event.reason === 'penalty' || event.reason === 'contract_revenue'));
    expect(moves.map((event) => (event.type === 'MoneyChanged' ? [event.reason, event.deltaCents] : []))).toEqual([['penalty', -contract.penaltiesCents]]);
    const ship = must(world.ships.get(must(contract.shipId, 'shipId')), 'loď kontraktu');
    expect(ship.state).toBe('inbound');
    expect(world.xp).toBe(0);
  }, RUN_TIMEOUT_MS);
});
