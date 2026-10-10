// Export po koľaji a `railShare` (TR6-01, ADR-043): podiel losuje `Rng` len pri napojenom termináli; vlak privezie splatné železničné kontajnery bookingu (vznik v `in_train`, registrácia na
// booking), vagóny sa plnia po jednom od lokomotívy a vlak s nevyloženým nákladom z príchodu neodíde.
import { describe, expect, it } from 'vitest';
import { ExportContract } from '@sim/contracts';
import type { SimEvent } from '@sim/events';
import { isRailExportIndex, trainSlotMap, wagonFillTeu } from '@sim/rail';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptUnchecked, TICKS_PER_DAY } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { railWorld, type RailDefsOptions } from '../helpers/r6-rail';
import type { World } from '@sim/world';

function railBooking(world: World, units: number, railShareBp: number): ExportContract {
  const book = world.contractBook;
  const tick = world.clock.tick;
  const contract = new ExportContract({
    slaDays: 3,
    rewardCents: 1_000_000,
    xpReward: 1,
    offeredTick: tick,
    offerExpiresTick: tick + 2 * TICKS_PER_DAY,
    shipClassId: 'feeder',
    cargoTypeId: 'container_teu',
    lineId: 'blue_anchor',
    id: book.allocateId(),
    voyageId: book.allocateVoyageId(),
    templateId: 'container_feeder_export',
    volumeUnits: units,
    volumeTeu: units,
    destinationPort: 'Hamburg',
    railShareBp,
  });
  book.add(contract);
  acceptUnchecked(world, contract.id);
  return contract;
}

/** Plán príchodov (seed 6001) leží v ticku 5837 … 11070 (12 TEU = 4 kontajnery): prvý vlak príde až po poslednom (hodina 31 = tick 11 160). */
const AFTER_PLAN: RailDefsOptions = { timetable: { firstArrivalHour: 31, intervalHours: 4, dwellMinutes: 30 } };

function tickAll(world: World, ticks: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...world.tick());
    assertCargoConservation(world);
  }
  return events;
}

describe('railShare', () => {
  it('označenie kontajnerov je rovnomerná funkcia podielu (bez Rng)', () => {
    const rail = (share: number, count: number): boolean[] => Array.from({ length: count }, (_, index) => isRailExportIndex(share, index));
    expect(rail(0, 6)).toEqual([false, false, false, false, false, false]);
    expect(rail(10_000, 3)).toEqual([true, true, true]);
    expect(rail(5_000, 6)).toEqual([false, true, false, true, false, true]);
    expect(rail(2_500, 8).filter(Boolean)).toHaveLength(2);
  });

  it('s napojeným terminálom ponuky šablón s `railShare` dostanú podiel z rozsahu šablóny; Rng ho losuje len tam', () => {
    const { world } = railWorld();
    expect(world.hasRailService).toBe(true);
    tickAll(world, 40);
    const shares = [...world.contracts.values()].map((contract) => ({ template: contract.templateId, bp: contract.railShareBp }));
    expect(shares.length).toBeGreaterThan(0);
    for (const { template, bp } of shares) {
      if (template === 'container_feeder_standard' || template === 'container_handy_run') expect(bp).toBeGreaterThanOrEqual(3000);
      if (template === 'container_feeder_standard' || template === 'container_handy_run') expect(bp).toBeLessThanOrEqual(6000);
      if (template === 'container_feeder_express') expect(bp).toBe(0);
    }
    expect(shares.some(({ bp }) => bp > 0)).toBe(true);
  });
});

describe('export po koľaji', () => {
  it('vlak privezie splatné železničné kontajnery: vznik v `in_train`, vagón po vagóne od lokomotívy, registrácia na booking; vlak ich drží (neodíde)', () => {
    const { world } = railWorld(AFTER_PLAN);
    const contract = railBooking(world, 4, 10_000);
    expect(contract.booking?.arrivalPlan).toHaveLength(4);
    const events = tickAll(world, 11_200);
    const arrived = events.filter((event) => event.type === 'TrainArrived');
    expect(arrived[0]).toMatchObject({ exportUnits: 4 });
    expect(events.filter((event) => event.type === 'TrainExportArrived')).toHaveLength(4);
    expect(contract.booking?.arrivalPlan).toEqual([]);
    expect(contract.booking?.arrivedUnits).toBe(4);
    const train = [...world.trains.values()][0];
    expect(world.cargo.countAt('in_train', train.id)).toBe(4);
    expect(wagonFillTeu(world.cargo, train)).toEqual([3, 1, 0, 0]);
    expect(trainSlotMap(world.cargo, train).slice(0, 5)).toEqual([true, true, true, true, false]);
    expect(findWorldViolation(world)).toBeUndefined();
    // Nevyložený export vlak drží aj po plánovanom pobyte.
    tickAll(world, 1200);
    expect(train.state).toBe('dwelling');
    expect(world.rail.counters.trainsDeparted).toBe(0);
  });

  it('vlak vezie len toľko, koľko sa zmestí; zvyšok počká na ďalší vlak', () => {
    const { world } = railWorld({ timetable: { ...AFTER_PLAN.timetable, wagonsPerTrain: 1 }, train: { wagonTeu: 2 } });
    railBooking(world, 4, 10_000);
    const events = tickAll(world, 11_200);
    expect(events.find((event) => event.type === 'TrainArrived')).toMatchObject({ exportUnits: 2 });
    const contract = [...world.contracts.values()][0];
    expect(contract.booking?.arrivalPlan).toHaveLength(2);
  });

  it('podiel 0 → žiadny kontajner nejde vlakom (vlak príde prázdny a odíde)', () => {
    const { world } = railWorld(AFTER_PLAN);
    railBooking(world, 4, 0);
    const events = tickAll(world, 11_200 + 1500);
    expect(events.find((event) => event.type === 'TrainArrived')).toMatchObject({ exportUnits: 0 });
    expect(events.find((event) => event.type === 'TrainDeparted')).toMatchObject({ units: 0 });
  });
});
