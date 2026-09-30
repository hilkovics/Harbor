// World a moduly (T02-03, ADR-014): placeModule/addModule/removeModule zapisujú cell.moduleId, žeriav stojí na
// bunkách berthu (craneIds, rozhodnutie 3), dotazy moduleAt/berthOfCell/craneAt, štrukturálne chyby sú atomické,
// world.ships je prázdna mapa, world.stats a assertInvariants.
import { describe, expect, it } from 'vitest';
import { SpawnShipDebugCommand } from '@sim/commands';
import { BerthModule, CraneModule, ModuleError, moduleRegistry, type ModuleErrorCode } from '@sim/modules';
import { StatResolver } from '@sim/tech';
import { World, WorldInvariantError } from '@sim/world';
import { newWorld, place, placeBerth, placeCrane } from '../modules/harbor-fixtures';
import { BERTH, CRANE, MODULE_DEFS, NARROW_CRANE, id } from '../modules/module-fixtures';
import { driveCrane, restoreCrane } from '../helpers/crane-state';

function errorCode(action: () => unknown): ModuleErrorCode | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof ModuleError) return error.code;
    throw error;
  }
  return undefined;
}

/** Svet s Root-like berthom (40,14) a žeriavom (43,14). */
function harbor(): { world: World; berth: BerthModule; crane: CraneModule } {
  const world = newWorld();
  const berth = placeBerth(world, 40);
  const crane = placeCrane(world, 43);
  return { world, berth, crane };
}

/** Serializovaný stav bez `ids` (placeModule mohol spotrebovať id pred chybou). */
function withoutIds(world: World): Record<string, unknown> {
  const state: Record<string, unknown> = { ...world.serialize() };
  delete state.ids;
  return state;
}

/** Počet buniek mriežky s daným moduleId. */
function cellsOwnedBy(world: World, moduleId: number): number {
  let count = 0;
  for (let i = 0; i < world.grid.cellCount; i++) if (world.grid.atIndex(i).moduleId === moduleId) count += 1;
  return count;
}

describe('World — moduly, nový svet', () => {
  it('nový svet na mape bez starter modulov (BARE_MAP; Root modul testuje starter-modules.test.ts): prázdne moduly, skupiny aj lode', () => {
    const world = newWorld();
    expect(world.modules.size).toBe(0);
    expect(world.berthGroups).toEqual([]);
    expect(world.ships.size).toBe(0);
    expect(world.stats).toBeInstanceOf(StatResolver);
    expect(() => world.assertInvariants()).not.toThrow();
  });
});

describe('World.ships (T02-05)', () => {
  it('serialize() uloží živú loď (Ship.toState) — loď sa zo save ticho nestratí', () => {
    const world = newWorld();
    world.enqueue(new SpawnShipDebugCommand({ shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 1 }));
    world.applyPending();
    const [ship] = world.ships.values();
    expect(world.serialize().ships).toEqual([ship.toState()]);
  });
});

