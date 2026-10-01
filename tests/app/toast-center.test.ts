// T03-10: oznámenia zo simu — „Chýba sklad“ (NoStorageAvailable), „Nepripojené“ (ModulePlaced bez cesty), zásobník
// (max 4 viditeľné, dedupe, automatické zatvorenie po TOAST_AUTO_CLOSE_MS, akcia „Ukázať“).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { App } from '@app/app';
import { ConnectedToasts } from '@app/connected-toasts';
import { TOAST_AUTO_CLOSE_MS } from '@app/config';
import type { TimerHost } from '@app/snapshot-store';
import { ToastCenter, toastSpecsForEvents, type ToastSpec } from '@app/toast-center';
import { MAX_TOASTS } from '@ui/toasts';
import { YARD_ID, buildLogistics, createApp, frameUntil, runCommands } from './app-fixtures';

const ROOT_BERTH = 1 as EntityId;
const ROOT_CRANE = 2 as EntityId;

/** Ručne poháňané časovače (bez reálneho čakania). */
class FakeTimers implements TimerHost {
  now = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { at: this.now + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
      }
      if (due === null) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

const spec = (key: string, overrides: Partial<ToastSpec> = {}): ToastSpec => ({ key, tone: 'info', icon: 'ic_info', title: key, text: `text ${key}`, ...overrides });

function centerWith(options: ConstructorParameters<typeof ToastCenter>[1] = {}) {
  const app = createApp();
  const timers = new FakeTimers();
  const center = new ToastCenter(app.bridge, { timers, ...options });
  return { app, timers, center };
}

describe('toastSpecsForEvents', () => {
  it('NoStorageAvailable → „Chýba sklad“ (warning) s kódom kotviska a nákladom; bez akcie „Ukázať“', () => {
    const { world } = createApp();
    const events: SimEvent[] = [{ type: 'NoStorageAvailable', berthId: ROOT_BERTH, cargoTypeId: 'container_teu' }];
    expect(toastSpecsForEvents(world, events)).toEqual([
      {
        key: 'no_storage:1',
        tone: 'warning',
        icon: 'ic_warning',
        title: 'Chýba sklad',
        text: 'Kotvisko BRT-01 nemá kam uložiť kontajnery (postav alebo pripoj kontajnerový dvor)',
      },
    ]);
  });

  it('ModulePlaced dvora bez cesty → „Nepripojené“ (info) s bodom pre „Ukázať“ v strede modulu', () => {
    const app = createApp();
    buildLogistics(app, { roads: false });
    const events: SimEvent[] = [{ type: 'ModulePlaced', moduleId: YARD_ID, defId: 'container_yard_small', x: 42, y: 18, rotation: 0, cells: [] }];
    const specs = toastSpecsForEvents(app.world, events);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      key: `disconnected:${String(YARD_ID)}`,
      tone: 'info',
      icon: 'ic_info',
      title: 'Nepripojené',
      focus: { x: 44, y: 20 }, // dvor 4×4 na (42, 18)
    });
    expect(specs[0]?.text).toContain('Kontajnerový dvor S');
    expect(specs[0]?.text).toContain('YRD-04');
  });

  it('pripojený modul, modul bez cestných konektorov (žeriav) a zaniknutý modul toast nedajú', () => {
    const app = createApp();
    buildLogistics(app);
    const placed = (moduleId: EntityId): SimEvent => ({ type: 'ModulePlaced', moduleId, defId: 'x', x: 0, y: 0, rotation: 0, cells: [] });
    expect(toastSpecsForEvents(app.world, [placed(YARD_ID)])).toEqual([]);
    expect(toastSpecsForEvents(app.world, [placed(ROOT_CRANE)])).toEqual([]);
    expect(toastSpecsForEvents(app.world, [placed(999 as EntityId)])).toEqual([]);
  });

  it('ostatné udalosti oznámenie nedajú; poradie zodpovedá poradiu udalostí', () => {
    const app = createApp();
    buildLogistics(app, { roads: false });
    const events: SimEvent[] = [
      { type: 'MoneyChanged', cashCents: 0, deltaCents: 0, reason: 'road_capex' },
      { type: 'NoStorageAvailable', berthId: ROOT_BERTH, cargoTypeId: 'container_teu' },
      { type: 'ModulePlaced', moduleId: YARD_ID, defId: 'container_yard_small', x: 42, y: 18, rotation: 0, cells: [] },
    ];
    expect(toastSpecsForEvents(app.world, events).map((s) => s.title)).toEqual(['Chýba sklad', 'Nepripojené']);
  });
});

