/**
 * Prijatie exportu do skladu (F6a, T6A-04, ADR-032 bod 8): job `at_ramp → in_storage` pre jednotky vyložené kamiónom,
 * zoskupenie podľa voyage, náklad na odvoz vs. export na prijatie na docku (`isPickupCargo`), index zadržaných jednotiek
 * a invarianty kroku 12 pre export (rezervácie docku vykladajúcimi kamiónmi, pool po skupinách, index hold).
 */
import { describe, expect, it } from 'vitest';
import type { CargoUnit } from '@sim/cargo/cargo-unit';
import { HoldIndex } from '@sim/cargo/hold-index';
import type { ContractId, EntityId } from '@sim/core';
import { createExportJobs } from '@sim/logistics/dispatcher';
import { isPickupCargo } from '@sim/logistics/dock-cargo';
import { allocateExportStorage } from '@sim/logistics/export-intake';
import { LoadingRamp, StorageModule } from '@sim/modules';
import { TransportJob } from '@sim/logistics';
import type { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { TICKS_PER_DAY, acceptedBooking, exportUnitIds, exportUnitsByLocation, exportWorld, f6aDefs, lostUnits, offerBooking, startLoading, tickEvents, tickUntil } from '../helpers/f6a';
import type { ExportContract } from '@sim/contracts';
import { itR1Interim } from '../helpers/r1-interim';

const LABELS = (contract: ExportContract) => ({ direction: 'export' as const, voyageId: contract.voyageId, lineId: contract.lineId, destinationPort: contract.booking.destinationPort, weightClass: 'medium' as const });

const yardsOf = (world: World): StorageModule[] => [...world.modules.values()].filter((module): module is StorageModule => module instanceof StorageModule);
const storageOf = (world: World, job: TransportJob): StorageModule => world.modules.get(job.toModuleId) as StorageModule;
const rampOf = (world: World): LoadingRamp => [...world.modules.values()].find((module): module is LoadingRamp => module instanceof LoadingRamp) as LoadingRamp;

/** Export jednotka `at_ramp` (dock 0) pre kontrakt — ako po vykládke kamiónom (fiktívny držiteľ `in_truck`). */
function unitAtRamp(world: World, contract: ExportContract, dock = 0): EntityId {
  const unit = world.cargo.create('container_teu', { kind: 'in_truck', truckId: 900 as EntityId }, contract.id, LABELS(contract));
  world.cargo.move(unit.id, { kind: 'at_ramp', rampId: rampOf(world).id, dock });
  return unit.id;
}

/** Export jednotka uložená v sklade `storage` (cez fiktívne vozidlo) — voyage už v ňom leží. */
function unitInStorage(world: World, contract: ExportContract, storage: StorageModule, slot: number): EntityId {
  const id = unitAtRamp(world, contract, 1);
  world.cargo.move(id, { kind: 'in_vehicle', vehicleId: 901 as EntityId });
  world.cargo.move(id, { kind: 'in_storage', moduleId: storage.id, slot });
  return id;
}

describe('zoskupenie exportu podľa voyage', () => {
  it('bez jednotiek voyage v sklade ide jednotka do najbližšieho skladu od rampy (rampa je pri ďalekom dvore)', () => {
    const world = exportWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 4 });
    const unit = world.cargo.get(unitAtRamp(world, exportContract)) as CargoUnit;
    const [near, far] = yardsOf(world);
    const chosen = allocateExportStorage(world, rampOf(world), unit, 'container');
    expect(chosen?.id).toBe(far.id);
    expect(near.id).not.toBe(far.id);
  });

  it('sklad, v ktorom už leží jednotka voyage, má prednosť pred najbližším skladom', () => {
    const world = exportWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 4 });
    const [near, far] = yardsOf(world);
    unitInStorage(world, exportContract, near, 0);
    const unit = world.cargo.get(unitAtRamp(world, exportContract)) as CargoUnit;
    expect(allocateExportStorage(world, rampOf(world), unit, 'container')?.id).toBe(near.id);
    // Iná voyage (iný booking) toto zoskupenie nezdedí — ide do najbližšieho.
    const other = acceptedBooking(world, { kind: 'export', booked: 4 }).exportContract;
    const otherUnit = world.cargo.get(unitAtRamp(world, other, 1)) as CargoUnit;
    expect(allocateExportStorage(world, rampOf(world), otherUnit, 'container')?.id).toBe(far.id);
  });

  it('job do skladu voyage, ktorý ešte nemá uloženú jednotku (job v lete), tiež zoskupuje', () => {
    const world = exportWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 4 });
    const [near] = yardsOf(world);
    const first = unitAtRamp(world, exportContract);
    const slot = near.reserve();
    world.addJob(new TransportJob({ id: world.ids.next(), unitIds: [first], from: world.cargo.get(first)!.location, to: { kind: 'in_storage', moduleId: near.id, slot }, createdTick: 0 }));
    const second = world.cargo.get(unitAtRamp(world, exportContract, 1)) as CargoUnit;
    expect(allocateExportStorage(world, rampOf(world), second, 'container')?.id).toBe(near.id);
  });

  it('plný sklad voyage sa preskočí: najbližší sklad s voľným miestom', () => {
    const defs = f6aDefs({ moduleParams: { container_yard_small: { capacityUnits: 1 } } });
    const world = exportWorld({ defs, vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 4 });
    const [near, far] = yardsOf(world);
    unitInStorage(world, exportContract, near, 0);
    const unit = world.cargo.get(unitAtRamp(world, exportContract)) as CargoUnit;
    expect(near.freeCount).toBe(0);
    expect(allocateExportStorage(world, rampOf(world), unit, 'container')?.id).toBe(far.id);
  });

  it('bez voľného skladu job nevznikne a jednotka čaká na docku', () => {
    const defs = f6aDefs({ moduleParams: { container_yard_small: { capacityUnits: 1 } } });
    const world = exportWorld({ defs, vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 4 });
    const [near, far] = yardsOf(world);
    unitInStorage(world, exportContract, near, 0);
    unitInStorage(world, exportContract, far, 0);
    unitAtRamp(world, exportContract);
    expect(createExportJobs(world)).toBe(0);
    expect(world.jobs.size).toBe(0);
  });

  it('createExportJobs: jeden job na jednotku exportu na prijatie, slot rezervovaný, FIFO a bez duplicity (druhé volanie nič)', () => {
    const world = exportWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 4 });
    const a = unitAtRamp(world, exportContract, 0);
    const b = unitAtRamp(world, exportContract, 1);
    expect(createExportJobs(world)).toBe(2);
    expect([...world.jobs.values()].map((job) => job.unitIds[0])).toEqual([a, b]);
    for (const job of world.jobs.values()) {
      expect(job.from.kind).toBe('at_ramp');
      expect(job.to.kind).toBe('in_storage');
      expect(job.state).toBe('open');
      expect(job.priority).toBe(1);
    }
    expect(createExportJobs(world)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('import jednotka na rampe (náklad na odvoz) a export po uzavretí bookingu job do skladu nedostanú', () => {
    const world = exportWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'roundtrip', booked: 4, importUnits: 4 });
    const importUnit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 902 as EntityId }, null);
    world.cargo.move(importUnit.id, { kind: 'in_vehicle', vehicleId: 901 as EntityId });
    world.cargo.move(importUnit.id, { kind: 'at_ramp', rampId: rampOf(world).id, dock: 0 });
    expect(createExportJobs(world)).toBe(0);
    // Uzavretý booking (zlyhal): jednotka na docku je náklad na odvoz (návrat odosielateľovi), nie export na prijatie.
    const unit = unitAtRamp(world, exportContract, 1);
    world.contractBook.changeState(exportContract, 'ship_en_route');
    world.contractBook.changeState(exportContract, 'failed');
    expect(isPickupCargo(world.contractBook, world.cargo.get(unit) as CargoUnit)).toBe(true);
    expect(createExportJobs(world)).toBe(0);
    expect(rampOf(world).stagedAt(1)).toBe(1);
    expect(rampOf(world).intakeAt(1)).toBe(0);
  });
});

