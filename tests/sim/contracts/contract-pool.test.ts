/**
 * Pool ponúk kontraktov (T05-05, TDD; „Rozhodnutia orchestrátora" 8): najviac `offersPerDay` ponúk, expirácia po
 * `offerExpiryDays`, filter `minTier`, doplnenie pri `DayClosed`, váhový výber šablón jediným `Rng`, objem
 * `clamp(round(U(volumeScaleRange) × capacityHint), volumeUnitsRange)` a `≤` kapacita lode. Očakávané hodnoty sa počítajú
 * z defov (`helpers/f5.ts`), nie z implementácie.
 *
 * Predpoklady o API:
 *  P1 pool sa plní najneskôr v prvom ticku hry (tick 0/1) a pri každom `DayClosed` do `offersPerDay`; ponuka je
 *     `Contract` v stave `offered` vo `world.contracts`, vznik ohlási `ContractOffered { contractId }`;
 *  P2 expirácia = `ContractStateChanged offered → expired` + `ContractExpired { reason: 'timeout' }` najskôr v
 *     `offerExpiresTick`, najneskôr do jedného herného dňa po ňom; expirovaný kontrakt môže z mapy zmiznúť;
 *  P3 uložený stav v5 obsahuje kľúč `completedContracts` (rozhodnutie 11), z ktorého sa berie tier.
 */
import { describe, expect, it, vi } from 'vitest';
import { World, type WorldState } from '@sim/world';
import { emptyScenario, must } from '../helpers/harbor';
import {
  DEFS,
  MAP,
  Run5,
  TICKS_PER_DAY,
  capacityHintOf,
  completedOf,
  contractById,
  contractList,
  declineContract,
  defsWith,
  events5,
  expectedRewardCents,
  expectedXpReward,
  findSeed,
  offeredContracts,
  offeredIdsOf,
  portScenario,
  stateOfContract,
  tickWorld,
  tierOf,
  volumeBounds,
  worldWithPool,
  type ContractLike,
  type TemplateRaw,
} from '../helpers/f5';

const OFFERS = DEFS.economy.offersPerDay;
const EXPIRY_TICKS = DEFS.economy.offerExpiryDays * TICKS_PER_DAY;
const LONG_TIMEOUT_MS = 300_000;

/** Ceny, ktoré môže mať ponuka šablóny: pre každé celé SLA zo `slaDaysRange`. */
function allowedRewards(contract: ContractLike, defs = DEFS): number[] {
  const template = defs.contractTemplates.get(contract.templateId);
  const rewards: number[] = [];
  for (let sla = template.slaDaysRange[0]; sla <= template.slaDaysRange[1]; sla++) {
    rewards.push(expectedRewardCents(template.cargoTypeId, contract.volumeTeu, sla, defs));
  }
  return rewards;
}

