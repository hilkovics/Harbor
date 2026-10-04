// F6a (T6A-06): jednotky vo VGM hold v sklade / na rampe / na aprone označené odznakom `overlay.warning_badge` (+ počet).
import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { rotateFootprint, type Rotation } from '@sim/grid';
import { HoldBadge, holdBadgeLabel } from '@render/badges';
import { badgeScaleForZoom } from '@render/crane-view';
import { WARNING_BADGE_SIZE, manifestScale, moduleSprite } from '@render/entity-assets';
import { footprintPose, localCellCenter } from '@render/footprint-pose';
import { HOLD_BADGE_INSET_PX, HoldDecor, holdMarks } from '@render/hold-decor';
import { ModuleLayer } from '@render/module-layer';
import { MODULE_DECORS } from '@render/module-decors';
import { ModuleView } from '@render/module-view';
import type { ModuleVM } from '@render/view-models';
import { TRUCK_LENGTH_PX } from '@render/world-scale';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;
const UNIT = manifestScale(CELL);
const HALF = (WARNING_BADGE_SIZE.w / 2 + HOLD_BADGE_INSET_PX) * UNIT;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

function plain(id: number, defId: string, kind: string, x: number, y: number, rotation: Rotation): ModuleVM {
  const base = moduleSprite(defId)?.footprint;
  if (base === undefined) throw new Error(defId);
  const size = rotateFootprint(base.w, base.h, rotation);
  return { id, defId, kind, x, y, rotation, w: size.w, h: size.h, connected: true };
}

const yard = (held?: ModuleVM['held'], rotation: Rotation = 0): ModuleVM => ({
  ...plain(1, 'container_yard_small', 'storage', 44, 19, rotation),
  storage: { capacity: 64, stored: 20, reserved: 0 },
  ...(held === undefined ? {} : { held }),
});

const ramp = (held?: ModuleVM['held'], rotation: Rotation = 0): ModuleVM => ({
  ...plain(2, 'loading_ramp_container', 'ramp', 30, 23, rotation),
  ramp: { docks: 2, staged: [1, 0], operational: true },
  ...(held === undefined ? {} : { held }),
});

const berth = (held?: ModuleVM['held'], rotation: Rotation = 0): ModuleVM => ({
  ...plain(3, 'berth_standard', 'berth', 40, 14, rotation),
  apron: { capacity: 8, units: [{ slot: 0, unitId: 11, typeId: 'container_teu' }, { slot: 2, unitId: 12, typeId: 'container_teu' }] },
  ...(held === undefined ? {} : { held }),
});

/** Kontext ozdoby pre `holdMarks` bez Pixi view. */
function context(vm: ModuleVM) {
  return { deps: deps(null), pose: footprintPose(vm, CELL), entry: moduleSprite(vm.defId) };
}

function mount(view: ModuleView): Container {
  const root = new Container();
  root.addChild(view.view);
  return root;
}

describe('holdBadgeLabel', () => {
  it.each([
    [0, ''],
    [1, ''],
    [2, '2'],
    [17, '17'],
    [99, '99'],
    [100, '99+'],
    [-4, ''],
    [3.7, '3'],
  ] as const)('%f → "%s"', (count, expected) => {
    expect(holdBadgeLabel(count)).toBe(expected);
  });
});

describe('HoldBadge', () => {
  it('jedna jednotka = len odznak, od dvoch štítok s počtom', () => {
    const badge = new HoldBadge({ ...deps(new StubTextures()) }, 0, 1);
    badge.setCount(1);
    expect(badge.countVisible).toBe(false);
    badge.setCount(3);
    expect(badge.shownText).toBe('3');
    expect(badge.countVisible).toBe(true);
    badge.setCount(1);
    expect(badge.countVisible).toBe(false);
    expect(badge.shownText).toBe('');
  });
});

describe('holdMarks (kde odznaky sú)', () => {
  it('bez poľa held alebo s nulou nič', () => {
    expect(holdMarks(yard(), context(yard()))).toEqual([]);
    const none = yard({ count: 0 });
    expect(holdMarks(none, context(none))).toEqual([]);
  });

  it('sklad: jeden odznak s počtom v pravom hornom rohu footprintu', () => {
    const vm = yard({ count: 3 });
    const marks = holdMarks(vm, context(vm));
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ key: 'module', count: 3 });
    expect(marks[0].x).toBeCloseTo((4 * CELL) / 2 - HALF, 9);
    expect(marks[0].y).toBeCloseTo((-4 * CELL) / 2 + HALF, 9);
  });

  it('rampa: odznak pri každom doku s jednotkou v hold (v osi docku za zadkom kamióna v doku), počet z docks[i]', () => {
    const vm = ramp({ count: 3, docks: [2, 0] });
    const marks = holdMarks(vm, context(vm));
    expect(marks.map((mark) => [mark.key, mark.count])).toEqual([['dock-0', 2]]);
    const dock = moduleSprite('loading_ramp_container')?.docks?.[0];
    const pose = footprintPose(vm, CELL);
    if (dock === undefined) throw new Error('dock');
    expect(marks[0].x).toBeCloseTo((-pose.baseW * CELL) / 2 + (dock.x + dock.w / 2) * UNIT, 9);
    const rear = dock.y + dock.h / 2 - TRUCK_LENGTH_PX / 2; // zadok kamióna stojaceho v doku
    expect(marks[0].y).toBeCloseTo((-pose.baseH * CELL) / 2 + Math.max(HALF / UNIT, rear - HALF / UNIT) * UNIT, 9);
    // odznak neprekrýva kamión v doku: jeho spodok sedí presne na zadku kamióna (rampa A má nad dokom dosť miesta)
    expect(rear).toBeGreaterThanOrEqual((2 * HALF) / UNIT);
    expect(marks[0].y + HALF).toBeCloseTo((-pose.baseH * CELL) / 2 + rear * UNIT, 9);
    const both = ramp({ count: 3, docks: [2, 1] });
    expect(holdMarks(both, context(both)).map((mark) => mark.key)).toEqual(['dock-0', 'dock-1']);
  });

  it('berth: odznak pri slote apronu s jednotkou v hold', () => {
    const vm = berth({ count: 2, slots: [0, 2] });
    const marks = holdMarks(vm, context(vm));
    expect(marks.map((mark) => mark.key)).toEqual(['slot-0', 'slot-2']);
    expect(marks.every((mark) => mark.count === 1)).toBe(true);
    const pose = footprintPose(vm, CELL);
    const cell = moduleSprite('berth_standard')?.apronSlots?.[2];
    if (cell === undefined) throw new Error('slot');
    const center = localCellCenter(cell, pose.baseW, pose.baseH, CELL);
    expect(marks[1].x).toBeCloseTo(center.x + CELL / 2 - HALF, 9);
    expect(marks[1].y).toBeCloseTo(center.y - CELL / 2 + HALF, 9);
  });

  it('dok / slot, ktorý manifest nepozná, spadne na odznak modulu s celkovým počtom', () => {
    const noDock = ramp({ count: 2, docks: [0, 0, 2] });
    expect(holdMarks(noDock, context(noDock)).map((mark) => [mark.key, mark.count])).toEqual([['module', 2]]);
    const noSlot = berth({ count: 1, slots: [99] });
    expect(holdMarks(noSlot, context(noSlot)).map((mark) => [mark.key, mark.count])).toEqual([['module', 1]]);
    const total = ramp({ count: 4 });
    expect(holdMarks(total, context(total)).map((mark) => [mark.key, mark.count])).toEqual([['module', 4]]);
  });
});

