// R2 (TR2-03): blok skladu zhora — rozloženie pozícií, vrchný kontajner každého stohu (20′ / 40′ na páre bays), tieň výšky, telo bloku a vzťah
// k portálovému žeriavu dvora. Bez `ModuleVM.stacks` sa sklad kreslí ako doteraz (fill stavy).
import { Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { cargoSizePx } from '@render/cargo-sprite';
import { manifestScale } from '@render/entity-assets';
import { ModuleView } from '@render/module-view';
import {
  BAY_FILL,
  STACK_GROUND_INSET_CELLS,
  STACK_MARGIN_CELLS,
  StacksDecor,
  coveredPositions,
  pairStartOf,
  positionCentre,
  shadowOutline,
  stackCentre,
  stackGeometryOf,
  stackLayout,
  visibleStacks,
} from '@render/stacks-decor';
import type { ContainerVM, ModuleVM, StackVM } from '@render/view-models';
import { BLOCK, BLOCK_GEOMETRY, DEPOT, DEPOT_GEOMETRY, DEPOT_STACKS, emptyBox, emptyPosition, stack20, stack40 } from '@render/__demo__/r2-stacks.fixtures';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;
const UNIT = manifestScale(CELL);

function deps(textures: StubTextures | null = new StubTextures()) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures, now: () => 0, reducedMotion: () => true };
}

function dry(sizeFt: 20 | 40 = 20, lineId: string | null = 'blue_anchor'): ContainerVM {
  return { sizeFt, containerType: 'dry', lineId, direction: 'import' };
}

/** Sklad bez polí R2 (`stacks`, `stackGeometry`): VM z F3–F6c. */
function withoutStacks(vm: ModuleVM): ModuleVM {
  const copy: ModuleVM = { ...vm };
  delete copy.stacks;
  delete copy.stackGeometry;
  return copy;
}

function decorOf(view: ModuleView): StacksDecor {
  const decor = view.decor<StacksDecor>('stacks');
  if (decor === undefined) throw new Error('blok nemá ozdobu stohov');
  return decor;
}

describe('stackGeometryOf / stackLayout', () => {
  it('geometria z VM, inak odvodená zo stohov (max bay + 1, max row + 1, max výška; aspoň 1)', () => {
    expect(stackGeometryOf({ stackGeometry: { bays: 6, rows: 3, maxTier: 5 }, stacks: [] })).toEqual({ bays: 6, rows: 3, maxTier: 5 });
    expect(stackGeometryOf({ stacks: [stack20(2, 1, 3, dry()), stack20(0, 3, 1, dry())] })).toEqual({ bays: 3, rows: 4, maxTier: 3 });
    expect(stackGeometryOf({ stacks: [] })).toEqual({ bays: 1, rows: 1, maxTier: 1 });
  });

  it('4 × 4 pozície v bloku 4 × 4 buniek: rozstup = (footprint − 2 × okraj) / počet, 20′ sa zmenší, aby sa zmestil do bay', () => {
    const layout = stackLayout({ bays: 4, rows: 4 }, 4, 4, CELL);
    const inner = 4 * CELL - 2 * STACK_MARGIN_CELLS * CELL;
    expect(layout.pitchX).toBeCloseTo(inner / 4, 9);
    expect(layout.pitchY).toBeCloseTo(inner / 4, 9);
    expect(layout.left).toBeCloseTo(-inner / 2, 9);
    expect(layout.fit).toBeCloseTo((layout.pitchX * BAY_FILL) / 64, 9);
    expect(layout.fit).toBeLessThan(1);
    expect(layout.natural).toEqual(cargoSizePx('container_20_dry', CELL));
    const first = positionCentre(layout, 0, 0);
    const last = positionCentre(layout, 3, 3);
    expect(first.x).toBeCloseTo(-last.x, 9); // symetricky okolo stredu footprintu
    expect(first.y).toBeCloseTo(-last.y, 9);
  });

  it('blok 4 radov vo footprinte 3 buniek má rozstup radov 42 px (rozstup straddle bloku z Claude Design)', () => {
    expect(stackLayout({ bays: 4, rows: 4 }, 4, 3, 64).pitchY).toBeCloseTo(42, 9);
  });

  it('veľký footprint: kontajner sa nezväčšuje nad prirodzenú veľkosť', () => {
    expect(stackLayout({ bays: 2, rows: 2 }, 8, 8, CELL).fit).toBe(1);
  });

  it('pozície a 40′: pár bays (2k, 2k + 1), stred 40′ je medzi stredmi oboch pozícií v tom istom rade', () => {
    expect([0, 1, 2, 3, 4].map(pairStartOf)).toEqual([0, 0, 2, 2, 4]);
    const layout = stackLayout({ bays: 4, rows: 4 }, 4, 4, CELL);
    const centre = stackCentre(layout, { bay: 2, row: 1 }, 40);
    expect(centre.x).toBeCloseTo((positionCentre(layout, 2, 1).x + positionCentre(layout, 3, 1).x) / 2, 9);
    expect(centre.y).toBeCloseTo(positionCentre(layout, 2, 1).y, 9);
    expect(stackCentre(layout, { bay: 3, row: 1 }, 40)).toEqual(centre); // nepárna pozícia páru dá ten istý stred
    expect(stackCentre(layout, { bay: 3, row: 1 }, 20)).toEqual(positionCentre(layout, 3, 1));
  });
});

