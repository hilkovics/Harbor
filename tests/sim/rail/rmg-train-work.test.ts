// RMG a práca s vlakom (TR6-02, ADR-043 dodatok): `RmgCrane` (poloha, priority), nakládka po vagónoch od lokomotívy, vykládka exportu do bufferu pred nakládkou, odchod plného vlaka pred plánom,
// striedanie vlaka a ťahača, železničný import (`isRailImportUnit`, reefer a OOG nejdú vlakom) a plánovač (železničná jednotka najprv do bufferu, kamión ju nevezme), save uprostred cyklu s vlakom.
import { describe, expect, it } from 'vitest';
import { ImportContract } from '@sim/contracts';
import type { CargoUnitLabelsInput } from '@sim/cargo';
import type { ContractId, EntityId } from '@sim/core';
import { forEachPickupCandidate, isRailBound, isRailImportUnit, railTerminalTakes } from '@sim/logistics';
import { chooseSlotInBlock } from '@sim/logistics/yard-planner';
import { LANE_ROW, RmgCrane, RtgCrane, trackRow } from '@sim/machines';
import { trainSlotMap, wagonFillTeu } from '@sim/rail';
import { serveQueueFirst, trainSlotBay } from '@sim/systems/rmg-train-work';
import { World, stateHash } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { TICKS_PER_DAY } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { railWorld } from '../helpers/r6-rail';
import { EXPORT_CONTRACT, EXPORT_LABELS, TEU } from '../cargo/cargo-fixtures';

function importContract(world: World, railShareBp: number): ImportContract {
  const book = world.contractBook;
  const tick = world.clock.tick;
  const contract = new ImportContract({
    slaDays: 5, rewardCents: 1_000_000, xpReward: 1, offeredTick: tick, offerExpiresTick: tick + 2 * TICKS_PER_DAY, shipClassId: 'feeder', cargoTypeId: TEU, lineId: 'blue_anchor',
    id: book.allocateId(), voyageId: book.allocateVoyageId(), templateId: 'container_feeder_standard', volumeUnits: 40, volumeTeu: 40, railShareBp,
  });
  book.add(contract);
  return contract;
}

/** Nová jednotka importu na lodi a v žeriave (jediný povolený vznik importu: `on_ship`, potom `in_crane`). */
function newImport(world: World, contractId: ContractId | null, labels: CargoUnitLabelsInput): ReturnType<World['cargo']['create']> {
  const unit = world.cargo.create(TEU, { kind: 'on_ship', shipId: 901 as EntityId }, contractId, labels);
  world.cargo.move(unit.id, { kind: 'in_crane', craneId: 900 as EntityId });
  return unit;
}

/** Uloží import do bufferu terminálu tak, ako by ho uložil ťahač s RMG (ledger `in_crane → in_vehicle → in_storage`, rezervácia, `commit`). */
function putImport(world: World, contract: ImportContract | null, sizeFt: 20 | 40 = 20, extra: Partial<CargoUnitLabelsInput> = {}): EntityId {
  const terminal = [...world.modules.values()].find((module) => module.def.id === 'rmg_rail_block') as never as { id: EntityId; reserveFor(slot: number, unit: { id: EntityId; sizeFt: 20 | 40 }): void; commit(slot: number, id: EntityId): void };
  const labels: CargoUnitLabelsInput = { direction: 'import', voyageId: contract?.voyageId ?? null, lineId: contract === null ? null : 'blue_anchor', destinationPort: null, weightClass: 'medium', sizeFt, ...extra };
  const unit = newImport(world, contract?.id ?? null, labels);
  const slot = chooseSlotInBlock(world, world.modules.get(terminal.id) as never, unit) ?? (() => { throw new Error('buffer nemá miesto'); })();
  terminal.reserveFor(slot, unit);
  world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
  world.cargo.move(unit.id, { kind: 'in_storage', moduleId: terminal.id, slot });
  terminal.commit(slot, unit.id);
  return unit.id;
}

function runUntil(world: World, done: (world: World) => boolean, maxTicks: number): void {
  for (let i = 0; i < maxTicks && !done(world); i++) {
    world.tick();
    expect(findWorldViolation(world)).toBeUndefined();
  }
  expect(done(world), 'podmienka sa nesplnila v limite').toBe(true);
}

const dwellingTrain = (world: World) => [...world.trains.values()].find((train) => train.state === 'dwelling');

