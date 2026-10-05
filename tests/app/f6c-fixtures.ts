// Spoločné pomôcky pre testy UI/app F6c (T6C-05): repositioning prázdnych a prekládka vložené priamo do knihy kontraktov sveta
// (správanie dodá sim T6C-02 / T6C-03, UI sa testuje na fixture dátach, ako `helpers/f6a.ts` pri exporte) a prázdne kontajnery
// v sklade vytvorené a presunuté cez ledger.
import type { CargoUnit, CargoUnitLabelsInput } from '@sim/cargo';
import { EmptyRepositioningContract, TranshipContract, type AcceptContext } from '@sim/contracts';
import type { EntityId } from '@sim/core';
import type { World } from '@sim/world';
import { TEU } from './f6a-fixtures';

export { TEU };

/** Štítky prázdneho kontajnera linky (bez kontraktu, voyage a prístavu; ADR-034). */
export function emptyLabels(lineId: string): CargoUnitLabelsInput {
  return { direction: 'empty', voyageId: null, lineId, destinationPort: null, weightClass: 'light' };
}

export interface RepositioningOptions {
  readonly volumeUnits?: number;
  readonly lineId?: string;
  readonly destinationPort?: string;
}

/** Ponuka repositioningu prázdnych (vlastná plavba) pridaná do knihy sveta; stav `offered`. */
export function addRepositioningOffer(world: World, options: RepositioningOptions = {}): EmptyRepositioningContract {
  const { contractBook, clock } = world;
  const contract = new EmptyRepositioningContract({
    id: contractBook.allocateId(),
    voyageId: contractBook.allocateVoyageId(),
    lineId: options.lineId ?? 'blue_anchor',
    templateId: 'container_feeder_repositioning',
    cargoTypeId: TEU,
    volumeUnits: options.volumeUnits ?? 24,
    slaDays: 3,
    rewardCents: 316_800,
    xpReward: 24,
    offeredTick: clock.tick,
    offerExpiresTick: clock.tick + 2 * clock.ticksPerDay,
    shipClassId: 'feeder',
    destinationPort: options.destinationPort ?? 'Rotterdam',
  });
  contractBook.add(contract);
  return contract;
}

export interface TranshipOptions {
  readonly volumeUnits?: number;
  readonly lineId?: string;
  readonly destinationPort?: string;
}

/** Ponuka prekládky: voyage lode A kontraktu a voyage lode B pridelená knihou; stav `offered`. */
export function addTranshipOffer(world: World, options: TranshipOptions = {}): TranshipContract {
  const { contractBook, clock } = world;
  const contract = new TranshipContract({
    id: contractBook.allocateId(),
    voyageId: contractBook.allocateVoyageId(),
    outVoyageId: contractBook.allocateVoyageId(),
    lineId: options.lineId ?? 'golden_wave',
    templateId: 'container_feeder_tranship',
    cargoTypeId: TEU,
    volumeUnits: options.volumeUnits ?? 36,
    slaDays: 5,
    rewardCents: 1_159_200,
    xpReward: 36,
    offeredTick: clock.tick,
    offerExpiresTick: clock.tick + 2 * clock.ticksPerDay,
    shipClassId: 'feeder',
    destinationPort: options.destinationPort ?? 'Hamburg',
  });
  contractBook.add(contract);
  return contract;
}

export interface AcceptPlan {
  /** Za koľko tickov od teraz príde loď A (predvolene 2 dni). */
  readonly arrivalIn?: number;
  /** Rozstup príchodu lode B po lodi A v dňoch (predvolene 1,5 — stred `transhipGapDaysRange`). */
  readonly gapDays?: number;
}

/**
 * Prijme kontrakt cez `Contract.accept` (rovnaký plán ako `AcceptContract`: príchod lode, SLA, pri prekládke príchod lode B) a
 * prepne ho do `accepted`. `Rng` je deterministický stub — `range` vráti `gapDays`.
 */
export function acceptContract(world: World, contract: EmptyRepositioningContract | TranshipContract, plan: AcceptPlan = {}): void {
  const { clock, contractBook } = world;
  const context: AcceptContext = {
    tick: clock.tick,
    shipArrivalTick: clock.tick + (plan.arrivalIn ?? 2 * clock.ticksPerDay),
    ticksPerDay: clock.ticksPerDay,
    ticksPerHour: clock.ticksPerHour,
    cutoffHours: world.defs.economy.cutoffHours,
    arrivalWindowDays: world.defs.logistics.exportFlow.arrivalWindowDays,
    transhipGapDaysRange: world.defs.economy.transhipGapDaysRange,
    rng: { int: (min: number) => min, range: () => plan.gapDays ?? 1.5 },
  };
  contract.accept(context);
  contractBook.changeState(contract, 'accepted');
}

/** Prázdny kontajner linky v kamióne (miesto vzniku prázdneho; ADR-034). */
export function createEmptyUnit(world: World, lineId: string): CargoUnit {
  return world.cargo.create(TEU, { kind: 'in_truck', truckId: 9001 as EntityId }, null, emptyLabels(lineId));
}

/** Prázdny kontajner linky uložený v sklade `moduleId` (reťazec `in_truck → at_ramp → in_vehicle → in_storage`). */
export function storeEmptyUnit(world: World, lineId: string, moduleId: EntityId, slot: number): CargoUnit {
  const unit = createEmptyUnit(world, lineId);
  world.cargo.move(unit.id, { kind: 'at_ramp', rampId: 9002 as EntityId, dock: 0 });
  world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: 9003 as EntityId });
  world.cargo.move(unit.id, { kind: 'in_storage', moduleId, slot });
  return unit;
}


/** Rozdelenie nákladu lode do troch druhov paluby (`ShipVM.cargoSplit`). */
export interface DeckCounts {
  import: number;
  export: number;
  empty: number;
}

/**
 * Orákulum rozdelenia nákladu lode `shipId` pre testy nad skutočným svetom, nezávislé od `src/app/cargo-vm.ts` (tam sa pravidlo A / B pre
 * prekládku rozhoduje podľa voyage jednotky a lode): smer jednotky, a pri prekládke lode kontraktu — loď A (`contract.shipId`) ju privezie
 * (import), loď B (`tranship.outShipId`), po záchrane aj akákoľvek iná loď, ju odváža (export). Voyage sa nepoužíva vôbec.
 */
export function oracleDeckSplit(world: World, shipId: EntityId): DeckCounts {
  const split: DeckCounts = { import: 0, export: 0, empty: 0 };
  const count = world.cargo.countAt('on_ship', shipId);
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('on_ship', shipId, i);
    const unit: CargoUnit | undefined = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit === undefined) throw new Error('jednotka na lodi chýba v ledgeri');
    if (unit.direction === 'tranship') {
      const contract = unit.contractId === null ? undefined : world.contracts.get(unit.contractId);
      split[contract?.shipId === shipId ? 'import' : 'export'] += 1;
    } else {
      split[unit.direction] += 1;
    }
  }
  return split;
}