describe('visibleStacks / coveredPositions / shadowOutline', () => {
  it('prázdne pozície a výška 0 sa nekreslia, 40′ raz na pár bays (na prvej pozícii), od najnižšieho potom po radoch a bays', () => {
    const stacks: StackVM[] = [
      emptyPosition(0, 0),
      stack20(1, 0, 3, dry()),
      ...stack40(1, 0, 2, dry(40)), // bays 2 a 3, rad 0
      stack20(0, 1, 1, dry()),
      { bay: 0, row: 2, height: 0, top: dry() }, // výška 0 so zvyškom štítkov: nekreslí sa
    ];
    const visible = visibleStacks(stacks);
    expect(visible.map((stack) => [stack.bay, stack.row, stack.height, stack.top.sizeFt])).toEqual([
      [0, 1, 1, 20],
      [2, 0, 2, 40],
      [1, 0, 3, 20],
    ]);
  });

  it('40′ s chýbajúcou prvou pozíciou páru sa nakreslí raz na pár', () => {
    const visible = visibleStacks([{ bay: 3, row: 0, height: 1, top: dry(40) }]);
    expect(visible.map((stack) => stack.bay)).toEqual([2]);
  });

  it('obrys 40′ zakrýva oba bays páru', () => {
    const covered = coveredPositions(visibleStacks(stack40(1, 2, 1, dry(40))));
    expect([...covered].sort()).toEqual(['2:2', '3:2']);
  });

  it('tieň je šesťuholník: obrys kontajnera spojený s posunutým o shift dole-vpravo', () => {
    expect(shadowOutline(10, 20, 50, 40, 6)).toEqual([10, 20, 50, 20, 56, 26, 56, 46, 16, 46, 10, 40]);
  });
});

