// F6c (T6C-04): prázdne kontajnery na aprone, pod žeriavom berthu a na žeriave dvora — kreslia sa farbou `--cargo-empty`
// (procedurálne z tokenov), pásik farby linky z `--line-*`; plné kontajnery ostávajú sprite `cargo.container_teu` (oranžový).
import { Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { CargoSprite, LINE_BAND_SHARE, cargoSizePx } from '@render/cargo-sprite';
import { CraneView } from '@render/crane-view';
import { cargoSpriteEntry, moduleSprite } from '@render/entity-assets';
import { ModuleView, unitLook } from '@render/module-view';
import { lineColorOf } from '@render/tokens';
import type { CraneVM, ModuleVM } from '@render/view-models';
import { YardCraneDecor } from '@render/yard-crane-decor';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures, now: () => 0, reducedMotion: () => true };
}

type Unit = NonNullable<ModuleVM['apron']>['units'][number];

function berth(units: Unit[]): ModuleVM {
  return { id: 1, defId: 'berth_standard', kind: 'berth', x: 40, y: 14, rotation: 0, w: 8, h: 3, apron: { capacity: 8, units } };
}

function yard(over: Partial<ModuleVM> = {}): ModuleVM {
  return { id: 4, defId: 'container_yard_small', kind: 'storage', x: 42, y: 18, rotation: 0, w: 4, h: 4, storage: { capacity: 64, stored: 10, reserved: 0 }, connected: true, ...over };
}

function craneHolding(holding: CraneVM['holding']): CraneVM {
  return { id: 7, defId: 'crane_container_gantry', berthId: 1, x: 43, y: 14, rotation: 0, state: 'placing', progress: 0.5, cycle: 'load', holding };
}

describe('CargoSprite: prázdny kontajner', () => {
  it('plný kontajner je sprite z manifestu, prázdny je procedurálny `Graphics` (aj keď textúra existuje)', () => {
    const textures = new StubTextures();
    const full = new CargoSprite(1, 'container_teu', deps(textures));
    expect(full.children[0]).toBeInstanceOf(Sprite);
    expect((full.children[0] as Sprite).texture).toBe(textures.textureFor(`file/${cargoSpriteEntry('container_teu')?.file ?? ''}`));
    expect(full.look).toEqual({});
    const empty = new CargoSprite(2, 'container_teu', deps(textures), { empty: true });
    expect(empty.children).toHaveLength(1);
    expect(empty.children[0]).toBeInstanceOf(Graphics);
    expect(empty.look.empty).toBe(true);
  });

  it('prázdny kontajner má rovnakú veľkosť ako plný (64 × 26 px)', () => {
    const size = cargoSizePx('container_teu', CELL);
    const empty = new CargoSprite(2, 'container_teu', deps(null), { empty: true });
    const box = empty.getLocalBounds();
    expect(box.width).toBeCloseTo(size.w, 4);
    expect(box.height).toBeCloseTo(size.h, 4);
    expect(box.x).toBeCloseTo(-size.w / 2, 4);
    expect(box.y).toBeCloseTo(-size.h / 2, 4);
  });

  it('pásik linky sa kreslí len s farbou linky a nezväčší kontajner', () => {
    const plain = new CargoSprite(3, 'container_teu', deps(null), { empty: true });
    const lineColor = lineColorOf(ENTITY_PALETTE, 'line-blue');
    expect(lineColor).toBeDefined();
    const banded = new CargoSprite(4, 'container_teu', deps(null), { empty: true, ...(lineColor === undefined ? {} : { lineColor }) });
    expect((banded.children[0] as Graphics).context.instructions.length).toBeGreaterThan((plain.children[0] as Graphics).context.instructions.length);
    const size = cargoSizePx('container_teu', CELL);
    expect(banded.getLocalBounds().width).toBeCloseTo(size.w, 4);
    expect(banded.getLocalBounds().height).toBeCloseTo(size.h, 4);
    expect(LINE_BAND_SHARE).toBeGreaterThan(0);
    expect(LINE_BAND_SHARE).toBeLessThan(1);
  });
});

describe('unitLook', () => {
  it('plná jednotka (aj s linkou) nemá vzhľad prázdneho; prázdna dostane farbu linky z palety', () => {
    expect(unitLook({}, deps(null))).toEqual({});
    expect(unitLook({ lineToken: 'line-blue' }, deps(null))).toEqual({});
    expect(unitLook({ empty: false }, deps(null))).toEqual({});
    expect(unitLook({ empty: true }, deps(null))).toEqual({ empty: true });
    expect(unitLook({ empty: true, lineToken: 'line-amber' }, deps(null))).toEqual({ empty: true, lineColor: lineColorOf(ENTITY_PALETTE, 'line-amber') });
    expect(unitLook({ empty: true, lineToken: 'line-pink' }, deps(null))).toEqual({ empty: true }); // neznáma linka = bez pásika
  });
});

