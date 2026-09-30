import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { moduleSprite } from '@render/entity-assets';
import { MODULE_DECORS } from '@render/module-decors';
import { ModuleView } from '@render/module-view';
import type { ModuleVM } from '@render/view-models';
import { YARD_BOX_CELLS, YARD_INSET_CELLS, YardCraneDecor, isYardEntry, yardCraneHome, yardSlotSpot } from '@render/yard-crane-decor';
import { CRANE_LIFT_SCALE, CRANE_PHASE_MS, craneOpDuration } from '@render/yard-crane-motion';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;
const YARD = moduleSprite('container_yard_small')!;

function clock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    set: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function deps(now: () => number, reducedMotion = false) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures: new StubTextures(), now, reducedMotion: () => reducedMotion };
}

function yard(over: Partial<ModuleVM> = {}): ModuleVM {
  return {
    id: 4,
    defId: 'container_yard_small',
    kind: 'storage',
    x: 42,
    y: 18,
    rotation: 0,
    w: 4,
    h: 4,
    storage: { capacity: 64, stored: 10, reserved: 0 },
    connected: true,
    ...over,
  };
}

function decorOf(view: ModuleView): YardCraneDecor {
  const decor = view.decor<YardCraneDecor>('yard_crane');
  if (decor === undefined) throw new Error('dvor nemá žeriav');
  return decor;
}

describe('yardSlotSpot: poloha slotu dvora v lokálnom rámci (bunky od stredu footprintu)', () => {
  it('manifest `container_yard_small`: 4 × 4 bunky, 32 pozícií na vrstve, 2 vrstvy (kapacita 64)', () => {
    expect(YARD.footprint).toEqual({ w: 4, h: 4 });
    expect(YARD.slots).toBe(32);
    expect(YARD.layers).toBe(2);
    expect(isYardEntry(YARD)).toBe(true);
    expect(isYardEntry(moduleSprite('truck_gate'))).toBe(false);
    expect(isYardEntry(undefined)).toBe(false);
  });

  it('pozície tvoria mriežku 4 stĺpce × 8 riadkov vo vnútri dvora (mimo okraja)', () => {
    const spots = Array.from({ length: 32 }, (_, slot) => yardSlotSpot(YARD, slot));
    const xs = [...new Set(spots.map((spot) => spot.x))];
    const ys = [...new Set(spots.map((spot) => spot.y))];
    expect(xs).toHaveLength(4);
    expect(ys).toHaveLength(8);
    for (const spot of spots) {
      expect(Math.abs(spot.x)).toBeLessThan(2 - YARD_INSET_CELLS);
      expect(Math.abs(spot.y)).toBeLessThan(2 - YARD_INSET_CELLS);
    }
    // poradie: sloty 0–3 sú prvý riadok zľava doprava, slot 4 začína druhý riadok
    expect(spots[0].y).toBe(spots[3].y);
    expect(spots[0].x).toBeLessThan(spots[3].x);
    expect(spots[4].y).toBeGreaterThan(spots[0].y);
    expect(spots[4].x).toBe(spots[0].x);
  });

  it('stĺpce ležia na stĺpcoch políčok sprite dvora (44, 100, 156, 212 px z 256 px; ± 3 px)', () => {
    const xs = [0, 1, 2, 3].map((slot) => (yardSlotSpot(YARD, slot).x + 2) * 64);
    [44, 100, 156, 212].forEach((expected, i) => {
      expect(Math.abs(xs[i] - expected)).toBeLessThan(3);
    });
  });

  it('vrstvy sa skladajú na tie isté pozície: slot 32 + n je nad slotom n; slot mimo rozsahu sa orezá', () => {
    expect(yardSlotSpot(YARD, 32)).toEqual(yardSlotSpot(YARD, 0));
    expect(yardSlotSpot(YARD, 45)).toEqual(yardSlotSpot(YARD, 13));
    expect(yardSlotSpot(YARD, -5)).toEqual(yardSlotSpot(YARD, 0));
    expect(yardSlotSpot(YARD, 3.9)).toEqual(yardSlotSpot(YARD, 3));
  });

  it('domovská poloha: stred prvého riadku', () => {
    const home = yardCraneHome(YARD);
    expect(home.x).toBe(0);
    expect(home.y).toBe(yardSlotSpot(YARD, 0).y);
  });

  it('kontajner žeriavu má rozmer políčka dvora (47 × 17 px z 64 px bunky)', () => {
    expect(YARD_BOX_CELLS.w * 64).toBeCloseTo(47, 9);
    expect(YARD_BOX_CELLS.h * 64).toBeCloseTo(17, 9);
  });
});

