// R3 (TR3-03): nový STS (pevný rám, vozík po Y, spreader podľa kontajnera), RTG nad blokom, ťahač terminálu (kĺbový), overlay pruhov.
import { describe, expect, it } from 'vitest';
import { CraneLayer } from '@render/crane-layer';
import { entitySpriteFiles, articulatedSprite, machineSprite, moduleSprite, stsSprite } from '@render/entity-assets';
import { MachineLayer } from '@render/machine-layer';
import { MACHINE_HOIST_SCALE, MachineView, rtgHoistScale, rtgTrolleyFrameX } from '@render/machine-view';
import { StsCraneView, stsSpreaderSize, stsTrolleyFrameY, stsTrolleyFraction } from '@render/sts-crane-view';
import { footprintPose } from '@render/footprint-pose';
import { LANE_DIR_ANGLE, LanesDecor, laneArrows } from '@render/lanes-decor';
import { VehicleView } from '@render/vehicle-view';
import type { ContainerVM, CraneVM, MachineVM, ModuleVM, VehicleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;
const SCALE = CELL / 64;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures, now: () => 0 };
}

function box(sizeFt: 20 | 40 = 40): ContainerVM {
  return { sizeFt, containerType: 'dry', lineId: 'blue_anchor', direction: 'import' };
}

function sts(over: Partial<CraneVM> = {}): CraneVM {
  return { id: 5, defId: 'sts', berthId: 1, x: 10, y: 4, rotation: 0, state: 'idle', progress: 0, holding: null, ...over };
}

function rtg(over: Partial<MachineVM> = {}): MachineVM {
  return { id: 9, defId: 'rtg', blockId: 3, x: 20.5, y: 12, trolley: 0, hoist: 0, state: 'idle', cargo: null, ...over };
}

describe('manifest R3', () => {
  it('sts: rám 3 × 10 s pivotom, vozík s travel y 30–560, spreadery 20 a 40', () => {
    const entry = stsSprite('sts');
    expect(entry?.footprint).toEqual({ w: 3, h: 10 });
    expect(entry?.frame.pivot).toEqual({ x: 96, y: 369 });
    expect(entry?.travelY).toEqual({ yMin: 30, yMax: 560 });
    expect(entry?.spreader20.pivot).toEqual({ x: 64, y: 32 });
    expect(entry?.spreader40.pivot).toEqual({ x: 96, y: 32 });
    expect(stsSprite('sts_standard')).toBeDefined(); // `sts*` id → záznam `sts`
    expect(stsSprite('crane_container_gantry')).toBeUndefined(); // starý žeriav s výložníkom
  });

  it('berth_standard je 8 × 4 s ôsmimi konektormi; ťahač je kĺbový 1 × 3; rtg 5 × 2 s travel x 32–288', () => {
    expect(moduleSprite('berth_standard')?.footprint).toEqual({ w: 8, h: 4 });
    expect(moduleSprite('berth_standard')?.connectors).toHaveLength(8);
    const tractor = articulatedSprite('terminal_tractor');
    expect(tractor?.footprint).toEqual({ w: 1, h: 3 });
    expect(tractor?.cab.pivot).toEqual({ x: 32, y: 52 });
    expect(tractor?.trailer.pivot).toEqual({ x: 32, y: 4 });
    const machine = machineSprite('rtg');
    expect(machine?.footprint).toEqual({ w: 5, h: 2 });
    expect(machine?.frame.pivot).toEqual({ x: 160, y: 64 });
    expect(machine?.travelX).toEqual({ yMin: 32, yMax: 288 });
    expect(machineSprite('rtg_crane')).toBeDefined();
  });

  it('atlas načíta všetky nové súbory', () => {
    const files = entitySpriteFiles();
    for (const file of [
      'modules/sts_frame.svg',
      'modules/sts_trolley.svg',
      'modules/sts_spreader_20.svg',
      'modules/sts_spreader_40.svg',
      'modules/berth_standard.svg',
      'entities/terminal_tractor_cab.svg',
      'entities/terminal_tractor_chassis_40.svg',
      'entities/rtg_frame.svg',
      'entities/rtg_trolley.svg',
    ]) {
      expect(files, file).toContain(file);
    }
  });
});

