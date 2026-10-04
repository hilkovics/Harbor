import { Container, Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ROTATIONS, rotateFootprint, type Rotation } from '@sim/grid';
import { WARNING_BADGE_FILE, WARNING_BADGE_SIZE, manifestScale, moduleSprite } from '@render/entity-assets';
import { badgeScaleForZoom } from '@render/crane-view';
import { ModuleLayer } from '@render/module-layer';
import { ModuleView } from '@render/module-view';
import type { EntityTextures } from '@render/sprite-atlas';
import type { ModuleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;
const YARD = 'container_yard_small';
const DEPOT = 'vehicle_depot';

function deps(textures: EntityTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

/** Kontajnerový dvor S (4×4) s ľavým horným rohom (32, 20) po rotácii. */
function yard(stored: number, over: Partial<ModuleVM> = {}): ModuleVM {
  const rotation = over.rotation ?? 0;
  const size = rotateFootprint(4, 4, rotation);
  return {
    id: 7,
    defId: YARD,
    kind: 'storage',
    x: 32,
    y: 20,
    rotation,
    w: size.w,
    h: size.h,
    storage: { capacity: 64, stored, reserved: 0 },
    connected: true,
    ...over,
  };
}

/** Depo vozidiel (3×3) s ľavým horným rohom (46, 21) po rotácii. */
function depot(over: Partial<ModuleVM> = {}): ModuleVM {
  const rotation = over.rotation ?? 0;
  const size = rotateFootprint(3, 3, rotation);
  return { id: 8, defId: DEPOT, kind: 'depot', x: 46, y: 21, rotation, w: size.w, h: size.h, connected: true, ...over };
}

function mount(view: ModuleView): Container {
  const root = new Container();
  root.addChild(view.view);
  return root;
}

const stateFile = (key: string): string => `file/${moduleSprite(YARD)?.states?.[key] ?? 'CHÝBA'}`;

describe('manifest: sklad so stavmi zaplnenia', () => {
  it('container_yard_small má päť stavov fill00…fill100 a nemá jediný `file`; kapacita = sloty × vrstvy', () => {
    const entry = moduleSprite(YARD);
    expect(entry?.file).toBeUndefined();
    expect(Object.keys(entry?.states ?? {})).toEqual(['fill00', 'fill25', 'fill50', 'fill75', 'fill100']);
    expect(entry?.footprint).toEqual({ w: 4, h: 4 });
  });

  it('vehicle_depot má jediný sprite (`file`), žiadne stavy', () => {
    const entry = moduleSprite(DEPOT);
    expect(entry?.file).toBe('modules/vehicle_depot.svg');
    expect(entry?.states).toBeUndefined();
    expect(entry?.footprint).toEqual({ w: 3, h: 3 });
  });
});

describe('ModuleView: fill stav skladu', () => {
  it.each([
    [0, 'fill00'],
    [1, 'fill25'],
    [23, 'fill25'],
    [24, 'fill50'],
    [39, 'fill50'],
    [40, 'fill75'],
    [63, 'fill75'],
    [64, 'fill100'],
  ])('stored %i / 64 → sprite %s, veľkosť footprint × cell a ľavý horný roh v strede − polovica', (stored, key) => {
    const textures = new StubTextures();
    const view = new ModuleView(yard(stored), deps(textures));
    const sprite = view.view.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor(stateFile(key)));
    expect(sprite.width).toBeCloseTo(4 * CELL, 6);
    expect(sprite.height).toBeCloseTo(4 * CELL, 6);
    expect(sprite.position.x).toBe(-2 * CELL);
    expect(sprite.position.y).toBe(-2 * CELL);
    expect(view.view.position.x).toBe(34 * CELL);
    expect(view.view.position.y).toBe(22 * CELL);
  });

  it('update prepne textúru podľa zaplnenia; nezmenený fill stav ponechá ten istý objekt spritu', () => {
    const textures = new StubTextures();
    const view = new ModuleView(yard(0), deps(textures));
    expect(view.fill).toBe(0);
    const body = view.view.children[0];
    view.update(yard(0, { storage: { capacity: 64, stored: 0, reserved: 5 } })); // rezervácia fill nemení
    expect(view.view.children[0]).toBe(body);
    view.update(yard(48));
    expect(view.fill).toBe(75);
    expect((view.view.children[0] as Sprite).texture).toBe(textures.textureFor(stateFile('fill75')));
    const grown = view.view.children[0];
    view.update(yard(49));
    expect(view.view.children[0]).toBe(grown);
    view.update(yard(64));
    expect((view.view.children[0] as Sprite).texture).toBe(textures.textureFor(stateFile('fill100')));
    view.update(yard(0));
    expect((view.view.children[0] as Sprite).texture).toBe(textures.textureFor(stateFile('fill00')));
    expect(view.fill).toBe(0);
  });

  it('sklad bez `storage` vo VM (napr. ešte nenaplnené) ukáže prázdny dvor fill00', () => {
    const textures = new StubTextures();
    const view = new ModuleView(yard(0, { storage: undefined }), deps(textures));
    expect((view.view.children[0] as Sprite).texture).toBe(textures.textureFor(stateFile('fill00')));
  });

  it('modul s jediným spritom (`file`) nemá fill stav: depo ani berth sa pri zmene VM nepreskladá', () => {
    const textures = new StubTextures();
    const view = new ModuleView(depot(), deps(textures));
    expect(view.fill).toBeNull();
    expect((view.view.children[0] as Sprite).texture).toBe(textures.textureFor('file/modules/vehicle_depot.svg'));
    const body = view.view.children[0];
    view.update(depot({ connected: false }));
    expect(view.view.children[0]).toBe(body);
  });

  it.each(ROTATIONS)('rot %i: kontajner sa otočí, sprite skladu ostáva v rozmeroch rot 0', (rotation) => {
    const view = new ModuleView(yard(30, { rotation }), deps(new StubTextures()));
    expect(view.view.angle).toBeCloseTo(rotation, 9);
    const sprite = view.view.children[0] as Sprite;
    expect(sprite.width).toBeCloseTo(4 * CELL, 6);
    expect(sprite.height).toBeCloseTo(4 * CELL, 6);
  });

  it('bez textúr (textures: null) → `Graphics`; zmena fill stavu nespadne', () => {
    const view = new ModuleView(yard(0), deps(null));
    expect(view.view.children[0]).toBeInstanceOf(Graphics);
    view.update(yard(64));
    expect(view.view.children[0]).toBeInstanceOf(Graphics);
    expect(view.fill).toBe(100);
  });

  it('chýbajúca textúra nového stavu → fallback `Graphics`; po návrate textúry zase sprite', () => {
    const textures = new StubTextures();
    const missing = new Set<string>();
    const partial: EntityTextures = { file: (path) => (missing.has(path) ? undefined : textures.file(path)) };
    const view = new ModuleView(yard(0), deps(partial));
    expect(view.view.children[0]).toBeInstanceOf(Sprite);
    missing.add(moduleSprite(YARD)?.states?.['fill75'] ?? '');
    view.update(yard(48));
    expect(view.view.children[0]).toBeInstanceOf(Graphics);
    view.update(yard(0));
    expect(view.view.children[0]).toBeInstanceOf(Sprite);
  });

  it('náklad na aprone a fill telo spolu: telo je vždy prvé dieťa (pod nákladom)', () => {
    const view = new ModuleView(yard(0), deps(new StubTextures()));
    view.update(yard(64));
    expect(view.view.children[0]).toBeInstanceOf(Sprite);
    expect(view.view.children[1]?.label).toBe('apron-cargo');
  });
});

describe('ModuleView: odznak „nepripojené“', () => {
  const badgeFile = `file/${WARNING_BADGE_FILE}`;

  it('manifest: overlay.warning_badge je 24×24 px', () => {
    expect(WARNING_BADGE_FILE).toBe('overlay/warning_badge.svg');
    expect(WARNING_BADGE_SIZE).toEqual({ w: 24, h: 24 });
  });

  it('pripojený modul alebo modul bez informácie o pripojení odznak nemá', () => {
    const connected = new ModuleView(depot({ connected: true }), deps(new StubTextures()));
    expect(connected.badgeVisible).toBe(false);
    expect(connected.badgeView).toBeNull();
    const unknown = new ModuleView(depot({ connected: undefined }), deps(new StubTextures()));
    expect(unknown.badgeVisible).toBe(false);
  });

  it('`connected === false` → sprite `overlay.warning_badge` (24 px × cell / 64) vycentrovaný v strede modulu', () => {
    const textures = new StubTextures();
    const view = new ModuleView(depot({ connected: false }), deps(textures));
    expect(view.badgeVisible).toBe(true);
    const sprite = view.badgeView?.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor(badgeFile));
    expect(sprite.anchor.x).toBe(0.5);
    expect(sprite.width).toBeCloseTo(24 * manifestScale(CELL), 6);
    expect(sprite.height).toBeCloseTo(24 * manifestScale(CELL), 6);
    mount(view);
    const center = sprite.getGlobalPosition();
    expect(center.x).toBeCloseTo(47.5 * CELL, 6); // stred depa 46 + 3/2
    expect(center.y).toBeCloseTo(22.5 * CELL, 6);
  });

  it('odznak sa objaví a zmizne so zmenou `connected` (update, nie nový view)', () => {
    const view = new ModuleView(depot({ connected: true }), deps(new StubTextures()));
    view.update(depot({ connected: false }));
    expect(view.badgeVisible).toBe(true);
    const badge = view.badgeView;
    view.update(depot({ connected: false }));
    expect(view.badgeView).toBe(badge); // rovnaký objekt, bez alokácie
    view.update(depot({ connected: true }));
    expect(view.badgeVisible).toBe(false);
    view.update(depot({ connected: false }));
    expect(view.badgeView).toBe(badge);
    expect(view.badgeVisible).toBe(true);
  });

  it('zmena zaplnenia skladu odznak neovplyvní; nepripojený dvor má odznak aj fill sprite', () => {
    const textures = new StubTextures();
    const view = new ModuleView(yard(0, { connected: false }), deps(textures));
    view.update(yard(64, { connected: false }));
    expect(view.badgeVisible).toBe(true);
    expect((view.view.children[0] as Sprite).texture).toBe(textures.textureFor(stateFile('fill100')));
  });

  it.each(ROTATIONS)('rot %i: odznak ostáva vzpriamený (nerotuje s modulom)', (rotation: Rotation) => {
    const view = new ModuleView(depot({ connected: false, rotation }), deps(new StubTextures()));
    mount(view);
    const transform = view.badgeView?.getGlobalTransform();
    expect(transform?.a).toBeCloseTo(1, 9);
    expect(transform?.b).toBeCloseTo(0, 9);
    expect(view.view.angle).toBeCloseTo(rotation, 9);
  });

  it('bez textúry odznaku → kruh `Graphics` z tokenu `--module-disconnected`', () => {
    const view = new ModuleView(depot({ connected: false }), deps(null));
    expect(view.badgeView?.children[0]).toBeInstanceOf(Graphics);
    expect(ENTITY_PALETTE.disconnected.color).toBe(0xf2b233);
  });

  it('setBadgeScale nastaví násobok odznaku, aj keď odznak ešte nevznikol', () => {
    const view = new ModuleView(depot({ connected: true }), deps(new StubTextures()));
    view.setBadgeScale(2);
    view.update(depot({ connected: false }));
    expect(view.badgeView?.scale.x).toBe(2);
    view.setBadgeScale(1.5);
    expect(view.badgeView?.scale.x).toBe(1.5);
  });
});

