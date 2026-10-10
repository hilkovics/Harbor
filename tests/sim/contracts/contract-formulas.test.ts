/**
 * Vzorce kontraktov (T05-05, TDD; „Rozhodnutia orchestrátora" 1, 5, 7, 8): odmena, urgency v bázických bodoch,
 * `xpReward`, príchod lode a SLA po prijatí, sadzby demurrage a late z odmeny. Tabuľky sú spočítané z defov ručne
 * (ceny v centoch, zaokrúhľovanie nadol) a stráži ich test defov; simulácia sa porovnáva s tabuľkou aj so vzorcom.
 *
 * Predpoklady o API:
 *  F1 `AcceptContract` nastaví okamžite (už po `applyPending()`) `acceptedTick = clock.tick`,
 *     `shipArrivalTick = acceptedTick + round(rng.range(arrivalDaysRange) × ticksPerDay)` a
 *     `slaDeadlineTick = shipArrivalTick + slaDays × ticksPerDay`, kde `slaDays` je celé číslo zo `slaDaysRange` šablóny;
 *  F2 `rewardCents` a `xpReward` sa určia pri vzniku ponuky a pri prijatí sa nemenia.
 */
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import { World } from '@sim/world';
import { must } from '../helpers/harbor';
import {
  DEFS,
  FIXED_ARRIVAL_DAYS,
  FIXED_SLA_DAYS,
  FIXED_TEMPLATE,
  FIXED_VOLUME,
  MAP,
  TICKS_PER_DAY,
  acceptContract,
  cashOf,
  contractById,
  defsWith,
  demurrageStepCents,
  expectedRewardCents,
  expectedXpGain,
  expectedXpReward,
  findSeed,
  fixedContractDefs,
  lateStepCents,
  maxSlaDaysOf,
  offeredContracts,
  rateBp,
  tickWorld,
  urgencyBp,
  worldWithPool,
  type ContractLike,
  type TemplateRaw,
} from '../helpers/f5';

/** Prijme ponuku a vráti kontrakt po `applyPending()` (bez tiku: hodiny stoja). */
function acceptNow(world: World, id: number): ContractLike {
  world.enqueue(commandFromJSON(acceptContract(id)));
  const events = world.applyPending();
  expect(events.filter((event) => event.type === 'CommandRejected'), `AcceptContract ${String(id)}`).toEqual([]);
  return contractById(world, id);
}

describe('vzorce: tabuľky z defov', () => {
  it('stráž: tabuľky nižšie platia pre bundled defy (cena TEU 450 USD, urgencyFactor 0,6, maxSla 8, demurrage 0,5 %/h, late 5 %/deň)', () => {
    expect(DEFS.cargoTypes.get('container_teu').basePricePerUnitCents).toBe(45_000);
    expect(DEFS.cargoTypes.get('container_teu').xpPerUnit).toBe(1);
    expect(DEFS.economy.urgencyFactor).toBe(0.6);
    expect(DEFS.economy.xpMultiplier).toBe(1);
    expect(DEFS.economy.lateXpFactor).toBe(0.5);
    expect(maxSlaDaysOf(DEFS)).toBe(8);
    expect(rateBp(DEFS.economy.demurrageRateOfRewardPerHour)).toBe(50);
    expect(rateBp(DEFS.economy.latePenaltyRateOfRewardPerDay)).toBe(500);
    expect(DEFS.economy.failAfterDaysLate).toBe(3);
    expect(DEFS.ships.get('feeder').berthAllowanceTicks).toBe(2 * TICKS_PER_DAY);
  });

  it.each([
    { sla: 2, bp: 14_500 },
    { sla: 3, bp: 13_750 },
    { sla: 4, bp: 13_000 },
    { sla: 5, bp: 12_250 },
    { sla: 6, bp: 11_500 },
    { sla: 7, bp: 10_750 },
    { sla: 8, bp: 10_000 },
  ])('urgency: SLA $sla dní (maxSla 8) → $bp bp', ({ sla, bp }) => {
    // 10 000 + ⌊6 000 × (8 − sla) / 8⌋
    expect(urgencyBp(sla)).toBe(bp);
  });

  it.each([
    { volume: 12, sla: 2, reward: 783_000 },
    { volume: 12, sla: 8, reward: 540_000 },
    { volume: 24, sla: 3, reward: 1_485_000 },
    { volume: 48, sla: 3, reward: 2_970_000 },
    { volume: 96, sla: 5, reward: 5_292_000 },
    { volume: 51, sla: 4, reward: 2_983_500 },
    { volume: 60, sla: 5, reward: 3_307_500 },
    { volume: 240, sla: 8, reward: 10_800_000 },
  ])('odmena: $volume TEU, SLA $sla dní → $reward centov', ({ volume, sla, reward }) => {
    // ⌊volume × 45 000 × urgencyBp / 10 000⌋
    expect(expectedRewardCents('container_teu', volume, sla)).toBe(reward);
  });

  it.each([
    { reward: 783_000, demurrage: 3_915, late: 39_150 },
    { reward: 540_000, demurrage: 2_700, late: 27_000 },
    { reward: 2_970_000, demurrage: 14_850, late: 148_500 },
    { reward: 5_292_000, demurrage: 26_460, late: 264_600 },
    { reward: 1_000_007, demurrage: 5_000, late: 50_000 },
    { reward: 199, demurrage: 0, late: 9 },
  ])('sadzby z odmeny $reward: demurrage $demurrage za hodinu (50 bp), late $late za deň (500 bp), nadol', ({ reward, demurrage, late }) => {
    expect(demurrageStepCents(reward)).toBe(demurrage);
    expect(lateStepCents(reward)).toBe(late);
  });

  it.each([
    { volume: 12, onTime: true, gain: 12 },
    { volume: 12, onTime: false, gain: 6 },
    { volume: 13, onTime: false, gain: 7 },
    { volume: 96, onTime: false, gain: 48 },
    { volume: 96, onTime: true, gain: 96 },
  ])('XP: $volume TEU, včas = $onTime → +$gain', ({ volume, onTime, gain }) => {
    const xpReward = expectedXpReward('container_teu', volume);
    expect(xpReward).toBe(volume);
    expect(expectedXpGain(xpReward, onTime)).toBe(gain);
  });
});

