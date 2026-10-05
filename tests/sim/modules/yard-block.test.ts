// YardBlock + StackGrid (TR2-02; ADR-039 bod 3–5): geometria a kódovanie slotu, pravidlá stohu (20′, 40′, výška, len vrchný),
// kapacita v TEU, odvodená cache `StackGrid` vs ledger (invariant kroku 12) a rezervácie bunky (40′ rezervuje aj tieň).
import { describe, expect, it } from 'vitest';
import { IMPORT_LABELS, type ContainerSize } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { EmptyDepot, YardBlock, positionOfCell, slotOfCell } from '@sim/modules';
import { World, findWorldViolation, type WorldState } from '@sim/world';
import { BARE_MAP, DEFS, SEED } from '../world/world-fixtures';

const YARD = 'container_yard_small';
const DEPOT = 'empty_depot';
const TEU = 'container_teu';
const id = (value: number): EntityId => value as EntityId;

function worldWith(defId: string, x: number, y: number): { world: World; block: YardBlock } {
  const world = World.create(DEFS, BARE_MAP, SEED);
  const block = world.placeModule({ defId, x, y, rotation: 0 }, 0);
  if (!(block instanceof YardBlock)) throw new Error(`${defId} nie je YardBlock`);
  return { world, block };
}

/** Jednotka `sizeFt` vo vozidle (po reťazci §7.1 až `in_vehicle`), pripravená na uloženie do skladu. */
function inVehicle(world: World, sizeFt: ContainerSize = 20): EntityId {
  const unit = world.cargo.create(TEU, { kind: 'on_ship', shipId: id(900) }, null, { ...IMPORT_LABELS, sizeFt }).id;
  world.cargo.move(unit, { kind: 'in_crane', craneId: id(901) });
  world.cargo.move(unit, { kind: 'on_apron', berthId: id(902), slot: 0 });
  world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(903) });
  return unit;
}

function put(world: World, block: YardBlock, unit: EntityId, bay: number, row: number, tier: number): void {
  world.cargo.move(unit, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(bay, row, tier) });
}

function take(world: World, unit: EntityId): void {
  world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(903) });
}

/** Kód chyby (`ModuleError` pravidiel stohu alebo `CargoError` ledgera), alebo `undefined`, keď akcia prešla. */
function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code ?? 'other';
  }
  return undefined;
}

describe('geometria a kódovanie slotu', () => {
  it('straddle blok 4 × 4 × 3 = 48 TEU; slot = ((row × bays) + bay) × maxTier + tier a dekódovanie je inverzné', () => {
    const { block } = worldWith(YARD, 50, 20);
    expect(block.geometry).toEqual({ bays: 4, rows: 4, maxTier: 3 });
    expect([block.capacityTeu, block.capacity, block.usedTeu, block.freeCount]).toEqual([48, 48, 0, 48]);
    expect(block.slotOf(0, 0, 0)).toBe(0);
    expect(block.slotOf(1, 0, 2)).toBe(5);
    expect(block.slotOf(2, 3, 1)).toBe((3 * 4 + 2) * 3 + 1);
    for (let slot = 0; slot < block.capacity; slot++) {
      const { bay, row, tier } = block.positionOfSlot(slot);
      expect(block.slotOf(bay, row, tier)).toBe(slot);
      expect(positionOfCell(block.geometry, slotOfCell(block.geometry, bay, row, tier))).toEqual({ bay, row, tier });
    }
    expect([codeOf(() => block.slotOf(4, 0, 0)), codeOf(() => block.slotOf(0, 0, 3)), codeOf(() => block.positionOfSlot(48))]).toEqual(['invalid_slot', 'invalid_slot', 'invalid_slot']);
  });

  it('depo prázdnych je tiež YardBlock: 4 × 3 × 8 = 96 TEU, stohy do výšky 8', () => {
    const { block } = worldWith(DEPOT, 34, 20);
    expect(block).toBeInstanceOf(EmptyDepot);
    expect([block.geometry, block.capacityTeu]).toEqual([{ bays: 4, rows: 3, maxTier: 8 }, 96]);
  });
});