describe('RmgCrane', () => {
  it('je RtgCrane s defom `rmg`: pozícia, priorita vlaka pred ťahačom a housekeepingom, riadky koľají pod pruhom', () => {
    const { world, terminal } = railWorld();
    const machine = world.machineOfBlock(terminal.id);
    expect(machine).toBeInstanceOf(RmgCrane);
    expect(machine).toBeInstanceOf(RtgCrane);
    const rmg = machine as RmgCrane;
    expect(rmg.defId).toBe('rmg');
    expect(rmg.trainPriority).toBe(world.defs.equipment.rmg.priorities.train);
    expect(rmg.trainPriority).toBeLessThan(rmg.priorityOf('ship'));
    expect(rmg.priorityOf('ship')).toBeLessThan(rmg.priorityOf('housekeeping'));
    expect(rmg.poseNow()).toEqual({ gantry: 0, trolley: LANE_ROW, hoist: terminal.geometry.maxTier });
    expect([trackRow(0), trackRow(1)]).toEqual([-2, -3]);
  });

  it('poloha miesta vo vlaku: čelo lokomotívy na konci koľaje, jedno TEU = jeden bay, 40′ medzi dvoma bayami', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 0 } });
    runUntil(world, (w) => dwellingTrain(w) !== undefined, 2000);
    const train = dwellingTrain(world)!;
    expect(trainSlotBay(train, 16, 0, 1)).toBe(12);
    expect(trainSlotBay(train, 16, 11, 1)).toBe(1);
    expect(trainSlotBay(train, 16, 3, 2)).toBe(8.5);
    expect(trainSlotBay(train, 16, 40, 1)).toBe(0);
  });

  it('striedanie: čakajúci ťahač je na rade po nepárnom počte hotových cyklov, bez ťahača nikdy', () => {
    const stub = (queue: number, moves: number): RmgCrane => ({ queue: Array<number>(queue).fill(1), moves }) as unknown as RmgCrane;
    expect([serveQueueFirst(stub(0, 0)), serveQueueFirst(stub(1, 0)), serveQueueFirst(stub(1, 1)), serveQueueFirst(stub(1, 2)), serveQueueFirst(stub(0, 1))]).toEqual([false, false, true, false, false]);
  });
});

describe('nakládka po vagónoch a vykládka', () => {
  it('import z bufferu sa nakladá po celých vagónoch od lokomotívy (4× 20′ + 40′ + 20′ = [3, 3, 1, 0]), bez medzier', () => {
    const { world, terminal } = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 600 } });
    const contract = importContract(world, 10_000);
    const sizes: (20 | 40)[] = [20, 20, 20, 20, 40, 20];
    const ids = sizes.map((size) => putImport(world, contract, size));
    expect(ids).toHaveLength(6);
    const order: number[] = [];
    runUntil(world, (w) => {
      for (const train of w.trains.values()) {
        for (const unitId of w.cargo.unitsAt('in_train', train.id)) if (!order.includes(unitId)) order.push(unitId);
      }
      return order.length === sizes.length && (dwellingTrain(w)?.state === 'dwelling' ? w.machineOfBlock(terminal.id)?.state === 'idle' : false);
    }, 4000);
    const train = dwellingTrain(world)!;
    expect(wagonFillTeu(world.cargo, train)).toEqual([3, 3, 1, 0]);
    expect(trainSlotMap(world.cargo, train).slice(0, 8)).toEqual([true, true, true, true, true, true, true, false]);
    assertCargoConservation(world);
  });

  it('export z vlaka sa vyloží do bufferu skôr, než sa nakladá import; vlak odíde až po vykládke', () => {
    const { world, terminal } = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 30 } });
    const contract = importContract(world, 10_000);
    const imports = [putImport(world, contract), putImport(world, contract)];
    runUntil(world, (w) => dwellingTrain(w) !== undefined, 2000);
    const train = dwellingTrain(world)!;
    const exportUnit = world.cargo.create(TEU, { kind: 'in_train', trainId: train.id, slot: 11 }, EXPORT_CONTRACT, EXPORT_LABELS);
    // Vykládka (in_train → in_storage) predchádza nakládke: v okamihu, keď je prvý import vo vlaku, je export už v bufferi.
    let unloadedFirst = false;
    runUntil(world, (w) => {
      const loaded = imports.some((id) => w.cargo.get(id)?.location.kind === 'in_train');
      if (loaded) unloadedFirst = w.cargo.get(exportUnit.id)?.location.kind === 'in_storage';
      return imports.every((id) => w.cargo.get(id)?.location.kind === 'in_train');
    }, 1500);
    expect(unloadedFirst).toBe(true);
    expect(world.cargo.get(exportUnit.id)?.location).toMatchObject({ kind: 'in_storage', moduleId: terminal.id });
    runUntil(world, (w) => w.rail.counters.trainsDeparted === 1, 1500);
    expect(world.cargo.exportedCount).toBe(2);
    expect(world.cargo.get(exportUnit.id)?.location.kind).toBe('in_storage');
  });

  it('plný vlak (4 vagóny = 12 TEU) odíde pred koncom plánovaného pobytu', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 600 } });
    const contract = importContract(world, 10_000);
    for (let i = 0; i < 14; i++) putImport(world, contract);
    runUntil(world, (w) => w.rail.counters.trainsDeparted === 1, 4000);
    expect(world.cargo.exportedCount).toBe(12);
    expect(world.rail.counters.turnaroundTicksMax).toBeLessThan(600 * 6);
    expect(world.cargo.liveCount).toBe(2);
  });

  it('save uprostred cyklu s vlakom: obnovený svet pokračuje bit po bite rovnako', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 120 } });
    // Jednotky bez kontraktu (obnova save by pri ponuke bez nákladu odmietla kontrakt); RMG nakladá každý import z bufferu.
    for (let i = 0; i < 5; i++) putImport(world, null);
    runUntil(world, (w) => [...w.machines.values()].some((machine) => machine.cycle?.trainId !== undefined && machine.state === 'shift'), 4000);
    const saved = JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>;
    const copy = World.deserialize(world.defs, world.map, saved, { checkInvariants: true });
    expect(stateHash(copy)).toBe(stateHash(world));
    for (let i = 0; i < 1500; i++) {
      world.tick();
      copy.tick();
    }
    expect(stateHash(copy)).toBe(stateHash(world));
    expect(world.rail.counters.trainsDeparted).toBeGreaterThanOrEqual(1);
    assertCargoConservation(copy);
  });
});

