// T04-08: oznámenie „Rampa neprevádzková — ⟨dôvod⟩“ (RampOperationalChanged na false) s akciou „Ukázať“; návrat do
// prevádzky ani neznáma rampa toast nevytvárajú. Kamióny (T04-08 B): „Chýba čakacia plocha“ / „Stojisko je plné“ (NoWaitingBay).
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { LoadingRamp, RAMP_INOPERATIVE_REASONS } from '@sim/modules';
import type { TimerHost } from '@app/snapshot-store';
import {
  NO_WAITING_AREA_TITLE,
  RAMP_INOPERATIVE_TOAST_REASON,
  RAMP_INOPERATIVE_TOAST_TITLE,
  WAITING_AREA_FULL_TITLE,
  ToastCenter,
  toastSpecsForEvents,
} from '@app/toast-center';
import { CHAIN_RAMP_ID, RAMP_ID, buildFullChain, buildLandside, createApp, createAppWithBays, frameUntil } from './app-fixtures';

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

const noWaitingBay = (rampId: EntityId = RAMP_ID): SimEvent => ({ type: 'NoWaitingBay', rampId });

describe('toastSpecsForEvents: NoWaitingBay', () => {
  it('rampa so stojiskom na trase: „Stojisko je plné“ (warning) s kódom rampy, kľúčom no_waiting_bay:<rampId> a bodom pre „Ukázať“', () => {
    const app = createApp();
    buildLandside(app);
    expect(app.world.landsideRoutes(app.world.modules.get(RAMP_ID) as LoadingRamp).length).toBeGreaterThan(0);
    expect(toastSpecsForEvents(app.world, [noWaitingBay()])).toEqual([
      {
        key: 'no_waiting_bay:5',
        tone: 'warning',
        icon: 'ic_warning',
        title: 'Stojisko je plné',
        text: 'RMP-05 — všetky stojiská sú obsadené, ďalší kamión vznikne, keď sa jedno uvoľní',
        focus: { x: 55, y: 29 },
      },
    ]);
  });

  it('rampa, k ktorej nevedie trasa cez stojisko (bez čakacej plochy): „Chýba čakacia plocha“', () => {
    const app = createApp();
    buildLandside(app, { parts: ['gate', 'ramp'] }); // jediná rampa má id 4
    const ramp = [...app.world.modules.values()].find((module) => module instanceof LoadingRamp) as LoadingRamp;
    expect(app.world.landsideRoutes(ramp)).toEqual([]);
    const [spec] = toastSpecsForEvents(app.world, [noWaitingBay(ramp.id)]);
    expect(spec).toMatchObject({ key: `no_waiting_bay:${String(ramp.id)}`, tone: 'warning', title: 'Chýba čakacia plocha' });
    expect(ramp.id).toBe(4);
    expect(spec?.text).toBe('RMP-04 — k rampe nevedie trasa cez čakaciu plochu, kamión sa nemá kde zastaviť');
  });

  it('titulky sú z exportovaných konštánt a oba prípady sa líšia', () => {
    expect([NO_WAITING_AREA_TITLE, WAITING_AREA_FULL_TITLE]).toEqual(['Chýba čakacia plocha', 'Stojisko je plné']);
  });

  it('id, ktoré nie je rampa (zaniknutý modul, brána), toast nevytvorí', () => {
    const app = createApp();
    buildLandside(app);
    expect(toastSpecsForEvents(app.world, [noWaitingBay(99 as EntityId)])).toEqual([]);
    expect(toastSpecsForEvents(app.world, [noWaitingBay(3 as EntityId)])).toEqual([]); // brána
  });

  it('rampa v celom reťazci po reálnych tickoch: rovnaký toast, kľúč podľa rampy (id 8)', () => {
    const app = createApp();
    buildFullChain(app, { units: 2 });
    frameUntil(app, () => app.world.trucks.size > 0, 3000);
    expect(toastSpecsForEvents(app.world, [noWaitingBay(CHAIN_RAMP_ID)])).toMatchObject([{ key: 'no_waiting_bay:8', title: 'Stojisko je plné' }]);
  });
});

describe('ToastCenter: NoWaitingBay', () => {
  it('udalosť zo simu → toast s akciou „Ukázať“, ktorá vycentruje kameru na rampu; opakovaná udalosť pre tú istú rampu sa nezdvojí', () => {
    const app = createApp();
    buildLandside(app);
    const centerOn = vi.fn();
    const center = new ToastCenter(app.bridge, { timers: NEVER, centerOn });
    app.bridge.publish([noWaitingBay()]);
    const toasts = (): number => center.get().filter((toast) => toast.title === WAITING_AREA_FULL_TITLE).length;
    expect(toasts()).toBe(1);
    const toast = center.get()[0];
    expect(toast).toMatchObject({ tone: 'warning', showLabel: 'Ukázať' });
    toast?.onShow?.(toast.id);
    expect(centerOn).toHaveBeenCalledExactlyOnceWith(55, 29);
    app.bridge.publish([noWaitingBay()]);
    expect(toasts()).toBe(1);
  });

  it('toast zmizne po zatvorení a nový výskyt udalosti ho zobrazí znova (sim ju hlási najviac raz za hernú hodinu)', () => {
    const app = createApp();
    buildLandside(app);
    const center = new ToastCenter(app.bridge, { timers: NEVER });
    app.bridge.publish([noWaitingBay()]);
    const first = center.get()[0];
    expect(first).toBeDefined();
    center.close(first?.id ?? 0);
    expect(center.get()).toEqual([]);
    app.bridge.publish([noWaitingBay()]);
    expect(center.get()).toHaveLength(1);
  });
});

describe('ToastCenter: NoWaitingBay zo skutočného behu', () => {
  it('čakacia plocha s jediným stojiskom a dva docky: sim ohlási NoWaitingBay a hráč dostane „Stojisko je plné“ s akciou na rampu', () => {
    const app = createAppWithBays(1);
    const centerOn = vi.fn();
    const center = new ToastCenter(app.bridge, { timers: NEVER, centerOn });
    buildFullChain(app, { units: 12 });
    frameUntil(app, () => center.get().some((toast) => toast.title === WAITING_AREA_FULL_TITLE), 6000);
    const toast = center.get().find((candidate) => candidate.title === WAITING_AREA_FULL_TITLE);
    expect(toast).toMatchObject({ tone: 'warning', showLabel: 'Ukázať', text: expect.stringContaining('RMP-08') as string });
    toast?.onShow?.(toast.id);
    expect(centerOn).toHaveBeenCalledExactlyOnceWith(55, 29);
    expect(center.get().filter((candidate) => candidate.title === WAITING_AREA_FULL_TITLE)).toHaveLength(1);
  });
});
