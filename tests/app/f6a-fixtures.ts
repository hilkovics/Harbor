// Spoločné pomôcky pre testy UI/app F6a (T6A-07): export booking a roundtrip vložené priamo do knihy kontraktov sveta
// (správanie exportu dodá sim T6A-04/05, UI sa testuje na fixture dátach) a náklad exportu presunutý cez ledger.
import type { CargoLocation, CargoUnit, CargoUnitLabels, WeightClass } from '@sim/cargo';
import { ExportContract, ImportContract } from '@sim/contracts';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import type { World } from '@sim/world';

export const TEU = 'container_teu';

export interface Roundtrip {
  readonly voyageId: VoyageId;
  readonly importContract: ImportContract;
  readonly exportContract: ExportContract;
}

export interface RoundtripOptions {
  readonly importUnits?: number;
  readonly exportUnits?: number;
  readonly destinationPort?: string;
  readonly shipClassId?: string;
}

/** Ponuka roundtripu (import n, export n + 1, jedna voyage) pridaná do knihy sveta; stav `offered`. */
export function addRoundtripOffer(world: World, options: RoundtripOptions = {}): Roundtrip {
  const { contractBook, clock } = world;
  const voyageId = contractBook.allocateVoyageId();
  const base = {
    voyageId,
    templateId: 'container_feeder_roundtrip',
    cargoTypeId: TEU,
    slaDays: 3,
    xpReward: 20,
    offeredTick: clock.tick,
    offerExpiresTick: clock.tick + 2 * clock.ticksPerDay,
    shipClassId: options.shipClassId ?? 'feeder',
  };
  const importContract = new ImportContract({ ...base, id: contractBook.allocateId(), volumeUnits: options.importUnits ?? 48, rewardCents: 180_000_000 });
  const exportContract = new ExportContract({
    ...base,
    id: contractBook.allocateId(),
    volumeUnits: options.exportUnits ?? 24,
    rewardCents: 96_000_000,
    destinationPort: options.destinationPort ?? 'Rotterdam',
  });
  contractBook.add(importContract);
  contractBook.add(exportContract);
  return { voyageId, importContract, exportContract };
}

export interface AcceptOptions {
  /** Za koľko tickov od teraz príde loď (predvolene 2 dni). */
  readonly arrivalIn?: number;
  /** Cut-off pred príchodom lode v tickoch (predvolene 12 h). */
  readonly cutoffBefore?: number;
  /** Plán príchodov kamiónov (zostávajúce ticky). */
  readonly arrivalPlan?: readonly number[];
}

/** Prijme kontrakty roundtripu (plán lode, cut-off, plán príchodov exportu) a prepne ich do `accepted`. */
export function acceptRoundtrip(world: World, roundtrip: Roundtrip, options: AcceptOptions = {}): void {
  const { clock, contractBook } = world;
  const arrival = clock.tick + (options.arrivalIn ?? 2 * clock.ticksPerDay);
  for (const contract of [roundtrip.importContract, roundtrip.exportContract]) {
    contract.acceptedTick = clock.tick;
    contract.shipArrivalTick = arrival;
    contract.slaDeadlineTick = arrival + contract.slaDays * clock.ticksPerDay;
    contractBook.changeState(contract, 'accepted');
  }
  const { exportContract } = roundtrip;
  exportContract.cutoffTick = arrival - (options.cutoffBefore ?? 12 * clock.ticksPerHour);
  exportContract.arrivalPlan = [...(options.arrivalPlan ?? Array.from({ length: exportContract.volumeUnits }, (_, index) => clock.tick + 100 + index))];
}

/** Štítky exportnej jednotky bookingu. */
export function exportLabels(contract: ExportContract, weightClass: WeightClass = 'medium'): CargoUnitLabels {
  return { direction: 'export', voyageId: contract.voyageId, destinationPort: contract.destinationPort, weightClass };
}

/** Exportná jednotka bookingu v kamióne (miesto vzniku exportu). */
export function createExportUnit(world: World, contract: ExportContract, weightClass: WeightClass = 'medium'): CargoUnit {
  return world.cargo.create(TEU, { kind: 'in_truck', truckId: 9001 as EntityId }, contract.id as ContractId, exportLabels(contract, weightClass));
}

/** Presunie jednotku cez ledger po reťazci `at_ramp → in_vehicle → …` až na `last`. */
export function moveChain(world: World, unitId: EntityId, chain: readonly CargoLocation[]): void {
  for (const location of chain) world.cargo.move(unitId, location);
}

/** Reťazec exportu po uloženie v sklade `storageId` (ADR-032 bod 5). */
export function toStorageChain(storageId: EntityId, slot: number): readonly CargoLocation[] {
  return [
    { kind: 'at_ramp', rampId: 9002 as EntityId, dock: 0 },
    { kind: 'in_vehicle', vehicleId: 9003 as EntityId },
    { kind: 'in_storage', moduleId: storageId, slot },
  ];
}

/** Reťazec exportu po palubu lode `shipId` (z docku cez apron a žeriav, bez skladu — last minute vetva). */
export function toShipChain(shipId: EntityId): readonly CargoLocation[] {
  return [
    { kind: 'at_ramp', rampId: 9002 as EntityId, dock: 0 },
    { kind: 'in_vehicle', vehicleId: 9003 as EntityId },
    { kind: 'on_apron', berthId: 9004 as EntityId, slot: 0 },
    { kind: 'in_crane', craneId: 9005 as EntityId },
    { kind: 'on_ship', shipId },
  ];
}
