// Spoločné pomôcky pre testy nákladu (T02-02): samostatný CargoLedger s vlastným alokátorom id, zbernicou udalostí
// a hodinami, stavitelia lokácií a „snímka" ledgera na overenie atomickosti.
import cargoTypesJson from '@data/defs/cargo_types.json';
import {
  CARGO_LOCATION_KINDS,
  IMPORT_LABELS,
  CargoLedger,
  type CargoUnit,
  type CargoUnitLabelsInput,
  type CargoLedgerDeps,
  type CargoLedgerState,
  type CargoLocation,
  type CargoLocationKind,
} from '@sim/cargo';
import { EntityIdAllocator, EventBus, type ContractId, type EntityId, type VoyageId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { CargoMovedEvent, SimEvent } from '@sim/events';
import { RAW_DEFS } from '../world/world-fixtures';

export const TEU = 'container_teu';
/** Testovací sypký typ s `unitsPerBatch ≠ 1` (bundled defy majú zatiaľ len kontajner). */
export const GRAIN = 'grain_test';
export const GRAIN_BATCH = 25;

/** Bundled defy + `grain_test` (bulk, 25 t na batch). */
export const CARGO_DEFS: DefRegistry = DefRegistry.fromRaw({
  ...RAW_DEFS,
  cargo_types: {
    ...cargoTypesJson,
    items: [
      ...cargoTypesJson.items,
      {
        id: GRAIN,
        category: 'bulk',
        unitName: 't',
        unitsPerBatch: GRAIN_BATCH,
        basePricePerUnitCents: 1200,
        exportPricePerUnitCents: 1000,
        repositioningPricePerUnitCents: 300,
        transhipPricePerUnitCents: 700,
        xpPerUnit: 1,
        colorToken: 'cargo-bulk',
      },
    ],
  },
});

export const id = (value: number): EntityId => value as EntityId;

/** Stavitelia lokácií (id držiteľov sú obyčajné čísla — ledger existenciu držiteľa neoveruje). */
export const at = {
  ship: (shipId: number): CargoLocation => ({ kind: 'on_ship', shipId: id(shipId) }),
  crane: (craneId: number): CargoLocation => ({ kind: 'in_crane', craneId: id(craneId) }),
  apron: (berthId: number, slot: number): CargoLocation => ({ kind: 'on_apron', berthId: id(berthId), slot }),
  vehicle: (vehicleId: number): CargoLocation => ({ kind: 'in_vehicle', vehicleId: id(vehicleId) }),
  handler: (machineId: number): CargoLocation => ({ kind: 'in_handler', machineId: id(machineId) }),
  storage: (moduleId: number, slot: number): CargoLocation => ({ kind: 'in_storage', moduleId: id(moduleId), slot }),
  pipeline: (pipelineId: number): CargoLocation => ({ kind: 'in_pipeline', pipelineId: id(pipelineId) }),
  truck: (truckId: number): CargoLocation => ({ kind: 'in_truck', truckId: id(truckId) }),
  train: (trainId: number, slot = 0): CargoLocation => ({ kind: 'in_train', trainId: id(trainId), slot }),
  exported: (): CargoLocation => ({ kind: 'exported' }),
  shipped: (): CargoLocation => ({ kind: 'shipped' }),
};

/** Jedna ukážková lokácia každého druhu (tabuľkové testy). */
export const SAMPLE_LOCATIONS: Readonly<Record<CargoLocationKind, CargoLocation>> = {
  on_ship: at.ship(900),
  in_crane: at.crane(901),
  on_apron: at.apron(902, 1),
  in_vehicle: at.vehicle(903),
  in_handler: at.handler(909),
  in_storage: at.storage(904, 7),
  in_pipeline: at.pipeline(905),
  in_truck: at.truck(907),
  in_train: at.train(908, 3),
  exported: at.exported(),
  shipped: at.shipped(),
};

/** Importné reťazce §7.1 (bez počiatočného `on_ship`, ktorý dá `create`). */
export const CONTAINER_CHAIN: readonly CargoLocation[] = [
  at.crane(20),
  at.apron(10, 0),
  at.vehicle(30),
  at.storage(40, 3),
  at.vehicle(31),
  at.truck(60),
  at.exported(),
];
export const LIQUID_CHAIN: readonly CargoLocation[] = [
  at.pipeline(70),
  at.storage(41, 0),
  at.pipeline(71),
  at.truck(80),
  at.exported(),
];
export const RORO_CHAIN: readonly CargoLocation[] = [
  at.vehicle(32),
  at.storage(42, 5),
  at.vehicle(32),
  at.truck(61),
  at.exported(),
];

/** Exportný reťazec ADR-032 (bez počiatočného `in_truck`, ktorý dá `create` s exportnými štítkami). */
export const EXPORT_CHAIN: readonly CargoLocation[] = [
  at.vehicle(30),
  at.storage(40, 4),
  at.vehicle(31),
  at.apron(10, 2),
  at.crane(20),
  at.ship(90),
  at.shipped(),
];
/** „Last minute" export (ADR-032 bod 6): z kamióna priamo na apron, bez skladu. */
export const LAST_MINUTE_CHAIN: readonly CargoLocation[] = [at.vehicle(30), at.apron(10, 3), at.crane(20), at.ship(90), at.shipped()];

/** Importný reťazec pod hákom (ADR-033): žeriav odovzdá jednotku priamo vozidlu, bez apronu. */
export const UNDER_HOOK_IMPORT_CHAIN: readonly CargoLocation[] = [at.crane(20), at.vehicle(30), at.storage(40, 3), at.vehicle(31), at.truck(60), at.exported()];
/** Importný reťazec ťahač + RTG (ADR-040, TERMINAL_2 §6.1): žeriav → ťahač → RTG (`in_handler`) → stoh, odtiaľ RTG späť na ťahač a cez žeriav na loď. */
export const RTG_DISCHARGE_CHAIN: readonly CargoLocation[] = [at.crane(20), at.vehicle(30), at.handler(95), at.storage(40, 3)];
/** Nakládka cez RTG (TERMINAL_2 §6.3, bez počiatočného `in_storage`): stoh → RTG → ťahač → žeriav → loď → `shipped`. */
export const RTG_LOAD_CHAIN: readonly CargoLocation[] = [at.handler(95), at.vehicle(30), at.crane(20), at.ship(90), at.shipped()];

/** Exportný reťazec pod hákom (ADR-033, bez počiatočného `in_truck`): vozidlo z príjmu čaká pod žeriavom a ten jednotku zdvihne. */
export const UNDER_HOOK_EXPORT_CHAIN: readonly CargoLocation[] = [
  at.vehicle(30),
  at.storage(40, 4),
  at.vehicle(31),
  at.crane(20),
  at.ship(90),
  at.shipped(),
];

/** Štítky exportnej jednotky bookingu (kontrakt 77, voyage 7, Rotterdam, ťažká). */
export const EXPORT_CONTRACT = 77 as ContractId;
export const EXPORT_LABELS: CargoUnitLabelsInput = { direction: 'export', voyageId: 7 as VoyageId, lineId: 'blue_anchor', destinationPort: 'Rotterdam', weightClass: 'heavy' };

/** Celá import jednotka bez kontraktu (štítky `IMPORT_LABELS`, bez hold) — pre ručne skladané pohľady a stavy. */
export function importUnit(fields: Pick<CargoUnit, 'id' | 'location'> & Partial<CargoUnit>): CargoUnit {
  return { typeId: TEU, contractId: null, ...IMPORT_LABELS, hold: null, status: 'available', repairUntilTick: null, reefer: null, quantity: 1, ...fields };
}

export interface LedgerHarness {
  readonly ledger: CargoLedger;
  readonly ids: EntityIdAllocator;
  readonly events: EventBus<SimEvent>;
  /** Meniteľný zdroj `CargoMoved.tick` (zástupca `world.clock`). */
  readonly clock: { tick: number };
  readonly deps: CargoLedgerDeps;
}

export interface HarnessOptions {
  readonly defs?: DefRegistry;
  readonly nextId?: number;
  readonly tick?: number;
}

/** Prázdny ledger nad vlastnými závislosťami (rovnaké zapojenie ako vo `World`). */
export function createHarness(options: HarnessOptions = {}): LedgerHarness {
  const ids = new EntityIdAllocator({ nextId: options.nextId ?? 1 });
  const events = new EventBus<SimEvent>();
  const clock = { tick: options.tick ?? 0 };
  const defs = options.defs ?? CARGO_DEFS;
  const deps: CargoLedgerDeps = { cargoTypes: defs.cargoTypes, containerTypes: defs.containerTypes, ids, events, clock };
  return { ledger: new CargoLedger(deps), ids, events, clock, deps };
}

/** Presunie jednotku postupne cez `path` a po každom kroku overí konzerváciu. */
export function moveThrough(ledger: CargoLedger, unitId: EntityId, path: readonly CargoLocation[]): void {
  for (const to of path) {
    ledger.move(unitId, to);
    ledger.assertConservation();
  }
}

/** Udalosti `CargoMoved` z bufferu (buffer sa vyprázdni). */
export function flushMoves(events: EventBus<SimEvent>): CargoMovedEvent[] {
  return events.flush().filter((event): event is CargoMovedEvent => event.type === 'CargoMoved');
}

export interface LedgerSnapshot {
  readonly state: CargoLedgerState;
  readonly counts: Readonly<Record<CargoLocationKind, number>>;
  readonly createdCount: number;
  readonly exportedCount: number;
  readonly liveCount: number;
  readonly nextId: number;
  readonly pendingEvents: number;
}

/** Všetko pozorovateľné o ledgeri a jeho závislostiach — porovnanie pred/po chybe dokazuje atomickosť. */
export function snapshot(harness: LedgerHarness): LedgerSnapshot {
  const { ledger } = harness;
  return {
    state: JSON.parse(JSON.stringify(ledger.getState())) as CargoLedgerState,
    counts: Object.fromEntries(CARGO_LOCATION_KINDS.map((kind) => [kind, ledger.countByKind(kind)])) as Record<
      CargoLocationKind,
      number
    >,
    createdCount: ledger.createdCount,
    exportedCount: ledger.exportedCount,
    liveCount: ledger.liveCount,
    nextId: harness.ids.getState().nextId,
    pendingEvents: harness.events.pending,
  };
}

/** Hlboká kópia cez JSON (simuluje save → load). */
export function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