describe('uzavretie bookingu počas jobu na prijatie (T6A-09b, review major 3)', () => {
  it('jednotka na docku s otvoreným jobom do skladu nie je náklad na odvoz ani po uzavretí bookingu; invarianty držia', () => {
    const world = exportWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 4 });
    const withJob = unitAtRamp(world, exportContract, 0);
    const without = unitAtRamp(world, exportContract, 1);
    expect(createExportJobs(world)).toBe(2);
    expect(world.jobOfUnit(without)).toBeDefined();
    world.contractBook.changeState(exportContract, 'ship_en_route');
    world.contractBook.changeState(exportContract, 'failed');

    // Oba majú job: po uzavretí bookingu ostávajú exportom na prijatie, počítadlá docku ich nerátajú ako náklad na odvoz.
    expect(world.isPickupCargo(world.cargo.get(withJob) as CargoUnit)).toBe(false);
    expect(world.isPickupCargo(world.cargo.get(without) as CargoUnit)).toBe(false);
    expect(rampOf(world).stagedAt(0)).toBe(0);
    expect(rampOf(world).stagedAt(1)).toBe(0);
    expect(rampOf(world).intakeAt(0)).toBe(1);
    expect(findWorldViolation(world)).toBeUndefined();

    // Po zrušení jobu (uzavretý booking, nič nejde do skladu) je jednotka náklad na odvoz — vrátenie odosielateľovi.
    const job = world.jobOfUnit(without) as TransportJob;
    storageOf(world, job).release(job.to.kind === 'in_storage' ? job.to.slot : -1);
    job.transition('cancelled');
    world.removeJob(job.id);
    expect(world.isPickupCargo(world.cargo.get(without) as CargoUnit)).toBe(true);
    expect(rampOf(world).stagedAt(1)).toBe(1);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('scenár: zlyhanie bookingu, kým jednotky na docku čakajú na vozidlo — pickup kamión sa nenárokuje, invarianty držia každý tick', () => {
    const world = exportWorld({ vehicles: [] });
    const run = startLoading({ world, kind: 'export', booked: 3, arrivals: [10, 20, 30] });
    const contract = run.offer.exportContract;
    tickUntil(world, (w) => contract.state === 'ship_en_route' && w.jobs.size === 3 && exportUnitsByLocation(w)['at_ramp'] === 3, 20_000);
    contract.slaDeadlineTick = world.clock.tick - (world.defs.economy.failAfterDaysLate + 1) * TICKS_PER_DAY;
    tickEvents(world, 3_000);
    expect(contract.state).toBe('failed');
    expect(exportUnitsByLocation(world)).toEqual({ at_ramp: 3 });
    expect(world.jobs.size).toBe(3);
    expect([...world.trucks.values()].filter((truck) => truck.mission === 'pickup')).toHaveLength(0);
    expect(rampOf(world).stagedAt(0) + rampOf(world).stagedAt(1)).toBe(0);
    expect(lostUnits(world)).toBe(0);
  });

  it('isPickupCargo(contracts, unit, hasJob): export s jobom nie je náklad na odvoz ani pri uzavretom kontrakte; import vždy', () => {
    const lookupFree = { get: () => ({ outbound: 'free' }) as never };
    const exportUnit = { id: 5 as EntityId, direction: 'export', contractId: 7 as ContractId } as CargoUnit;
    expect(isPickupCargo(lookupFree, exportUnit, () => true)).toBe(false);
    expect(isPickupCargo(lookupFree, exportUnit, () => false)).toBe(true);
    expect(isPickupCargo(lookupFree, exportUnit)).toBe(true);
    expect(isPickupCargo(lookupFree, { id: 6 as EntityId, direction: 'import', contractId: 7 as ContractId } as CargoUnit, () => true)).toBe(true);
  });
});

