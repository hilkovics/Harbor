// T6D-03: lode na rejde v prezentácii — jednotné natočenie (kurz mapy `anchorageHeading`), nie kurz posledného úseku trasy.
// Skutočný sim (harbor_01, jedno kotvisko Root, štyri lode) → `SimBridge` snapshot / `shipVMs` → `ShipView` (pixi.js, bez DOM):
//  - každá loď na kotve má v VM aj vo view rovnaký uhol = `anchorageHeading` mapy (0 = predok na sever, 90 = východ), nezávisle od
//    smeru príchodu (západná strana rejdy: príchod kurzom 270, na kotve 90) a od triedy lode;
//  - kým loď pláva na rejdu, jej kurz sleduje trasu (kardinálne); na rejde sa zafixuje na kurz mapy;
//  - loď pri kotvisku má svoj kurz pri kotvisku (DOCKED_HEADING) — jednotné natočenie sa týka len rejdy.
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import { DOCKED_HEADING, type Ship } from '@sim/ships';
import { ShipView, shipPose } from '@render/ship-view';
import { shipVMs } from '@app/entities-vm';
import { createApp } from './app-fixtures';
import { ENTITY_PALETTE, PALETTE, StubTextures } from '../render/stub-textures';

const CELL = PALETTE.cellPx;
const deps = (): { cellPx: number; palette: typeof ENTITY_PALETTE; textures: StubTextures | null } => ({ cellPx: CELL, palette: ENTITY_PALETTE, textures: null });

function isResting(ship: Ship): boolean {
  return ship.state === 'waiting_anchorage' && ship.waypointIndex >= ship.route.length;
}

describe('lode na rejde: jednotné natočenie v prezentácii (T6D-03)', () => {
  it('všetky lode na kotve majú v ShipVM aj v ShipView uhol anchorageHeading; počas plavby kurz sleduje trasu', () => {
    const app = createApp();
    const { world } = app;
    const spawn = (classId: string): void => {
      app.bridge.dispatch(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: classId, cargoTypeId: 'container_teu', units: 40 }));
    };
    for (const classId of ['feeder', 'handy', 'feeder', 'handy']) spawn(classId);

    const sailingHeadings = new Set<number>();
    const ships = (): Ship[] => [...world.ships.values()];
    for (let i = 0; i < 6000 && !(ships().length === 4 && ships().filter(isResting).length === 3); i += 1) {
      world.tick();
      for (const ship of ships()) if (ship.state === 'waiting_anchorage' && !isResting(ship)) sailingHeadings.add(ship.heading);
    }
    const resting = ships().filter(isResting);
    expect(resting).toHaveLength(3);
    // lode plávali na rejdu rôznymi smermi (juh po dráhe, východ, západ), na kotve je kurz jeden
    expect([...sailingHeadings].sort()).toEqual(expect.arrayContaining([90, 180, 270]));

    const vms = shipVMs(world);
    const restingVms = vms.filter((vm) => vm.state === 'waiting_anchorage');
    expect(restingVms).toHaveLength(3);
    const expected = world.map.anchorageHeading;
    expect(restingVms.map((vm) => vm.heading)).toEqual([expected, expected, expected]);

    // ShipView: sprite sa otáča o `heading` (pixi uhol v stupňoch), rovnako pre feeder aj handy a pre všetky bunky rejdy
    const angles = restingVms.map((vm) => new ShipView(vm, deps(), 1).view.angle);
    expect(angles).toEqual([expected, expected, expected]);
    expect(restingVms.map((vm) => vm.classId)).toContain('feeder');
    expect(restingVms.map((vm) => vm.classId)).toContain('handy');
    expect(restingVms.map((vm) => shipPose(vm, 1, CELL).angle)).toEqual([expected, expected, expected]);

    // loď pri kotvisku (Root, strana n) má kurz pri kotvisku, nie kurz rejdy
    const berthed = vms.find((vm) => vm.state === 'docked' || vm.state === 'berthing' || vm.state === 'inbound');
    expect(berthed).toBeDefined();
    if (berthed?.state === 'docked') expect(berthed.heading).toBe(DOCKED_HEADING.n);
  });

  it('ShipView: loď, ktorá dopláva na rejdu kurzom 270 a na kotve sa natočí na kurz mapy, sa vykreslí s uhlom kurzu mapy', () => {
    const app = createApp();
    const { world } = app;
    for (const classId of ['feeder', 'handy', 'feeder', 'handy']) {
      app.bridge.dispatch(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: classId, cargoTypeId: 'container_teu', units: 40 }));
    }
    let view: ShipView | undefined;
    let sailedWest = false;
    for (let i = 0; i < 6000 && !(world.ships.size === 4 && [...world.ships.values()].filter(isResting).length === 3); i += 1) {
      world.tick();
      for (const vm of shipVMs(world)) {
        if (vm.state !== 'waiting_anchorage') continue;
        if (view?.id !== vm.id && vm.heading === 270) view = new ShipView(vm, deps(), 1);
        if (view?.id === vm.id) {
          view.update(vm, 1);
          sailedWest ||= view.view.angle === 270;
        }
      }
    }
    expect(view).toBeDefined();
    expect(sailedWest).toBe(true);
    // na konci plavby (loď stojí na rejde) je uhol view = kurz mapy
    const vm = shipVMs(world).find((candidate) => candidate.id === view?.id);
    if (vm === undefined || view === undefined) throw new Error('loď na rejde chýba');
    view.update(vm, 1);
    expect(view.view.angle).toBe(world.map.anchorageHeading);
  });
});
