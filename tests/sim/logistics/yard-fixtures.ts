// Fixtúra testov plánovača a rehandlingu (TR2-02, ADR-039): dispatchový svet (cesta pozdĺž nábrežia, depo, Root berth) s kontajnerovými
// dvormi W a E, jednotkami s ľubovoľnými štítkami (import, export, prázdne) a pomocníkmi, ktoré robia to, čo vozidlo — rezervácia bunky plánovačom,
// presun v ledgeri a commit.
import { vi } from 'vitest';
import { IMPORT_LABELS, type CargoUnit, type CargoUnitLabelsInput } from '@sim/cargo';
import type { EntityId, VoyageId } from '@sim/core';
import type { DefRegistry } from '@sim/defs';
import { TransportJob, reserveYardSlot } from '@sim/logistics';
import { BerthModule, YardBlock } from '@sim/modules';
import type { World } from '@sim/world';
import { DEFS } from '../world/world-fixtures';
import { ROOT_BERTH_ID, YARD_E, YARD_W, buyVehicle, dispatchWorld, placeYard } from './dispatch-fixtures';

export const TEU = 'container_teu';

export interface YardTestWorld {
  readonly world: World;
  readonly berth: BerthModule;
  readonly yards: readonly YardBlock[];
  readonly depotId: EntityId;
}

/** Dispatchový svet s dvormi W (blízko) a E (ďaleko od berthu 4); `yards` v poradí id. */
export function yardTestWorld(defs: DefRegistry = DEFS, seed = 3050, cells = [YARD_W, YARD_E]): YardTestWorld {
  const { world, depot } = dispatchWorld(defs, seed);
  const yards = cells.map((cell) => {
    const yard = placeYard(world, cell);
    if (!(yard instanceof YardBlock)) throw new Error('dvor nie je YardBlock');
    return yard;
  });
  const berth = world.modules.get(ROOT_BERTH_ID);
  if (!(berth instanceof BerthModule)) throw new Error('chýba Root berth');
  return { world, berth, yards, depotId: depot.id };
}

export { buyVehicle };

/** Štítky exportu: voyage, cieľový prístav, hmotnostná trieda, veľkosť. */
export function exportLabels(voyageId: number, weightClass: CargoUnitLabelsInput['weightClass'], sizeFt: 20 | 40 = 20, port = 'gdansk'): CargoUnitLabelsInput {
  return { direction: 'export', voyageId: voyageId as VoyageId, lineId: 'northern_star', destinationPort: port, weightClass, sizeFt };
}

/** Štítky prázdneho kontajnera linky. */
export function emptyLabelsOf(lineId: string, sizeFt: 20 | 40 = 20): CargoUnitLabelsInput {
  return { direction: 'empty', voyageId: null, lineId, destinationPort: null, weightClass: 'light', sizeFt };
}

/**
 * Nová jednotka so štítkami `labels` pripravená na uloženie vo vozidle 903: import po reťazci §7.1, export / prázdny po kamióne a rampe
 * (`in_truck → at_ramp → in_vehicle`, kontrakt `contractId` len pre export).
 */
export function newUnit(world: World, labels: CargoUnitLabelsInput = IMPORT_LABELS, contractId: number | null = null): CargoUnit {
  const direction = labels.direction;
  const spawn = direction === 'import' || direction === 'tranship' ? ({ kind: 'on_ship', shipId: 900 as EntityId } as const) : ({ kind: 'in_truck', truckId: 950 as EntityId } as const);
  const { id } = world.cargo.create(TEU, spawn, contractId as never, labels);
  if (spawn.kind === 'on_ship') {
    world.cargo.move(id, { kind: 'in_crane', craneId: 901 as EntityId });
    world.cargo.move(id, { kind: 'on_apron', berthId: 902 as EntityId, slot: 0 });
    world.cargo.move(id, { kind: 'in_vehicle', vehicleId: 903 as EntityId });
  } else {
    world.cargo.move(id, { kind: 'at_ramp', rampId: 960 as EntityId, dock: 0 });
    world.cargo.move(id, { kind: 'in_vehicle', vehicleId: 903 as EntityId });
  }
  return world.cargo.get(id) as CargoUnit;
}

/** Uloží jednotku tak, ako to robí job: plánovač vyberie bunku a rezervuje ju, ledger ju presunie, `commit`. Vráti bunku `[blok, bay, row, tier]` alebo `null`. */
export function storeByPlanner(world: World, berth: BerthModule, unit: CargoUnit): { block: YardBlock; bay: number; row: number; tier: number } | null {
  const choice = reserveYardSlot(world, unit, berth);
  if (choice === null) return null;
  const block = world.modules.get(choice.moduleId);
  if (!(block instanceof YardBlock)) throw new Error('plánovač vybral modul, ktorý nie je YardBlock');
  block.assertCommittable(choice.slot, unit.id);
  world.cargo.move(unit.id, { kind: 'in_storage', moduleId: block.id, slot: choice.slot });
  block.commit(choice.slot, unit.id);
  return { block, ...block.positionOfSlot(choice.slot) };
}

/** Job `in_storage → on_apron` Root berthu pre uloženú jednotku (rezervuje slot apronu); vozidlo ho dostane od dispatchera. */
export function openLoadJob(world: World, berth: BerthModule, unitId: EntityId): TransportJob {
  const unit = world.cargo.get(unitId);
  if (unit === undefined) throw new Error('jednotka neexistuje');
  const job = new TransportJob({ id: world.ids.next(), unitIds: [unitId], from: unit.location, to: { kind: 'on_apron', berthId: berth.id, slot: berth.apron.reserve() }, createdTick: world.clock.tick });
  world.addJob(job);
  return job;
}

/**
 * Pripíše kontraktom exportu plánovaný príchod lode voyage (`arrivalOnVoyage`) bez celého kontraktového stroja — `plannedDepartureTick` číta len kontrakt jednotky
 * (`contractBook.get`). Falošný kontrakt je „zadržaný" (`outbound: 'held'`), takže dispatcher sám žiadne joby nezakladá. Vráti obnovu spy.
 */
export function stubVoyageArrivals(world: World, arrivals: Readonly<Record<number, number>>): () => void {
  const fake = { outbound: 'held', shipArrivalTick: undefined, slaDeadlineTick: undefined, arrivalOnVoyage: (voyageId: number): number | undefined => arrivals[voyageId] };
  const spy = vi.spyOn(world.contractBook, 'get').mockReturnValue(fake as never);
  return () => spy.mockRestore();
}