describe('ModuleView: blok so stohmi', () => {
  it('telo bloku kreslí ozdoba: sprite fillNN sa skryje (ostáva fill00), žeriav dvora sa nekreslí', () => {
    const view = new ModuleView(BLOCK, deps());
    expect(view.fill).toBe(0);
    expect(view.bodyVisible).toBe(false);
    expect(view.decor('stacks')).toBeDefined();
    expect(view.decor('yard_crane')).toBeUndefined();
    expect(decorOf(view).coversBody).toBe(true);
  });

  it('bez `stacks` sa sklad kreslí ako doteraz: fill stav podľa zaplnenia, viditeľné telo, portálový žeriav', () => {
    const view = new ModuleView({ ...withoutStacks(BLOCK), storage: { capacity: 64, stored: 40, reserved: 0 } }, deps());
    expect(view.fill).toBe(75);
    expect(view.bodyVisible).toBe(true);
    expect(view.decor('stacks')).toBeUndefined();
    expect(view.decor('yard_crane')).toBeDefined();
  });

  it('jeden vrchný kontajner na stoh: 40′ raz na pár bays, sprite podľa veľkosti, typu a linky, poloha podľa pozície', () => {
    const textures = new StubTextures();
    const view = new ModuleView(BLOCK, deps(textures));
    const decor = decorOf(view);
    const drawn = decor.stacks;
    expect(drawn).toHaveLength(12); // 16 pozícií − 1 prázdna − 3 × druhý stoh páru 40′
    expect(drawn.filter((stack) => stack.sizeFt === 40)).toHaveLength(3);
    const at = (bay: number, row: number) => drawn.find((stack) => stack.bay === bay && stack.row === row)!;
    expect(at(0, 0).sprite.textureFile).toBe('cargo/container_20_dry.svg');
    expect(at(2, 0).sprite.textureFile).toBe('cargo/container_40_dry.svg');
    expect(at(0, 2).sprite.textureFile).toBe('cargo/container_20_empty.svg');
    expect(at(0, 0).sprite.tintColor).toBe(ENTITY_PALETTE.line['line-blue'].color);
    expect(at(3, 1).sprite.tintColor).toBeNull(); // bez linky
    const layout = decor.layout;
    expect(at(1, 3).sprite.position.x).toBeCloseTo(positionCentre(layout, 1, 3).x, 6);
    expect(at(1, 3).sprite.position.y).toBeCloseTo(positionCentre(layout, 1, 3).y, 6);
    expect(at(2, 2).sprite.position.x).toBeCloseTo((positionCentre(layout, 2, 2).x + positionCentre(layout, 3, 2).x) / 2, 6);
    expect(at(0, 0).sprite.scale.x).toBeCloseTo(layout.fit, 9);
    expect(drawn.map((stack) => stack.height)).toEqual([...drawn.map((stack) => stack.height)].sort((a, b) => a - b));
  });

  it('tieň výšky: šesťuholník s pravým okrajom o 3 px × výška (pri cell 64 px) za pravým okrajom kontajnera', () => {
    const view = new ModuleView(BLOCK, deps());
    const decor = decorOf(view);
    const inner = decor.stacks.find((stack) => stack.bay === 1 && stack.row === 1) ?? decor.stacks.find((stack) => stack.bay === 1 && stack.row === 2)!;
    expect(inner.height).toBeGreaterThan(1);
    const bounds = inner.shadow.getLocalBounds();
    const shift = bounds.x + bounds.width - (inner.sprite.x + (decor.layout.natural.w * decor.layout.fit) / 2);
    expect(shift).toBeCloseTo(inner.height * ENTITY_PALETTE.stack.shadowStepPx * UNIT, 6);
    // tieň je pod svojím kontajnerom a nikdy mimo plochy bloku
    const half = (4 * CELL) / 2 - (STACK_GROUND_INSET_CELLS + 2 / 64) * CELL;
    for (const stack of decor.stacks) {
      const box = stack.shadow.getLocalBounds();
      expect(box.x + box.width).toBeLessThanOrEqual(half + 1e-6);
      expect(box.y + box.height).toBeLessThanOrEqual(half + 1e-6);
      expect(stack.shadow).toBeInstanceOf(Graphics);
    }
  });

  it('depo prázdnych: výška do 8, všetky kontajnery sivé; vyšší stoh má dlhší tieň', () => {
    const view = new ModuleView(DEPOT, deps());
    const decor = decorOf(view);
    expect(Math.max(...decor.stacks.map((stack) => stack.height))).toBe(DEPOT_GEOMETRY.maxTier);
    expect(decor.stacks.every((stack) => stack.sprite.textureFile?.endsWith('_empty.svg') === true)).toBe(true);
    const width = (height: number): number => {
      const stack = decor.stacks.find((candidate) => candidate.height === height && candidate.sizeFt === 20)!;
      return stack.shadow.getLocalBounds().width;
    };
    expect(width(8)).toBeGreaterThan(width(4));
    expect(width(4)).toBeGreaterThan(width(2));
    // odznaky depa ostávajú (ozdoba depa nie je dotknutá)
    expect(view.decor('depot')).toBeDefined();
    expect(DEPOT_STACKS.length).toBeGreaterThan(0);
  });

  it('prázdne pozície majú len obrys: nulové stohy sa nekreslia ako kontajnery', () => {
    const view = new ModuleView({ ...BLOCK, stacks: [emptyPosition(0, 0), emptyPosition(1, 0)], stackGeometry: BLOCK_GEOMETRY }, deps());
    expect(decorOf(view).stacks).toHaveLength(0);
    expect(view.bodyVisible).toBe(false);
  });

  it('prekreslenie len pri zmene: rovnaký VM nechá sprity, zmena výšky / štítkov ich vytvorí nanovo', () => {
    const view = new ModuleView(BLOCK, deps());
    const decor = decorOf(view);
    const before = decor.stacks.map((stack) => stack.sprite);
    view.update({ ...BLOCK });
    expect(decor.stacks.map((stack) => stack.sprite)).toEqual(before);
    const changed: ModuleVM = { ...BLOCK, stacks: [...(BLOCK.stacks ?? []).filter((stack) => !(stack.bay === 0 && stack.row === 0)), stack20(0, 0, 1, dry(20, 'northern_star'))] };
    view.update(changed);
    const redrawn = decor.stacks.find((stack) => stack.bay === 0 && stack.row === 0)!;
    expect(redrawn.height).toBe(1);
    expect(redrawn.sprite.tintColor).toBe(ENTITY_PALETTE.line['line-amber'].color);
    expect(before).not.toContain(redrawn.sprite);
  });

  it('bez textúr kreslí kontajnery z tokenov (Graphics), blok nepadne', () => {
    const view = new ModuleView(DEPOT, deps(null));
    const stacks = decorOf(view).stacks;
    expect(stacks.length).toBeGreaterThan(0);
    for (const stack of stacks) expect(stack.sprite.children[0]).toBeInstanceOf(Graphics);
    expect(stacks[0].sprite.children[0]).not.toBeInstanceOf(Sprite);
  });

  it('rotácia modulu: ozdoba žije v rámci rot 0 (rozloženie podľa footprintu pred rotáciou)', () => {
    const rotated: ModuleVM = { ...BLOCK, rotation: 90, w: 4, h: 4 };
    const view = new ModuleView(rotated, deps());
    expect(view.view.angle).toBe(90);
    expect(decorOf(view).layout.pitchX).toBeCloseTo(stackLayout(BLOCK_GEOMETRY, 4, 4, CELL).pitchX, 9);
  });

  it('keď VM stratí `stacks`, ozdoba sa skryje a telo sa vráti', () => {
    const view = new ModuleView(BLOCK, deps());
    view.update(withoutStacks(BLOCK));
    expect(decorOf(view).view.visible).toBe(false);
    expect(view.bodyVisible).toBe(true);
  });

  it('prázdne kontajnery na depe majú pásik farby linky (emptyBox) — štítky v VM stoh→sprite', () => {
    const view = new ModuleView({ ...DEPOT, stacks: [stack20(0, 0, 2, emptyBox(20, 'golden_wave'))] }, deps());
    const sprite = decorOf(view).stacks[0].sprite;
    expect(sprite.textureFile).toBe('cargo/container_20_empty.svg');
    expect(sprite.children[0].children).toHaveLength(2); // sprite + pásik linky
  });
});
