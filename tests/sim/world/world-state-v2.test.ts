// WorldState v2 — moduly a náklad (T02-03, ARCHITECTURE §14, ADR-014): roundtrip modulov (poradie, triedy, bunky,
// craneIds, runtime žeriavov), odvodený stav z ledgera (obsadenie apronov vo FIFO, držaná jednotka žeriavu),
// rezervácie apronov z reservedSlot žeriavov a validácia s JSON pointerom.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { BerthModule, CraneModule, type CraneRuntimeState } from '@sim/modules';
import { World, WorldStateError, type WorldState } from '@sim/world';
import { newWorld, placeBerth, placeCrane } from '../modules/harbor-fixtures';
import { BERTH, CRANE, MODULE_DEFS, id } from '../modules/module-fixtures';
import { MAP, hashState, runTicks } from './world-fixtures';
import { restoreCrane } from '../helpers/crane-state';

const TEU = 'container_teu';
/** Loď, ktorá vo svete neexistuje — len zdroj jednotiek (každá sa z nej hneď presunie). */
const SOURCE_SHIP = id(900);

function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface ModuleWorld {
  readonly world: World;
  readonly berthA: BerthModule;
  readonly crane1: CraneModule;
  readonly crane2: CraneModule;
  readonly berthB: BerthModule;
  readonly units: readonly EntityId[];
}

/**
 * Berth A (40,14) so žeriavmi C1 (43,14) a C2 (45,14), berth B (48,14). Po 800 tickoch (hodina 2):
 * u5 na aprone A slot 0; u6 drží C1 (`placing`, rezervovaný slot 1 na A); u7 na aprone B slot 2, u8 na B slot 0
 * (FIFO [u7, u8] ≠ poradie slotov); C2 `blocked` s počítadlami. Id: A 1, C1 2, C2 3, B 4, u5–u8 5–8.
 * Poradie jednotiek v save (kanonické): [u6 in_crane, u5 apron A, u7 apron B, u8 apron B].
 */
function moduleWorld(): ModuleWorld {
  const world = newWorld();
  runTicks(world, 800);
  const berthA = placeBerth(world, 40);
  const crane1 = placeCrane(world, 43);
  const crane2 = placeCrane(world, 45);
  const berthB = placeBerth(world, 48);
  const units = [0, 1, 2, 3].map(() => world.cargo.create(TEU, { kind: 'on_ship', shipId: SOURCE_SHIP }).id);
  const [u5, u6, u7, u8] = units;
  const toApron = (unit: EntityId, berth: BerthModule, slot: number, via: CraneModule): void => {
    world.cargo.move(unit, { kind: 'in_crane', craneId: via.id });
    world.cargo.move(unit, { kind: 'on_apron', berthId: berth.id, slot });
  };
  toApron(u5, berthA, 0, crane1);
  world.cargo.move(u6, { kind: 'in_crane', craneId: crane1.id });
  restoreCrane(crane1, { state: 'placing', reservedSlot: berthA.apron.reserve(), phaseTicksTotal: 6, phaseTicksLeft: 3 });
  crane1.heldUnitId = u6;
  toApron(u7, berthB, 2, crane2);
  toApron(u8, berthB, 0, crane2);
  restoreCrane(crane2, { state: 'blocked', busyTicks: 10, idleTicks: 750, blockedTicks: 40, lastBlockedHour: 1 });
  world.applyPending();
  return { world, berthA, crane1, crane2, berthB, units };
}

