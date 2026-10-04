import { Container, Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { CraneLayer } from '@render/crane-layer';
import {
  BADGE_MAX_SCALE,
  CRANE_BOOM_TILT_DEG,
  CraneView,
  badgeScaleForZoom,
  craneBox,
  craneParts,
  trolleyBoomY,
  trolleyTravelFraction,
  type CraneState,
} from '@render/crane-view';
import { BLOCKED_BADGE_FILE, moduleSprite } from '@render/entity-assets';
import type { CraneVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;
const SPRITE = moduleSprite('crane_container_gantry');
const TRAVEL = SPRITE?.parts?.['trolley']?.travel ?? { yMin: 0, yMax: 0 };
const BOOM_PIVOT = SPRITE?.parts?.['boom']?.pivot ?? { x: 0, y: 0 };

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

function crane(over: Partial<CraneVM> = {}): CraneVM {
  return {
    id: 7,
    defId: 'crane_container_gantry',
    berthId: 1,
    x: 43,
    y: 14,
    rotation: 0,
    state: 'idle',
    progress: 0,
    holding: null,
    ...over,
  };
}

describe('manifest žeriava', () => {
  it('crane_container_gantry: base + boom (pivot, mountOnBase) + trolley (travel po výložníku)', () => {
    const parts = SPRITE !== undefined ? craneParts(SPRITE) : undefined;
    expect(parts?.baseFile).toContain('crane_container_gantry_base');
    expect(parts?.boom?.pivot).toBeDefined();
    expect(parts?.boom?.mountOnBase).toBeDefined();
    expect(parts?.mover?.travel?.axis).toBe('boom');
    expect(TRAVEL.yMax).toBeGreaterThan(TRAVEL.yMin);
  });
});

describe('trolleyTravelFraction (0 = pevnina, 1 = more)', () => {
  it.each([
    ['idle', 0.4, 0],
    ['blocked', 0.4, 0],
    ['grabbing', 0, 0],
    ['grabbing', 0.5, 0.5],
    ['grabbing', 1, 1],
    ['swinging', 0.3, 1],
    ['placing', 0, 1],
    ['placing', 0.25, 0.75],
    ['placing', 1, 0],
  ] as const)('%s pri progress %f → %f', (state, progress, expected) => {
    expect(trolleyTravelFraction(state, progress)).toBeCloseTo(expected, 12);
  });

  it('progress mimo 0..1 sa orezá', () => {
    expect(trolleyTravelFraction('grabbing', -1)).toBe(0);
    expect(trolleyTravelFraction('grabbing', 2)).toBe(1);
  });
});

describe('trolleyBoomY (y stredu vozíka v súbore výložníka)', () => {
  it('0 = pevninský koniec (yMax), 1 = morský koniec (yMin), lineárne medzi', () => {
    expect(trolleyBoomY(0, TRAVEL)).toBe(TRAVEL.yMax);
    expect(trolleyBoomY(1, TRAVEL)).toBe(TRAVEL.yMin);
    expect(trolleyBoomY(0.5, TRAVEL)).toBe((TRAVEL.yMin + TRAVEL.yMax) / 2);
  });
});

describe('CraneView: skladanie častí', () => {
  it('základňa vyplní footprint, výložník sa kladie pivotom na mountOnBase, sprity z manifestu', () => {
    const textures = new StubTextures();
    const view = new CraneView(crane(), deps(textures));
    expect(view.view.position.x).toBe(44 * CELL); // stred footprintu 2×3 na (43, 14)
    expect(view.view.position.y).toBe(15.5 * CELL);
    const body = view.view.children[0] as Container;
    // základňa je samostatný koreň `baseView` (F6d): kreslí sa pod vozidlami, výložník a vozík nad nimi
    expect(view.baseView.position.x).toBe(44 * CELL);
    expect(view.baseView.position.y).toBe(15.5 * CELL);
    const base = (view.baseView.children[0] as Container).children[0] as Sprite;
    expect(base.texture).toBe(textures.textureFor('file/modules/crane_container_gantry_base.svg'));
    expect(base.position.x).toBe(-CELL);
    expect(base.position.y).toBe(-1.5 * CELL);
    expect(base.width).toBeCloseTo(2 * CELL, 6);
    expect(base.height).toBeCloseTo(3 * CELL, 6);

    expect(body.children).toHaveLength(1); // len výložník (so vozíkom); základňa je v `baseView`
    const boomGroup = body.children[0] as Container;
    const mount = SPRITE?.parts?.['boom']?.mountOnBase ?? { x: 0, y: 0 };
    expect(boomGroup.position.x).toBe(-CELL + mount.x);
    expect(boomGroup.position.y).toBe(-1.5 * CELL + mount.y);
    const boom = boomGroup.children[0] as Sprite;
    expect(boom.texture).toBe(textures.textureFor('file/modules/crane_container_gantry_boom.svg'));
    expect(boom.position.x).toBe(-BOOM_PIVOT.x); // pivot sprite je v počiatku skupiny výložníka
    expect(boom.position.y).toBe(-BOOM_PIVOT.y);
    expect(boom.height).toBeCloseTo(5 * CELL, 6);
  });

  it('rot 90: kontajner sa otočí, stred je stred otočeného footprintu 3×2', () => {
    const vm = crane({ rotation: 90, x: 43, y: 14 });
    expect(craneBox(vm, { w: 2, h: 3 })).toEqual({ x: 43, y: 14, w: 3, h: 2, rotation: 90 });
    const view = new CraneView(vm, deps(new StubTextures()));
    expect(view.view.position.x).toBe(44.5 * CELL);
    expect(view.view.position.y).toBe(15 * CELL);
    expect(view.view.angle).toBe(0); // koreň sa neotáča (odznak ostáva vzpriamený)
    const body = view.view.children[0] as Container;
    expect(body.angle).toBeCloseTo(90, 9);
    expect((view.baseView.children[0] as Container).angle).toBeCloseTo(90, 9); // základňa sa otáča rovnako
    expect(view.baseView.position.x).toBe(44.5 * CELL);
  });

  it('bez textúr → obdĺžniky `Graphics` z tokenov', () => {
    const view = new CraneView(crane(), deps(null));
    const body = view.view.children[0] as Container;
    expect((view.baseView.children[0] as Container).children[0]).toBeInstanceOf(Graphics);
    const boomGroup = body.children[0] as Container;
    expect(boomGroup.children[0]).toBeInstanceOf(Graphics);
  });
});

describe('CraneView: vozík podľa fázy', () => {
  const scale = CELL / 64; // manifest je kreslený pri 64 px na bunku
  const offset = (fraction: number) => (trolleyBoomY(fraction, TRAVEL) - BOOM_PIVOT.y) * scale;

  it('idle: vozík na pevninskom konci', () => {
    const view = new CraneView(crane({ state: 'idle' }), deps(new StubTextures()));
    expect(view.trolleyOffsetY).toBeCloseTo(offset(0), 9);
  });

  it('grabbing: vozík ide z pevniny na more podľa progress', () => {
    const view = new CraneView(crane({ state: 'grabbing', progress: 0 }), deps(new StubTextures()));
    expect(view.trolleyOffsetY).toBeCloseTo(offset(0), 9);
    view.update(crane({ state: 'grabbing', progress: 0.5 }));
    expect(view.trolleyOffsetY).toBeCloseTo(offset(0.5), 9);
    view.update(crane({ state: 'grabbing', progress: 1 }));
    expect(view.trolleyOffsetY).toBeCloseTo(offset(1), 9);
  });

  it('placing: vozík sa vracia (1 − progress) a nesie kontajner', () => {
    const holding = { unitId: 5, typeId: 'container_teu' };
    const view = new CraneView(crane({ state: 'placing', progress: 0.25, holding }), deps(new StubTextures()));
    expect(view.trolleyOffsetY).toBeCloseTo(offset(0.75), 9);
    expect(view.heldCargo?.unitId).toBe(5);
    expect(view.heldCargo?.typeId).toBe('container_teu');
  });

  it('trolley je dieťa skupiny výložníka: pri náklone sa natáča s ním', () => {
    const view = new CraneView(crane({ state: 'grabbing', progress: 0.5 }), deps(new StubTextures()));
    expect(view.boomAngle).toBeCloseTo(CRANE_BOOM_TILT_DEG.grabbing, 9);
    const boomGroup = (view.view.children[0] as Container).children[0] as Container;
    expect(boomGroup.children).toHaveLength(2); // sprite výložníka + skupina vozíka
  });

  it('náklad: držaný len s `holding`, po odložení zmizne, výmena jednotky vymení sprite', () => {
    const view = new CraneView(crane({ state: 'placing', progress: 0.5, holding: { unitId: 1, typeId: 'container_teu' } }), deps(new StubTextures()));
    const first = view.heldCargo;
    expect(first).not.toBeNull();
    view.update(crane({ state: 'placing', progress: 0.6, holding: { unitId: 1, typeId: 'container_teu' } }));
    expect(view.heldCargo).toBe(first); // rovnaká jednotka, ten istý sprite
    view.update(crane({ state: 'idle', progress: 0, holding: null }));
    expect(view.heldCargo).toBeNull();
    expect(first?.destroyed).toBe(true);
    view.update(crane({ state: 'placing', progress: 0.1, holding: { unitId: 2, typeId: 'container_teu' } }));
    expect(view.heldCargo?.unitId).toBe(2);
  });

  it('náklad je pod spritom vozíka (spreader nad kontajnerom)', () => {
    const view = new CraneView(crane({ state: 'placing', progress: 0.5, holding: { unitId: 1, typeId: 'container_teu' } }), deps(new StubTextures()));
    const boomGroup = (view.view.children[0] as Container).children[0] as Container;
    const moverGroup = boomGroup.children[1] as Container;
    expect(moverGroup.children[0]).toBe(view.heldCargo);
    expect(moverGroup.children[1]).toBeInstanceOf(Sprite);
  });
});

describe('CraneView: sklon výložníka a odznak', () => {
  it.each(Object.keys(CRANE_BOOM_TILT_DEG) as CraneState[])('%s: sklon z konštanty CRANE_BOOM_TILT_DEG', (state) => {
    const view = new CraneView(crane({ state }), deps(new StubTextures()));
    expect(view.boomAngle).toBeCloseTo(CRANE_BOOM_TILT_DEG[state], 9);
  });

  it('sklon je malý (do 10°), aby výložník ostal nad vodou', () => {
    for (const degrees of Object.values(CRANE_BOOM_TILT_DEG)) expect(Math.abs(degrees)).toBeLessThanOrEqual(10);
  });

  it('blocked zobrazí odznak `overlay.blocked_badge`, iné stavy ho skryjú', () => {
    const textures = new StubTextures();
    const view = new CraneView(crane({ state: 'blocked' }), deps(textures));
    expect(view.badgeVisible).toBe(true);
    const badge = (view.view.children[1] as Container).children[0] as Sprite;
    expect(badge.texture).toBe(textures.textureFor(`file/${BLOCKED_BADGE_FILE}`));
    expect(badge.width).toBeCloseTo(24, 6);
    view.update(crane({ state: 'grabbing', progress: 0.1 }));
    expect(view.badgeVisible).toBe(false);
    view.update(crane({ state: 'blocked' }));
    expect(view.badgeVisible).toBe(true);
  });

  it('badgeScaleForZoom: 1 pri zoome ≥ 1, inak 1/zoom najviac BADGE_MAX_SCALE', () => {
    expect(badgeScaleForZoom(2)).toBe(1);
    expect(badgeScaleForZoom(1)).toBe(1);
    expect(badgeScaleForZoom(0.8)).toBeCloseTo(1.25, 12);
    expect(badgeScaleForZoom(0.25)).toBe(BADGE_MAX_SCALE);
    expect(() => badgeScaleForZoom(0)).toThrow(RangeError);
  });
});

describe('CraneLayer (synchronizácia podľa id)', () => {
  it('vytvára a ruší views podľa id, nezmenené ponecháva', () => {
    const layer = new CraneLayer(deps(new StubTextures()));
    layer.sync([crane({ id: 1 }), crane({ id: 2, x: 50 })]);
    expect(layer.craneCount).toBe(2);
    const first = layer.craneView(1);
    layer.sync([crane({ id: 1, state: 'grabbing', progress: 0.3 })]);
    expect(layer.craneView(1)).toBe(first);
    expect(first?.vm.state).toBe('grabbing');
    expect(layer.craneCount).toBe(1);
    expect(layer.view.children).toHaveLength(1);
  });

  it('zmena polohy alebo rotácie vytvorí view nanovo', () => {
    const layer = new CraneLayer(deps(new StubTextures()));
    layer.sync([crane()]);
    const first = layer.craneView(7);
    layer.sync([crane({ rotation: 180 })]);
    expect(layer.craneView(7)).not.toBe(first);
    expect(first?.view.destroyed).toBe(true);
  });

  it('setZoom zväčší odznaky pri malom zoome (aj pre nové žeriavy)', () => {
    const layer = new CraneLayer(deps(new StubTextures()));
    layer.sync([crane({ state: 'blocked' })]);
    layer.setZoom(0.5);
    const badge = layer.craneView(7)?.view.children[1] as Container;
    expect(badge.scale.x).toBeCloseTo(2, 9);
    layer.sync([crane({ state: 'blocked' }), crane({ id: 8, x: 50, state: 'blocked' })]);
    const other = layer.craneView(8)?.view.children[1] as Container;
    expect(other.scale.x).toBeCloseTo(2, 9);
    layer.setZoom(1);
    expect(badge.scale.x).toBe(1);
  });
});