describe('pravidlá stohu — 20′', () => {
  it('ukladá sa len na zem alebo vrchol stohu a nie nad maxTier; výšku a vrch sleduje StackGrid', () => {
    const { world, block } = worldWith(YARD, 50, 20);
    const [a, b, c, d] = [inVehicle(world), inVehicle(world), inVehicle(world), inVehicle(world)];
    expect(codeOf(() => put(world, block, a, 0, 0, 1))).toBe('stack_rule'); // vrstva 1 nad prázdnym stohom
    put(world, block, a, 0, 0, 0);
    expect(codeOf(() => put(world, block, b, 0, 0, 2))).toBe('stack_rule'); // preskočená vrstva
    expect(codeOf(() => put(world, block, b, 0, 0, 0))).toBe('slot_occupied');
    put(world, block, b, 0, 0, 1);
    put(world, block, c, 0, 0, 2);
    expect([block.stackHeight(0, 0), block.topUnit(0, 0), block.stackHeight(1, 0), block.topUnit(1, 0)]).toEqual([3, c, 0, null]);
    expect(codeOf(() => put(world, block, d, 0, 0, 3))).toBe('invalid_slot'); // nad maxTier bunka neexistuje
    put(world, block, d, 1, 0, 0);
    expect([block.usedTeu, block.freeCount, block.findStackProblem(), findWorldViolation(world)]).toEqual([4, 44, undefined, undefined]);
  });

  it('berie sa len vrchný kontajner: spodný zlyhá (not_top), po odobratí vrchného ide ďalší; nič sa pri chybe nezmení', () => {
    const { world, block } = worldWith(YARD, 50, 20);
    const [a, b, c] = [inVehicle(world), inVehicle(world), inVehicle(world)];
    put(world, block, a, 2, 1, 0);
    put(world, block, b, 2, 1, 1);
    put(world, block, c, 2, 1, 2);
    expect([codeOf(() => take(world, a)), codeOf(() => take(world, b))]).toEqual(['not_top', 'not_top']);
    expect(world.cargo.get(a)?.location.kind).toBe('in_storage');
    expect([block.burialDepth(a), block.burialDepth(b), block.burialDepth(c), block.topBlockerOf(a)]).toEqual([2, 1, 0, c]);
    take(world, c);
    expect([block.stackHeight(2, 1), block.topUnit(2, 1)]).toEqual([2, b]);
    take(world, b);
    take(world, a);
    expect([block.stackHeight(2, 1), block.topUnit(2, 1), block.usedTeu, block.findStackProblem()]).toEqual([0, null, 0, undefined]);
  });
});

describe('pravidlá stohu — 40′', () => {
  it('40′ zaberá pár bays (2k, 2k+1): párny bay, rovnako vysoký pár; TEU sa rátajú 2', () => {
    const { world, block } = worldWith(YARD, 50, 20);
    const [odd, ok, second] = [inVehicle(world, 40), inVehicle(world, 40), inVehicle(world, 40)];
    expect(codeOf(() => put(world, block, odd, 1, 0, 0))).toBe('stack_rule'); // nepárny bay
    put(world, block, ok, 0, 0, 0);
    expect([block.stackHeight(0, 0), block.stackHeight(1, 0), block.topUnit(0, 0), block.topUnit(1, 0), block.usedTeu]).toEqual([1, 1, ok, ok, 2]);
    expect(block.unitInCell(1, 0, 0)).toBe(ok); // bunka tieňa
    put(world, block, second, 0, 0, 1); // 40′ na 40′
    expect([block.stackHeight(0, 0), block.stackHeight(1, 0), block.usedTeu, block.findStackProblem()]).toEqual([2, 2, 4, undefined]);
  });

  it('40′ nejde na pár s nerovnakou výškou, na 20′ ani nad maxTier; 20′ nejde na 40′', () => {
    const { world, block } = worldWith(YARD, 50, 20);
    const small = inVehicle(world, 20);
    put(world, block, small, 1, 1, 0); // stĺpec (1, 1) výška 1, (0, 1) výška 0
    const wideOnUneven = inVehicle(world, 40);
    expect(codeOf(() => put(world, block, wideOnUneven, 0, 1, 0))).toBe('stack_rule');
    const wide = inVehicle(world, 40);
    put(world, block, wide, 2, 1, 0);
    const smallOnWide = inVehicle(world, 20);
    expect(codeOf(() => put(world, block, smallOnWide, 2, 1, 1))).toBe('stack_rule');
    expect(codeOf(() => put(world, block, smallOnWide, 3, 1, 1))).toBe('stack_rule');
    const wideOnSmall = inVehicle(world, 40);
    const smallPair = [inVehicle(world, 20), inVehicle(world, 20)];
    put(world, block, smallPair[0], 0, 2, 0);
    put(world, block, smallPair[1], 1, 2, 0);
    expect(codeOf(() => put(world, block, wideOnSmall, 0, 2, 1))).toBe('stack_rule'); // pod 40′ musí byť 40′ alebo zem
    // 40′ do výšky maxTier: tri vrstvy sú povolené, štvrtá bunka neexistuje.
    const tower = [inVehicle(world, 40), inVehicle(world, 40), inVehicle(world, 40)];
    tower.forEach((unit, tier) => put(world, block, unit, 0, 3, tier));
    expect([block.stackHeight(0, 3), block.stackHeight(1, 3), block.usedTeu, block.findStackProblem()]).toEqual([3, 3, 1 + 2 + 2 + 6, undefined]);
  });

  it('40′ sa berie len zhora a uvoľní oba stĺpce; zlá veľkosť pod ním sa nedá obísť', () => {
    const { world, block } = worldWith(YARD, 50, 20);
    const [low, high] = [inVehicle(world, 40), inVehicle(world, 40)];
    put(world, block, low, 2, 0, 0);
    put(world, block, high, 2, 0, 1);
    expect(codeOf(() => take(world, low))).toBe('not_top');
    take(world, high);
    expect([block.stackHeight(2, 0), block.stackHeight(3, 0)]).toEqual([1, 1]);
    take(world, low);
    expect([block.stackHeight(2, 0), block.stackHeight(3, 0), block.topUnit(3, 0), block.usedTeu]).toEqual([0, 0, null, 0]);
  });
});