describe('pool: prvé naplnenie', () => {
  it('po prvom ticku je v poole práve offersPerDay ponúk v stave offered, s jedinečnými id a bez prijatia', () => {
    const world = worldWithPool();
    const offers = offeredContracts(world);
    expect(offers).toHaveLength(OFFERS);
    expect(new Set(offers.map((offer) => offer.id)).size).toBe(OFFERS);
    expect(contractList(world)).toHaveLength(OFFERS);
    for (const offer of offers) {
      expect(offer.state).toBe('offered');
      expect(offer.acceptedTick).toBeUndefined();
      expect(offer.shipId).toBeUndefined();
      expect(offer.unitsUnloaded).toBe(0);
      expect(offer.unitsExported).toBe(0);
      expect(offer.penaltiesCents).toBe(0);
    }
  });

  it('ponuka zodpovedá šablóne: náklad, trieda lode, tier 0, expirácia offerExpiryDays po vzniku, xpReward z defu', () => {
    const world = worldWithPool();
    for (const offer of offeredContracts(world)) {
      const template = DEFS.contractTemplates.get(offer.templateId);
      expect(offer.cargoTypeId, `${offer.templateId}`).toBe(template.cargoTypeId);
      expect(template.shipClassIds, `${offer.templateId}`).toContain(offer.shipClassId);
      expect(template.minTier, `${offer.templateId}`).toBeLessThanOrEqual(tierOf(world));
      expect(offer.offeredTick).toBeLessThanOrEqual(world.clock.tick);
      expect(offer.offerExpiresTick - offer.offeredTick).toBe(EXPIRY_TICKS);
      expect(offer.xpReward).toBe(expectedXpReward(offer.cargoTypeId, offer.volumeTeu));
    }
  });

  it('bez skladov je capacityHint = minCapacityHint a objem leží v [clamp(round(0,4 × hint)), clamp(round(1,2 × hint))] šablóny', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const world = worldWithPool(DEFS, seed);
      const hint = capacityHintOf(world);
      expect(hint).toBe(DEFS.economy.minCapacityHint);
      for (const offer of offeredContracts(world)) {
        const bounds = volumeBounds(offer.templateId, hint);
        expect(offer.volumeTeu, `seed ${String(seed)}, ${offer.templateId}`).toBeGreaterThanOrEqual(bounds.min);
        expect(offer.volumeTeu, `seed ${String(seed)}, ${offer.templateId}`).toBeLessThanOrEqual(bounds.max);
        expect(offer.volumeTeu).toBeGreaterThan(0);
      }
    }
  });

  it('odmena každej ponuky = ⌊objem × cena × urgencyBp / 10 000⌋ pre niektoré celé SLA zo slaDaysRange šablóny', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const world = worldWithPool(DEFS, seed);
      for (const offer of offeredContracts(world)) {
        expect(allowedRewards(offer), `seed ${String(seed)}, ${offer.templateId}, objem ${String(offer.volumeTeu)}, odmena ${String(offer.rewardCents)}`).toContain(offer.rewardCents);
      }
    }
  });

  it('tier 0: žiadna ponuka šablóny s minTier 1 (container_handy_run)', () => {
    for (let seed = 1; seed <= 12; seed++) {
      for (const offer of offeredContracts(worldWithPool(DEFS, seed))) {
        expect(offer.templateId, `seed ${String(seed)}`).not.toBe('container_handy_run');
      }
    }
  });

  it('determinizmus: rovnaký seed dá rovnaké ponuky, iný seed iné', () => {
    const shape = (world: World): unknown[] => offeredContracts(world).map((offer) => [offer.id, offer.templateId, offer.volumeUnits, offer.volumeTeu, offer.rewardCents, offer.shipClassId]);
    expect(shape(worldWithPool(DEFS, 5005))).toEqual(shape(worldWithPool(DEFS, 5005)));
    expect(shape(worldWithPool(DEFS, 5005))).not.toEqual(shape(worldWithPool(DEFS, 5006)));
  });

  it('šablóny s minTier 1 pri tier 0: pool je prázdny a hra nespadne', () => {
    const items: TemplateRaw[] = DEFS.contractTemplates.items.map((template) => ({ ...template, minTier: 1 }));
    const defs = defsWith({ templates: items });
    const world = worldWithPool(defs, 5005);
    expect(offeredContracts(world)).toHaveLength(0);
    for (let day = 0; day < 3; day++) {
      tickWorld(world, TICKS_PER_DAY);
    }
    expect(offeredContracts(world)).toHaveLength(0);
  });

  // T06-08b (review T06-07, minor 2): kniha bez šablóny pre tier 0 ostáva `untouched` (žiadne id) — pool sa predtým
  // pokúšal doplniť v každom ticku. Po prvom neúspešnom pokuse sa ďalší pokus robí len pri `DayClosed`.
  it('šablóny s minTier 1 pri tier 0: pool sa nedopĺňa v každom ticku, len pri DayClosed; save/load priebeh nemení', () => {
    const defs = defsWith({ templates: DEFS.contractTemplates.items.map((template) => ({ ...template, minTier: 1 })) });
    const world = worldWithPool(defs, 5005);
    const attempts = vi.spyOn(world.contractBook, 'tier');
    const withinDay = TICKS_PER_DAY - world.clock.tick - 1;
    tickWorld(world, withinDay);
    expect(attempts).toHaveBeenCalledTimes(0);
    tickWorld(world, 1);
    expect(world.clock.tick % TICKS_PER_DAY).toBe(0);
    expect(attempts).toHaveBeenCalledTimes(1);
    // Obnova: prvý tick po načítaní skúsi pool znova (no-op bez `Rng`) — pokračovanie je zhodné s pôvodným svetom.
    const restored = World.deserialize(defs, MAP, JSON.parse(JSON.stringify(world.serialize())) as WorldState);
    tickWorld(world, TICKS_PER_DAY);
    tickWorld(restored, TICKS_PER_DAY);
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
    expect(offeredContracts(restored)).toHaveLength(0);
  });
});

