// F6a (T6A-06): indikátor stavu lashing na lodi — odznak s prstencom postupu podľa lashingTicksLeft.
import { Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { badgeScaleForZoom } from '@render/crane-view';
import { QUEUE_BADGE_FILE } from '@render/entity-assets';
import { EntityLayer } from '@render/entity-layer';
import { LASHING_PROGRESS_STEPS, LashingBadge, lashingProgress, lashingStep } from '@render/lashing-badge';
import { LASHING_STATE, ShipView } from '@render/ship-view';
import type { ShipVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

function feeder(over: Partial<ShipVM> = {}): ShipVM {
  return {
    id: 5,
    classId: 'feeder',
    cargoCategory: 'container',
    state: 'docked',
    x: 43,
    y: 13,
    prevX: 43,
    prevY: 13,
    heading: 90,
    lengthCells: 6,
    widthCells: 2,
    unitsOnBoard: 40,
    capacityUnits: 120,
    ...over,
  };
}

const lashing = (ticksLeft: number, ticksTotal = 400, over: Partial<ShipVM> = {}): ShipVM =>
  feeder({ state: LASHING_STATE, lashing: { ticksLeft, ticksTotal }, cargoSplit: { import: 0, export: 40 }, ...over });

describe('lashingProgress / lashingStep', () => {
  it('postup = 1 − ticksLeft / ticksTotal', () => {
    expect(lashingProgress(400, 400)).toBe(0);
    expect(lashingProgress(300, 400)).toBeCloseTo(0.25, 12);
    expect(lashingProgress(100, 400)).toBeCloseTo(0.75, 12);
    expect(lashingProgress(0, 400)).toBe(1);
  });

  it('neznámy celkový čas alebo hodnoty mimo rozsahu sa orežú', () => {
    expect(lashingProgress(5, 0)).toBe(0);
    expect(lashingProgress(5, -1)).toBe(0);
    expect(lashingProgress(-10, 400)).toBe(1);
    expect(lashingProgress(900, 400)).toBe(0);
    expect(lashingProgress(Number.NaN, 400)).toBe(0);
  });

  it('kvantovanie na LASHING_PROGRESS_STEPS krokov', () => {
    expect(lashingStep(0)).toBe(0);
    expect(lashingStep(0.5)).toBe(LASHING_PROGRESS_STEPS / 2);
    expect(lashingStep(1)).toBe(LASHING_PROGRESS_STEPS);
    expect(lashingStep(0.2049)).toBe(20);
    expect(lashingStep(2)).toBe(LASHING_PROGRESS_STEPS);
    expect(lashingStep(-1)).toBe(0);
  });
});

describe('LashingBadge', () => {
  it('základ je overlay.queue_badge z manifestu a kríž výstuh; bez textúry kruh z tokenov', () => {
    const textures = new StubTextures();
    const badge = new LashingBadge(deps(textures));
    expect(badge.children[0]).toBeInstanceOf(Sprite);
    expect((badge.children[0] as Sprite).texture).toBe(textures.textureFor(`file/${QUEUE_BADGE_FILE}`));
    const bare = new LashingBadge(deps(null));
    expect(bare.children[0]).toBeInstanceOf(Graphics);
  });

  it('prstenec sa prekreslí len pri zmene kvantovaného kroku', () => {
    const badge = new LashingBadge(deps(new StubTextures()));
    expect(badge.drawnStep).toBe(0);
    badge.setProgress(0.5);
    expect(badge.drawnStep).toBe(LASHING_PROGRESS_STEPS / 2);
    badge.setProgress(0.501);
    expect(badge.drawnStep).toBe(LASHING_PROGRESS_STEPS / 2);
    badge.setProgress(1);
    expect(badge.drawnStep).toBe(LASHING_PROGRESS_STEPS);
    badge.setProgress(0);
    expect(badge.drawnStep).toBe(0);
  });
});

describe('ShipView: odznak lashingu', () => {
  it('mimo stavu lashing odznak nie je (nevznikne ani sa nealokuje)', () => {
    const view = new ShipView(feeder(), deps(new StubTextures()));
    expect(view.lashing).toBeNull();
    expect(view.lashingVisible).toBe(false);
  });

  it('v stave lashing je odznak viditeľný a prstenec nesie postup podľa lashingTicksLeft', () => {
    const view = new ShipView(lashing(400), deps(new StubTextures()));
    expect(view.lashingVisible).toBe(true);
    expect(view.lashing?.drawnStep).toBe(0);
    view.update(lashing(300), 1);
    expect(view.lashing?.drawnStep).toBe(25);
    view.update(lashing(200), 1);
    expect(view.lashing?.drawnStep).toBe(50);
    view.update(lashing(1), 1);
    expect(view.lashing?.drawnStep).toBe(Math.round((399 / 400) * LASHING_PROGRESS_STEPS));
  });

  it('po lashingu (undocking) odznak zmizne, pri ďalšom lashingu sa znova ukáže', () => {
    const view = new ShipView(lashing(100), deps(new StubTextures()));
    expect(view.lashingVisible).toBe(true);
    view.update(feeder({ state: 'undocking' }), 1);
    expect(view.lashingVisible).toBe(false);
    view.update(lashing(50), 1);
    expect(view.lashingVisible).toBe(true);
  });

  it('stav lashing bez údajov o postupe ukáže odznak s prázdnym prstencom', () => {
    const view = new ShipView(feeder({ state: LASHING_STATE }), deps(new StubTextures()));
    expect(view.lashingVisible).toBe(true);
    expect(view.lashing?.drawnStep).toBe(0);
  });

  it('odznak ostáva vzpriamený pri každom kurze lode', () => {
    for (const heading of [0, 90, 180, 270] as const) {
      const view = new ShipView(lashing(200, 400, { heading }), deps(new StubTextures()));
      const badge = view.lashing;
      expect(badge, `heading ${String(heading)}`).not.toBeNull();
      const world = view.view.toGlobal({ x: 10, y: 0 });
      const rotated = badge?.toGlobal({ x: 10, y: 0 });
      const origin = view.view.toGlobal({ x: 0, y: 0 });
      // lokálna os x odznaku ukazuje vo svete vždy doprava (nezávisle od kurzu lode)
      expect((rotated?.x ?? 0) - origin.x).toBeCloseTo(10, 6);
      expect((rotated?.y ?? 1) - origin.y).toBeCloseTo(0, 6);
      expect(world.x - origin.x).not.toBeNaN();
    }
  });

  it('odznak je navrchu nad spritom aj kontajnermi na palube', () => {
    const view = new ShipView(lashing(100), deps(new StubTextures()));
    const children = view.view.children;
    expect(children[children.length - 1]).toBe(view.lashing);
    expect(children.indexOf(view.deckCargo as never)).toBeLessThan(children.indexOf(view.lashing as never));
  });

  it('zoom: odznak drží čitateľnú veľkosť (setBadgeScale) aj keď vznikne až po zmene zoomu', () => {
    const view = new ShipView(lashing(100), deps(new StubTextures()));
    view.setBadgeScale(2);
    expect(view.lashing?.scale.x).toBe(2);
    const idle = new ShipView(feeder(), deps(new StubTextures()));
    idle.setBadgeScale(1.5);
    idle.update(lashing(100), 1);
    expect(idle.lashing?.scale.x).toBe(1.5);
  });

  it('EntityLayer.setZoom škáluje odznaky existujúcich aj nových lodí', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.sync([lashing(100)], 1);
    layer.setZoom(0.5);
    expect(layer.shipView(5)?.lashing?.scale.x).toBe(badgeScaleForZoom(0.5));
    layer.sync([lashing(100), lashing(100, 400, { id: 6 })], 1);
    expect(layer.shipView(6)?.lashing?.scale.x).toBe(badgeScaleForZoom(0.5));
    layer.setZoom(4);
    expect(layer.shipView(5)?.lashing?.scale.x).toBe(1);
    expect(layer.shipView(6)?.lashing?.scale.x).toBe(1);
  });
});
