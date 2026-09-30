// RemoveModule (T02-04, ARCHITECTURE §8 bod 8; ADR-015, rozhodnutie 2): odmietne unknown_module, has_cargo,
// ship_docked, has_cranes, busy; refundácia = refundCents(purchaseCostCents, removalRefundRate) zo ZAPLATENEJ ceny,
// cells = footprint modulu, costCents = −refundácia; apply uvoľní bunky, emituje ModuleRemoved a pri refundácii > 0
// MoneyChanged(module_sale).
import { describe, expect, it } from 'vitest';
import { PlaceModuleCommand, RemoveModuleCommand, commandFromJSON, refundCents } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { BerthModule, CraneModule } from '@sim/modules';
import type { World } from '@sim/world';
import { DEFS, REFUND_RATE, START_CASH, defsWith, hashState, newBareWorld, ofType } from './command-fixtures';

const BERTH = 'berth_standard';
const CRANE = 'crane_container_gantry';
const BERTH_COST = DEFS.modules.get(BERTH).costCents;
const CRANE_COST = DEFS.modules.get(CRANE).costCents;

const id = (value: number): EntityId => value as EntityId;
const remove = (moduleId: number): RemoveModuleCommand => new RemoveModuleCommand(moduleId);

/** Postaví modul skutočným PlaceModule (zaplatí cenu defu) a zahodí udalosti. */
function buy(world: World, defId: string, x: number, y = 14): World {
  const command = new PlaceModuleCommand({ defId, x, y, rotation: 0 });
  expect(command.validate(world).reasons).toEqual([]);
  command.apply(world);
  world.events.flush();
  return world;
}

/** Svet s kúpeným kotviskom #1 na (40, 14) a žeriavom #2 na (43, 14). */
function harbor(world = newBareWorld()): { world: World; berth: BerthModule; crane: CraneModule } {
  buy(buy(world, BERTH, 40), CRANE, 43);
  const berth = world.modules.get(id(1));
  const crane = world.modules.get(id(2));
  if (!(berth instanceof BerthModule) || !(crane instanceof CraneModule)) throw new Error('zlé triedy modulov');
  return { world, berth, crane };
}

