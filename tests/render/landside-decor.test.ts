import { Container, Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ROTATIONS, rotateFootprint, type Rotation } from '@sim/grid';
import { moduleSprite } from '@render/entity-assets';
import { ModuleView } from '@render/module-view';
import { RampDecor, STAGED_INSET_PX, stagedPlacements } from '@render/ramp-decor';
import { STALL_FILL_ALPHA, WaitingAreaDecor, occupiedStalls } from '@render/waiting-area-decor';
import type { ModuleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

const SIX_FREE = [false, false, false, false, false, false];

/** Čakacia plocha 4×3 s ľavým horným rohom (33; 26) po rotácii. */
function waitingArea(occupied: readonly boolean[] = SIX_FREE, rotation: Rotation = 0, over: Partial<ModuleVM> = {}): ModuleVM {
  const size = rotateFootprint(4, 3, rotation);
  return {
    id: 8,
    defId: 'truck_waiting_area',
    kind: 'waiting_area',
    x: 33,
    y: 26,
    rotation,
    w: size.w,
    h: size.h,
    connected: true,
    waitingArea: { bays: 6, occupied },
    ...over,
  };
}

/** Rampa 4×2 s ľavým horným rohom (30; 23) po rotácii. */
function ramp(
  staged: readonly number[] = [0, 0],
  operational = true,
  over: Partial<ModuleVM> = {},
  rotation: Rotation = 0,
): ModuleVM {
  const size = rotateFootprint(4, 2, rotation);
  return {
    id: 9,
    defId: 'loading_ramp_container',
    kind: 'ramp',
    x: 30,
    y: 23,
    rotation,
    w: size.w,
    h: size.h,
    connected: true,
    ramp: { docks: 2, staged, operational },
    ...over,
  };
}

function waitingDecor(view: ModuleView): WaitingAreaDecor {
  const decor = view.decor<WaitingAreaDecor>('waiting_area');
  if (decor === undefined) throw new Error('ModuleView nemá ozdobu čakacej plochy');
  return decor;
}

function rampDecor(view: ModuleView): RampDecor {
  const decor = view.decor<RampDecor>('ramp');
  if (decor === undefined) throw new Error('ModuleView nemá ozdobu rampy');
  return decor;
}

describe('occupiedStalls', () => {
  it('indexy obsadených stojísk v poradí; index mimo manifestu a chýbajúce pole sa preskočia', () => {
    expect(occupiedStalls([true, true, false, true, true, false], 6)).toEqual([0, 1, 3, 4]);
    expect(occupiedStalls([true, true, true], 2)).toEqual([0, 1]);
    expect(occupiedStalls(undefined, 6)).toEqual([]);
    expect(occupiedStalls([], 6)).toEqual([]);
  });
});

describe('ModuleView: čakacia plocha (obsadené stojiská)', () => {
  it('ozdoba vznikne len pre VM s `waitingArea`; zvýrazní obsadené stojiská', () => {
    const plain = new ModuleView(waitingArea(SIX_FREE, 0, { waitingArea: undefined }), deps(new StubTextures()));
    expect(plain.decor('waiting_area')).toBeUndefined();
    const view = new ModuleView(waitingArea([true, true, false, true, true, false]), deps(new StubTextures()));
    expect(waitingDecor(view).highlighted).toEqual([0, 1, 3, 4]);
  });

  it('zvýraznenie sa mení s obsadenosťou, prázdna plocha nemá nič', () => {
    const view = new ModuleView(waitingArea(), deps(new StubTextures()));
    expect(waitingDecor(view).highlighted).toEqual([]);
    view.update(waitingArea([false, false, true, false, false, true]));
    expect(waitingDecor(view).highlighted).toEqual([2, 5]);
    view.update(waitingArea());
    expect(waitingDecor(view).highlighted).toEqual([]);
  });

  it('stojisko sa kreslí na obdĺžnik `stalls[i]` z manifestu (px súboru × cell / 64) v lokálnom rámci modulu', () => {
    const view = new ModuleView(waitingArea([false, true, false, false, false, false]), deps(new StubTextures()));
    const graphics = waitingDecor(view).view.children[0] as Graphics;
    expect(graphics).toBeInstanceOf(Graphics);
    const stall = moduleSprite('truck_waiting_area')?.stalls?.[1];
    expect(stall).toEqual({ x: 48, y: 12, w: 40, h: 116 });
    const bounds = graphics.getLocalBounds();
    // footprint 4×3: ľavý horný roh je (−128; −96); obrys je vo vnútri obdĺžnika (alignment 1)
    expect(bounds.x).toBeCloseTo(-128 + 48, 6);
    expect(bounds.y).toBeCloseTo(-96 + 12, 6);
    expect(bounds.width).toBeCloseTo(40, 6);
    expect(bounds.height).toBeCloseTo(116, 6);
  });

  it('zvýraznenie je priesvitné a v tokene `--ui-accent`', () => {
    expect(STALL_FILL_ALPHA).toBeGreaterThan(0);
    expect(STALL_FILL_ALPHA).toBeLessThan(1);
    expect(ENTITY_PALETTE.accent.color).toBe(0x3aa0ff);
  });

  it('nezmenená obsadenosť nekreslí znova; zvýraznenie nespustí odznak upozornenia', () => {
    const view = new ModuleView(waitingArea([true, false, false, false, false, false]), deps(new StubTextures()));
    const decor = waitingDecor(view);
    const before = decor.highlighted;
    view.update(waitingArea([true, false, false, false, false, false]));
    expect(decor.highlighted).toBe(before);
    expect(view.badgeVisible).toBe(false);
  });

  it.each(ROTATIONS)('rot %i: ozdoba sa otáča s modulom (je v jeho kontajneri)', (rotation) => {
    const view = new ModuleView(waitingArea([true, false, false, false, false, false], rotation), deps(new StubTextures()));
    const root = new Container();
    root.addChild(view.view);
    expect(waitingDecor(view).view.parent?.parent).toBe(view.view);
    expect(view.view.angle).toBeCloseTo(rotation, 9);
  });
});

describe('stagedPlacements (kontajnery pripravené na doku)', () => {
  const dock = { x: 68, y: 60, w: 56, h: 62 };
  const teu = { w: 64, h: 32 };

  it('žiadny kontajner → nič', () => {
    expect(stagedPlacements(dock, 0, teu)).toEqual([]);
    expect(stagedPlacements(dock, -1, teu)).toEqual([]);
  });

  it('kontajner sa zmenší na šírku doku bez okrajov a leží pri vzdialenom (hornom) konci doku', () => {
    const scale = (56 - 2 * STAGED_INSET_PX) / 64;
    expect(stagedPlacements(dock, 1, teu)).toEqual([{ x: 96, y: 60 + STAGED_INSET_PX + (32 * scale) / 2, scale }]);
  });

  it('dva kontajnery sa zmestia pod seba bez prekrytia a ostanú v doku', () => {
    const [first, second] = stagedPlacements(dock, 2, teu);
    const height = 32 * first.scale;
    expect(second.y - first.y).toBeCloseTo(height, 9);
    expect(first.y - height / 2).toBeGreaterThanOrEqual(dock.y + STAGED_INSET_PX - 1e-9);
    expect(second.y + height / 2).toBeLessThanOrEqual(dock.y + dock.h - STAGED_INSET_PX + 1e-9);
  });

  it('viac kusov, než sa zmestí: prekrývajú sa, ale posledný ostane v doku', () => {
    const placements = stagedPlacements(dock, 5, teu);
    expect(placements).toHaveLength(5);
    const height = 32 * placements[0].scale;
    expect(placements[1].y - placements[0].y).toBeLessThan(height);
    expect(placements[4].y + height / 2).toBeCloseTo(dock.y + dock.h - STAGED_INSET_PX, 9);
  });
});

describe('ModuleView: rampa (pripravené kontajnery a upozornenie)', () => {
  it('ozdoba vznikne len pre VM s `ramp`; počet nakreslených kontajnerov sedí so `staged` po dokoch', () => {
    const plain = new ModuleView(ramp([0, 0], true, { ramp: undefined }), deps(new StubTextures()));
    expect(plain.decor('ramp')).toBeUndefined();
    const view = new ModuleView(ramp([2, 1]), deps(new StubTextures()));
    const decor = rampDecor(view);
    expect([decor.stagedDrawn(0), decor.stagedDrawn(1)]).toEqual([2, 1]);
    view.update(ramp([0, 2]));
    expect([decor.stagedDrawn(0), decor.stagedDrawn(1)]).toEqual([0, 2]);
  });

  it('kontajner je `cargo.container_teu` zmenšený na šírku doku a stojí na doku (lokálny rámec modulu 4×2)', () => {
    const textures = new StubTextures();
    const view = new ModuleView(ramp([2, 0]), deps(textures));
    const cargo = rampDecor(view).stagedSprite(0, 0);
    const sprite = cargo?.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor('file/cargo/container_teu.svg'));
    const scale = (56 - 2 * STAGED_INSET_PX) / 64;
    expect(cargo?.scale.x).toBeCloseTo(scale, 9);
    // dok 0: x 68–124, y 60–122 px súboru; footprint 4×2 → ľavý horný roh (−128; −64)
    expect(cargo?.position.x).toBeCloseTo(-128 + 96, 9);
    expect(cargo?.position.y).toBeCloseTo(-64 + 60 + STAGED_INSET_PX + (32 * scale) / 2, 9);
    const second = rampDecor(view).stagedSprite(0, 1);
    expect((second?.position.y ?? 0) - (cargo?.position.y ?? 0)).toBeCloseTo(32 * scale, 9);
    // druhý dok je vpravo od prvého
    const other = new ModuleView(ramp([0, 1]), deps(textures));
    expect(rampDecor(other).stagedSprite(1, 0)?.position.x).toBeCloseTo(-128 + 160, 9);
  });

  it('bez textúr → kontajnery `Graphics` z tokenov', () => {
    const view = new ModuleView(ramp([1, 0]), deps(null));
    expect(rampDecor(view).stagedSprite(0, 0)?.children[0]).toBeInstanceOf(Graphics);
  });

  it('nezmenený počet nekreslí znova (rovnaké objekty), zmenšenie počtu kontajnery zruší', () => {
    const view = new ModuleView(ramp([2, 0]), deps(new StubTextures()));
    const decor = rampDecor(view);
    const first = decor.stagedSprite(0, 0);
    view.update(ramp([2, 0]));
    expect(decor.stagedSprite(0, 0)).toBe(first);
    view.update(ramp([1, 0]));
    expect(decor.stagedDrawn(0)).toBe(1);
    expect(decor.stagedSprite(0, 1)).toBeUndefined();
    view.update(ramp([0, 0]));
    expect(first?.destroyed).toBe(true);
  });

  it('`staged` kratšie než počet dokov alebo záporné hodnoty: chýbajúce doky sú prázdne', () => {
    const view = new ModuleView(ramp([1]), deps(new StubTextures()));
    expect([rampDecor(view).stagedDrawn(0), rampDecor(view).stagedDrawn(1)]).toEqual([1, 0]);
    view.update(ramp([-3, 0]));
    expect(rampDecor(view).stagedDrawn(0)).toBe(0);
  });

  it('neprevádzková rampa má odznak upozornenia (`overlay.warning_badge`), prevádzková nie', () => {
    const textures = new StubTextures();
    const working = new ModuleView(ramp([0, 0], true), deps(textures));
    expect(working.badgeVisible).toBe(false);
    const broken = new ModuleView(ramp([0, 0], false), deps(textures));
    expect(broken.badgeVisible).toBe(true);
    const sprite = broken.badgeView?.children[0] as Sprite;
    expect(sprite.texture).toBe(textures.textureFor('file/overlay/warning_badge.svg'));
    // rampa sa sprevádzkuje → odznak zmizne; opäť vypadne → odznak sa vráti
    broken.update(ramp([0, 0], true));
    expect(broken.badgeVisible).toBe(false);
    broken.update(ramp([0, 0], false));
    expect(broken.badgeVisible).toBe(true);
  });

  it('nepripojená prevádzková rampa má odznak tiež (`connected === false`), pripojená prevádzková nie', () => {
    const view = new ModuleView(ramp([0, 0], true, { connected: false }), deps(new StubTextures()));
    expect(view.badgeVisible).toBe(true);
    view.update(ramp([0, 0], true, { connected: true }));
    expect(view.badgeVisible).toBe(false);
  });

  it('odznak upozornenia ostáva vzpriamený pri rotácii modulu', () => {
    const view = new ModuleView(ramp([0, 0], false, {}, 90), deps(new StubTextures()));
    expect((((view.view.angle + (view.badgeView?.angle ?? 0)) % 360) + 360) % 360).toBeCloseTo(0, 9);
  });

  it('rampa bez záznamu v manifeste: ozdoba nespadne a nič nekreslí', () => {
    const view = new ModuleView(ramp([2, 2], false, { defId: 'neznama_rampa' }), deps(new StubTextures()));
    expect(rampDecor(view).stagedDrawn(0)).toBe(0);
    expect(view.badgeVisible).toBe(true); // neprevádzková, aj keď sa nevie nakresliť
  });

  it('destroy uvoľní kontajnery', () => {
    const view = new ModuleView(ramp([1, 1]), deps(new StubTextures()));
    const cargo = rampDecor(view).stagedSprite(0, 0);
    view.destroy();
    expect(cargo?.destroyed).toBe(true);
  });
});
