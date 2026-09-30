// T04-08: oznámenie „Rampa neprevádzková — ⟨dôvod⟩“ (RampOperationalChanged na false) s akciou „Ukázať“; návrat do
// prevádzky ani neznáma rampa toast nevytvárajú.
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { RAMP_INOPERATIVE_REASONS } from '@sim/modules';
import type { TimerHost } from '@app/snapshot-store';
import { RAMP_INOPERATIVE_TOAST_REASON, RAMP_INOPERATIVE_TOAST_TITLE, ToastCenter, toastSpecsForEvents } from '@app/toast-center';
import { RAMP_ID, buildLandside, createApp } from './app-fixtures';

/** Časovače, ktoré sa nikdy nespustia (auto-zatvorenie tu nikoho nezaujíma). */
const NEVER: TimerHost = { setTimeout: () => 0, clearTimeout: () => undefined };

const rampEvent = (overrides: Partial<Extract<SimEvent, { type: 'RampOperationalChanged' }>> = {}): SimEvent => ({
  type: 'RampOperationalChanged',
  rampId: RAMP_ID,
  operational: false,
  reason: 'no_gate',
  ...overrides,
});

describe('toastSpecsForEvents: rampa neprevádzková', () => {
  function withRamp() {
    const app = createApp();
    buildLandside(app, { roads: false, parts: ['gate', 'waiting_area', 'ramp'] });
    return app;
  }

  it('RampOperationalChanged na false → warning „Rampa neprevádzková“ s kódom rampy, dôvodom a bodom pre „Ukázať“ v strede rampy', () => {
    const { world } = withRamp();
    expect(toastSpecsForEvents(world, [rampEvent()])).toEqual([
      {
        key: 'ramp_inoperative:5',
        tone: 'warning',
        icon: 'ic_warning',
        title: 'Rampa neprevádzková',
        text: 'RMP-05 — chýba brána na ceste',
        focus: { x: 55, y: 29 }, // rampa (53, 28) rot 0, 4×2 → stred (55, 29)
      },
    ]);
  });

  it('každý dôvod zo simu má vlastný text (no_gate, no_waiting_area, not_connected)', () => {
    const { world } = withRamp();
    expect(Object.keys(RAMP_INOPERATIVE_TOAST_REASON).sort()).toEqual([...RAMP_INOPERATIVE_REASONS].sort());
    const texts = RAMP_INOPERATIVE_REASONS.map((reason) => toastSpecsForEvents(world, [rampEvent({ reason })])[0]?.text);
    expect(texts).toEqual(['RMP-05 — chýba súvislá cesta k rampe', 'RMP-05 — chýba brána na ceste', 'RMP-05 — chýba stojisko']);
    expect(new Set(texts).size).toBe(RAMP_INOPERATIVE_REASONS.length);
  });

  it('bez dôvodu (reason null) ostane v texte len kód rampy', () => {
    const { world } = withRamp();
    expect(toastSpecsForEvents(world, [rampEvent({ reason: null })])[0]).toMatchObject({ title: RAMP_INOPERATIVE_TOAST_TITLE, text: 'RMP-05' });
  });

  it('návrat do prevádzky (operational true) toast nevytvorí', () => {
    const { world } = withRamp();
    expect(toastSpecsForEvents(world, [rampEvent({ operational: true, reason: null })])).toEqual([]);
  });

  it('rampa, ktorá vo svete medzitým zanikla, toast nevytvorí', () => {
    const { world } = createApp();
    expect(toastSpecsForEvents(world, [rampEvent({ rampId: 99 as EntityId })])).toEqual([]);
  });
});

describe('ToastCenter: rampa neprevádzková zo simu', () => {
  it('rampa postavená bez brány → toast s akciou „Ukázať“, ktorá vycentruje kameru na rampu', () => {
    const app = createApp();
    const centerOn = vi.fn();
    const center = new ToastCenter(app.bridge, { timers: NEVER, centerOn });
    buildLandside(app, { parts: ['ramp'] });
    const toast = center.get().find((candidate) => candidate.title === RAMP_INOPERATIVE_TOAST_TITLE);
    expect(toast).toMatchObject({ tone: 'warning', showLabel: 'Ukázať' });
    expect(toast?.text).toMatch(/^RMP-03 — /);
    toast?.onShow?.(toast.id);
    expect(centerOn).toHaveBeenCalledExactlyOnceWith(55, 29);
  });

  it('dostavanie brány a stojiska rampu oživí bez ďalšieho toastu; opakovaná udalosť pre tú istú rampu sa nezdvojí', () => {
    const app = createApp();
    const center = new ToastCenter(app.bridge, { timers: NEVER });
    buildLandside(app, { parts: ['ramp'] });
    const inoperative = (): number => center.get().filter((toast) => toast.title === RAMP_INOPERATIVE_TOAST_TITLE).length;
    expect(inoperative()).toBe(1);
    app.bridge.publish([rampEvent({ rampId: 3 as EntityId })]);
    expect(inoperative()).toBe(1);
    buildLandside(app, { roads: false, parts: ['gate', 'waiting_area'] });
    expect(inoperative()).toBe(1);
  });
});