describe('StsCraneView', () => {
  it('vozík sa posúva po Y podľa trolleyY, rám je statický', () => {
    const view = new StsCraneView(sts({ trolleyY: 0 }), deps(new StubTextures()), stsSprite('sts')!);
    const near = view.trolleyOffsetY;
    view.update(sts({ trolleyY: 1 }));
    const far = view.trolleyOffsetY;
    expect(far - near).toBeCloseTo((560 - 30) * SCALE);
    // y vozíka 30 v rámci rámu (výška 640) leží 290 px nad stredom footprintu
    expect(near).toBeCloseTo((30 - 320) * SCALE);
    expect(stsTrolleyFrameY(0.5, { yMin: 30, yMax: 560 })).toBe(295);
  });

  it('bez trolleyY sa poloha odvodí zo stavu cyklu (idle = backreach, grabbing = k vode)', () => {
    expect(stsTrolleyFraction(sts())).toBe(1);
    expect(stsTrolleyFraction(sts({ state: 'grabbing', progress: 1 }))).toBe(0);
    expect(stsTrolleyFraction(sts({ trolleyY: 7 }))).toBe(1); // orezanie
  });

  it('spreader podľa veľkosti kontajnera a kontajner visí pod ním (pred rámom)', () => {
    const textures = new StubTextures();
    const view = new StsCraneView(sts({ cargo: box(20) }), deps(textures), stsSprite('sts')!);
    expect(view.spreaderSizeFt).toBe(20);
    expect(view.heldCargo?.textureFile).toBe('cargo/container_20_dry.svg');
    view.update(sts({ cargo: box(40) }));
    expect(view.spreaderSizeFt).toBe(40);
    expect(view.heldCargo?.textureFile).toBe('cargo/container_40_dry.svg');
    view.update(sts({ cargo: null }));
    expect(view.heldCargo).toBeNull();
    expect(view.spreaderSizeFt).toBe(40);
    expect(stsSpreaderSize(undefined)).toBe(40);
    // poradie: kontajner, spreader, rám, vozík
    const labels = (view.view.children[0]?.children ?? []).map((child) => child.label);
    expect(labels.slice(0, 2)).toEqual(['sts-cargo', 'sts-spreader']);
    expect(labels.at(-1)).toBe('sts-trolley');
  });

  it('bez textúr (fallback) nepadne a odznak sa ukáže pri blocked', () => {
    const view = new StsCraneView(sts({ state: 'blocked' }), deps(null), stsSprite('sts')!);
    expect(view.badgeVisible).toBe(true);
    expect(view.textured).toBe(false);
  });

  it('CraneLayer vyberie STS view podľa manifestu a starý žeriav ostáva CraneView', () => {
    const layer = new CraneLayer(deps(new StubTextures()));
    layer.sync([sts(), sts({ id: 6, defId: 'crane_container_gantry', x: 30 })]);
    expect(layer.craneCount).toBe(2);
    expect(layer.stsView(5)).toBeInstanceOf(StsCraneView);
    expect(layer.craneView(5)).toBeUndefined();
    expect(layer.craneView(6)).toBeDefined();
    layer.sync([sts({ trolleyY: 0.25 }), sts({ id: 6, defId: 'crane_container_gantry', x: 30 })]);
    expect(layer.stsView(5)?.vm.trolleyY).toBe(0.25);
  });

  it('rotácia 90° prehodí footprint rámu (10 × 3)', () => {
    const entry = stsSprite('sts')!;
    const pose = footprintPose({ x: 0, y: 0, w: 10, h: 3, rotation: 90 }, CELL);
    expect(pose.baseW).toBe(entry.footprint.w);
    expect(pose.baseH).toBe(entry.footprint.h);
  });
});

describe('MachineView (RTG)', () => {
  it('rám sedí na x, y; vozík ide naprieč rámom podľa trolley', () => {
    const view = new MachineView(rtg(), deps(new StubTextures()));
    expect(view.view.x).toBe(20.5 * CELL);
    expect(view.view.y).toBe(12 * CELL);
    expect(view.textured).toBe(true);
    expect(view.trolleyOffsetX).toBeCloseTo((32 - 160) * SCALE);
    view.update(rtg({ trolley: 1 }));
    expect(view.trolleyOffsetX).toBeCloseTo((288 - 160) * SCALE);
    expect(rtgTrolleyFrameX(0.5, { yMin: 32, yMax: 288 })).toBe(160);
  });

  it('kontajner visí pod vozíkom (pozdĺž Y), hoist ho zväčší', () => {
    const view = new MachineView(rtg({ cargo: box(40), hoist: 1 }), deps(new StubTextures()));
    expect(view.heldCargo?.textureFile).toBe('cargo/container_40_dry.svg');
    expect(view.heldCargo?.angle).toBe(90);
    expect(rtgHoistScale(1)).toBeCloseTo(1 + MACHINE_HOIST_SCALE);
    expect(rtgHoistScale(0)).toBe(1);
    view.update(rtg({ cargo: null }));
    expect(view.heldCargo).toBeNull();
  });

  it('MachineLayer vytvára a ruší views podľa id; bez textúr sa nakreslí fallback', () => {
    const layer = new MachineLayer(deps(null));
    layer.sync([rtg(), rtg({ id: 10 })]);
    expect(layer.machineCount).toBe(2);
    expect(layer.machineView(9)?.textured).toBe(false);
    layer.sync([rtg({ y: 13 })]);
    expect(layer.machineCount).toBe(1);
    expect(layer.machineView(9)?.view.y).toBe(13 * CELL);
  });
});

