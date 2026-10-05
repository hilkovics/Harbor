// F6c (T6C-04): depo prázdnych kontajnerov — sprite z manifestu (stavy zaplnenia), odznaky poškodených a opráv (vzor HoldBadge),
// ozdoba vzniká len pre VM s `depot`.
import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { rotateFootprint, type Rotation } from '@sim/grid';
import { DepotBadge, damagedBadgeLabel, repairBadgeLabel } from '@render/depot-badge';
import { DEPOT_BADGE_INSET_PX, DepotDecor, depotMarks } from '@render/depot-decor';
import { WARNING_BADGE_SIZE, manifestScale, moduleSprite } from '@render/entity-assets';
import { footprintPose } from '@render/footprint-pose';
import { ModuleLayer } from '@render/module-layer';
import { MODULE_DECORS } from '@render/module-decors';
import { ModuleView, moduleBodyFile, moduleFillState } from '@render/module-view';
import type { ModuleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;
const UNIT = manifestScale(CELL);
const HALF = (WARNING_BADGE_SIZE.w / 2 + DEPOT_BADGE_INSET_PX) * UNIT;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

function depot(depotState: ModuleVM['depot'], rotation: Rotation = 0, stored = 56): ModuleVM {
  const base = moduleSprite('empty_depot')?.footprint;
  if (base === undefined) throw new Error('empty_depot');
  const size = rotateFootprint(base.w, base.h, rotation);
  return {
    id: 5,
    defId: 'empty_depot',
    kind: 'storage',
    x: 44,
    y: 19,
    rotation,
    w: size.w,
    h: size.h,
    connected: true,
    storage: { capacity: 96, stored, reserved: 0 },
    ...(depotState === undefined ? {} : { depot: depotState }),
  };
}

const BUSY = { available: 51, damaged: 3, inRepair: 2, repairBays: 2 } as const;

function context(vm: ModuleVM) {
  return { deps: deps(null), pose: footprintPose(vm, CELL), entry: moduleSprite(vm.defId) };
}

function decorOf(view: ModuleView): DepotDecor {
  const decor = view.decor<DepotDecor>('depot');
  if (decor === undefined) throw new Error('depo nemá ozdobu');
  return decor;
}

describe('manifest: depo prázdnych', () => {
  it('empty_depot: 4×4, päť stavov zaplnenia ako malý dvor, 16 pozícií × 6 vrstiev (kapacita 96), konektor na juhu', () => {
    const entry = moduleSprite('empty_depot');
    expect(entry?.footprint).toEqual({ w: 4, h: 4 });
    expect(Object.keys(entry?.states ?? {})).toEqual(['fill00', 'fill25', 'fill50', 'fill75', 'fill100']);
    expect((entry?.slots ?? 0) * (entry?.layers ?? 0)).toBe(96);
    expect(entry?.connectors[0]).toMatchObject({ x: 1, y: 3, side: 's' });
  });

  it('sprite sa volí podľa zaplnenia 96 miest (rovnako ako dvor): 0 → fill00, 56 → fill50, 96 → fill100', () => {
    const entry = moduleSprite('empty_depot');
    const fill = (stored: number) => moduleFillState(entry, depot(undefined, 0, stored));
    expect([fill(0), fill(20), fill(56), fill(80), fill(96)]).toEqual([0, 25, 50, 75, 100]);
    expect(moduleBodyFile(entry, 50)).toBe('modules/empty_depot_fill50.svg');
    const textures = new StubTextures();
    const view = new ModuleView(depot(undefined, 0, 56), deps(textures));
    expect(view.fill).toBe(50);
  });
});

describe('štítky odznakov', () => {
  it('poškodené: počet čakajúcich na opravu, nula = bez odznaku, `99+` zhora orezané', () => {
    expect([0, 1, 3, 99, 100, -2].map((count) => damagedBadgeLabel(count))).toEqual(['', '1', '3', '99', '99+', '']);
  });

  it('oprava: `v oprave / miesta opráv`, nula v oprave = bez odznaku, miesta aspoň toľko, koľko sa opravuje', () => {
    expect(repairBadgeLabel(0, 2)).toBe('');
    expect(repairBadgeLabel(1, 2)).toBe('1/2');
    expect(repairBadgeLabel(2, 2)).toBe('2/2');
    expect(repairBadgeLabel(3, 2)).toBe('3/3'); // nesúlad dát: štítok nikdy neukáže viac opráv než miest
    expect(repairBadgeLabel(2.9, 4)).toBe('2/4');
    expect(repairBadgeLabel(-1, 2)).toBe('');
  });
});

describe('DepotBadge', () => {
  it('štítok s textom len keď je čo ukázať; prekreslí sa len pri zmene textu', () => {
    const badge = new DepotBadge(deps(new StubTextures()), 'damaged', 0, 1);
    expect(badge.shownText).toBe('');
    badge.setLabel('3');
    expect(badge.shownText).toBe('3');
    badge.setLabel('3');
    expect(badge.shownText).toBe('3');
    badge.setLabel('');
    expect(badge.shownText).toBe('');
  });

  it('odznak je kruh so značkou (`Graphics`) a drží sa vzpriamene: `angle` a `scale` z konštruktora', () => {
    const badge = new DepotBadge(deps(null), 'repair', -90, 1.5);
    expect(badge.kind).toBe('repair');
    expect(badge.angle).toBe(-90);
    expect(badge.scale.x).toBe(1.5);
    expect(badge.children.filter((child) => child instanceof Graphics).length).toBeGreaterThanOrEqual(2);
  });

  it('kruh odznaku má polomer odznaku upozornenia (24 px zdroja)', () => {
    const badge = new DepotBadge(deps(null), 'damaged', 0, 1);
    badge.setLabel('');
    const box = badge.getLocalBounds();
    expect(box.width).toBeCloseTo(WARNING_BADGE_SIZE.w * UNIT, 0);
    expect(box.height).toBeCloseTo(WARNING_BADGE_SIZE.h * UNIT, 0);
  });
});

describe('depotMarks', () => {
  it('bez `depot` alebo bez problémov nie sú žiadne odznaky', () => {
    expect(depotMarks(depot(undefined), context(depot(undefined)))).toEqual([]);
    const clean = depot({ available: 20, damaged: 0, inRepair: 0, repairBays: 2 });
    expect(depotMarks(clean, context(clean))).toEqual([]);
  });

  it('poškodené a oprava: dva odznaky vedľa seba pri ľavom hornom rohu footprintu, vo vnútri depa', () => {
    const vm = depot(BUSY);
    const marks = depotMarks(vm, context(vm));
    expect(marks.map((mark) => [mark.kind, mark.label])).toEqual([
      ['damaged', '3'],
      ['repair', '2/2'],
    ]);
    const left = (-vm.w * CELL) / 2;
    const top = (-vm.h * CELL) / 2;
    expect(marks[0].x).toBeCloseTo(left + HALF, 9);
    expect(marks[0].y).toBeCloseTo(top + HALF, 9);
    expect(marks[1].y).toBeCloseTo(marks[0].y, 9);
    expect(marks[1].x - marks[0].x).toBeGreaterThanOrEqual(WARNING_BADGE_SIZE.w * UNIT); // odznaky sa neprekrývajú
    for (const mark of marks) {
      expect(mark.x).toBeGreaterThan(left);
      expect(mark.x).toBeLessThan(-left);
    }
  });

  it('len oprava (bez poškodených) zaujme miesto prvého odznaku; len poškodené ostane na mieste prvého', () => {
    const repairOnly = depot({ available: 51, damaged: 0, inRepair: 1, repairBays: 2 });
    const first = depotMarks(repairOnly, context(repairOnly));
    const damagedOnly = depot({ available: 51, damaged: 4, inRepair: 0, repairBays: 2 });
    const second = depotMarks(damagedOnly, context(damagedOnly));
    expect(first.map((mark) => mark.kind)).toEqual(['repair']);
    expect(second.map((mark) => mark.kind)).toEqual(['damaged']);
    expect(first[0].x).toBe(second[0].x);
  });
});

describe('DepotDecor (ModuleView)', () => {
  it('ozdoba je registrovaná a vznikne len pre VM s `depot`', () => {
    expect(MODULE_DECORS.map((factory) => factory.id)).toContain('depot');
    expect(new ModuleView(depot(undefined), deps(new StubTextures())).decor('depot')).toBeUndefined();
    expect(new ModuleView(depot(BUSY), deps(new StubTextures())).decor('depot')).toBeDefined();
  });

  it('dva odznaky s textami; po oprave poškodených ostane len odznak opráv, po dokončení opráv žiadny', () => {
    const view = new ModuleView(depot(BUSY), deps(new StubTextures()));
    const decor = decorOf(view);
    expect(decor.badgeCount).toBe(2);
    expect(decor.badge('damaged')?.shownText).toBe('3');
    expect(decor.badge('repair')?.shownText).toBe('2/2');
    view.update(depot({ available: 53, damaged: 0, inRepair: 2, repairBays: 2 }));
    expect(decor.badgeCount).toBe(1);
    expect(decor.badge('damaged')).toBeUndefined();
    expect(decor.badge('repair')?.shownText).toBe('2/2');
    view.update(depot({ available: 55, damaged: 0, inRepair: 0, repairBays: 2 }));
    expect(decor.badgeCount).toBe(0);
    view.update(depot({ ...BUSY, damaged: 1 }));
    expect(decor.badge('damaged')?.shownText).toBe('1');
  });

  it('nezmenený VM nevytvára nové odznaky', () => {
    const view = new ModuleView(depot(BUSY), deps(new StubTextures()));
    const damaged = decorOf(view).badge('damaged');
    view.update(depot(BUSY));
    expect(decorOf(view).badge('damaged')).toBe(damaged);
  });

  it.each([0, 90, 180, 270] as const)('rot %i: odznaky ostávajú vzpriamené (proti rotácii modulu)', (rotation) => {
    const view = new ModuleView(depot(BUSY, rotation), deps(new StubTextures()));
    const root = new Container();
    root.addChild(view.view);
    const decor = decorOf(view);
    for (const kind of ['damaged', 'repair'] as const) {
      const badge = decor.badge(kind);
      expect(badge?.angle).toBeCloseTo(-rotation, 9);
      // globálny uhol (rotácia modulu + odznaku) je 0
      expect((view.view.angle + (badge?.angle ?? 0) + 720) % 360).toBeCloseTo(0, 6);
    }
  });

  it('setBadgeScale platí pre existujúce aj nové odznaky', () => {
    const view = new ModuleView(depot({ ...BUSY, damaged: 0 }), deps(new StubTextures()));
    view.setBadgeScale(2);
    expect(decorOf(view).badge('repair')?.scale.x).toBe(2);
    view.update(depot(BUSY)); // nový odznak poškodených vznikne so zoomom
    expect(decorOf(view).badge('damaged')?.scale.x).toBe(2);
  });

  it('ModuleLayer synchronizuje odznaky depa zo snímky', () => {
    const layer = new ModuleLayer(deps(new StubTextures()));
    layer.sync([depot(BUSY)]);
    expect(layer.moduleView(5)?.decor<DepotDecor>('depot')?.badgeCount).toBe(2);
    layer.sync([depot({ available: 55, damaged: 0, inRepair: 0, repairBays: 2 })]);
    expect(layer.moduleView(5)?.decor<DepotDecor>('depot')?.badgeCount).toBe(0);
  });

  it('zničenie view uvoľní odznaky', () => {
    const view = new ModuleView(depot(BUSY), deps(new StubTextures()));
    const decor = decorOf(view);
    view.destroy();
    expect(decor.view.destroyed).toBe(true);
  });
});