describe('železničný import a plánovač', () => {
  it('podiel: hash id dáva ≈ railShareBp; reefer, OOG, jednotka bez kontraktu a podiel 0 nejdú vlakom', () => {
    const { world } = railWorld();
    const contract = importContract(world, 3000);
    let rail = 0;
    const total = 400;
    for (let i = 0; i < total; i++) {
      const unit = newImport(world, contract.id, { direction: 'import', voyageId: contract.voyageId, lineId: 'blue_anchor', destinationPort: null, weightClass: 'medium' });
      if (isRailImportUnit(world, unit)) rail += 1;
    }
    expect(rail).toBeGreaterThan(total * 0.3 - 40);
    expect(rail).toBeLessThan(total * 0.3 + 40);
    const all = importContract(world, 10_000);
    const reefer = newImport(world, all.id, { direction: 'import', voyageId: all.voyageId, lineId: 'blue_anchor', destinationPort: null, weightClass: 'medium', containerType: 'reefer' });
    const oog = newImport(world, all.id, { direction: 'import', voyageId: all.voyageId, lineId: 'blue_anchor', destinationPort: null, weightClass: 'medium', containerType: 'flat_rack', oog: true });
    const dry = newImport(world, all.id, { direction: 'import', voyageId: all.voyageId, lineId: 'blue_anchor', destinationPort: null, weightClass: 'medium' });
    const none = newImport(world, null, { direction: 'import', voyageId: null, lineId: null, destinationPort: null, weightClass: 'medium' });
    expect([isRailImportUnit(world, reefer), isRailImportUnit(world, oog), isRailImportUnit(world, dry), isRailImportUnit(world, none)]).toEqual([false, false, true, false]);
    const zero = importContract(world, 0);
    const zeroUnit = newImport(world, zero.id, { direction: 'import', voyageId: zero.voyageId, lineId: 'blue_anchor', destinationPort: null, weightClass: 'medium' });
    expect(isRailImportUnit(world, zeroUnit)).toBe(false);
  });

  it('plánovač: železničný import ide do bufferu terminálu, ostatné jednotky nie; export len z vlaka terminálu', () => {
    const { world, terminal } = railWorld();
    const all = importContract(world, 10_000);
    const none = importContract(world, 0);
    const railUnit = newImport(world, all.id, { direction: 'import', voyageId: all.voyageId, lineId: 'blue_anchor', destinationPort: null, weightClass: 'medium' });
    const plainUnit = newImport(world, none.id, { direction: 'import', voyageId: none.voyageId, lineId: 'blue_anchor', destinationPort: null, weightClass: 'medium' });
    const exportUnit = world.cargo.create(TEU, { kind: 'in_truck', truckId: 800 as EntityId }, EXPORT_CONTRACT, EXPORT_LABELS);
    expect(railTerminalTakes(world, terminal, railUnit, terminal)).toBe(true);
    expect(railTerminalTakes(world, terminal, plainUnit, terminal)).toBe(false);
    // Export patrí do bufferu len z vlaka tohto terminálu (zdroj = terminál), nie z brány alebo iného modulu.
    expect(railTerminalTakes(world, terminal, exportUnit, terminal)).toBe(true);
    const other = { ...terminal } as never;
    expect(railTerminalTakes(world, terminal, exportUnit, other)).toBe(false);
    expect(chooseSlotInBlock(world, terminal, railUnit)).not.toBeNull();
  });

  it('kamión nevezme import z bufferu terminálu, kým je železničná služba; bez služby ho vezme', () => {
    const { world, terminal } = railWorld({ timetable: { firstArrivalHour: 100 } });
    const unitId = putImport(world, null);
    const unit = world.cargo.get(unitId)!;
    expect(isRailBound(world, unit)).toBe(true);
    const visited: EntityId[] = [];
    forEachPickupCandidate(world, (candidate) => (visited.push(candidate.id), true));
    expect(visited).toEqual([]);
    // Bez železničnej služby (koľaj odstránená) sa jednotka správa ako bežná: kamión ju smie vziať.
    const cells = [...world.rail.crossings];
    expect(cells).toEqual([]);
    world.grid.at(95, 51).road = 'none';
    world.markRoadsChanged();
    expect(world.hasRailService).toBe(false);
    expect(isRailBound(world, unit)).toBe(false);
    forEachPickupCandidate(world, (candidate) => (visited.push(candidate.id), true));
    expect(visited).toEqual([unitId]);
    expect(terminal.id).toBeGreaterThan(0);
  });
});