describe('ModuleLayer: sklady, odznaky a zoom', () => {
  it('zmena zaplnenia alebo pripojenia nevytvorí view nanovo', () => {
    const layer = new ModuleLayer(deps(new StubTextures()));
    layer.sync([yard(0), depot()]);
    const first = layer.moduleView(7);
    layer.sync([yard(48, { connected: false }), depot({ connected: false })]);
    expect(layer.moduleView(7)).toBe(first);
    expect(first?.fill).toBe(75);
    expect(layer.moduleView(7)?.badgeVisible).toBe(true);
    expect(layer.moduleView(8)?.badgeVisible).toBe(true);
    expect(layer.moduleCount).toBe(2);
  });

  it('setZoom nastaví odznaky podľa badgeScaleForZoom, aj pre views vytvorené až neskôr', () => {
    const layer = new ModuleLayer(deps(new StubTextures()));
    layer.sync([depot({ connected: false })]);
    layer.setZoom(0.5);
    expect(layer.moduleView(8)?.badgeView?.scale.x).toBe(badgeScaleForZoom(0.5));
    layer.sync([depot({ connected: false }), yard(0, { connected: false })]);
    expect(layer.moduleView(7)?.badgeView?.scale.x).toBe(badgeScaleForZoom(0.5));
    layer.setZoom(2);
    expect(layer.moduleView(8)?.badgeView?.scale.x).toBe(1);
    expect(layer.moduleView(7)?.badgeView?.scale.x).toBe(1);
  });

  it('nový view po zmene zoomu dostane aktuálny násobok', () => {
    const layer = new ModuleLayer(deps(new StubTextures()));
    layer.setZoom(0.25);
    layer.sync([depot({ connected: false })]);
    expect(layer.moduleView(8)?.badgeView?.scale.x).toBe(badgeScaleForZoom(0.25));
  });
});
