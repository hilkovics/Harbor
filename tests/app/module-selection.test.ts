import { describe, expect, it, vi } from 'vitest';
import { RemoveModuleCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { SelectionRect, SelectionRingView } from '@render/build-layer';
import { ModuleSelection, bindSelectionRing } from '@app/module-selection';
import { createApp } from './app-fixtures';

class FakeRing implements SelectionRingView {
  rect: SelectionRect | null = null;
  calls = 0;

  setSelectionRing(rect: SelectionRect | null): void {
    this.rect = rect;
    this.calls += 1;
  }
}

const ROOT_BERTH = 1 as EntityId;
const ROOT_CRANE = 2 as EntityId;

describe('ModuleSelection', () => {
  it('drží id modulu, poslucháč sa volá len pri zmene', () => {
    const selection = new ModuleSelection();
    const listener = vi.fn();
    selection.subscribe(listener);
    expect(selection.get()).toBeNull();
    selection.select(ROOT_CRANE);
    selection.select(ROOT_CRANE);
    expect(selection.get()).toBe(ROOT_CRANE);
    expect(listener).toHaveBeenCalledTimes(1);
    selection.select(null);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('bindSelectionRing', () => {
  it('výber nastaví obrys na footprint modulu (kotvisko 8×3, žeriav 2×3), zrušenie ho skryje', () => {
    const { bridge } = createApp();
    const selection = new ModuleSelection();
    const ring = new FakeRing();
    bindSelectionRing(selection, bridge, ring);
    selection.select(ROOT_BERTH);
    expect(ring.rect).toEqual({ x: 40, y: 14, w: 8, h: 4 });
    selection.select(ROOT_CRANE);
    expect(ring.rect).toEqual({ x: 43, y: 14, w: 2, h: 3 });
    selection.select(null);
    expect(ring.rect).toBeNull();
  });

  it('pri väzbe sa obrys hneď zosúladí s existujúcim výberom', () => {
    const { bridge } = createApp();
    const selection = new ModuleSelection();
    selection.select(ROOT_CRANE);
    const ring = new FakeRing();
    bindSelectionRing(selection, bridge, ring);
    expect(ring.rect).toEqual({ x: 43, y: 14, w: 2, h: 3 });
  });

  it('výber neexistujúceho modulu obrys skryje', () => {
    const { bridge } = createApp();
    const selection = new ModuleSelection();
    const ring = new FakeRing();
    bindSelectionRing(selection, bridge, ring);
    selection.select(999 as EntityId);
    expect(ring.rect).toBeNull();
  });

  it('odstránenie vybraného modulu (ModuleRemoved) zruší výber a obrys; odstránenie iného výber nechá', () => {
    const { bridge, loop, world } = createApp();
    const selection = new ModuleSelection();
    const ring = new FakeRing();
    bindSelectionRing(selection, bridge, ring);

    // Root žeriav sa dá odstrániť (nečinný, bez lode) — vyberieme berth, žeriav odstránime: výber ostáva
    selection.select(ROOT_BERTH);
    bridge.dispatch(new RemoveModuleCommand(ROOT_CRANE));
    loop.frame(0);
    expect(world.modules.has(ROOT_CRANE)).toBe(false);
    expect(selection.get()).toBe(ROOT_BERTH);
    expect(ring.rect).toEqual({ x: 40, y: 14, w: 8, h: 4 });

    // teraz berth (už bez žeriavov) odstránime: výber aj obrys zaniknú
    bridge.dispatch(new RemoveModuleCommand(ROOT_BERTH));
    loop.frame(0);
    expect(world.modules.has(ROOT_BERTH)).toBe(false);
    expect(selection.get()).toBeNull();
    expect(ring.rect).toBeNull();
  });

  it('funkcia na odhlásenie zastaví reakcie na výber aj na udalosti', () => {
    const { bridge, loop } = createApp();
    const selection = new ModuleSelection();
    const ring = new FakeRing();
    const stop = bindSelectionRing(selection, bridge, ring);
    stop();
    const calls = ring.calls;
    selection.select(ROOT_BERTH);
    expect(ring.calls).toBe(calls);
    bridge.dispatch(new RemoveModuleCommand(ROOT_CRANE));
    loop.frame(0);
    expect(selection.get()).toBe(ROOT_BERTH);
  });
});