describe('pool: doplnenie pri DayClosed a objem podľa kapacity prístavu', () => {
  const DECLINED = 3;

  it('odmietnuté ponuky sa dopĺňajú až pri DayClosed, na offersPerDay, s objemom podľa capacityHint (dvory zvýšia hint)', () => {
    const world = World.create(DEFS, MAP, 5301);
    const run = new Run5(world, portScenario('f5_pool_refill', 5301));
    run.runTo(100);
    const firstBatch = offeredContracts(world).map((offer) => offer.id);
    expect(firstBatch).toHaveLength(OFFERS);
    const declinedIds = firstBatch.slice(0, DECLINED);
    for (const id of declinedIds) run.send(declineContract(id));
    run.runTo(TICKS_PER_DAY - 1);

    // Odmietnuté ponuky sú preč (expired alebo odstránené), ostatné ostali a nič sa zatiaľ nedoplnilo.
    for (const id of declinedIds) expect(['expired', 'removed'], `ponuka ${String(id)}`).toContain(stateOfContract(world, id));
    expect(offeredContracts(world)).toHaveLength(OFFERS - DECLINED);
    const offeredBefore = run.of('ContractOffered').filter((entry) => entry.tick > 100);
    expect(offeredBefore).toEqual([]);

    run.runTo(TICKS_PER_DAY);
    const refill = run.of('ContractOffered').filter((entry) => entry.tick >= TICKS_PER_DAY);
    expect(refill.map((entry) => entry.tick)).toEqual(Array<number>(DECLINED).fill(TICKS_PER_DAY));
    expect(offeredContracts(world)).toHaveLength(OFFERS);

    const hint = capacityHintOf(world);
    expect(hint).toBe(128);
    for (const entry of refill) {
      const offer = contractById(world, entry.event.contractId);
      const bounds = volumeBounds(offer.templateId, hint);
      expect(offer.volumeTeu, offer.templateId).toBeGreaterThanOrEqual(bounds.min);
      expect(offer.volumeTeu, offer.templateId).toBeLessThanOrEqual(bounds.max);
      expect(firstBatch).not.toContain(offer.id);
    }
    expect(run.violations).toEqual([]);
    expect(run.ticksChecked).toBe(world.clock.tick);
  });
});

describe('pool: expirácia', () => {
  it('nevybraná ponuka expiruje po offerExpiryDays: ContractExpired(timeout) v okne [offerExpiresTick, +1 deň), offered → expired', () => {
    const world = World.create(DEFS, MAP, 5302);
    const run = new Run5(world, emptyScenario('f5_pool_expiry', 5302));
    run.runTo(1);
    const initial = offeredContracts(world).map((offer) => ({ id: offer.id, expires: offer.offerExpiresTick }));
    expect(initial).toHaveLength(OFFERS);
    run.runTo(4 * TICKS_PER_DAY);

    const expired = run.of('ContractExpired');
    for (const { id, expires } of initial) {
      const events = expired.filter((entry) => entry.event.contractId === id);
      expect(events, `ponuka ${String(id)}`).toHaveLength(1);
      expect(events[0].event.reason).toBe('timeout');
      expect(events[0].tick).toBeGreaterThanOrEqual(expires);
      expect(events[0].tick).toBeLessThan(expires + TICKS_PER_DAY);
      expect(['expired', 'removed']).toContain(stateOfContract(world, id));
      const changes = events5(run.events, 'ContractStateChanged').filter((entry) => entry.event.contractId === id);
      expect(changes.map((entry) => `${entry.event.from}>${entry.event.to}`)).toEqual(['offered>expired']);
    }
    expect(run.violations).toEqual([]);
  });

  it('nové ponuky vznikajú len pri DayClosed (násobky ticksPerDay) a pool nikdy nepresiahne offersPerDay ani po expirácii', () => {
    const world = World.create(DEFS, MAP, 5303);
    let maxOffered = 0;
    const run = new Run5(world, emptyScenario('f5_pool_cadence', 5303), {
      onTick: () => {
        maxOffered = Math.max(maxOffered, offeredContracts(world).length);
      },
    });
    run.runTo(6 * TICKS_PER_DAY);
    const offered = run.of('ContractOffered').filter((entry) => entry.tick > 1);
    expect(offered.length).toBeGreaterThan(0);
    for (const entry of offered) expect(entry.tick % TICKS_PER_DAY, `ponuka ${String(entry.event.contractId)} v ticku ${String(entry.tick)}`).toBe(0);
    expect(maxOffered).toBeLessThanOrEqual(OFFERS);
    expect(run.violationsOf('pool_size')).toEqual([]);
  });
});