describe('ťahač terminálu', () => {
  function tractor(over: Partial<VehicleVM> = {}): VehicleVM {
    const head = { x: 5.5, y: 5.5 };
    return {
      id: 20,
      defId: 'terminal_tractor',
      x: head.x,
      y: head.y,
      prevX: head.x,
      prevY: head.y,
      heading: 90,
      loaded: true,
      state: 'to_dropoff',
      body: [
        { x: 4.5, y: 5.5 },
        { x: 3.5, y: 5.5 },
      ],
      lengthCells: 3,
      cargo: box(40),
      ...over,
    };
  }

  it('kreslí sa kĺbovo (kabína + podvozok) s kontajnerom na podvozku', () => {
    const view = new VehicleView(tractor(), deps(new StubTextures()));
    expect(view.textured).toBe(true);
    expect(view.cabView).not.toBeNull();
    expect(view.trailerView).not.toBeNull();
    expect(view.cargoSprite?.textureFile).toBe('cargo/container_40_dry.svg');
    expect(view.trailerView?.children.includes(view.cargoSprite!)).toBe(true);
  });

  it('bez textúr je to fallback bez pádu', () => {
    const view = new VehicleView(tractor(), deps(null));
    expect(view.textured).toBe(false);
  });
});

describe('overlay pruhov (ModuleVM.lanes)', () => {
  const berth: ModuleVM = {
    id: 1,
    defId: 'berth_standard',
    kind: 'berth',
    x: 8,
    y: 6,
    rotation: 0,
    w: 8,
    h: 4,
    lanes: [
      { x: 8, y: 7, dir: 'e' },
      { x: 9, y: 7, dir: 'e' },
      { x: 9, y: 9, dir: 'w' },
    ],
  };
  const context = { deps: deps(null), pose: footprintPose(berth, CELL), entry: moduleSprite('berth_standard') };

  it('šípky ležia v lokálnom rámci modulu a majú uhol podľa smeru', () => {
    const arrows = laneArrows(berth.lanes!, context);
    expect(arrows).toHaveLength(3);
    expect(arrows[0]).toEqual({ x: (0.5 - 4) * CELL, y: (1.5 - 2) * CELL, angle: LANE_DIR_ANGLE.e });
    expect(arrows[2]?.angle).toBe(270);
  });

  it('pri rotácii modulu sa uhol a poloha prepočítajú späť do lokálneho rámca', () => {
    const rotated: ModuleVM = { ...berth, rotation: 90, w: 4, h: 8, x: 8, y: 6, lanes: [{ x: 8, y: 6, dir: 's' }] };
    const pose = footprintPose(rotated, CELL);
    const arrow = laneArrows(rotated.lanes!, { ...context, pose })[0]!;
    // svet: smer `s` (180°) − rotácia modulu (90°) = 90° v lokálnom rámci
    expect(arrow.angle).toBe(90);
    // bunka (8; 6) je ľavý horný roh rotovaného footprintu 4 × 8 → lokálne vľavo hore (rot 0: 8 × 4)
    expect(arrow.x).toBeCloseTo((0.5 - 4) * CELL);
    expect(arrow.y).toBeCloseTo((3.5 - 2) * CELL);
  });

  it('LanesDecor nakreslí šípku na bunku a pri nezmenených lanes neprekresľuje', () => {
    const decor = new LanesDecor(berth, context);
    expect(decor.arrowCount).toBe(3);
    const first = decor.view.children[0];
    decor.update(berth);
    expect(decor.view.children[0]).toBe(first);
    decor.update({ ...berth, lanes: [] });
    expect(decor.arrowCount).toBe(0);
  });
});
