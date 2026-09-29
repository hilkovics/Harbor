import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimBridgeProvider, useSimBridge, useSimSnapshot } from '@app/use-sim-snapshot';
import { DEFAULT_SNAPSHOT_THROTTLE_MS, createSnapshotStore, createThrottle } from '@app/snapshot-store';
import { TestAdjustCash, createApp } from './app-fixtures';

describe('createThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prvé volanie ide okamžite (leading), ďalšie v rámci odstupu sa zlúčia do jedného trailing', () => {
    let fired = 0;
    const throttle = createThrottle(() => fired++, 100);
    throttle.notify();
    expect(fired).toBe(1);
    throttle.notify();
    throttle.notify();
    throttle.notify();
    expect(fired).toBe(1);
    vi.advanceTimersByTime(99);
    expect(fired).toBe(1);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(2);
  });

  it('bez ďalšej požiadavky trailing nevznikne a po odstupe ide nové volanie znova okamžite', () => {
    let fired = 0;
    const throttle = createThrottle(() => fired++, 100);
    throttle.notify();
    vi.advanceTimersByTime(500);
    expect(fired).toBe(1);
    throttle.notify();
    expect(fired).toBe(2);
  });

  it('nepretržité požiadavky → najviac jedno volanie za odstup', () => {
    let fired = 0;
    const throttle = createThrottle(() => fired++, 100);
    for (let t = 0; t < 1000; t += 10) {
      throttle.notify();
      vi.advanceTimersByTime(10);
    }
    // 1000 ms / 100 ms = 10 okien → 10 volaní (leading + trailing na hraniciach), nikdy nie 100.
    expect(fired).toBeGreaterThanOrEqual(9);
    expect(fired).toBeLessThanOrEqual(11);
  });

  it('cancel zruší čakajúci trailing a ďalšie notify ignoruje', () => {
    let fired = 0;
    const throttle = createThrottle(() => fired++, 100);
    throttle.notify();
    throttle.notify();
    throttle.cancel();
    vi.advanceTimersByTime(1000);
    expect(fired).toBe(1);
    throttle.notify();
    expect(fired).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('intervalMs = 0 → bez throttlingu a bez časovačov', () => {
    let fired = 0;
    const throttle = createThrottle(() => fired++, 0);
    throttle.notify();
    throttle.notify();
    expect(fired).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('neplatný odstup → RangeError', () => {
    expect(() => createThrottle(() => undefined, -1)).toThrow(RangeError);
    expect(() => createThrottle(() => undefined, Number.NaN)).toThrow(RangeError);
  });
});

describe('createSnapshotStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('predvolený odstup je 100 ms (ARCHITECTURE §13)', () => {
    expect(DEFAULT_SNAPSHOT_THROTTLE_MS).toBe(100);
  });

  it('select vracia hodnotu zo snapshotu a je stabilný, kým sa svet nezmení', () => {
    const { world, bridge } = createApp();
    const store = createSnapshotStore(bridge, 100);
    const selectTick = (s: { tick: number }): number => s.tick;
    expect(store.select(selectTick)).toBe(0);
    world.tick();
    expect(store.select(selectTick)).toBe(1);
  });

  it('selektor vracajúci nový objekt: s isEqual ostáva referencia stabilná pri nezmenených dátach', () => {
    const { world, bridge } = createApp();
    const store = createSnapshotStore(bridge, 100);
    const equalHud = (a: { cash: number }, b: { cash: number }): boolean => a.cash === b.cash;

    const first = store.select((s) => ({ cash: s.cashCents }), equalHud);
    world.tick(); // zmena ticku, hotovosť rovnaká
    const second = store.select((s) => ({ cash: s.cashCents }), equalHud);
    expect(second).toBe(first);

    world.cashCents -= 5;
    const third = store.select((s) => ({ cash: s.cashCents }), equalHud);
    expect(third).not.toBe(first);
    expect(third.cash).toBe(world.cashCents);
  });

  it('opakované select nad tým istým snapshotom a selektorom nevolá selektor znova', () => {
    const { bridge } = createApp();
    const store = createSnapshotStore(bridge, 100);
    const selector = vi.fn((s: { tick: number }) => s.tick);
    store.select(selector);
    store.select(selector);
    store.select(selector);
    expect(selector).toHaveBeenCalledTimes(1);
  });

  it('subscribe: notifikácie sú throttlované na 100 ms, posledná zmena sa nestratí', () => {
    const { bridge, loop } = createApp();
    const store = createSnapshotStore(bridge, 100);
    let notified = 0;
    store.subscribe(() => notified++);

    loop.frame(100); // tick 1 → leading
    expect(notified).toBe(1);
    loop.frame(100); // tick 2 — v cooldowne
    loop.frame(100); // tick 3 — v cooldowne
    expect(notified).toBe(1);
    vi.advanceTimersByTime(100);
    expect(notified).toBe(2); // trailing s posledným stavom
    expect(store.select((s) => s.tick)).toBe(3);
  });

  it('unsubscribe odhlási z bridge a zruší čakajúci trailing', () => {
    const { bridge, loop } = createApp();
    const store = createSnapshotStore(bridge, 100);
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified++);
    loop.frame(100);
    loop.frame(100);
    unsubscribe();
    vi.advanceTimersByTime(1000);
    loop.frame(100);
    expect(notified).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dve subscribe sú nezávislé', () => {
    const { bridge, loop } = createApp();
    const store = createSnapshotStore(bridge, 100);
    let a = 0;
    let b = 0;
    const unsubscribeA = store.subscribe(() => a++);
    store.subscribe(() => b++);
    loop.frame(100);
    unsubscribeA();
    vi.advanceTimersByTime(200);
    loop.frame(100);
    expect([a, b]).toEqual([1, 2]);
  });
});

