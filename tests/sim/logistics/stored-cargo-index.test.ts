// StoredCargoIndex (T05-04, ADR-027): uskladnené jednotky podľa kontraktu v poradí sklad ↑, FIFO — odvodená cache pre
// outbound joby dispatchera, udržiavaná háčikom `CargoLedger.move`, nie je v save (obnova ju zostaví z ledgera).
import { describe, expect, it } from 'vitest';
import { IMPORT_LABELS, type CargoLocation, type CargoUnit } from '@sim/cargo';
import type { ContractId, EntityId } from '@sim/core';
import { StoredCargoIndex, type StoredCargoGroup } from '@sim/logistics';
import { World, findWorldViolation, type WorldState } from '@sim/world';
import { outboundWorld, stockYard } from './outbound-fixtures';

const id = (value: number): EntityId => value as EntityId;
const contract = (value: number): ContractId => value as ContractId;

const unitAt = (unitId: number, contractId: number | null, location: CargoLocation): CargoUnit =>
  Object.freeze({ id: id(unitId), typeId: 'container_teu', contractId: contractId === null ? null : contract(contractId), ...IMPORT_LABELS, hold: null, status: 'available', repairUntilTick: null, reefer: null, quantity: 1, location });

const vehicle: CargoLocation = { kind: 'in_vehicle', vehicleId: id(900) };
const storage = (moduleId: number, slot = 0): CargoLocation => ({ kind: 'in_storage', moduleId: id(moduleId), slot });

/** Presun do skladu `storageId` (ako háčik ledgera: jednotka pred presunom + cieľ). */
function store(index: StoredCargoIndex, unitId: number, contractId: number | null, storageId: number): void {
  index.cargoMoved(unitAt(unitId, contractId, vehicle), storage(storageId));
}

/** Presun zo skladu `storageId` do vozidla. */
function take(index: StoredCargoIndex, unitId: number, contractId: number | null, storageId: number): void {
  index.cargoMoved(unitAt(unitId, contractId, storage(storageId)), vehicle);
}

const view = (group: StoredCargoGroup | undefined): [number, number][] =>
  group === undefined ? [] : group.units.map((unit, i) => [unit, group.storages[i]]);

/** Všetky skupiny v kanonickom poradí (null na koniec) pre porovnanie indexov. */
function snapshot(index: StoredCargoIndex): [number | null, [number, number][]][] {
  return [...index.entries]
    .map((group): [number | null, [number, number][]] => [group.contractId, view(group)])
    .sort((a, b) => (a[0] ?? Infinity) - (b[0] ?? Infinity));
}

describe('StoredCargoIndex: udržiavanie háčikom ledgera', () => {
  it('poradie v skupine = sklad ↑, v sklade FIFO, aj keď jednotky prichádzajú do skladov na preskáčku', () => {
    const index = new StoredCargoIndex();
    store(index, 10, 1, 8);
    store(index, 11, 1, 5);
    store(index, 12, 1, 8);
    store(index, 13, 1, 5);
    store(index, 14, 1, 9);
    expect(view(index.groupOf(contract(1)))).toEqual([
      [11, 5],
      [13, 5],
      [10, 8],
      [12, 8],
      [14, 9],
    ]);
    expect(index.size).toBe(5);
  });

  it('skupiny sú podľa kontraktu; jednotky bez kontraktu majú skupinu null', () => {
    const index = new StoredCargoIndex();
    store(index, 20, null, 5);
    store(index, 21, 2, 5);
    store(index, 22, null, 6);
    expect(view(index.groupOf(null))).toEqual([
      [20, 5],
      [22, 6],
    ]);
    expect(view(index.groupOf(contract(2)))).toEqual([[21, 5]]);
    expect(index.groupOf(contract(3))).toBeUndefined();
    expect(index.size).toBe(3);
  });

  it('výdaj zo skladu jednotku vyradí; prázdna skupina zanikne; iné presuny index nemenia', () => {
    const index = new StoredCargoIndex();
    store(index, 30, 4, 5);
    store(index, 31, 4, 5);
    index.cargoMoved(unitAt(40, 4, { kind: 'on_ship', shipId: id(700) }), { kind: 'in_crane', craneId: id(2) });
    index.cargoMoved(unitAt(41, 4, { kind: 'in_vehicle', vehicleId: id(9) }), { kind: 'in_truck', truckId: id(800) });
    take(index, 30, 4, 5);
    expect(view(index.groupOf(contract(4)))).toEqual([[31, 5]]);
    take(index, 31, 4, 5);
    expect(index.groupOf(contract(4))).toBeUndefined();
    expect([...index.entries]).toEqual([]);
    expect(index.size).toBe(0);
  });

  it('výdaj jednotky, ktorá v indexe nie je, nevyhodí a nič nezmení (háčik nesmie vyhodiť)', () => {
    const index = new StoredCargoIndex();
    store(index, 50, 1, 5);
    expect(() => take(index, 51, 1, 5)).not.toThrow();
    expect(() => take(index, 52, 7, 5)).not.toThrow();
    expect(view(index.groupOf(contract(1)))).toEqual([[50, 5]]);
    expect(index.size).toBe(1);
  });

  it('rebuild z ledgera dá rovnaké skupiny a poradie ako postupné presuny (sklady ↑, FIFO)', () => {
    const { world, near, far } = outboundWorld({ landside: [] });
    stockYard(world, far, 3);
    stockYard(world, near, 2);
    stockYard(world, far, 2);
    const rebuilt = new StoredCargoIndex();
    rebuilt.rebuild(world.cargo, world.modules.keys());
    expect(snapshot(rebuilt)).toEqual(snapshot(world.storedCargo));
    const [first, second] = [near.id, far.id].sort((a, b) => a - b);
    expect(view(world.storedCargo.groupOf(null)).map(([, storageId]) => storageId)).toEqual([
      ...Array<number>(first === near.id ? 2 : 5).fill(first),
      ...Array<number>(first === near.id ? 5 : 2).fill(second),
    ]);
    expect(world.storedCargo.size).toBe(world.cargo.countByKind('in_storage'));
  });
});