describe('World.placeModule / addModule', () => {
  it('berth: id z alokátora, zaplatená cena, cell.moduleId na všetkých 24 bunkách', () => {
    const world = newWorld();
    const berth = place(world, BERTH, 40, 14, 0, 40_000_000);
    expect(berth).toBeInstanceOf(BerthModule);
    expect(berth.id).toBe(1);
    expect(world.ids.getState().nextId).toBe(2);
    expect(berth.purchaseCostCents).toBe(40_000_000);
    expect(world.modules.get(berth.id)).toBe(berth);
    expect(cellsOwnedBy(world, berth.id)).toBe(24);
    for (const { x, y } of berth.cells) expect(world.grid.at(x, y).moduleId).toBe(berth.id);
    // Hotovosť ani udalosti placeModule nemení — to je vec príkazu (T02-04).
    expect(world.cashCents).toBe(MODULE_DEFS.economy.startingCashCents);
    expect(world.events.pending).toBe(0);
  });

  it('žeriav: bunky ostávajú berthu, berth ho eviduje v craneIds (rozhodnutie 3)', () => {
    const { world, berth, crane } = harbor();
    expect(crane.berthId).toBe(berth.id);
    expect(berth.craneIds).toEqual([crane.id]);
    expect(cellsOwnedBy(world, berth.id)).toBe(24);
    expect(cellsOwnedBy(world, crane.id)).toBe(0);
    expect([...world.modules.keys()]).toEqual([berth.id, crane.id]);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('druhý žeriav vedľa prvého; tretí → max_cranes', () => {
    const { world, berth, crane } = harbor();
    const second = placeCrane(world, 45);
    expect(berth.craneIds).toEqual([crane.id, second.id]);
    expect(errorCode(() => placeCrane(world, 40))).toBe('max_cranes');
  });

  const INVALID: readonly [string, (world: World) => unknown, ModuleErrorCode][] = [
    ['berth cez berth', (w) => placeBerth(w, 44), 'occupied'],
    ['žeriav mimo berthu (pevnina)', (w) => placeCrane(w, 43, 20), 'no_berth'],
    ['žeriav presahuje berth (x 47–48)', (w) => placeCrane(w, 47), 'no_berth'],
    ['žeriav s inou rotáciou', (w) => place(w, CRANE, 41, 14, 90), 'rotation_mismatch'],
    ['žeriav cez žeriav', (w) => placeCrane(w, 44), 'crane_overlap'],
    ['footprint mimo mapy', (w) => placeBerth(w, 90), 'out_of_bounds'],
  ];
  it.each(INVALID)('%s → ModuleError %s, svet sa nezmení', (_name, action, code) => {
    const { world } = harbor();
    const before = withoutIds(world);
    expect(errorCode(() => action(world))).toBe(code);
    // placeModule pridelí id pred addModule, takže `ids` sa môže posunúť; inak sa nezmení nič.
    expect(withoutIds(world)).toEqual(before);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('bunka s cestou → road', () => {
    const world = newWorld();
    world.grid.at(45, 15).road = 'road';
    expect(errorCode(() => placeBerth(world, 40))).toBe('road');
    expect(world.modules.size).toBe(0);
    expect(cellsOwnedBy(world, 1)).toBe(0);
  });

  it('addModule: duplicitné id a id nepridelené alokátorom sú chyby', () => {
    const world = newWorld();
    const berth = placeBerth(world, 40);
    expect(errorCode(() => world.addModule(berth))).toBe('duplicate_id');
    const foreign = moduleRegistry.create(MODULE_DEFS.modules.get(BERTH), { defId: BERTH, x: 60, y: 14, rotation: 0 }, id(50), 0, {
      grid: world.grid,
      cargo: world.cargo,
    });
    expect(errorCode(() => world.addModule(foreign))).toBe('invalid_input');
    expect(world.modules.size).toBe(1);
  });

  it('úzky žeriav (1×3) sa zmestí ako tretí? nie — maxCranes platí pre všetky žeriavy', () => {
    const { world } = harbor();
    place(world, NARROW_CRANE, 41, 14);
    expect(errorCode(() => place(world, NARROW_CRANE, 46, 14))).toBe('max_cranes');
  });
});

describe('World.removeModule', () => {
  it('berth: uvoľní bunky, prepočíta skupiny a vráti modul', () => {
    const world = newWorld();
    const a = placeBerth(world, 40);
    const b = placeBerth(world, 48);
    expect(world.berthGroups[0].totalLength).toBe(16);
    expect(world.removeModule(b.id)).toBe(b);
    expect(world.modules.has(b.id)).toBe(false);
    expect(cellsOwnedBy(world, b.id)).toBe(0);
    expect(world.berthGroups).toEqual([{ id: 1, berthIds: [a.id], totalLength: 8, minDepth: 1 }]);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('žeriav: odpojí sa od berthu, bunky ostanú berthu; potom ide odstrániť aj berth', () => {
    const { world, berth, crane } = harbor();
    expect(errorCode(() => world.removeModule(berth.id))).toBe('has_cranes');
    world.removeModule(crane.id);
    expect(berth.craneIds).toEqual([]);
    expect(cellsOwnedBy(world, berth.id)).toBe(24);
    world.removeModule(berth.id);
    expect(world.modules.size).toBe(0);
    expect(cellsOwnedBy(world, berth.id)).toBe(0);
  });

  it('neznáme id → unknown_module', () => {
    expect(errorCode(() => newWorld().removeModule(id(99)))).toBe('unknown_module');
  });

  it('berth s loďou → ship_docked; s rezervovaným slotom apronu → has_cargo', () => {
    const world = newWorld();
    const berth = placeBerth(world, 40);
    berth.dockedShipId = id(77);
    expect(errorCode(() => world.removeModule(berth.id))).toBe('ship_docked');
    berth.dockedShipId = null;
    berth.apron.reserve();
    expect(errorCode(() => world.removeModule(berth.id))).toBe('has_cargo');
    expect(world.modules.has(berth.id)).toBe(true);
  });

  it('berth s nákladom na aprone → has_cargo', () => {
    const { world, berth, crane } = harbor();
    const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: id(500) }).id;
    world.cargo.move(unit, { kind: 'in_crane', craneId: crane.id });
    world.cargo.move(unit, { kind: 'on_apron', berthId: berth.id, slot: 0 });
    world.removeModule(crane.id);
    expect(errorCode(() => world.removeModule(berth.id))).toBe('has_cargo');
  });

  it('žeriav uprostred cyklu → busy; žeriav s jednotkou v ledgeri → has_cargo', () => {
    const { world, crane } = harbor();
    restoreCrane(crane, { state: 'grabbing', reservedSlot: 0, phaseTicksTotal: 6, phaseTicksLeft: 6 });
    expect(errorCode(() => world.removeModule(crane.id))).toBe('busy');
    restoreCrane(crane, { state: 'idle', reservedSlot: null, phaseTicksTotal: 0, phaseTicksLeft: 0 });
    const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: id(500) }).id;
    world.cargo.move(unit, { kind: 'in_crane', craneId: crane.id });
    expect(errorCode(() => world.removeModule(crane.id))).toBe('has_cargo');
  });

  it('žeriav na kotvisku s dokovanou loďou → ship_docked (T02-14), svet sa nezmení', () => {
    const { world, berth, crane } = harbor();
    world.enqueue(new SpawnShipDebugCommand({ shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 2 }));
    world.applyPending();
    const [ship] = world.ships.values();
    for (let i = 0; i < 1000 && ship.state !== 'docked'; i++) world.tick();
    expect(ship.state).toBe('docked');
    expect(berth.dockedShipId).toBe(ship.id);
    const before = JSON.stringify(world.serialize());
    expect(errorCode(() => world.removeModule(crane.id))).toBe('ship_docked');
    expect(() => world.removeModule(crane.id)).toThrow(/stojí na berth_standard #1, ktoré drží loď #\d+/);
    expect(JSON.stringify(world.serialize())).toBe(before);
    expect(berth.craneIds).toEqual([crane.id]);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('blokovaný žeriav bez jednotky ide odstrániť', () => {
    const { world, crane } = harbor();
    driveCrane(crane, 'blocked');
    expect(() => world.removeModule(crane.id)).not.toThrow();
  });
});

describe('World — dotazy na bunky', () => {
  it('moduleAt = vlastník bunky (pri žeriave berth), berthOfCell, craneAt', () => {
    const { world, berth, crane } = harbor();
    expect(world.moduleAt(43, 15)).toBe(berth);
    expect(world.berthOfCell(43, 15)).toBe(berth);
    expect(world.craneAt(43, 15)).toBe(crane);
    expect(world.craneAt(44, 16)).toBe(crane);
    expect(world.craneAt(45, 15)).toBeUndefined();
    expect(world.moduleAt(40, 14)).toBe(berth);
    expect(world.moduleAt(48, 14)).toBeUndefined();
    expect(world.berthOfCell(48, 14)).toBeUndefined();
    expect(world.craneAt(48, 14)).toBeUndefined();
  });

  it('mimo mapy → undefined (bez výnimky)', () => {
    const { world } = harbor();
    expect(world.moduleAt(-1, 0)).toBeUndefined();
    expect(world.moduleAt(world.grid.width, 0)).toBeUndefined();
    expect(world.berthOfCell(0.5, 14)).toBeUndefined();
    expect(world.craneAt(-3, -3)).toBeUndefined();
  });
});

describe('World.stats — StatResolver (§10)', () => {
  it('cycleTicks žeriavu = základ z defu (bez modifikátorov)', () => {
    const { world, crane } = harbor();
    expect(world.stats.resolve('module', crane.def.id, 'cycleTicks')).toBe(12);
    expect(world.stats.resolve('module', BERTH, 'apronSlots')).toBe(4);
  });
});

describe('World.assertInvariants', () => {
  it('prejde na konzistentnom svete s nákladom na aprone a v žeriave', () => {
    const { world, berth, crane } = harbor();
    const [a, b] = [0, 1].map(() => world.cargo.create('container_teu', { kind: 'on_ship', shipId: id(500) }).id);
    world.cargo.move(a, { kind: 'in_crane', craneId: crane.id });
    world.cargo.move(a, { kind: 'on_apron', berthId: berth.id, slot: 2 });
    const slot = berth.apron.reserve();
    world.cargo.move(b, { kind: 'in_crane', craneId: crane.id });
    restoreCrane(crane, { state: 'placing', reservedSlot: slot, phaseTicksTotal: 6, phaseTicksLeft: 3 });
    crane.heldUnitId = b;
    // Jednotky on_ship(500) sú u lode, ktorá ešte neexistuje — tú invariant zachytí; tu už žiadna nie je.
    expect(world.cargo.countByKind('on_ship')).toBe(0);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('náklad u neexistujúcej lode → WorldInvariantError', () => {
    const world = newWorld();
    world.cargo.create('container_teu', { kind: 'on_ship', shipId: id(500) });
    expect(() => world.assertInvariants()).toThrow(WorldInvariantError);
    expect(() => world.assertInvariants()).toThrow(/on_ship/);
  });
});
