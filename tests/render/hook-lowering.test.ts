// Spustenie nákladu na vozidlo pod hákom (F6d, T6D-02): čistá matematika `hook-lowering.ts` a jej použitie v `CraneView` — kontajner sa pri
// vykládke spúšťa z vozíka na bunku pod hákom (kde stojí vozidlo), pri nakládke z nej stúpa; bez `hook` (režim apron) ostáva pod vozíkom.
import { describe, expect, it } from 'vitest';
import { CraneLayer } from '@render/crane-layer';
import { CraneView } from '@render/crane-view';
import {
  HOOK_LIFT_END,
  HOOK_LOWER_END,
  HOOK_LOWER_START,
  HOOK_RAISED_SCALE,
  hookCargoScale,
  hookLocalPx,
  hookLowering,
  smoothstep,
} from '@render/hook-lowering';
import type { CraneVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

describe('smoothstep', () => {
  it('0 pod dolnou hranou, 1 nad hornou, 0,5 v strede, monotónne', () => {
    expect(smoothstep(0.2, 0.8, 0)).toBe(0);
    expect(smoothstep(0.2, 0.8, 1)).toBe(1);
    expect(smoothstep(0.2, 0.8, 0.5)).toBeCloseTo(0.5, 12);
    let last = 0;
    for (let x = 0; x <= 1; x += 0.05) {
      const value = smoothstep(0.2, 0.8, x);
      expect(value).toBeGreaterThanOrEqual(last);
      last = value;
    }
  });
});

describe('hookLowering: podiel spustenia nákladu na vozidlo (0 = pod vozíkom, 1 = na vozidle)', () => {
  it('vykládka: pod vozíkom do HOOK_LOWER_START, na vozidle od HOOK_LOWER_END, medzi nimi klesá', () => {
    expect(hookLowering('unload', 'placing', 0)).toBe(0);
    expect(hookLowering('unload', 'placing', HOOK_LOWER_START)).toBe(0);
    const middle = hookLowering('unload', 'placing', (HOOK_LOWER_START + HOOK_LOWER_END) / 2);
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(1);
    expect(hookLowering('unload', 'placing', HOOK_LOWER_END)).toBe(1);
    expect(hookLowering('unload', 'placing', 1)).toBe(1);
  });

  it('žeriav čakajúci na vozidlo (progress tesne pod 1: fáza 6 ticky, zostáva 1 → 0,83) drží náklad spustený nad bunkou pod hákom', () => {
    expect(hookLowering('unload', 'placing', 1 - 1 / 6)).toBe(1);
  });

  it('nakládka: náklad práve zdvihnutý z vozidla (swinging, začiatok placing) je na vozidle, do HOOK_LIFT_END stúpa k vozíku', () => {
    expect(hookLowering('load', 'swinging', 0)).toBe(1);
    expect(hookLowering('load', 'placing', 0)).toBe(1);
    const middle = hookLowering('load', 'placing', HOOK_LIFT_END / 2);
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(1);
    expect(hookLowering('load', 'placing', HOOK_LIFT_END)).toBe(0);
    expect(hookLowering('load', 'placing', 1)).toBe(0);
  });

  it('mimo placing (a swinging nakládky) je náklad pod vozíkom', () => {
    for (const state of ['idle', 'grabbing', 'blocked']) {
      expect(hookLowering('unload', state, 0.9)).toBe(0);
      expect(hookLowering('load', state, 0.1)).toBe(0);
    }
    expect(hookLowering('unload', 'swinging', 0.5)).toBe(0);
  });
});

describe('hookCargoScale', () => {
  it('v zdvihu HOOK_RAISED_SCALE, na vozidle 1, medzi tým lineárne', () => {
    expect(hookCargoScale(0)).toBeCloseTo(HOOK_RAISED_SCALE, 12);
    expect(hookCargoScale(1)).toBe(1);
    expect(hookCargoScale(0.5)).toBeCloseTo((HOOK_RAISED_SCALE + 1) / 2, 12);
  });
});

describe('hookLocalPx: bunka pod hákom v súradniciach žeriava (px, rot 0, počiatok = stred footprintu)', () => {
  const center = { x: 44 * CELL, y: 15.5 * CELL };
  const hook = { x: 43.5, y: 16.5 };

  it('rot 0: priamy rozdiel stredov', () => {
    expect(hookLocalPx(center, 0, hook, CELL)).toEqual({ x: -0.5 * CELL, y: 1 * CELL });
  });

  it.each([90, 180, 270] as const)('rot %i: lokálny vektor otočený späť, po otočení o rotáciu dá svetový rozdiel', (rotation) => {
    const local = hookLocalPx(center, rotation, hook, CELL);
    const radians = (rotation * Math.PI) / 180;
    const world = { x: local.x * Math.cos(radians) - local.y * Math.sin(radians), y: local.x * Math.sin(radians) + local.y * Math.cos(radians) };
    expect(world.x).toBeCloseTo(hook.x * CELL - center.x, 9);
    expect(world.y).toBeCloseTo(hook.y * CELL - center.y, 9);
  });
});

function deps() {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures: new StubTextures() };
}

function crane(over: Partial<CraneVM> = {}): CraneVM {
  return {
    id: 7,
    defId: 'crane_container_gantry',
    berthId: 1,
    x: 43,
    y: 14,
    rotation: 0,
    state: 'placing',
    progress: 1,
    holding: { unitId: 5, typeId: 'container_teu' },
    cycle: 'unload',
    hook: { x: 43.5, y: 16.5 },
    ...over,
  };
}