describe('WorldState v2 — moduly v save', () => {
  it('modules: poradie umiestnenia, presne kľúče, runtime berthu {} a žeriavu podľa CraneRuntimeState', () => {
    const { world } = moduleWorld();
    world.assertInvariants();
    const state = world.serialize();
    expect(state.modules.map((m) => [m.id, m.defId, m.x, m.y, m.rotation, m.purchaseCostCents])).toEqual([
      [1, BERTH, 40, 14, 0, 0],
      [2, CRANE, 43, 14, 0, 0],
      [3, CRANE, 45, 14, 0, 0],
      [4, BERTH, 48, 14, 0, 0],
    ]);
    for (const entry of state.modules) expect(Object.keys(entry)).toEqual(['id', 'defId', 'x', 'y', 'rotation', 'purchaseCostCents', 'runtime']);
    expect(state.modules[0].runtime).toEqual({ lastNoStorageHour: null }); // v3: kotvisko ukladá throttle NoStorageAvailable (ADR-018)
    expect(state.modules[1].runtime).toEqual({
      state: 'placing',
      phaseTicksTotal: 6,
      phaseTicksLeft: 3,
      reservedSlot: 1,
      busyTicks: 0,
      idleTicks: 0,
      blockedTicks: 0,
      lastBlockedHour: null,
    } satisfies CraneRuntimeState);
    expect(state.cargo.units.map((u) => [u.id, u.location])).toEqual([
      [6, { kind: 'in_crane', craneId: 2 }],
      [5, { kind: 'on_apron', berthId: 1, slot: 0 }],
      [7, { kind: 'on_apron', berthId: 4, slot: 2 }],
      [8, { kind: 'on_apron', berthId: 4, slot: 0 }],
    ]);
    expect(viaJson(state)).toEqual(state);
  });

  it('purchaseCostCents sa ukladá (zaplatená cena, nie cena defu)', () => {
    const world = newWorld();
    world.placeModule({ defId: BERTH, x: 40, y: 14, rotation: 0 }, 123_456);
    const restored = World.deserialize(MODULE_DEFS, MAP, viaJson(world.serialize()));
    expect(restored.modules.get(id(1))?.purchaseCostCents).toBe(123_456);
  });

  it('roundtrip: rovnaké moduly (triedy, bunky, craneIds, skupiny), aprony vo FIFO, držaná jednotka, rezervácie', () => {
    const { world } = moduleWorld();
    const state = viaJson(world.serialize());
    const restored = World.deserialize(MODULE_DEFS, MAP, state);
    expect(restored.serialize()).toEqual(state);
    expect(() => restored.assertInvariants()).not.toThrow();

    expect([...restored.modules.keys()]).toEqual([1, 2, 3, 4]);
    const a = restored.modules.get(id(1));
    const c1 = restored.modules.get(id(2));
    const c2 = restored.modules.get(id(3));
    const b = restored.modules.get(id(4));
    if (!(a instanceof BerthModule && b instanceof BerthModule && c1 instanceof CraneModule && c2 instanceof CraneModule)) {
      throw new Error('obnovené moduly majú zlé triedy');
    }
    expect(a.craneIds).toEqual([2, 3]);
    expect(b.craneIds).toEqual([]);
    expect(restored.moduleAt(43, 15)).toBe(a);
    expect(restored.craneAt(46, 16)).toBe(c2);
    expect(restored.berthGroups).toEqual([{ id: 1, berthIds: [1, 4], totalLength: 16, minDepth: 1 }]);
    expect([a.groupId, b.groupId]).toEqual([1, 1]);

    expect(a.apron.units()).toEqual([5]);
    expect(a.apron.reservedSlots()).toEqual([1]);
    expect(b.apron.units()).toEqual([7, 8]);
    expect([b.apron.slotOf(id(7)), b.apron.slotOf(id(8))]).toEqual([2, 0]);
    expect([b.apron.usedCount, b.apron.reservedCount, b.apron.capacity]).toEqual([2, 0, 8]);
    expect(c1.heldUnitId).toBe(6);
    expect(c1.reservedSlot).toBe(1);
    expect(c2.heldUnitId).toBeNull();
    expect(c2.getRuntimeState()).toEqual(world.modules.get(id(3))?.getRuntimeState());
    for (let i = 0; i < world.grid.cellCount; i++) expect(restored.grid.atIndex(i)).toEqual(world.grid.atIndex(i));
  });

  it('obnovený svet pokračuje rovnako ako pôvodný (hash po 1 000 tickoch) a nezdieľa s ním stav', () => {
    const { world } = moduleWorld();
    const restored = World.deserialize(MODULE_DEFS, MAP, viaJson(world.serialize()));
    runTicks(world, 1000);
    runTicks(restored, 1000);
    expect(hashState(restored.serialize())).toBe(hashState(world.serialize()));
    const berth = restored.modules.get(id(4));
    if (!(berth instanceof BerthModule)) throw new Error('berth B');
    berth.apron.reserve();
    const original = world.modules.get(id(4));
    expect(original instanceof BerthModule && original.apron.reservedCount).toBe(0);
  });

  it('odstránený modul sa do save nedostane a obnovený svet ho nemá', () => {
    const world = newWorld();
    placeBerth(world, 40);
    const extra = placeBerth(world, 48);
    world.removeModule(extra.id);
    const restored = World.deserialize(MODULE_DEFS, MAP, viaJson(world.serialize()));
    expect([...restored.modules.keys()]).toEqual([1]);
    expect(restored.moduleAt(50, 15)).toBeUndefined();
  });
});

