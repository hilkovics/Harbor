import { Container, Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ROTATIONS, rotateFootprint, type Rotation } from '@sim/grid';
import { moduleSprite } from '@render/entity-assets';
import { ModuleView } from '@render/module-view';
import { RampDecor, STAGED_ANGLE, STAGED_INSET_PX, stagedPlacements } from '@render/ramp-decor';
import { STALL_FILL_ALPHA, WaitingAreaDecor, occupiedStalls } from '@render/waiting-area-decor';
import type { ModuleVM } from '@render/view-models';
import { TEU_PX } from '@render/world-scale';
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
  const teu = TEU_PX;

  it('žiadny kontajner → nič', () => {
    expect(stagedPlacements(dock, 0, teu)).toEqual([]);
    expect(stagedPlacements(dock, -1, teu)).toEqual([]);
  });

  it('jeden kontajner má veľkosť TEU (64 × 26), leží dlhšou stranou pozdĺž doku a je v jeho strede', () => {
    expect(stagedPlacements(dock, 1, teu)).toEqual([{ x: dock.x + dock.w / 2, y: dock.y + dock.h / 2, angle: STAGED_ANGLE }]);
    expect(STAGED_ANGLE).toBe(90);
    // dĺžka kontajnera (64 px, viditeľný obsah 62) zaberie dok 56 × 62 px pozdĺž, šírka 26 px sa zmestí naprieč
    expect(teu.h).toBeLessThan(dock.w - 2 * STAGED_INSET_PX);
    expect(teu.w - 2).toBeLessThanOrEqual(dock.h);
  });

  it('dva kontajnery sa zmestia vedľa seba bez prekrytia, symetricky okolo stredu doku a v jeho šírke', () => {
    const [first, second] = stagedPlacements(dock, 2, teu);
    expect(second.x - first.x).toBeCloseTo(teu.h, 9);
    expect((first.x + second.x) / 2).toBeCloseTo(dock.x + dock.w / 2, 9);
    expect(first.x - teu.h / 2).toBeGreaterThanOrEqual(dock.x + STAGED_INSET_PX - 1e-9);
    expect(second.x + teu.h / 2).toBeLessThanOrEqual(dock.x + dock.w - STAGED_INSET_PX + 1e-9);
    expect(first.y).toBe(second.y);
  });

  it('viac kusov, než sa zmestí: prekrývajú sa, ale krajné ostanú v doku; užší dok než kontajner krok nezáporný', () => {
    const placements = stagedPlacements(dock, 5, teu);
    expect(placements).toHaveLength(5);
    expect(placements[1].x - placements[0].x).toBeLessThan(teu.h);
    expect(placements[0].x - teu.h / 2).toBeCloseTo(dock.x + STAGED_INSET_PX, 9);
    expect(placements[4].x + teu.h / 2).toBeCloseTo(dock.x + dock.w - STAGED_INSET_PX, 9);
    const narrow = stagedPlacements({ x: 0, y: 0, w: 20, h: 62 }, 3, teu);
    expect(narrow.map((placement) => placement.x)).toEqual([10, 10, 10]);
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

  it('kontajner je `cargo.container_teu` v pôvodnej veľkosti TEU 64 × 26, natočený pozdĺž doku a stojí na doku (lokálny rámec modulu 4×2)', () => {
    const textures = new StubTextures();
    const view = new ModuleView(ramp([2, 0]), deps(textures));
    const cargo = rampDecor(view).stagedSprite(0, 0);
    const sprite = cargo?.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor('file/cargo/container_teu.svg'));
    // bez škálovania (rovnaká veľkosť ako na aprone, pod žeriavom a v návese kamióna) a dlhšou stranou pozdĺž doku
    expect(cargo?.scale.x).toBe(1);
    expect(cargo?.scale.y).toBe(1);
    expect(sprite.width).toBeCloseTo(TEU_PX.w * (CELL / 64), 9);
    expect(sprite.height).toBeCloseTo(TEU_PX.h * (CELL / 64), 9);
    expect(cargo?.angle).toBe(STAGED_ANGLE);
    // dok 0: x 68–124, y 60–122 px súboru; footprint 4×2 → ľavý horný roh (−128; −64); dva kusy vedľa seba okolo stredu doku
    const second = rampDecor(view).stagedSprite(0, 1);
    expect(cargo?.position.x).toBeCloseTo(-128 + 96 - TEU_PX.h / 2, 9);
    expect(second?.position.x).toBeCloseTo(-128 + 96 + TEU_PX.h / 2, 9);
    expect(cargo?.position.y).toBeCloseTo(-64 + 91, 9);
    expect(second?.position.y).toBeCloseTo(-64 + 91, 9);
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