describe('ToastCenter: zásobník', () => {
  it('konštanta auto-zatvorenia je v config.ts a predvolene ju center používa', () => {
    expect(TOAST_AUTO_CLOSE_MS).toBeGreaterThan(0);
    const { center, timers } = centerWith();
    center.push(spec('a'));
    timers.advance(TOAST_AUTO_CLOSE_MS - 1);
    expect(center.get()).toHaveLength(1);
    timers.advance(1);
    expect(center.get()).toHaveLength(0);
  });

  it('push zaradí toast s tónom, ikonou, názvom a textom; get() má stabilnú referenciu do zmeny', () => {
    const { center } = centerWith();
    expect(center.get()).toEqual([]);
    const empty = center.get();
    expect(center.get()).toBe(empty);
    expect(center.push(spec('a', { tone: 'warning', icon: 'ic_warning', title: 'Chýba sklad', text: 'popis' }))).toBe(true);
    const one = center.get();
    expect(one).not.toBe(empty);
    expect(center.get()).toBe(one);
    expect(one[0]).toMatchObject({ tone: 'warning', icon: 'ic_warning', title: 'Chýba sklad', text: 'popis' });
    expect(one[0]?.onShow).toBeUndefined();
  });

  it('rovnaký kľúč sa naraz nezobrazí dvakrát; po zatvorení ho možno zaradiť znova', () => {
    const { center } = centerWith();
    expect(center.push(spec('a'))).toBe(true);
    expect(center.push(spec('a'))).toBe(false);
    expect(center.get()).toHaveLength(1);
    center.close(center.get()[0]?.id ?? -1);
    expect(center.push(spec('a'))).toBe(true);
  });

  it('× (onClose) zatvorí toast a zruší jeho časovač; neznáme id sa ignoruje', () => {
    const { center, timers } = centerWith();
    center.push(spec('a'));
    center.push(spec('b'));
    expect(timers.pending).toBe(2);
    const [first] = center.get();
    first?.onClose(first.id);
    expect(center.get().map((toast) => toast.title)).toEqual(['b']);
    expect(timers.pending).toBe(1);
    center.close(12345);
    expect(center.get()).toHaveLength(1);
  });

  it(`najviac ${String(MAX_TOASTS)} viditeľných: ostatné čakajú bez časovača a ukážu sa po zatvorení; odpočet im začne až vtedy`, () => {
    const { center, timers } = centerWith({ autoCloseMs: 1000 });
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) center.push(spec(key));
    expect(center.get()).toHaveLength(6); // Toasts ukáže prvých MAX_TOASTS, zvyšok čaká
    expect(timers.pending).toBe(MAX_TOASTS);
    timers.advance(1000); // a–d vypršali, e a f sa zobrazili
    expect(center.get().map((toast) => toast.title)).toEqual(['e', 'f']);
    expect(timers.pending).toBe(2);
    timers.advance(999);
    expect(center.get()).toHaveLength(2);
    timers.advance(1);
    expect(center.get()).toEqual([]);
  });

  it('akcia „Ukázať“: onShow centruje kameru na focus; bez centerOn alebo focus toast akciu nemá', () => {
    const centerOn = vi.fn();
    const { center } = centerWith({ centerOn });
    center.push(spec('with', { focus: { x: 44, y: 20 } }));
    center.push(spec('without'));
    const [withFocus, without] = center.get();
    expect(withFocus?.showLabel).toBe('Ukázať');
    withFocus?.onShow?.(withFocus.id);
    expect(centerOn).toHaveBeenCalledWith(44, 20);
    expect(without?.onShow).toBeUndefined();
    const bare = centerWith().center;
    bare.push(spec('with', { focus: { x: 1, y: 2 } }));
    expect(bare.get()[0]?.onShow).toBeUndefined();
  });

  it('subscribe: odberateľ dostane oznam pri push aj close; po odhlásení nie', () => {
    const { center } = centerWith();
    const listener = vi.fn();
    const stop = center.subscribe(listener);
    center.push(spec('a'));
    center.close(center.get()[0]?.id ?? -1);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    center.push(spec('b'));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('dispose: odpojí od udalostí, zruší časovače a vyprázdni zásobník', () => {
    const { app, center, timers } = centerWith();
    center.push(spec('a'));
    center.dispose();
    expect(center.get()).toEqual([]);
    expect(timers.pending).toBe(0);
    expect(center.push(spec('b'))).toBe(false);
    buildLogistics(app, { roads: false }); // ModulePlaced po dispose už toast nevytvorí
    expect(center.get()).toEqual([]);
  });
});

describe('ToastCenter: udalosti zo simu', () => {
  it('položenie dvora bez cesty vytvorí toast „Nepripojené“; „Ukázať“ vycentruje kameru na dvor', () => {
    const centerOn = vi.fn();
    const { app, center } = centerWith({ centerOn });
    runCommands(app, [{ type: 'PlaceModule', defId: 'container_yard_small', x: 42, y: 18, rotation: 0 }]);
    const toasts = center.get();
    expect(toasts.map((toast) => [toast.tone, toast.title])).toEqual([['info', 'Nepripojené']]);
    toasts[0]?.onShow?.(toasts[0].id);
    expect(centerOn).toHaveBeenCalledWith(44, 20);
  });

  it('položenie dvora vedľa hotovej cesty toast nevytvorí', () => {
    const { app, center } = centerWith();
    runCommands(app, [
      { type: 'PlaceRoad', cells: [{ x: 41, y: 17 }, { x: 41, y: 18 }, { x: 41, y: 19 }, { x: 41, y: 20 }, { x: 41, y: 21 }, { x: 41, y: 22 }, { x: 42, y: 22 }, { x: 43, y: 22 }] },
      { type: 'PlaceModule', defId: 'container_yard_small', x: 42, y: 18, rotation: 0 },
    ]);
    expect(center.get()).toEqual([]);
  });

  it('loď s nákladom bez skladu: apron sa naplní a vznikne „Chýba sklad“ s kódom kotviska; opakovanie pre to isté kotvisko sa nezdvojí', () => {
    const { app, center } = centerWith();
    runCommands(app, [{ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }]);
    frameUntil(app, () => center.get().some((toast) => toast.title === 'Chýba sklad'), 3000);
    const toast = center.get().find((t) => t.title === 'Chýba sklad');
    expect(toast).toMatchObject({ tone: 'warning', text: 'Kotvisko BRT-01 nemá kam uložiť kontajnery (postav alebo pripoj kontajnerový dvor)' });
    // ďalšia hodina hry: udalosť príde znova, ale toast s rovnakým kľúčom je ešte zobrazený → jediný
    let repeated = 0;
    app.bridge.onEvents((events) => {
      repeated += events.filter((event) => event.type === 'NoStorageAvailable').length;
    });
    const { ticksPerHour } = app.world.clock;
    for (let i = 0; i < ticksPerHour + 10; i += 1) app.loop.frame(app.loop.tickMs);
    expect(repeated).toBeGreaterThan(0);
    expect(center.get().filter((t) => t.title === 'Chýba sklad')).toHaveLength(1);
  });

  it('dvor postavený, ale nepripojený: kotvisko hlási „Chýba sklad“ (sklad existuje, no dispatcher ho ignoruje)', () => {
    const { app, center } = centerWith();
    buildLogistics(app, { roads: false });
    runCommands(app, [{ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }]);
    frameUntil(app, () => center.get().some((toast) => toast.title === 'Chýba sklad'), 3000);
    expect(center.get().map((toast) => toast.title)).toContain('Chýba sklad');
  });
});

describe('ConnectedToasts a App', () => {
  it('prázdny zásobník nevykreslí nič; toast sa vykreslí s tónom, názvom, textom a akciou „Ukázať“', () => {
    const { center } = centerWith({ centerOn: () => undefined });
    expect(renderToStaticMarkup(createElement(ConnectedToasts, { center }))).toBe('');
    center.push(spec('a', { tone: 'warning', title: 'Chýba sklad', text: 'Kotvisko BRT-01', focus: { x: 1, y: 2 } }));
    const html = renderToStaticMarkup(createElement(ConnectedToasts, { center }));
    expect(html).toContain('class="app__toasts"');
    expect(html).toContain('toast--warning');
    expect(html).toContain('Chýba sklad');
    expect(html).toContain('Kotvisko BRT-01');
    expect(html).toContain('Ukázať');
  });

  it('viac než 4 toastov sa vykreslí najviac 4', () => {
    const { center } = centerWith();
    for (const key of ['a', 'b', 'c', 'd', 'e']) center.push(spec(key));
    const html = renderToStaticMarkup(createElement(ConnectedToasts, { center }));
    expect(html.match(/data-toast-id=/g)).toHaveLength(MAX_TOASTS);
  });

  it('App zobrazí toasty len s `toasts`; bez neho zásobník nie je v DOM', () => {
    const { app, center } = centerWith();
    center.push(spec('a', { title: 'Nepripojené' }));
    const noFeedback = { feedback: () => null, subscribeFeedback: () => () => undefined };
    expect(renderToStaticMarkup(createElement(App, { bridge: app.bridge, feedback: noFeedback, toasts: center }))).toContain('Nepripojené');
    expect(renderToStaticMarkup(createElement(App, { bridge: app.bridge, feedback: noFeedback }))).not.toContain('class="toasts"');
  });
});