describe('StoredCargoIndex vo svete: save/load a krok 12', () => {
  it('obnova zo save zostaví rovnaký index (nie je v save)', () => {
    const { world, near, far } = outboundWorld({ landside: [] });
    stockYard(world, far, 4);
    stockYard(world, near, 3);
    world.tick();
    const saved = JSON.parse(JSON.stringify(world.serialize())) as WorldState;
    expect(JSON.stringify(saved)).not.toContain('storedCargo');
    const clone = World.deserialize(world.defs, world.map, saved);
    expect(snapshot(clone.storedCargo)).toEqual(snapshot(world.storedCargo));
    expect(clone.storedCargo.size).toBe(7);
  });

  it('krok 12 odhalí index, ktorý nesedí s počtom jednotiek v skladoch', () => {
    const { world, far } = outboundWorld({ landside: [] });
    const [unit] = stockYard(world, far, 2);
    expect(findWorldViolation(world)).toBeUndefined();
    const stored = world.cargo.get(unit);
    if (stored === undefined) throw new Error('jednotka chýba');
    world.storedCargo.cargoMoved(stored, vehicle);
    expect(findWorldViolation(world)).toMatch(/index uskladneného nákladu má 1 jednotiek, sklady 2/);
  });
});

describe('StoredCargoIndex: prázdne kontajnery (F6c, ADR-034)', () => {
  const empty = (unitId: number, lineId: string, location: CargoLocation): CargoUnit =>
    Object.freeze({ ...unitAt(unitId, null, location), direction: 'empty', lineId, voyageId: null, destinationPort: null, weightClass: 'light' });

  it('prázdny nepatrí do skupiny null (odchádzajúci „voľný“ prúd) — vedie ho zvlášť podľa linky; size ho počíta, emptySize len prázdne', () => {
    const index = new StoredCargoIndex();
    index.cargoMoved(unitAt(50, null, vehicle), storage(5, 0));
    index.cargoMoved(empty(51, 'blue_anchor', vehicle), storage(6, 0));
    index.cargoMoved(empty(52, 'blue_anchor', vehicle), storage(6, 1));
    index.cargoMoved(empty(53, 'golden_wave', vehicle), storage(5, 1));
    expect(view(index.groupOf(null))).toEqual([[50, 5]]);
    expect([...index.entries].map((group) => group.contractId)).toEqual([null]);
    expect([...index.emptiesOf('blue_anchor')]).toEqual([51, 52]);
    expect([...index.emptiesOf('golden_wave')]).toEqual([53]);
    expect(index.emptiesOf('northern_star')).toEqual([]);
    expect([index.size, index.emptySize]).toEqual([4, 3]);
  });

  it('výdaj prázdneho zo skladu ho vyradí z indexu linky; prázdny zoznam zanikne; export a iné presuny index nemenia', () => {
    const index = new StoredCargoIndex();
    index.cargoMoved(empty(60, 'blue_anchor', vehicle), storage(6, 0));
    index.cargoMoved(empty(61, 'blue_anchor', vehicle), storage(6, 1));
    index.cargoMoved(empty(62, 'blue_anchor', { kind: 'in_vehicle', vehicleId: id(9) }), { kind: 'in_truck', truckId: id(800) });
    expect(index.emptySize).toBe(2);
    index.cargoMoved(empty(60, 'blue_anchor', storage(6, 0)), vehicle);
    expect([...index.emptiesOf('blue_anchor')]).toEqual([61]);
    index.cargoMoved(empty(61, 'blue_anchor', storage(6, 1)), vehicle);
    expect(index.emptiesOf('blue_anchor')).toEqual([]);
    expect([index.size, index.emptySize]).toEqual([0, 0]);
    index.cargoMoved(empty(63, 'blue_anchor', storage(6, 2)), vehicle); // jednotka mimo indexu sa ignoruje
    expect(index.emptySize).toBe(0);
  });

  it('rebuild z ledgera zostaví prázdne podľa linky (poradie nie je významné — výber určuje najmenšie id)', () => {
    const units = new Map<number, CargoUnit>([
      [70, empty(70, 'blue_anchor', storage(6, 0))],
      [71, unitAt(71, 5, storage(5, 0))],
      [72, empty(72, 'blue_anchor', storage(5, 1))],
    ]);
    const holders = new Map<number, number[]>([[5, [71, 72]], [6, [70]]]);
    const source = {
      countAt: (_kind: 'in_storage', holderId: EntityId): number => holders.get(holderId)?.length ?? 0,
      unitAtIndex: (_kind: 'in_storage', holderId: EntityId, index: number): EntityId | undefined => holders.get(holderId)?.[index] as EntityId | undefined,
      get: (unitId: EntityId): CargoUnit | undefined => units.get(unitId),
    };
    const index = new StoredCargoIndex();
    index.rebuild(source, [id(5), id(6)]);
    expect([...index.emptiesOf('blue_anchor')].sort()).toEqual([70, 72]);
    expect(view(index.groupOf(contract(5)))).toEqual([[71, 5]]);
    expect([index.size, index.emptySize]).toEqual([3, 2]);
  });
});