/** Svetová poloha držaného kontajnera v px (cez celý reťazec transformácií: koreň → telo → výložník → vozík). */
function heldWorld(view: CraneView): { x: number; y: number } {
  const point = view.heldCargo?.getGlobalPosition();
  if (point === undefined) throw new Error('žeriav nič nedrží');
  return { x: point.x, y: point.y };
}

describe('CraneView s `hook`: kontajner sa spúšťa na vozidlo pod hákom', () => {
  it('vykládka na konci placing: kontajner leží na bunke pod hákom (svetová poloha = stred bunky), v mierke 1', () => {
    const view = new CraneView(crane({ progress: 1 }), deps());
    expect(view.lowering).toBe(1);
    const at = heldWorld(view);
    expect(at.x).toBeCloseTo(43.5 * CELL, 6);
    expect(at.y).toBeCloseTo(16.5 * CELL, 6);
    expect(view.heldCargo?.scale.x).toBe(1);
  });

  it('vykládka na začiatku placing: kontajner visí pod vozíkom (poloha 0 voči vozíku), v mierke „v zdvihu“', () => {
    const view = new CraneView(crane({ progress: 0.1 }), deps());
    expect(view.lowering).toBe(0);
    expect(view.heldCargo?.position.x).toBe(0);
    expect(view.heldCargo?.position.y).toBe(0);
    expect(view.heldCargo?.scale.x).toBeCloseTo(HOOK_RAISED_SCALE, 12);
  });

  it('vykládka počas spúšťania: poloha aj mierka sú medzi vozíkom a vozidlom', () => {
    const progress = (HOOK_LOWER_START + HOOK_LOWER_END) / 2;
    const view = new CraneView(crane({ progress }), deps());
    expect(view.lowering).toBeGreaterThan(0);
    expect(view.lowering).toBeLessThan(1);
    expect(view.heldCargo?.scale.x).toBeGreaterThan(1);
    expect(view.heldCargo?.scale.x).toBeLessThan(HOOK_RAISED_SCALE);
  });

  it('nakládka: jednotka práve zdvihnutá z vozidla (swinging) je na bunke pod hákom, po zdvihu (placing, progress 0,5) pod vozíkom', () => {
    const view = new CraneView(crane({ cycle: 'load', state: 'swinging', progress: 0 }), deps());
    const at = heldWorld(view);
    expect(at.x).toBeCloseTo(43.5 * CELL, 6);
    expect(at.y).toBeCloseTo(16.5 * CELL, 6);
    view.update(crane({ cycle: 'load', state: 'placing', progress: 0.5 }));
    expect(view.lowering).toBe(0);
    expect(view.heldCargo?.position.x).toBe(0);
    expect(view.heldCargo?.position.y).toBe(0);
  });

  it.each([90, 180, 270] as const)('rot %i: kontajner na konci vykládky leží na bunke pod hákom aj pri otočenom žeriavi', (rotation) => {
    const hook = { x: 44.5, y: 15.5 };
    const view = new CraneView(crane({ rotation, hook }), deps());
    const at = heldWorld(view);
    expect(at.x).toBeCloseTo(hook.x * CELL, 6);
    expect(at.y).toBeCloseTo(hook.y * CELL, 6);
  });

  it('bez `hook` (režim apron) ostáva kontajner pod vozíkom v mierke 1 aj na konci placing — správanie F2–F6c', () => {
    const withoutHook = crane({ progress: 1 });
    delete withoutHook.hook;
    const view = new CraneView(withoutHook, deps());
    expect(view.lowering).toBe(0);
    expect(view.heldCargo?.position.x).toBe(0);
    expect(view.heldCargo?.position.y).toBe(0);
    expect(view.heldCargo?.scale.x).toBe(1);
  });

  it('update zmení polohu s postupom fázy a zruší ju, keď žeriav nič nedrží', () => {
    const view = new CraneView(crane({ progress: 0.1 }), deps());
    expect(view.lowering).toBe(0);
    view.update(crane({ progress: 1 }));
    expect(view.lowering).toBe(1);
    view.update(crane({ state: 'idle', progress: 0, holding: null }));
    expect(view.heldCargo).toBeNull();
    expect(view.lowering).toBe(0);
  });
});

/** Žeriav na starom view (`CraneView`): kontajnerový `crane_container_gantry` sa od R3 kreslí STS rámom, výložník ostal pre sypký žeriav. */
const OLD_CRANE = 'crane_bulk_grab';

describe('CraneLayer: základne žeriavov v samostatnom kontajneri pod vozidlami', () => {
  it('každý žeriav má základňu v `baseView` a výložník v `view`; zánik žeriava odstráni obe', () => {
    const layer = new CraneLayer(deps());
    layer.sync([crane({ defId: OLD_CRANE, id: 1 }), crane({ defId: OLD_CRANE, id: 2, x: 50, hook: { x: 50.5, y: 16.5 } })]);
    expect(layer.view.children).toHaveLength(2);
    expect(layer.baseView.children).toHaveLength(2);
    const first = layer.craneView(1);
    expect(first?.baseView.parent).toBe(layer.baseView);
    expect(first?.view.parent).toBe(layer.view);
    layer.sync([crane({ defId: OLD_CRANE, id: 2, x: 50, hook: { x: 50.5, y: 16.5 } })]);
    expect(layer.baseView.children).toHaveLength(1);
    expect(first?.baseView.destroyed).toBe(true);
  });

  it('zmena bunky pod hákom vytvorí view nanovo (poloha nákladu sa odvodzuje z `hook`)', () => {
    const layer = new CraneLayer(deps());
    layer.sync([crane({ defId: OLD_CRANE })]);
    const first = layer.craneView(7);
    layer.sync([crane({ defId: OLD_CRANE, hook: { x: 44.5, y: 16.5 } })]);
    expect(layer.craneView(7)).not.toBe(first);
  });
});