describe('StackGrid je odvodená cache: obnova zo save ju zostaví z ledgera', () => {
  it('roundtrip serialize → deserialize dá rovnaké výšky, vrchy aj počty TEU', () => {
    const { world, block } = worldWith(YARD, 50, 20);
    const units = [inVehicle(world, 20), inVehicle(world, 20), inVehicle(world, 40), inVehicle(world, 40)];
    put(world, block, units[0], 0, 0, 0);
    put(world, block, units[1], 0, 0, 1);
    put(world, block, units[2], 2, 2, 0);
    put(world, block, units[3], 2, 2, 1);
    const restored = World.deserialize(DEFS, BARE_MAP, JSON.parse(JSON.stringify(world.serialize())) as WorldState);
    const copy = restored.modules.get(block.id);
    if (!(copy instanceof YardBlock)) throw new Error('chýba YardBlock');
    for (let bay = 0; bay < 4; bay++) {
      for (let row = 0; row < 4; row++) expect([copy.stackHeight(bay, row), copy.topUnit(bay, row)]).toEqual([block.stackHeight(bay, row), block.topUnit(bay, row)]);
    }
    expect([copy.usedTeu, copy.findStackProblem(), findWorldViolation(restored)]).toEqual([6, undefined, undefined]);
  });
});

describe('rezervácie buniek', () => {
  it('rezervácia 40′ drží aj bunku tieňa; effectiveHeight počíta rezervácie; uvoľnenie vráti TEU', () => {
    const { world, block } = worldWith(YARD, 50, 20);
    const wide = inVehicle(world, 40);
    const unit = world.cargo.get(wide);
    if (unit === undefined) throw new Error('chýba jednotka');
    block.reserveFor(block.slotOf(2, 1, 0), unit);
    expect([block.reservedTeu, block.reservedCount, block.freeCount, block.effectiveHeight(2, 1), block.effectiveHeight(3, 1), block.effectiveHeight(0, 1)]).toEqual([2, 1, 46, 1, 1, 0]);
    expect([block.effectiveTopUnit(2, 1), block.effectiveTopSize(2, 1), block.effectiveTopSize(3, 1)]).toEqual([wide, 40, 40]);
    expect(codeOf(() => block.reserveFor(block.slotOf(2, 1, 0), unit))).toBe('slot_reserved');
    const small = world.cargo.get(inVehicle(world, 20));
    if (small === undefined) throw new Error('chýba jednotka');
    expect(codeOf(() => block.reserveFor(block.slotOf(3, 1, 0), small))).toBe('slot_reserved'); // bunka tieňa 40′ je rezervovaná, hoci `SlotReservations` pozná len kotvu
    expect(block.findStackProblem()).toBeUndefined();
    block.release(block.slotOf(2, 1, 0));
    expect([block.reservedTeu, block.effectiveHeight(2, 1)]).toEqual([0, 0]);
  });

  it('settleReservation: vozidlo, ktoré príde skôr, dostane skutočnú vrstvu a druhá rezervácia sa vymení', () => {
    const { world, block } = worldWith(YARD, 50, 20);
    const [first, second] = [inVehicle(world), inVehicle(world)];
    const units = [world.cargo.get(first), world.cargo.get(second)];
    if (units[0] === undefined || units[1] === undefined) throw new Error('chýba jednotka');
    const [lower, upper] = [block.slotOf(1, 1, 0), block.slotOf(1, 1, 1)];
    block.reserveFor(lower, units[0]);
    block.reserveFor(upper, units[1]);
    // `second` (rezervovaný na vrstvu 1) príde prvý: stoh je prázdny, takže dostane vrstvu 0 a `first` jeho vrstvu 1.
    expect(block.settleReservation(upper)).toEqual({ slot: lower, displaced: upper });
    expect(block.reservedSlots()).toEqual([lower, upper]);
    expect(block.findStackProblem()).toBeUndefined();
  });
});
