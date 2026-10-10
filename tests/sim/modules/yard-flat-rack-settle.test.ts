// Regresia TR6-02b: usadenie rezervácie (`settleReservation`) nesmie dať flat rack / OOG pod kontajner, ktorý sa nad neho plánoval; plánovač taký stoh nevytvorí
// a invariant kroku 12 (`findWorldViolation`) zachytí každé takéto uloženie.
import { describe, expect, it } from 'vitest';
import { IMPORT_LABELS } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { YardBlock } from '@sim/modules';
import { chooseSlotInBlock } from '@sim/logistics/yard-planner';
import { World, findWorldViolation } from '@sim/world';
import { BARE_MAP, DEFS, SEED } from '../world/world-fixtures';

const id = (value: number): EntityId => value as EntityId;

function setup(): { world: World; block: YardBlock } {
  const world = World.create(DEFS, BARE_MAP, SEED);
  const block = world.placeModule({ defId: 'container_yard_small', x: 50, y: 20, rotation: 0 }, 0);
  if (!(block instanceof YardBlock)) throw new Error('nie je YardBlock');
  return { world, block };
}

/** Jednotka daného typu vo vozidle (reťazec §7.1 až `in_vehicle`). */
function inVehicle(world: World, containerType: string): EntityId {
  const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: id(900) }, null, { ...IMPORT_LABELS, containerType }).id;
  world.cargo.move(unit, { kind: 'in_crane', craneId: id(901) });
  world.cargo.move(unit, { kind: 'on_apron', berthId: id(902), slot: 0 });
  world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(903) });
  return unit;
}

describe('flat rack a usadenie rezervácie', () => {
  it('flat rack s rezerváciou nad kontajnerom, ktorý príde neskôr: usadenie by ho dalo pod neho — ModuleError stack_rule, nič sa nezmení', () => {
    const { world, block } = setup();
    const dry = world.cargo.get(inVehicle(world, 'dry'));
    const flat = world.cargo.get(inVehicle(world, 'flat_rack'));
    if (dry === undefined || flat === undefined) throw new Error('chýba jednotka');
    const [lower, upper] = [block.slotOf(1, 1, 0), block.slotOf(1, 1, 1)];
    block.reserveFor(lower, dry);
    block.reserveFor(upper, flat);
    const before = block.reservedSlots();
    expect(() => block.settleReservation(upper)).toThrowError(expect.objectContaining({ code: 'stack_rule' }));
    expect(block.reservedSlots()).toEqual(before);
    // Opačné poradie (kontajner príde prvý) je v poriadku: dostane vrstvu 0 a flat rack ostane navrchu.
    expect(block.settleReservation(lower)).toEqual({ slot: lower, displaced: null });
    expect(block.findStackProblem()).toBeUndefined();
  });

  it('plánovač neukladá flat rack na stoh s rozbehnutou rezerváciou (ani pod, ani nad ňu); na prázdny stoh a na uložený kontajner áno', () => {
    const { world, block } = setup();
    const flat = world.cargo.get(inVehicle(world, 'flat_rack'));
    if (flat === undefined) throw new Error('chýba jednotka');
    // Všetky stohy okrem (3, 3) zaberie rezervácia; flat rack smie len na (3, 3).
    const filler = world.cargo.get(inVehicle(world, 'dry'));
    if (filler === undefined) throw new Error('chýba jednotka');
    for (let row = 0; row < block.geometry.rows; row++) {
      for (let bay = 0; bay < block.geometry.bays; bay++) if (bay !== 3 || row !== 3) block.reserveFor(block.slotOf(bay, row, 0), { id: id(-1), sizeFt: 20 });
    }
    expect(chooseSlotInBlock(world, block, flat)).toBe(block.slotOf(3, 3, 0));
    block.reserveFor(block.slotOf(3, 3, 0), filler);
    // Teraz je každý stoh s rezerváciou: flat rack nemá kam (kontajner by sa mohol usadiť až po ňom).
    expect(chooseSlotInBlock(world, block, flat)).toBeNull();
    // Obyčajný kontajner sa na rezervovaný stoh ukladať smie.
    const dry = world.cargo.get(inVehicle(world, 'dry'));
    if (dry === undefined) throw new Error('chýba jednotka');
    expect(chooseSlotInBlock(world, block, dry)).not.toBeNull();
  });

  it('invariant kroku 12 zachytí flat rack pod kontajnerom (poškodený save: spodná jednotka je flat rack)', () => {
    const { world, block } = setup();
    const lower = inVehicle(world, 'dry');
    const upper = inVehicle(world, 'dry');
    world.cargo.move(lower, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(0, 0, 0) });
    world.cargo.move(upper, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(0, 0, 1) });
    expect(findWorldViolation(world)).toBeUndefined();
    const state = JSON.parse(JSON.stringify(world.serialize())) as { cargo: { units: { id: number; containerType: string }[] } };
    const target = state.cargo.units.find((unit) => unit.id === lower);
    if (target === undefined) throw new Error('chýba jednotka v save');
    target.containerType = 'flat_rack';
    // Obnova pustí svet cez invarianty (krok 12): jednotka na flat racku ho neprejde.
    expect(() => World.deserialize(world.defs, world.map, state as never)).toThrowError(/leží na flat racku/);
  });
});