describe('isPickupCargo', () => {
  const unit = (overrides: Partial<CargoUnit>): CargoUnit =>
    ({
      id: 1 as EntityId,
      typeId: 'container_teu',
      contractId: 7 as ContractId,
      voyageId: 7 as never,
      direction: 'export',
      destinationPort: 'Hamburg',
      weightClass: 'medium',
      hold: null,
      quantity: 1,
      location: { kind: 'at_ramp', rampId: 8 as EntityId, dock: 0 },
      ...overrides,
    }) as CargoUnit;

  const lookup = (outbound: 'held' | 'free' | 'sla' | undefined) => ({ get: () => (outbound === undefined ? undefined : ({ outbound } as never)) });

  it('import vždy; export podľa kontraktu: otvorený booking (held) nie, uzavretý (free) áno; bez kontraktu v knihe áno', () => {
    expect(isPickupCargo(lookup('held'), unit({ direction: 'import', destinationPort: null }))).toBe(true);
    expect(isPickupCargo(lookup('held'), unit({}))).toBe(false);
    expect(isPickupCargo(lookup('free'), unit({}))).toBe(true);
    expect(isPickupCargo(lookup('sla'), unit({}))).toBe(true);
    expect(isPickupCargo(lookup(undefined), unit({}))).toBe(true);
    expect(isPickupCargo(lookup('held'), unit({ contractId: null }))).toBe(true);
  });
});