describe('RemoveModule — refundácia zo zaplatenej ceny', () => {
  it('kúpený žeriav: validate { ok, cells = footprint, costCents = −50 % }, apply vráti peniaze a emituje udalosti', () => {
    const { world, berth, crane } = harbor();
    const cash = world.cashCents;
    const refund = refundCents(CRANE_COST, REFUND_RATE);
    expect(refund).toBe(CRANE_COST / 2);

    const command = remove(crane.id);
    expect(command.validate(world)).toEqual({ ok: true, reasons: [], cells: crane.cells, costCents: -refund });
    command.apply(world);

    expect(world.modules.has(crane.id)).toBe(false);
    expect(berth.craneIds).toEqual([]);
    expect(world.grid.at(43, 14).moduleId).toBe(berth.id); // bunky ostávajú berthu
    expect(world.cashCents).toBe(cash + refund);
    expect(world.events.flush()).toEqual([
      { type: 'ModuleRemoved', moduleId: crane.id, defId: CRANE, cells: crane.cells },
      { type: 'MoneyChanged', cashCents: cash + refund, deltaCents: refund, reason: 'module_sale' },
    ]);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('kúpený berth bez žeriavov: bunky sa uvoľnia, skupiny prepočítajú, refundácia 50 %', () => {
    const world = buy(buy(newBareWorld(), BERTH, 40), BERTH, 48);
    expect(world.berthGroups[0].totalLength).toBe(16);
    const cash = world.cashCents;
    remove(2).apply(world);
    for (let x = 48; x < 56; x++) expect(world.grid.at(x, 14).moduleId).toBeNull();
    expect(world.berthGroups).toEqual([{ id: 1, berthIds: [1], totalLength: 8, minDepth: 1 }]);
    expect(world.cashCents).toBe(cash + refundCents(BERTH_COST, REFUND_RATE));
  });

  it('refundácia sa počíta zo zaplatenej ceny, nie z ceny v defe', () => {
    const world = newBareWorld();
    const module = world.placeModule({ defId: BERTH, x: 40, y: 14, rotation: 0 }, 12_345);
    expect(remove(module.id).validate(world).costCents).toBe(-refundCents(12_345, REFUND_RATE));
    expect(refundCents(12_345, REFUND_RATE)).toBe(6_172);
  });

  it('modul so zaplatenou cenou 0 (ako starter): costCents 0, žiadny MoneyChanged, len ModuleRemoved', () => {
    const world = newBareWorld();
    const module = world.placeModule({ defId: BERTH, x: 40, y: 14, rotation: 0 }, 0);
    const command = remove(module.id);
    expect(command.validate(world)).toEqual({ ok: true, reasons: [], cells: module.cells, costCents: 0 });
    expect(Object.is(command.validate(world).costCents, 0)).toBe(true);
    command.apply(world);
    expect(world.cashCents).toBe(START_CASH);
    expect(world.events.flush().map((e) => e.type)).toEqual(['ModuleRemoved']);
  });

  it('miera z economy.removalRefundRate v bázických bodoch (0.29 × 40 000 000 = 11 600 000)', () => {
    const world = newBareWorld(defsWith({ removalRefundRate: 0.29 }));
    buy(world, BERTH, 40);
    expect(remove(1).validate(world).costCents).toBe(-11_600_000);
  });

  it('odstránenie prejde aj pri zápornej hotovosti (refundácia nie je výdavok)', () => {
    const { world, crane } = harbor();
    world.cashCents = -1_000;
    expect(remove(crane.id).validate(world).ok).toBe(true);
  });
});

describe('RemoveModule — odmietnutia', () => {
  it('neznáme id → unknown_module bez buniek a ceny', () => {
    expect(remove(99).validate(newBareWorld())).toEqual({ ok: false, reasons: ['unknown_module'], cells: [], costCents: 0 });
    expect(remove(0).validate(newBareWorld()).reasons).toEqual(['unknown_module']);
  });

  it('berth so žeriavom → has_cranes (cells a costCents berthu ostávajú pre ghost)', () => {
    const { world, berth } = harbor();
    expect(remove(berth.id).validate(world)).toEqual({
      ok: false,
      reasons: ['has_cranes'],
      cells: berth.cells,
      costCents: -refundCents(BERTH_COST, REFUND_RATE),
    });
  });

  it('berth s loďou → ship_docked; s rezervovaným slotom apronu → has_cargo; spolu všetky naraz', () => {
    const { world, berth } = harbor();
    berth.dockedShipId = id(77);
    expect(remove(berth.id).validate(world).reasons).toEqual(['has_cranes', 'ship_docked']);
    berth.apron.reserve();
    expect(remove(berth.id).validate(world).reasons).toEqual(['has_cranes', 'has_cargo', 'ship_docked']);
  });

  it('berth s nákladom na aprone → has_cargo', () => {
    const { world, berth, crane } = harbor();
    const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: id(500) }).id;
    world.cargo.move(unit, { kind: 'in_crane', craneId: crane.id });
    world.cargo.move(unit, { kind: 'on_apron', berthId: berth.id, slot: 0 });
    berth.apron.reserveSlot(0);
    berth.apron.commit(0, unit);
    remove(crane.id).apply(world);
    expect(remove(berth.id).validate(world).reasons).toEqual(['has_cargo']);
  });

  it('žeriav uprostred cyklu → busy; s jednotkou → has_cargo aj busy; blokovaný bez jednotky ide odstrániť', () => {
    const { world, berth, crane } = harbor();
    Object.assign(crane, { state: 'grabbing', reservedSlot: berth.apron.reserve() });
    expect(remove(crane.id).validate(world).reasons).toEqual(['busy']);

    const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: id(500) }).id;
    world.cargo.move(unit, { kind: 'in_crane', craneId: crane.id });
    Object.assign(crane, { state: 'placing', heldUnitId: unit });
    expect(remove(crane.id).validate(world).reasons).toEqual(['has_cargo', 'busy']);

    const other = harbor();
    other.crane.state = 'blocked';
    expect(remove(other.crane.id).validate(other.world).ok).toBe(true);
  });

  it('validate nemení svet; apply bez platnej validácie vyhodí Error a nezmení nič', () => {
    const { world, berth } = harbor();
    const before = hashState(world.serialize());
    remove(berth.id).validate(world);
    remove(99).validate(world);
    expect(hashState(world.serialize())).toBe(before);
    expect(() => remove(berth.id).apply(world)).toThrow(/RemoveModule\.apply: príkaz nie je platný \(has_cranes\)/);
    expect(() => remove(99).apply(world)).toThrow(/unknown_module/);
    expect(hashState(world.serialize())).toBe(before);
    expect(world.events.pending).toBe(0);
  });
});

describe('RemoveModule — cez frontu sveta', () => {
  it('žeriav, potom berth v jednom kole prejde; opačné poradie odmietne berth (has_cranes)', () => {
    const inOrder = harbor().world;
    inOrder.enqueue(commandFromJSON({ type: 'RemoveModule', moduleId: 2 }));
    inOrder.enqueue(commandFromJSON({ type: 'RemoveModule', moduleId: 1 }));
    const events = inOrder.applyPending();
    expect(ofType(events, 'ModuleRemoved').map((e) => e.moduleId)).toEqual([2, 1]);
    expect(ofType(events, 'CommandRejected')).toEqual([]);
    expect(inOrder.modules.size).toBe(0);
    expect(inOrder.cashCents).toBe(START_CASH - BERTH_COST - CRANE_COST + refundCents(BERTH_COST, REFUND_RATE) + refundCents(CRANE_COST, REFUND_RATE));

    const reversed = harbor().world;
    reversed.enqueue(commandFromJSON({ type: 'RemoveModule', moduleId: 1 }));
    reversed.enqueue(commandFromJSON({ type: 'RemoveModule', moduleId: 2 }));
    const rejected = ofType(reversed.applyPending(), 'CommandRejected');
    expect(rejected).toEqual([{ type: 'CommandRejected', commandType: 'RemoveModule', reasons: ['has_cranes'] }]);
    expect([...reversed.modules.keys()]).toEqual([1]);
  });

  it('postav + predaj = štart − cena + refundácia; svet je konzistentný', () => {
    const world = newBareWorld();
    world.enqueue(commandFromJSON({ type: 'PlaceModule', defId: BERTH, x: 40, y: 14, rotation: 0 }));
    world.enqueue(commandFromJSON({ type: 'RemoveModule', moduleId: 1 }));
    world.applyPending();
    expect(world.cashCents).toBe(START_CASH - BERTH_COST + refundCents(BERTH_COST, REFUND_RATE));
    expect(world.modules.size).toBe(0);
    expect(world.berthGroups).toEqual([]);
    expect(() => world.assertInvariants()).not.toThrow();
  });
});