describe('useSimSnapshot / SimBridgeProvider (SSR render, bez DOM)', () => {
  function Cash(): ReactElement {
    const cash = useSimSnapshot((s) => s.cashCents);
    return createElement('span', null, `cash:${String(cash)}`);
  }

  function HudLike(): ReactElement {
    // Selektor s novým objektom + isEqual — nesmie zacyklit render.
    const view = useSimSnapshot(
      (s) => ({ day: s.day, hour: s.hour, minute: s.minute }),
      50,
      (a, b) => a.day === b.day && a.hour === b.hour && a.minute === b.minute,
    );
    return createElement('span', null, `t:${String(view.day)}:${String(view.hour)}:${String(view.minute)}`);
  }

  it('vyrenderuje aktuálnu hodnotu zo snapshotu', () => {
    const { world, bridge } = createApp();
    world.enqueue(new TestAdjustCash(-2500));
    world.applyPending();
    const html = renderToString(createElement(SimBridgeProvider, { bridge }, createElement(Cash)));
    expect(html).toContain(`cash:${String(world.cashCents)}`);
  });

  it('selektor s novým objektom a isEqual sa vyrenderuje bez zacyklenia', () => {
    const { bridge } = createApp();
    const html = renderToString(createElement(SimBridgeProvider, { bridge }, createElement(HudLike)));
    expect(html).toContain('t:0:0:0');
  });

  it('bez providera hodí zrozumiteľnú chybu', () => {
    function Bare(): ReactElement {
      useSimBridge();
      return createElement('span');
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => renderToString(createElement(Bare))).toThrow(/SimBridgeProvider/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('useSimBridge vráti bridge z providera (dispatch pre UI)', () => {
    const { bridge } = createApp();
    let seen: unknown = null;
    function Probe(): ReactElement {
      seen = useSimBridge();
      return createElement('span');
    }
    renderToString(createElement(SimBridgeProvider, { bridge }, createElement(Probe)));
    expect(seen).toBe(bridge);
  });
});