describe('vzorce: ponuky v poole', () => {
  it('xpReward = volumeTeu × xpPerUnit × xpMultiplier a rewardCents (objem v TEU, ADR-039) sedí s tabuľkou pre niektoré celé SLA šablóny (10 seedov)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      for (const offer of offeredContracts(worldWithPool(DEFS, seed))) {
        const template = DEFS.contractTemplates.get(offer.templateId);
        const slaChoices: number[] = [];
        for (let sla = template.slaDaysRange[0]; sla <= template.slaDaysRange[1]; sla++) slaChoices.push(sla);
        const rewards = slaChoices.map((sla) => expectedRewardCents(offer.cargoTypeId, offer.volumeTeu, sla));
        expect(rewards, `seed ${String(seed)}, ${offer.templateId}, ${String(offer.volumeTeu)} TEU`).toContain(offer.rewardCents);
        expect(offer.xpReward).toBe(offer.volumeTeu);
        expect(offer.rewardCents).toBeGreaterThan(0);
        expect(Number.isSafeInteger(offer.rewardCents)).toBe(true);
      }
    }
  });

  it('prijatie: SLA je celé číslo dní zo slaDaysRange, odmena presne podľa vzorca s týmto SLA, príchod lode 0,5 až 2 dni po prijatí', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const world = worldWithPool(DEFS, seed);
      const offer = must(offeredContracts(world)[0], 'prvá ponuka');
      const template = DEFS.contractTemplates.get(offer.templateId);
      const contract = acceptNow(world, offer.id);

      expect(contract.state).toBe('accepted');
      expect(contract.acceptedTick).toBe(world.clock.tick);
      const arrival = must(contract.shipArrivalTick, 'shipArrivalTick');
      const deadline = must(contract.slaDeadlineTick, 'slaDeadlineTick');
      const accepted = must(contract.acceptedTick, 'acceptedTick');

      const [minDays, maxDays] = DEFS.economy.arrivalDaysRange;
      expect(arrival - accepted, `seed ${String(seed)}: príchod`).toBeGreaterThanOrEqual(Math.floor(minDays * TICKS_PER_DAY) - 1);
      expect(arrival - accepted, `seed ${String(seed)}: príchod`).toBeLessThanOrEqual(Math.ceil(maxDays * TICKS_PER_DAY) + 1);

      const slaDays = (deadline - arrival) / TICKS_PER_DAY;
      expect(Number.isInteger(slaDays), `seed ${String(seed)}: SLA ${String(slaDays)} dní`).toBe(true);
      expect(slaDays).toBeGreaterThanOrEqual(template.slaDaysRange[0]);
      expect(slaDays).toBeLessThanOrEqual(template.slaDaysRange[1]);
      expect(contract.rewardCents, `seed ${String(seed)}`).toBe(expectedRewardCents(contract.cargoTypeId, contract.volumeTeu, slaDays));
    }
  });

  it('kratšie SLA = vyššia odmena za jednotku (urgency), najdlhšie SLA šablón (8 dní) dáva základnú cenu bez prirážky', () => {
    const perUnit = [2, 3, 4, 5, 6, 7, 8].map((sla) => expectedRewardCents('container_teu', 100, sla) / 100);
    for (let i = 1; i < perUnit.length; i++) expect(perUnit[i]).toBeLessThan(perUnit[i - 1]);
    expect(perUnit.at(-1)).toBe(45_000);
  });
});