describe('ModuleView: ozdoba hold', () => {
  it('registrovaná v MODULE_DECORS a vznikne lenivo, až keď VM nesie `held`', () => {
    expect(MODULE_DECORS.map((factory) => factory.id)).toContain('hold');
    const view = new ModuleView(yard(), deps(new StubTextures()));
    expect(view.decor<HoldDecor>('hold')).toBeUndefined();
    view.update(yard({ count: 2 }));
    const decor = view.decor<HoldDecor>('hold');
    expect(decor?.badgeCount).toBe(1);
    expect(decor?.badge('module')?.shownText).toBe('2');
  });

  it('počet sa mení s VM, po uvoľnení holdu odznak zmizne', () => {
    const view = new ModuleView(yard({ count: 2 }), deps(new StubTextures()));
    const decor = view.decor<HoldDecor>('hold');
    expect(decor?.badge('module')?.shownText).toBe('2');
    view.update(yard({ count: 5 }));
    expect(decor?.badge('module')?.shownText).toBe('5');
    view.update(yard({ count: 0 }));
    expect(decor?.badgeCount).toBe(0);
    view.update(yard(undefined));
    expect(decor?.badgeCount).toBe(0);
    view.update(yard({ count: 1 }));
    expect(decor?.badgeCount).toBe(1);
  });

  it('rampa: odznaky pri dokoch sa pridávajú a ruší podľa docks[]', () => {
    const view = new ModuleView(ramp({ count: 1, docks: [1, 0] }), deps(new StubTextures()));
    const decor = view.decor<HoldDecor>('hold');
    expect([decor?.badge('dock-0') !== undefined, decor?.badge('dock-1') !== undefined]).toEqual([true, false]);
    view.update(ramp({ count: 3, docks: [1, 2] }));
    expect(decor?.badge('dock-1')?.shownText).toBe('2');
    view.update(ramp({ count: 2, docks: [0, 2] }));
    expect(decor?.badge('dock-0')).toBeUndefined();
    expect(decor?.badge('dock-1')).toBeDefined();
  });

  it('odznak ostáva vzpriamený pri každej rotácii modulu', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const vm = yard({ count: 2 }, rotation);
      const view = new ModuleView(vm, deps(new StubTextures()));
      mount(view);
      const badge = view.decor<HoldDecor>('hold')?.badge('module');
      const origin = badge?.toGlobal({ x: 0, y: 0 });
      const along = badge?.toGlobal({ x: 10, y: 0 });
      expect((along?.x ?? 0) - (origin?.x ?? 0), `rotácia ${String(rotation)}`).toBeCloseTo(10, 6);
      expect((along?.y ?? 1) - (origin?.y ?? 0), `rotácia ${String(rotation)}`).toBeCloseTo(0, 6);
    }
  });

  it('odznak „nepripojené“ ostáva nezávislý: hold ho nezapína', () => {
    const view = new ModuleView(yard({ count: 2 }), deps(new StubTextures()));
    expect(view.badgeVisible).toBe(false);
    view.update({ ...yard({ count: 2 }), connected: false });
    expect(view.badgeVisible).toBe(true);
  });

  it('zoom: ModuleLayer.setZoom škáluje aj odznaky hold, vrátane tých, ktoré vzniknú neskôr', () => {
    const layer = new ModuleLayer(deps(new StubTextures()));
    layer.sync([yard({ count: 2 })]);
    layer.setZoom(0.5);
    const decor = layer.moduleView(1)?.decor<HoldDecor>('hold');
    expect(decor?.badge('module')?.scale.x).toBe(badgeScaleForZoom(0.5));
    layer.sync([{ ...ramp({ count: 1, docks: [1, 0] }) }, yard({ count: 2 })]);
    expect(layer.moduleView(2)?.decor<HoldDecor>('hold')?.badge('dock-0')?.scale.x).toBe(badgeScaleForZoom(0.5));
  });
});
