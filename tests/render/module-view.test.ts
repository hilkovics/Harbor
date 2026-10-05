import { Container, Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ROTATIONS, rotateFootprint, rotateLocalCell, type Rotation } from '@sim/grid';
import { cargoSpriteEntry, moduleSprite } from '@render/entity-assets';
import { localCellWorldCenter } from '@render/footprint-pose';
import { ModuleLayer } from '@render/module-layer';
import { ModuleView } from '@render/module-view';
import type { ModuleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

/** Berth 8×3 s ľavým horným rohom (40, 14) po rotácii. */
function berth(rotation: Rotation = 0, units: ModuleVM['apron'] = { capacity: 4, units: [] }): ModuleVM {
  const size = rotateFootprint(8, 3, rotation);
  return { id: 1, defId: 'berth_standard', kind: 'berth', x: 40, y: 14, rotation, w: size.w, h: size.h, apron: units };
}

const teu = (slot: number, unitId: number) => ({ slot, unitId, typeId: 'container_teu' });

/** Pixi potrebuje strom, aby `getGlobalPosition` použil transformácie predkov. */
function mount(view: ModuleView): Container {
  const root = new Container();
  root.addChild(view.view);
  return root;
}

describe('ModuleView: sprite modulu', () => {
  it('sprite `sprites.<defId>.file` z manifestu, ľavý horný roh v strede − polovica footprintu, veľkosť footprint × cell', () => {
    const textures = new StubTextures();
    const view = new ModuleView(berth(0), deps(textures));
    const sprite = view.view.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor(`file/${moduleSprite('berth_standard')?.file ?? ''}`));
    expect(sprite.position.x).toBe(-4 * CELL);
    expect(sprite.position.y).toBe(-1.5 * CELL);
    expect(sprite.width).toBeCloseTo(8 * CELL, 6);
    expect(sprite.height).toBeCloseTo(3 * CELL, 6);
    expect(view.view.position.x).toBe(44 * CELL);
    expect(view.view.position.y).toBe(15.5 * CELL);
    expect(view.view.angle).toBe(0);
  });

  it.each(ROTATIONS)('rot %i: kontajner sa otočí o rotáciu okolo stredu footprintu, sprite ostáva v rozmeroch rot 0', (rotation) => {
    const textures = new StubTextures();
    const vm = berth(rotation);
    const view = new ModuleView(vm, deps(textures));
    expect(view.view.angle).toBeCloseTo(rotation, 9);
    expect(view.view.position.x).toBe((vm.x + vm.w / 2) * CELL);
    expect(view.view.position.y).toBe((vm.y + vm.h / 2) * CELL);
    const sprite = view.view.children[0] as Sprite;
    expect(sprite.width).toBeCloseTo(8 * CELL, 6);
    expect(sprite.height).toBeCloseTo(3 * CELL, 6);
  });

  it('modul bez sprite v manifeste → obdĺžnik `Graphics` z tokenov', () => {
    const vm: ModuleVM = { id: 2, defId: 'neexistuje', kind: 'storage', x: 10, y: 10, rotation: 0, w: 2, h: 2 };
    const view = new ModuleView(vm, deps(new StubTextures()));
    expect(view.view.children[0]).toBeInstanceOf(Graphics);
  });

  it('bez textúr (textures: null) → `Graphics` aj pre modul z manifestu', () => {
    const view = new ModuleView(berth(0), deps(null));
    expect(view.view.children[0]).toBeInstanceOf(Graphics);
  });
});