describe('YardCraneDecor v ModuleView', () => {
  it('továreň: žeriav majú len kontajnerové dvory (sklad so stohovými pozíciami), nie ostatné moduly ani sklad bez manifestu', () => {
    const factory = MODULE_DECORS.find((candidate) => candidate.id === 'yard_crane')!;
    expect(factory.applies(yard())).toBe(true);
    expect(factory.applies({ ...yard(), storage: undefined })).toBe(false);
    expect(factory.applies({ ...yard(), defId: 'vehicle_depot', kind: 'depot' })).toBe(false);
    expect(factory.applies({ ...yard(), defId: 'neexistuje' })).toBe(false);
  });

  it('dvor dostane žeriav pri vzniku; stojí v domovskej polohe a nemá kontajner ani spreader', () => {
    const time = clock();
    const view = new ModuleView(yard(), deps(time.now));
    const decor = decorOf(view);
    const home = yardCraneHome(YARD);
    expect(decor.pose).toEqual({ gantryY: home.y, trolleyX: home.x, hoist: 0, cargo: null, phase: 'idle' });
    expect(decor.busy).toBe(false);
    expect(decor.gantryView.y).toBeCloseTo(home.y * CELL, 9);
    expect(decor.trolleyView.x).toBeCloseTo(home.x * CELL, 9);
    expect(decor.cargoView.visible).toBe(false);
  });

  it('nová operácia `lastStorageOp` spustí žeriav nad slot; rovnaká operácia v ďalších framoch ho nespúšťa znova', () => {
    const time = clock();
    const view = new ModuleView(yard(), deps(time.now));
    const op = { slot: 13, tick: 207, kind: 'put' as const };
    view.update(yard({ lastStorageOp: op }));
    const decor = decorOf(view);
    expect(decor.busy).toBe(true);
    const target = yardSlotSpot(YARD, 13);
    time.advance(craneOpDuration(yardCraneHome(YARD), target) + 10);
    view.update(yard({ lastStorageOp: op }));
    expect(decor.busy).toBe(false);
    expect(decor.pose.gantryY).toBeCloseTo(target.y, 9);
    expect(decor.pose.trolleyX).toBeCloseTo(target.x, 9);
    // tá istá operácia vo VM (ďalší frame) žeriav nerozbehne
    time.advance(500);
    view.update(yard({ lastStorageOp: op }));
    expect(decor.busy).toBe(false);
    // nový tick s rovnakým slotom je nová operácia
    view.update(yard({ lastStorageOp: { ...op, tick: 300, kind: 'take' } }));
    expect(decor.busy).toBe(true);
  });

  it('poloha scény sleduje pózu: portál v poloha y, vozík v x; kontajner je počas `put` viditeľný a väčší (zdvihnutý)', () => {
    const time = clock();
    const view = new ModuleView(yard(), deps(time.now));
    view.update(yard({ lastStorageOp: { slot: 13, tick: 1, kind: 'put' } }));
    const decor = decorOf(view);
    time.advance(10);
    view.update(yard({ lastStorageOp: { slot: 13, tick: 1, kind: 'put' } }));
    const pose = decor.pose;
    expect(pose.phase).toBe('travel');
    expect(decor.gantryView.y).toBeCloseTo(pose.gantryY * CELL, 9);
    expect(decor.trolleyView.x).toBeCloseTo(pose.trolleyX * CELL, 9);
    expect(decor.trolleyView.y).toBeCloseTo(pose.gantryY * CELL, 9);
    expect(decor.cargoView.visible).toBe(true);
    expect(decor.cargoView.scale.x).toBeCloseTo(CRANE_LIFT_SCALE, 1);
    // po skončení je kontajner skrytý (prevzal ho sprite dvora)
    time.advance(2000);
    view.update(yard({ lastStorageOp: { slot: 13, tick: 1, kind: 'put' } }));
    expect(decor.cargoView.visible).toBe(false);
  });

  it('operácia, ktorú dvor už mal pri vzniku view (načítaná hra), žeriav nerozbehne: stojí nad posledným slotom', () => {
    const time = clock();
    const view = new ModuleView(yard({ lastStorageOp: { slot: 13, tick: 5, kind: 'put' } }), deps(time.now));
    const decor = decorOf(view);
    const target = yardSlotSpot(YARD, 13);
    expect(decor.busy).toBe(false);
    expect(decor.pose.gantryY).toBeCloseTo(target.y, 9);
    expect(decor.pose.trolleyX).toBeCloseTo(target.x, 9);
  });

  it('prefers-reduced-motion: žeriav sa pri novej operácii presunie nad slot hneď, bez animácie', () => {
    const time = clock();
    const view = new ModuleView(yard(), deps(time.now, true));
    view.update(yard({ lastStorageOp: { slot: 13, tick: 7, kind: 'put' } }));
    const decor = decorOf(view);
    const target = yardSlotSpot(YARD, 13);
    expect(decor.busy).toBe(false);
    expect(decor.pose).toEqual({ gantryY: target.y, trolleyX: target.x, hoist: 0, cargo: null, phase: 'idle' });
    expect(decor.gantryView.y).toBeCloseTo(target.y * CELL, 9);
    expect(decor.cargoView.visible).toBe(false);
  });

  it('trvanie operácie je pod 1 s a nad 0,5 s (zadanie) pre ľubovoľný slot dvora', () => {
    const home = yardCraneHome(YARD);
    for (let slot = 0; slot < 32; slot++) {
      const ms = craneOpDuration(home, yardSlotSpot(YARD, slot));
      expect(ms, `slot ${String(slot)}`).toBeGreaterThanOrEqual(500);
      expect(ms, `slot ${String(slot)}`).toBeLessThanOrEqual(1000);
    }
    expect(CRANE_PHASE_MS.lower + CRANE_PHASE_MS.lift).toBeLessThan(500);
  });

  it('žeriav sa otáča s modulom (ozdoba žije v lokálnom rámci, rot 90)', () => {
    const time = clock();
    const view = new ModuleView(yard({ rotation: 90 }), deps(time.now));
    expect(view.view.angle).toBe(90);
    expect(decorOf(view).view.parent).toBeInstanceOf(Container);
  });

  it('ModuleView.destroy zruší aj ozdobu', () => {
    const time = clock();
    const view = new ModuleView(yard(), deps(time.now));
    const decor = decorOf(view);
    view.destroy();
    expect(decor.view.destroyed).toBe(true);
  });

  it('bez spritov (fallback z tokenov) žeriav funguje rovnako', () => {
    const time = clock();
    const view = new ModuleView(yard(), { cellPx: CELL, palette: ENTITY_PALETTE, textures: null, now: time.now, reducedMotion: () => false });
    view.update(yard({ lastStorageOp: { slot: 2, tick: 3, kind: 'take' } }));
    expect(decorOf(view).busy).toBe(true);
  });
});