describe('WorldState v2 — neplatné moduly a náklad → WorldStateError', () => {
  type Mutation = (state: {
    modules: Record<string, unknown>[];
    cargo: { units: { id: number; location: Record<string, unknown> }[] };
    ids: { nextId: number };
  }) => void;
  const runtime = (state: Parameters<Mutation>[0], index: number): Record<string, unknown> =>
    state.modules[index].runtime as Record<string, unknown>;
  const IDLE_CRANE: CraneRuntimeState = {
    state: 'idle',
    phaseTicksTotal: 0,
    phaseTicksLeft: 0,
    reservedSlot: null,
    busyTicks: 0,
    idleTicks: 0,
    blockedTicks: 0,
    lastBlockedHour: null,
  };

  const INVALID: readonly [string, string, Mutation][] = [
    ['neznámy kľúč modulu', '/modules/0/extra', (s) => (s.modules[0].extra = 1)],
    ['chýba runtime', '/modules/0/runtime', (s) => delete s.modules[0].runtime],
    ['id 0', '/modules/0/id', (s) => (s.modules[0].id = 0)],
    ['id ≥ ids.nextId', '/modules/0/id', (s) => (s.modules[0].id = s.ids.nextId)],
    ['duplicitné id', '/modules/1/id', (s) => (s.modules[1].id = 1)],
    ['neznámy defId', '/modules/0/defId', (s) => (s.modules[0].defId = 'berth_missing')],
    ['záporné x', '/modules/0/x', (s) => (s.modules[0].x = -1)],
    ['zlomkové y', '/modules/0/y', (s) => (s.modules[0].y = 14.5)],
    ['rotácia 45', '/modules/0/rotation', (s) => (s.modules[0].rotation = 45)],
    ['záporná zaplatená cena', '/modules/0/purchaseCostCents', (s) => (s.modules[0].purchaseCostCents = -1)],
    ['runtime nie je objekt', '/modules/0/runtime', (s) => (s.modules[0].runtime = [])],
    ['runtime berthu s kľúčom', '/modules/0/runtime/apron', (s) => (s.modules[0].runtime = { apron: {} })],
    ['footprint mimo mapy', '/modules/3', (s) => (s.modules[3].x = 95)],
    ['berth cez berth', '/modules/3', (s) => (s.modules[3].x = 44)],
    ['žeriav pred svojím berthom', '/modules/0', (s) => s.modules.splice(0, 2, s.modules[1], s.modules[0])],
    ['žeriav s inou rotáciou než berth', '/modules/2', (s) => (s.modules[2].rotation = 90)],
    ['žeriav presahuje berth', '/modules/2', (s) => (s.modules[2].x = 47)],
    [
      'tretí žeriav na berthe',
      '/modules/4',
      (s) => {
        s.ids.nextId += 1;
        s.modules.push({ id: s.ids.nextId - 1, defId: CRANE, x: 40, y: 14, rotation: 0, purchaseCostCents: 0, runtime: { ...IDLE_CRANE } });
      },
    ],
    ['neznámy stav žeriavu', '/modules/1/runtime/state', (s) => (runtime(s, 1).state = 'x')],
    ['rezervovaný slot mimo apronu', '/modules/1/runtime/reservedSlot', (s) => (runtime(s, 1).reservedSlot = 9)],
    [
      'dva žeriavy rezervujú ten istý slot',
      '/modules/2/runtime/reservedSlot',
      (s) => Object.assign(runtime(s, 2), { state: 'grabbing', reservedSlot: 1, phaseTicksTotal: 6, phaseTicksLeft: 6 }),
    ],
    // T02-14: nekonzistentná fáza žeriavu → WorldStateError pri deserialize (nie pád až v tick()).
    ['žeriav v placing so skončenou fázou', '/modules/1/runtime/phaseTicksLeft', (s) => (runtime(s, 1).phaseTicksLeft = 0)],
    ['blokovaný žeriav s bežiacou fázou', '/modules/2/runtime/phaseTicksLeft', (s) => Object.assign(runtime(s, 2), { phaseTicksTotal: 6, phaseTicksLeft: 2 })],
    ['žeriav v okamžitom stave swinging', '/modules/1/runtime/state', (s) => (runtime(s, 1).state = 'swinging')],
    ['hodina CraneBlocked v budúcnosti', '/modules/2/runtime/lastBlockedHour', (s) => (runtime(s, 2).lastBlockedHour = 99)],
    ['žeriav v placing bez jednotky in_crane', '/modules/1/runtime/state', (s) => (s.cargo.units[0].location = { kind: 'on_apron', berthId: 4, slot: 1 })],
    ['blokovaný žeriav drží jednotku', '/modules/2/runtime/state', (s) => (s.cargo.units[1].location = { kind: 'in_crane', craneId: 3 })],
    ['jednotka na neexistujúcom berthe', '/cargo/units/1/location/berthId', (s) => (s.cargo.units[1].location.berthId = 7)],
    ['jednotka na slote mimo apronu', '/cargo/units/1/location/slot', (s) => (s.cargo.units[1].location.slot = 8)],
    ['jednotka na slote rezervovanom žeriavom', '/cargo/units/1/location/slot', (s) => (s.cargo.units[1].location.slot = 1)],
    ['jednotka „v žeriave" berthu', '/cargo/units/0/location/craneId', (s) => (s.cargo.units[0].location = { kind: 'in_crane', craneId: 1 })],
    ['dve jednotky v jednom žeriave', '/cargo/units/1/location/craneId', (s) => (s.cargo.units[1].location = { kind: 'in_crane', craneId: 2 })],
    ['jednotka vo vozidle (vozidlá ešte neexistujú)', '/cargo/units/1/location/vehicleId', (s) => (s.cargo.units[1].location = { kind: 'in_vehicle', vehicleId: 3 })],
    ['jednotka na neexistujúcej lodi', '/cargo/units/1/location/shipId', (s) => (s.cargo.units[1].location = { kind: 'on_ship', shipId: 900 })],
    ['id jednotky = id modulu', '/cargo/units/1/id', (s) => (s.cargo.units[1].id = 4)],
  ];

  it.each(INVALID)('%s → WorldStateError na %s', (_name, path, mutate) => {
    const state = viaJson(moduleWorld().world.serialize()) as unknown as Parameters<Mutation>[0];
    mutate(state);
    let error: unknown;
    try {
      World.deserialize(MODULE_DEFS, MAP, state as unknown as WorldState);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe(path);
    expect((error as WorldStateError).message.startsWith(`WorldState${path}: `)).toBe(true);
  });

  it('kontrolný test: nezmenený stav sa načíta bez chyby', () => {
    const state = viaJson(moduleWorld().world.serialize());
    expect(() => World.deserialize(MODULE_DEFS, MAP, state)).not.toThrow();
  });
});