describe('ModuleView: prázdne kontajnery na aprone', () => {
  it('prázdna jednotka je sivý `Graphics`, plná sprite; zmena jednotky na slote vytvorí nový vzhľad', () => {
    const view = new ModuleView(
      berth([
        { slot: 0, unitId: 1, typeId: 'container_teu' },
        { slot: 1, unitId: 2, typeId: 'container_teu', empty: true, lineToken: 'line-blue' },
      ]),
      deps(new StubTextures()),
    );
    expect(view.cargoAt(0)?.children[0]).toBeInstanceOf(Sprite);
    expect(view.cargoAt(1)?.children[0]).toBeInstanceOf(Graphics);
    expect(view.cargoAt(1)?.look).toEqual({ empty: true, lineColor: lineColorOf(ENTITY_PALETTE, 'line-blue') });
    const before = view.cargoAt(1);
    view.update(berth([{ slot: 1, unitId: 2, typeId: 'container_teu', empty: true, lineToken: 'line-blue' }]));
    expect(view.cargoAt(1)).toBe(before); // nezmenená jednotka sa neprekreslí
    expect(view.cargoAt(0)).toBeUndefined();
    view.update(berth([{ slot: 1, unitId: 3, typeId: 'container_teu' }])); // iná (plná) jednotka na slote
    expect(view.cargoAt(1)?.children[0]).toBeInstanceOf(Sprite);
    expect(view.cargoAt(1)?.look).toEqual({});
  });
});

describe('CraneView: držaný prázdny kontajner', () => {
  it('prázdny kontajner pod vozíkom je sivý; výmena plný ↔ prázdny (aj tej istej jednotky) vymení vzhľad', () => {
    const view = new CraneView(craneHolding({ unitId: 1, typeId: 'container_teu', empty: true }), deps(new StubTextures()));
    expect(view.heldCargo?.look.empty).toBe(true);
    expect(view.heldCargo?.children[0]).toBeInstanceOf(Graphics);
    const first = view.heldCargo;
    view.update({ ...craneHolding({ unitId: 1, typeId: 'container_teu', empty: true }), progress: 0.6 });
    expect(view.heldCargo).toBe(first); // rovnaká jednotka a vzhľad: nič sa nevymieňa
    view.update(craneHolding({ unitId: 2, typeId: 'container_teu' }));
    expect(view.heldCargo).not.toBe(first);
    expect(view.heldCargo?.look.empty).toBeUndefined();
    expect(view.heldCargo?.children[0]).toBeInstanceOf(Sprite);
    view.update(craneHolding({ unitId: 2, typeId: 'container_teu', empty: true }));
    expect(view.heldCargo?.look.empty).toBe(true);
  });
});

describe('YardCraneDecor: kontajner na spreaderi', () => {
  const entry = moduleSprite('container_yard_small');

  function decor(vm: ModuleVM): { view: ModuleView; crane: YardCraneDecor } {
    const view = new ModuleView(vm, deps(new StubTextures()));
    const crane = view.decor<YardCraneDecor>('yard_crane');
    if (crane === undefined) throw new Error('dvor nemá žeriav');
    return { view, crane };
  }

  it('bežný dvor nesie oranžový kontajner, depo prázdnych vždy sivý', () => {
    expect(entry).toBeDefined();
    expect(decor(yard()).crane.carriesEmpty).toBe(false);
    const depot = decor(yard({ id: 5, defId: 'empty_depot', depot: { available: 10, damaged: 0, inRepair: 0, repairBays: 2 } }));
    expect(depot.crane.carriesEmpty).toBe(true);
  });

  it('operácia s prázdnym kontajnerom vo dvore prefarbí kontajner na spreaderi, ďalšia plná ho vráti', () => {
    const { view, crane } = decor(yard({ lastStorageOp: { slot: 1, tick: 5, kind: 'put' } }));
    expect(crane.carriesEmpty).toBe(false);
    view.update(yard({ lastStorageOp: { slot: 2, tick: 6, kind: 'put', empty: true } }));
    expect(crane.carriesEmpty).toBe(true);
    view.update(yard({ lastStorageOp: { slot: 3, tick: 7, kind: 'take' } }));
    expect(crane.carriesEmpty).toBe(false);
  });

  it('dvor, ktorý operáciu s prázdnym už mal (nový view po načítaní), začne sivý', () => {
    expect(decor(yard({ lastStorageOp: { slot: 2, tick: 6, kind: 'put', empty: true } })).crane.carriesEmpty).toBe(true);
  });

  it('depo ostáva sivé aj pri operácii bez príznaku `empty`', () => {
    const vm = yard({ id: 5, defId: 'empty_depot', depot: { available: 10, damaged: 0, inRepair: 0, repairBays: 2 }, lastStorageOp: { slot: 1, tick: 5, kind: 'put' } });
    const { view, crane } = decor(vm);
    view.update({ ...vm, lastStorageOp: { slot: 2, tick: 6, kind: 'take' } });
    expect(crane.carriesEmpty).toBe(true);
  });
});