describe('pool: šablóny a tier', () => {
  /** Každý deň odmietne všetky ponuky (pool sa dopĺňa a losuje nanovo) a zbiera šablóny nových ponúk. */
  function drawTemplates(world: World, days: number, seed: number): Map<string, number> {
    const seen = new Map<string, number>();
    const run = new Run5(world, emptyScenario('f5_pool_draw', seed), {
      onTick: (self, tickEvents) => {
        if (tickEvents.some((event) => event.type === 'DayClosed')) {
          for (const offer of offeredContracts(world)) self.send(declineContract(offer.id));
        }
        for (const id of offeredIdsOf(tickEvents)) {
          const template = contractById(world, id).templateId;
          seen.set(template, (seen.get(template) ?? 0) + 1);
        }
      },
    });
    run.runTo(days * TICKS_PER_DAY);
    expect(run.violations).toEqual([]);
    return seen;
  }

  it('tier 0 za 30 dní odmietaných ponúk: ponúkajú sa obe feeder šablóny, nikdy handy (minTier 1)', () => {
    const seen = drawTemplates(World.create(DEFS, MAP, 5304), 30, 5304);
    expect(seen.get('container_feeder_express') ?? 0).toBeGreaterThan(0);
    expect(seen.get('container_feeder_standard') ?? 0).toBeGreaterThan(0);
    expect(seen.get('container_handy_run') ?? 0).toBe(0);
  }, LONG_TIMEOUT_MS);

  it('tier 1 (10 dokončených kontraktov v uloženom stave): odomkne sa aj handy run a ponuka má loď handy', () => {
    const seed = 5305;
    const base = worldWithPool(DEFS, seed);
    const state = JSON.parse(JSON.stringify(base.serialize())) as Record<string, unknown>;
    expect(state, 'WorldState v5 nemá kľúč completedContracts (rozhodnutie 11)').toHaveProperty('completedContracts');
    state['completedContracts'] = DEFS.economy.contractsPerTier;
    const world = World.deserialize(DEFS, MAP, state as unknown as WorldState);
    expect(completedOf(world)).toBe(DEFS.economy.contractsPerTier);
    expect(tierOf(world)).toBe(1);

    const seen = drawTemplates(world, 30, seed);
    expect(seen.get('container_handy_run') ?? 0).toBeGreaterThan(0);
    expect(seen.get('container_feeder_standard') ?? 0).toBeGreaterThan(0);
    expect(tierOf(world)).toBe(1);
  }, LONG_TIMEOUT_MS);

  it('váhový výber: dve šablóny s váhou 1 a 9 dávajú v 60 ponukách častejšie šablónu s váhou 9', () => {
    const light: TemplateRaw = { id: 'light', cargoTypeId: 'container_teu', volumeUnitsRange: [12, 12], slaDaysRange: [2, 2], shipClassIds: ['feeder'], weight: 1, minTier: 0 };
    const heavy: TemplateRaw = { ...light, id: 'heavy', weight: 9 };
    const seen = drawTemplates(World.create(defsWith({ templates: [light, heavy] }), MAP, 5306), 10, 5306);
    expect(seen.get('heavy') ?? 0).toBeGreaterThan(seen.get('light') ?? 0);
  }, LONG_TIMEOUT_MS);

  it('findSeed: pomocník nájde seed, kde pool obsahuje obe šablóny (kontrola pomocníka pre ostatné testy)', () => {
    const seed = findSeed(
      (s) => World.create(DEFS, MAP, s),
      (world) => new Set(offeredContracts(world).map((offer) => offer.templateId)).size === 2,
    );
    const world = worldWithPool(DEFS, seed);
    expect(new Set(offeredContracts(world).map((offer) => offer.templateId)).size).toBe(2);
    expect(must(offeredContracts(world)[0], 'prvá ponuka').state).toBe('offered');
  });
});