describe('vzorce: deterministické defy (jedna šablóna, príchod lode presne 1 deň)', () => {
  it('urgency = 1 (maxSla 2 = SLA 2), odmena 12 × 45 000 = 540 000, xpReward 12, príchod +1 deň, SLA +2 dni po príchode', () => {
    const defs = fixedContractDefs();
    expect(urgencyBp(FIXED_SLA_DAYS, defs)).toBe(10_000);
    const world = worldWithPool(defs, 5401);
    const offers = offeredContracts(world);
    expect(offers).toHaveLength(defs.economy.offersPerDay);
    for (const offer of offers) {
      expect(offer.templateId).toBe(FIXED_TEMPLATE.id);
      expect(offer.volumeUnits).toBe(FIXED_VOLUME);
      expect(offer.rewardCents).toBe(540_000);
      expect(offer.xpReward).toBe(FIXED_VOLUME);
    }
    const contract = acceptNow(world, must(offers[0], 'ponuka').id);
    const accepted = must(contract.acceptedTick, 'acceptedTick');
    expect(must(contract.shipArrivalTick, 'shipArrivalTick') - accepted).toBeGreaterThanOrEqual(FIXED_ARRIVAL_DAYS * TICKS_PER_DAY - 1);
    expect(must(contract.shipArrivalTick, 'shipArrivalTick') - accepted).toBeLessThanOrEqual(FIXED_ARRIVAL_DAYS * TICKS_PER_DAY + 1);
    expect(must(contract.slaDeadlineTick, 'slaDeadlineTick') - must(contract.shipArrivalTick, 'shipArrivalTick')).toBe(FIXED_SLA_DAYS * TICKS_PER_DAY);
    expect(contract.rewardCents).toBe(540_000);
  });

  it('dve šablóny (SLA 2 a 6 dní, maxSla 6): urgency 14 000 bp → 12 TEU = 756 000, urgency 10 000 bp → 20 TEU = 900 000', () => {
    const fast: TemplateRaw = { ...FIXED_TEMPLATE, id: 'fast_run', slaDaysRange: [2, 2] };
    const slow: TemplateRaw = { ...FIXED_TEMPLATE, id: 'slow_run', volumeUnitsRange: [20, 20], slaDaysRange: [6, 6] };
    const defs = defsWith({ templates: [fast, slow] });
    expect(maxSlaDaysOf(defs)).toBe(6);
    expect(urgencyBp(2, defs)).toBe(14_000);
    expect(urgencyBp(6, defs)).toBe(10_000);
    const seed = findSeed(
      (s) => World.create(defs, MAP, s),
      (world) => new Set(offeredContracts(world).map((offer) => offer.templateId)).size === 2,
    );
    const world = worldWithPool(defs, seed);
    for (const offer of offeredContracts(world)) {
      if (offer.templateId === 'fast_run') expect([offer.volumeUnits, offer.rewardCents]).toEqual([12, 756_000]);
      else expect([offer.volumeUnits, offer.rewardCents]).toEqual([20, 900_000]);
    }
  });

  it('odmena a XP sa prijatím nemenia, hotovosť sa prijatím nemení a hodiny bežia ďalej (tickWorld s konzerváciou)', () => {
    const defs = fixedContractDefs();
    const world = worldWithPool(defs, 5402);
    const offer = must(offeredContracts(world)[0], 'ponuka');
    const cashBefore = cashOf(world);
    const contract = acceptNow(world, offer.id);
    expect([contract.rewardCents, contract.xpReward]).toEqual([offer.rewardCents, offer.xpReward]);
    expect(cashOf(world)).toBe(cashBefore);
    tickWorld(world, 100);
    const later = contractById(world, offer.id);
    expect([later.rewardCents, later.xpReward, later.penaltiesCents]).toEqual([540_000, 12, 0]);
    expect(later.state).toBe('accepted');
  });
});