describe('HoldIndex', () => {
  it('add drží vzostupne (untilTick, id); takeDue vyberie splatné a odstráni ich', () => {
    const index = new HoldIndex();
    index.add(50, 9 as EntityId);
    index.add(10, 5 as EntityId);
    index.add(10, 3 as EntityId);
    index.add(30, 4 as EntityId);
    expect(index.all.map((entry) => [entry.untilTick, entry.unitId])).toEqual([[10, 3], [10, 5], [30, 4], [50, 9]]);
    const due: { untilTick: number; unitId: EntityId }[] = [];
    index.takeDue(9, due);
    expect(due).toEqual([]);
    index.takeDue(30, due);
    expect(due.map((entry) => entry.unitId)).toEqual([3, 5, 4]);
    expect(index.size).toBe(1);
    index.takeDue(1000, due);
    expect(due.at(-1)?.unitId).toBe(9);
    expect(index.size).toBe(0);
  });

  it('zadržaná jednotka, ktorá opustí mapu (vrátenie odosielateľovi), vypadne z indexu a z počítadla heldUnits', () => {
    const world = exportWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 4 });
    const id = unitAtRamp(world, exportContract);
    (exportContract.booking.arrivalPlan as number[]).length = 0;
    exportContract.recordArrival(id, false);
    world.cargo.setHold(id, { reason: 'vgm', untilTick: 5000 });
    world.holdIndex.add(5000, id);
    exportContract.recordHold(1);
    expect(findWorldViolation(world)).toBeUndefined();
    world.cargo.move(id, { kind: 'in_truck', truckId: 902 as EntityId });
    world.cargo.move(id, { kind: 'exported' });
    expect(world.holdIndex.size).toBe(0);
    expect(exportContract.booking.heldUnits).toBe(0);
    expect(world.cargo.exportedCount).toBe(1);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('rebuild zostaví index len z jednotiek s hold', () => {
    const index = new HoldIndex();
    index.add(1, 1 as EntityId);
    const mk = (id: number, hold: CargoUnit['hold']): CargoUnit => ({ id: id as EntityId, hold }) as CargoUnit;
    index.rebuild([mk(4, { reason: 'vgm', untilTick: 70 }), mk(2, null), mk(3, { reason: 'vgm', untilTick: 20 })]);
    expect(index.all).toEqual([{ untilTick: 20, unitId: 3 }, { untilTick: 70, unitId: 4 }]);
  });
});

