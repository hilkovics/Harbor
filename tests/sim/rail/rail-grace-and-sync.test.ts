// TR6-02c (ADR-043 dodatok): (1) sloty priecestí na konci ticku sú pevný bod `syncAllCrossings` → obnova save je bit-presná aj tesne pred priecestím, (2) rešpitná lehota odchodu
// (`departGraceMinutes`): vlak s nevyloženým nákladom z príchodu neviaže koľaj donekonečna, (3) mapa miest `findTrainSlot` a indexy priecestí na trase dávajú rovnaké výsledky ako priamy výpočet.
import { describe, expect, it } from 'vitest';
import { findTrainSlot, syncAllCrossings, trainSlotMap, wagonFillTeu } from '@sim/rail';
import { slotKey } from '@sim/traffic';
import { World } from '@sim/world';
import { ExportContract } from '@sim/contracts';
import { acceptUnchecked, send, TICKS_PER_DAY } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { stateHash } from '../helpers/scenario';
import { railWorld } from '../helpers/r6-rail';

const CROSSING_X = 92;

function holders(world: World, cell: number): number[] {
  return [0, 1].map((lane) => world.laneSlots.holderOfKey(slotKey(cell, lane)));
}

function clone(world: World): World {
  return World.deserialize(world.defs, world.map, JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>);
}

describe('priecestie: stav slotov a obnova save', () => {
  it('na konci každého ticku je stav slotov pevný bod syncAllCrossings; kópia zo save má rovnaké sloty aj hash a ďalší beh je zhodný', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 2 } });
    send(world, { type: 'PlaceRoad', cells: [50, 51, 52].map((y) => ({ x: CROSSING_X, y })) });
    const cell = world.grid.index(CROSSING_X, 51);
    expect(world.rail.isCrossing(cell)).toBe(true);
    let sawClosed = false;
    for (let i = 0; i < 80; i++) {
      world.tick();
      const before = holders(world, cell);
      if (before.some((holder) => world.trains.has(holder as never))) sawClosed = true;
      syncAllCrossings(world);
      expect(holders(world, cell), `tick ${String(world.clock.tick)}`).toEqual(before);
      const copy = clone(world);
      expect(holders(copy, cell), `kópia, tick ${String(world.clock.tick)}`).toEqual(before);
      expect(stateHash(copy)).toBe(stateHash(world));
      if (i % 9 === 0) {
        for (let k = 0; k < 4; k++) {
          world.tick();
          copy.tick();
        }
        expect(stateHash(copy)).toBe(stateHash(world));
        expect(holders(copy, cell)).toEqual(holders(world, cell));
      }
    }
    expect(sawClosed).toBe(true);
  });
});

function railBooking(world: World, units: number): ExportContract {
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
    railShareBp: 10_000,
  });
  book.add(contract);
  acceptUnchecked(world, contract.id);
  return contract;
}

describe('rešpitná lehota odchodu vlaka', () => {
  it('nevyložený náklad z príchodu po lehote neviaže koľaj: vlak odíde, `undeliveredUnits` ho spočíta, ledger drží `exported`, nič sa nestratí', () => {
    // Pobyt 1 min + lehota 1 min = 12 tickov: RMG (vykládka 4 kontajnerov trvá stovky tickov) nestihne vyložiť.
    const { world, terminal } = railWorld({ timetable: { firstArrivalHour: 31, intervalHours: 4, dwellMinutes: 1, departGraceMinutes: 1 } });
    railBooking(world, 4);
    let departed: { units: number; undeliveredUnits: number } | undefined;
    for (let i = 0; i < 11_200 + 1500 && departed === undefined; i++) {
      for (const event of world.tick()) if (event.type === 'TrainDeparted') departed = { units: event.units, undeliveredUnits: event.undeliveredUnits };
      assertCargoConservation(world);
    }
    expect(departed).toBeDefined();
    expect(departed?.undeliveredUnits).toBeGreaterThan(0);
    expect(departed?.units).toBeGreaterThanOrEqual(departed?.undeliveredUnits ?? 0);
    expect(world.trains.size).toBe(0);
    expect(world.cargo.exportedCount).toBe(departed?.units);
    expect(world.cargo.countAt('in_storage', terminal.id) + (departed?.units ?? 0)).toBeGreaterThanOrEqual(1);
    expect(world.rail.trackTaken(terminal.id, 0)).toBe(false);
  });

  it('predvolená lehota (30 min) nevyloženého vlaka nepustí hneď po plánovanom odchode: RMG stihne vyložiť, undelivered 0', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 31, intervalHours: 4, dwellMinutes: 30 } });
    railBooking(world, 4);
    let undelivered = -1;
    for (let i = 0; i < 11_200 + 2500 && undelivered < 0; i++) {
      for (const event of world.tick()) if (event.type === 'TrainDeparted') undelivered = event.undeliveredUnits;
    }
    expect(undelivered).toBe(0);
  });
});

describe('vlak: mapa miest a indexy priecestí', () => {
  it('findTrainSlot s predpočítanou mapou = bez nej; wagonFillTeu a trainSlotMap sedia', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 31, intervalHours: 4, dwellMinutes: 30 } });
    railBooking(world, 4);
    for (let i = 0; i < 11_200; i++) world.tick();
    const train = [...world.trains.values()][0];
    const taken = trainSlotMap(world.cargo, train);
    for (const teu of [1, 2]) expect(findTrainSlot(world.cargo, train, teu, taken)).toBe(findTrainSlot(world.cargo, train, teu));
    expect(wagonFillTeu(world.cargo, train).reduce((a, b) => a + b, 0)).toBe(taken.filter(Boolean).length);
  });

  it('crossingIndexes: indexy trasy s priecestím; po pribudnutí priecestia sa prepočítajú', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 0 } });
    world.tick();
    const train = [...world.trains.values()][0];
    expect(train.crossingIndexes(world.rail.crossings)).toEqual([]);
    send(world, { type: 'PlaceRoad', cells: [50, 51, 52].map((y) => ({ x: CROSSING_X, y })) });
    const cell = world.grid.index(CROSSING_X, 51);
    expect(train.crossingIndexes(world.rail.crossings)).toEqual([train.route.indexOf(cell)]);
  });
});