describe('ModuleView: náklad na aprone', () => {
  const cargoFile = cargoSpriteEntry('container_teu')?.file ?? '';

  it('kontajner na obsadenom slote má sprite `cargo.container_teu` v jednotnej veľkosti TEU 64×26 a stred v bunke slotu', () => {
    const textures = new StubTextures();
    const view = new ModuleView(berth(0, { capacity: 4, units: [teu(0, 11), teu(3, 12)] }), deps(textures));
    expect(view.cargoCount).toBe(2);
    const first = view.cargoAt(0);
    const sprite = first?.children[0] as Sprite;
    expect(sprite.texture).toBe(textures.textureFor(`file/${cargoFile}`));
    expect(sprite.width).toBeCloseTo(CELL, 6);
    expect(sprite.height).toBeCloseTo((CELL * 26) / 64, 6);
    expect(sprite.anchor.x).toBe(0.5);
    // slot 0 = bunka (1, 1) berthu → svet (41, 15) + 0,5
    mount(view);
    const global = first?.getGlobalPosition();
    expect(global?.x).toBeCloseTo(41.5 * CELL, 6);
    expect(global?.y).toBeCloseTo(15.5 * CELL, 6);
  });

  it.each(ROTATIONS)('rot %i: náklad na každom slote leží v bunke, kam ho rotuje sim (rotateLocalCell)', (rotation) => {
    const slots = moduleSprite('berth_standard')?.apronSlots ?? [];
    const vm = berth(rotation, { capacity: slots.length, units: slots.map((_, i) => teu(i, 100 + i)) });
    const view = new ModuleView(vm, deps(new StubTextures()));
    mount(view);
    slots.forEach((slot, i) => {
      const cell = rotateLocalCell(slot.x, slot.y, 8, 3, rotation);
      const global = view.cargoAt(i)?.getGlobalPosition();
      expect(global?.x).toBeCloseTo((vm.x + cell.x + 0.5) * CELL, 6);
      expect(global?.y).toBeCloseTo((vm.y + cell.y + 0.5) * CELL, 6);
      // čistá funkcia dáva to isté
      const pure = localCellWorldCenter(vm, slot, CELL);
      expect(global?.x).toBeCloseTo(pure.x, 6);
      expect(global?.y).toBeCloseTo(pure.y, 6);
    });
  });

  it('náklad sa rotuje s modulom (dlhšia strana kontajnera ide pozdĺž nábrežia)', () => {
    const vm = berth(90, { capacity: 4, units: [teu(0, 1)] });
    const view = new ModuleView(vm, deps(new StubTextures()));
    mount(view);
    const transform = view.cargoAt(0)?.getGlobalTransform();
    // svetová rotácia kontajnera = rotácia modulu
    expect(transform?.b).toBeCloseTo(1, 9); // sin(90°)
    expect(transform?.a).toBeCloseTo(0, 9); // cos(90°)
  });

  it('update: nezmenené sloty ostávajú tie isté objekty, zmenená jednotka sa vymení, zmiznutá sa zruší', () => {
    const view = new ModuleView(berth(0, { capacity: 4, units: [teu(0, 1), teu(1, 2)] }), deps(new StubTextures()));
    const slot0 = view.cargoAt(0);
    const slot1 = view.cargoAt(1);
    view.update(berth(0, { capacity: 4, units: [teu(0, 1), teu(1, 3), teu(2, 4)] }));
    expect(view.cargoAt(0)).toBe(slot0); // nezmenené
    expect(view.cargoAt(1)).not.toBe(slot1); // iná jednotka na slote
    expect(slot1?.destroyed).toBe(true);
    expect(view.cargoAt(1)?.unitId).toBe(3);
    expect(view.cargoCount).toBe(3);
    view.update(berth(0, { capacity: 4, units: [] }));
    expect(view.cargoCount).toBe(0);
    expect(slot0?.destroyed).toBe(true);
  });

  it('slot mimo apronSlots z manifestu sa preskočí (nemá kam ísť)', () => {
    const view = new ModuleView(berth(0, { capacity: 4, units: [teu(9, 1)] }), deps(new StubTextures()));
    expect(view.cargoCount).toBe(0);
  });

  it('náklad bez sprite v manifeste → `Graphics` kontajner rovnakej veľkosti', () => {
    const unit = { slot: 0, unitId: 1, typeId: 'neznamy_naklad' };
    const view = new ModuleView(berth(0, { capacity: 4, units: [unit] }), deps(new StubTextures()));
    expect(view.cargoAt(0)?.children[0]).toBeInstanceOf(Graphics);
  });
});

describe('ModuleLayer (synchronizácia podľa id)', () => {
  const vmA = berth(0);
  const vmB: ModuleVM = { ...berth(0), id: 2, x: 48 };

  it('vytvára views podľa id, nezmenené ponecháva, zmiznuté ruší', () => {
    const layer = new ModuleLayer(deps(new StubTextures()));
    layer.sync([vmA, vmB]);
    expect(layer.moduleCount).toBe(2);
    expect(layer.view.children).toHaveLength(2);
    const a = layer.moduleView(1);
    const b = layer.moduleView(2);

    layer.sync([{ ...vmA }, { ...vmB }]); // nové objekty, rovnaký obsah
    expect(layer.moduleView(1)).toBe(a);
    expect(layer.moduleView(2)).toBe(b);

    layer.sync([vmB]);
    expect(layer.moduleCount).toBe(1);
    expect(layer.moduleView(1)).toBeUndefined();
    expect(a?.view.destroyed).toBe(true);
    expect(layer.view.children).toHaveLength(1);
  });

  it('zmena rotácie / polohy / defu vytvorí view nanovo, zmena nákladu nie', () => {
    const layer = new ModuleLayer(deps(new StubTextures()));
    layer.sync([vmA]);
    const first = layer.moduleView(1);
    layer.sync([berth(0, { capacity: 4, units: [teu(0, 1)] })]);
    expect(layer.moduleView(1)).toBe(first);
    expect(first?.cargoCount).toBe(1);
    layer.sync([berth(90)]);
    expect(layer.moduleView(1)).not.toBe(first);
    expect(first?.view.destroyed).toBe(true);
    expect(layer.moduleCount).toBe(1);
  });

  it('žeriavy (`kind === "crane"`) preskočí — kreslí ich CraneLayer', () => {
    const layer = new ModuleLayer(deps(new StubTextures()));
    const crane: ModuleVM = { id: 3, defId: 'crane_container_gantry', kind: 'crane', x: 43, y: 14, rotation: 0, w: 2, h: 3 };
    layer.sync([vmA, crane]);
    expect(layer.moduleCount).toBe(1);
    expect(layer.moduleView(3)).toBeUndefined();
  });

  it('destroy uvoľní všetky views', () => {
    const layer = new ModuleLayer(deps(new StubTextures()));
    layer.sync([vmA]);
    const view = layer.moduleView(1);
    layer.destroy();
    expect(view?.view.destroyed).toBe(true);
    expect(layer.view.destroyed).toBe(true);
  });
});