describe('invarianty kroku 12 pre export', () => {
  it('delivery kamión v unloading drží rezerváciu docku: chýbajúca rezervácia je porušenie', () => {
    const world = exportWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 1 });
    (exportContract.booking.arrivalPlan as number[]).splice(0, 1, 5);
    tickUntil(world, () => [...world.trucks.values()][0]?.state === 'unloading', 500);
    const truck = [...world.trucks.values()][0];
    const ramp = rampOf(world);
    expect(findWorldViolation(world)).toBeUndefined();
    ramp.release(truck.dock);
    expect(findWorldViolation(world)).toMatch(/vykladajúce kamióny naň vezú 1 jednotiek/);
    ramp.reserve(truck.dock);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('pool: viac booking skupín než bookingOffersPerDay a viac import skupín než offersPerDay sú porušenie', () => {
    const world = exportWorld({ defs: f6aDefs({ economy: { bookingOffersPerDay: 1, offersPerDay: 1 } }) });
    offerBooking(world, { kind: 'export' });
    expect(findWorldViolation(world)).toBeUndefined();
    offerBooking(world, { kind: 'roundtrip' });
    expect(findWorldViolation(world)).toMatch(/2 booking ponúk > bookingOffersPerDay 1/);
  });

  it('index zadržaných jednotiek musí zodpovedať počtu zadržaných jednotiek bookingov', () => {
    const world = exportWorld({ vehicles: [] });
    expect(findWorldViolation(world)).toBeUndefined();
    world.holdIndex.add(100, 5 as EntityId);
    expect(findWorldViolation(world)).toMatch(/index zadržaných jednotiek má 1 záznamov, kontrakty 0/);
  });

  it('naložený export na lodi sa nepočíta do `volume − unloaded` import kontraktu (len import jednotky)', () => {
    const world = exportWorld({ landside: [] });
    const { importContract, exportContract } = acceptedBooking(world, { kind: 'roundtrip', importUnits: 4, booked: 2 });
    tickUntil(world, () => importContract!.state === 'ship_en_route', 3 * 8640);
    expect(findWorldViolation(world)).toBeUndefined();
    // Export jednotka na palube (cez ledger: príchod bránou je len formalita) nerozbije kontrolu importu.
    const shipId = importContract!.shipId!;
    (exportContract as unknown as { arrivedUnits: number }).arrivedUnits = 1;
    const unit = world.cargo.create('container_teu', { kind: 'in_truck', truckId: 900 as EntityId }, exportContract.id, LABELS(exportContract));
    for (const next of [
      { kind: 'at_ramp', rampId: 8 as EntityId, dock: 0 },
      { kind: 'in_vehicle', vehicleId: 901 as EntityId },
      { kind: 'on_apron', berthId: 1 as EntityId, slot: 0 },
      { kind: 'in_crane', craneId: 2 as EntityId },
      { kind: 'on_ship', shipId },
    ] as const) {
      world.cargo.move(unit.id, next);
    }
    const violation = findWorldViolation(world);
    expect(violation === undefined || !/import jednotiek/.test(violation)).toBe(true);
  });
});

describe('prijatie exportu end-to-end', () => {
  it('všetky exporty bookingu skončia v sklade (vozidlá), nič sa nestratí; jednotky voyage sú zoskupené v jednom sklade', () => {
    const world = exportWorld();
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 12 });
    tickUntil(world, () => exportContract.booking.arrivedUnits === 12, 6000);
    tickEvents(world, 600);
    expect(exportUnitsByLocation(world)).toEqual({ in_storage: 12 });
    expect(lostUnits(world)).toBe(0);
    const group = world.storedCargo.groupOf(exportContract.id);
    expect(group?.units).toHaveLength(12);
    expect(new Set(group?.storages).size).toBe(1);
    expect(exportUnitIds(world, exportContract.id)).toHaveLength(12);
  });

  itR1Interim('export zostáva v sklade, kým booking beží (outbound held) — nevracia sa odosielateľovi', () => {
    const world = exportWorld();
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 3 });
    (exportContract.booking.arrivalPlan as number[]).splice(0, 3, 5, 6, 7);
    tickEvents(world, 3000);
    expect(exportUnitsByLocation(world)).toEqual({ in_storage: 3 });
    expect(world.cargo.exportedCount).toBe(0);
    expect(exportContract.unitsExported).toBe(0);
  });
});

