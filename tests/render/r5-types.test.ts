// R5 (TR5-03): kontajnery podľa typu a OOG, odznak zásuvky, reefer rack a reach stacker — manifest, výber sprite, geometria výložníka.
import { describe, expect, it } from 'vitest';
import { containerKey, containerSpriteId } from '@render/container-sprites';
import { cargoSpriteEntry, entitySpriteFiles, moduleSprite, reachStackerSprite } from '@render/entity-assets';
import { MachineLayer } from '@render/machine-layer';
import { ReachStackerView, reachBoomExtension } from '@render/reach-stacker-view';
import type { ContainerVM, MachineVM } from '@render/view-models';
import { MACHINES, R5_SCENES, VM, rackPlugs } from '@render/__demo__/r5-types.fixtures';
import { ENTITY_PALETTE, PALETTE } from './stub-textures';

const CELL = PALETTE.cellPx;
const SCALE = CELL / 64;

function box(over: Partial<ContainerVM> = {}): ContainerVM {
  return { sizeFt: 20, containerType: 'dry', lineId: null, direction: 'import', ...over };
}

function deps() {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures: null };
}

describe('manifest R5', () => {
  it.each([
    ['container_20_reefer', 64, 26],
    ['container_40_reefer', 128, 26],
    ['container_20_open_top', 64, 26],
    ['container_40_open_top', 128, 26],
    ['container_20_flat_rack', 64, 26],
    ['container_40_flat_rack', 128, 26],
    ['container_20_tank', 64, 26],
    ['container_40_open_top_oog', 128, 34],
    ['container_40_flat_rack_oog', 128, 40],
  ] as const)('%s: %i × %i px, netónovateľný', (id, w, h) => {
    expect(cargoSpriteEntry(id)).toMatchObject({ size: { w, h }, file: `cargo/${id}.svg`, tintable: false });
  });

  it('reach stacker: telo 1×2, výložník s pivotom, mountom a travel 0–64, spreadery 20 a 40', () => {
    const entry = reachStackerSprite();
    expect(entry?.footprint).toEqual({ w: 1, h: 2 });
    expect(entry?.boom).toMatchObject({ pivot: { x: 32, y: 116 }, mount: { x: 32, y: 96 }, travel: { yMin: 0, yMax: 64 } });
    expect(entry?.spreader20).toMatchObject({ pivot: { x: 32, y: 27 }, head: { x: 32, y: 8 } });
    expect(entry?.spreader40).toMatchObject({ pivot: { x: 64, y: 27 }, footprint: { w: 2, h: 1 } });
  });

  it('reefer_rack je 1×1 modul; sprity R5 sa načítajú do atlasu', () => {
    expect(moduleSprite('reefer_rack')?.footprint).toEqual({ w: 1, h: 1 });
    const files = entitySpriteFiles();
    for (const file of ['cargo/container_40_flat_rack_oog.svg', 'overlay/reefer_plug_alarm.svg', 'overlay/reefer_plug_on.svg', 'overlay/reefer_plug_off.svg', 'entities/reach_stacker.svg', 'entities/reach_stacker_boom.svg', 'entities/reach_stacker_spreader_40.svg', 'modules/reefer_rack.svg']) {
      expect(files).toContain(file);
    }
  });
});

describe('výber sprite kontajnera podľa typu a OOG', () => {
  it.each([
    [box({ containerType: 'reefer' }), 'container_20_reefer'],
    [box({ sizeFt: 40, containerType: 'flat_rack' }), 'container_40_flat_rack'],
    [box({ sizeFt: 40, containerType: 'flat_rack', oog: true }), 'container_40_flat_rack_oog'],
    [box({ sizeFt: 40, containerType: 'open_top', oog: true }), 'container_40_open_top_oog'],
    [box({ sizeFt: 20, containerType: 'flat_rack', oog: true }), 'container_20_flat_rack'], // bez OOG sprite → bežný
    [box({ sizeFt: 40, containerType: 'tank' }), 'container_40_dry'], // 40′ tank nemá sprite → dry
    [box({ containerType: 'reefer', direction: 'empty', oog: true }), 'container_20_empty'],
  ])('%j → %s', (container, id) => {
    expect(containerSpriteId(container)).toBe(id);
  });

  it('kľúč kontajnera rozlišuje OOG a stav zásuvky', () => {
    expect(containerKey(box({ oog: true }))).not.toBe(containerKey(box()));
    expect(containerKey(box({ reefer: 'alarm' }))).not.toBe(containerKey(box({ reefer: 'on' })));
  });
});

describe('reach stacker', () => {
  const stacker = (over: Partial<MachineVM> = {}): MachineVM => ({ ...MACHINES[0]!, ...over });

  it('výložník sa vysúva o boom × travel (orezané na 0..1)', () => {
    expect(reachBoomExtension(0, { yMin: 0, yMax: 64 })).toBe(0);
    expect(reachBoomExtension(0.5, { yMin: 0, yMax: 64 })).toBe(32);
    expect(reachBoomExtension(2, { yMin: 0, yMax: 64 })).toBe(64);
  });

  it('špička výložníka sa posúva dopredu (hore) o vysunutie a nesie kontajner so spreaderom podľa veľkosti', () => {
    const view = new ReachStackerView(stacker({ boom: 0, cargo: box({ sizeFt: 20 }) }), deps());
    const retracted = view.headOffset;
    expect(view.spreader).toBe(20);
    expect(view.heldCargo).not.toBeNull();
    view.update(stacker({ boom: 1, cargo: box({ sizeFt: 40, containerType: 'flat_rack', oog: true }) }));
    expect(view.spreader).toBe(40);
    expect(view.headOffset.x).toBeCloseTo(retracted.x);
    expect(retracted.y - view.headOffset.y).toBeCloseTo(64 * SCALE);
    expect(view.heldCargo?.look.container?.oog).toBe(true);
    view.update(stacker({ cargo: null }));
    expect(view.heldCargo).toBeNull();
    view.destroy();
  });

  it('MachineLayer kreslí reach_stacker ako ReachStackerView a rtg ako MachineView', () => {
    const layer = new MachineLayer(deps());
    layer.sync([...MACHINES, { id: 9, defId: 'rtg', blockId: 3, x: 20.5, y: 12, trolley: 0, hoist: 0, state: 'idle', cargo: null }]);
    expect(layer.machineCount).toBe(3);
    expect(layer.reachStackerView(41)).toBeDefined();
    expect(layer.machineView(41)).toBeUndefined();
    expect(layer.machineView(9)).toBeDefined();
    layer.destroy();
  });
});

describe('demo scéna types', () => {
  it('zásuvky racku ležia na rackoch a majú všetky stavy', () => {
    const racks = VM.modules.filter((module) => module.defId === 'reefer_rack');
    expect(racks).toHaveLength(4);
    const states = new Set<string>();
    racks.forEach((rack, index) => {
      expect(rack.plugs).toEqual(rackPlugs(index));
      for (const plug of rack.plugs ?? []) {
        expect(plug.x).toBeGreaterThan(rack.x);
        expect(plug.x).toBeLessThan(rack.x + rack.w);
        expect(plug.y).toBeGreaterThan(rack.y);
        expect(plug.y).toBeLessThan(rack.y + rack.h);
        states.add(plug.state);
      }
    });
    expect([...states].sort()).toEqual(['alarm', 'empty', 'off', 'on']);
    expect(R5_SCENES.types.vm).toBe(VM);
  });

  it('40′ stohy blokov sú v pároch bays', () => {
    const block = VM.modules.find((module) => module.stacks !== undefined);
    const forty = (block?.stacks ?? []).filter((stack) => stack.top?.sizeFt === 40);
    for (const stack of forty) {
      const partner = forty.find((other) => other.row === stack.row && other.bay === (stack.bay % 2 === 0 ? stack.bay + 1 : stack.bay - 1));
      expect(partner, `pár pre ${String(stack.bay)};${String(stack.row)}`).toBeDefined();
    }
  });
});
