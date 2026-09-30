/**
 * ToastCenter (T03-10) — oznámenia pre hráča zo simu: zásobník toastov, ktorý číta udalosti (`SimBridge.onEvents`) a
 * plní `@ui/toasts` (čisto prezentačné). Žije mimo Reactu (vzor `BuildSelection`), takže StrictMode ani prekreslenia
 * oznámenia nezdvojujú; React ho číta cez `useSyncExternalStore` (`subscribe`, `get`).
 *
 * Zdroje oznámení (`toastSpecsForEvents`, čistá funkcia nad `World` a udalosťami):
 * - `NoStorageAvailable` → „Chýba sklad“ (warning): kotvisko nemá kam uložiť náklad (aj keď je len nepripojené).
 * - `ModulePlaced` modulu s cestným konektorom, ktorý nie je pripojený → „Nepripojené“ (info) s akciou „Ukázať“
 *   (centruje kameru na modul).
 * - `RampOperationalChanged` na `false` → „Rampa neprevádzková“ (warning) s dôvodom (`RAMP_INOPERATIVE_TOAST_REASON`) a
 *   akciou „Ukázať“ (T04-08). Návrat do prevádzky toast nevytvára: rampa postavená ako posledná v hotovom reťazci by ním
 *   zbytočne zahltila panel.
 *
 * Pravidlá zásobníka:
 * - Rovnaký `key` (napr. `no_storage:1`) sa naraz nezobrazí dvakrát — opakovaná udalosť pre to isté kotvisko nezaplaví panel.
 * - Naraz sa ukáže najviac `MAX_TOASTS` (4); ďalšie čakajú a ukážu sa, keď sa niektorý zavrie.
 * - Zobrazený toast sa zatvorí sám po `autoCloseMs` (`TOAST_AUTO_CLOSE_MS`, reálny čas); odpočet začína až pri zobrazení.
 */
import type { EntityId } from '@sim/core';
import type { CargoCategory } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { RampInoperativeReason } from '@sim/modules';
import type { World } from '@sim/world';
import { moduleCode } from '@ui/module-inspector';
import { MAX_TOASTS, type ToastData, type ToastId, type ToastTone } from '@ui/toasts';
import { TOAST_AUTO_CLOSE_MS } from './config';
import { hasRoadConnector } from './entities-vm';
import type { SimBridge, Unsubscribe } from './sim-bridge';
import type { TimerHost } from './snapshot-store';

/** Popis oznámenia pred zaradením do zásobníka. */
export interface ToastSpec {
  /** Kľúč zhody: toast s rovnakým kľúčom už v zásobníku → nový sa zahodí. */
  readonly key: string;
  readonly tone: ToastTone;
  /** Názov ikony zo spritu (`ic_warning`). */
  readonly icon: string;
  readonly title: string;
  readonly text: string;
  /** Bod v bunkách, na ktorý akcia „Ukázať“ vycentruje kameru; bez neho toast akciu nemá. */
  readonly focus?: { readonly x: number; readonly y: number };
}

/** Názvy nákladu a skladu pre text „Chýba sklad“ podľa kategórie (prezentácia; F3 pozná len kontajnery). */
export const CARGO_CATEGORY_TEXT: Readonly<Record<CargoCategory, { readonly cargo: string; readonly storage: string }>> = Object.freeze({
  container: { cargo: 'kontajnery', storage: 'kontajnerový dvor' },
  bulk: { cargo: 'sypký náklad', storage: 'sklad sypkého nákladu' },
  liquid: { cargo: 'kvapaliny', storage: 'nádrž' },
  gas: { cargo: 'plyn', storage: 'zásobník plynu' },
  roro: { cargo: 'vozidlá', storage: 'parkovisko áut' },
});

/** Popis akcie „Ukázať“ (centrovanie kamery). */
export const TOAST_SHOW_ON_MAP_LABEL = 'Ukázať';

export const NO_STORAGE_TITLE = 'Chýba sklad';
export const DISCONNECTED_TOAST_TITLE = 'Nepripojené';
export const RAMP_INOPERATIVE_TOAST_TITLE = 'Rampa neprevádzková';

/** Dôvod neprevádzkovosti rampy (kód zo simu) → krátky text do oznámenia (úplná mapa: nový dôvod v sime = chyba kompilácie). */
export const RAMP_INOPERATIVE_TOAST_REASON: Readonly<Record<RampInoperativeReason, string>> = Object.freeze({
  not_connected: 'chýba súvislá cesta k rampe',
  no_gate: 'chýba brána na ceste',
  no_waiting_area: 'chýba stojisko',
});

/** Kód modulu pre text oznámenia (`BRT-01`); zaniknutý modul → kód z druhu `fallbackKind`. */
function codeOf(world: World, moduleId: EntityId, fallbackKind: string): string {
  return moduleCode(world.modules.get(moduleId)?.kind ?? fallbackKind, moduleId);
}

/** Oznámenia pre udalosti jedného framu, v poradí udalostí; `world` je stav po frame (pripojenie sa číta z neho). */
export function toastSpecsForEvents(world: World, events: readonly SimEvent[]): ToastSpec[] {
  const specs: ToastSpec[] = [];
  for (const event of events) {
    if (event.type === 'NoStorageAvailable') {
      const text = CARGO_CATEGORY_TEXT[world.defs.cargoTypes.get(event.cargoTypeId).category];
      specs.push({
        key: `no_storage:${String(event.berthId)}`,
        tone: 'warning',
        icon: 'ic_warning',
        title: NO_STORAGE_TITLE,
        text: `Kotvisko ${codeOf(world, event.berthId, 'berth')} nemá kam uložiť ${text.cargo} (postav alebo pripoj ${text.storage})`,
      });
    } else if (event.type === 'ModulePlaced') {
      const module = world.modules.get(event.moduleId);
      if (module === undefined || !hasRoadConnector(module) || world.isConnected(module)) continue;
      specs.push({
        key: `disconnected:${String(module.id)}`,
        tone: 'info',
        icon: 'ic_info',
        title: DISCONNECTED_TOAST_TITLE,
        text: `${module.def.displayName} ${moduleCode(module.kind, module.id)} nemá cestu k vjazdu — pripoj ho cestou`,
        focus: { x: module.origin.x + module.size.w / 2, y: module.origin.y + module.size.h / 2 },
      });
    } else if (event.type === 'RampOperationalChanged' && !event.operational) {
      const ramp = world.modules.get(event.rampId);
      if (ramp === undefined) continue;
      const reason = event.reason === null ? undefined : RAMP_INOPERATIVE_TOAST_REASON[event.reason];
      specs.push({
        key: `ramp_inoperative:${String(ramp.id)}`,
        tone: 'warning',
        icon: 'ic_warning',
        title: RAMP_INOPERATIVE_TOAST_TITLE,
        text: reason === undefined ? moduleCode(ramp.kind, ramp.id) : `${moduleCode(ramp.kind, ramp.id)} — ${reason}`,
        focus: { x: ramp.origin.x + ramp.size.w / 2, y: ramp.origin.y + ramp.size.h / 2 },
      });
    }
  }
  return specs;
}

export interface ToastCenterOptions {
  /** Vycentruje kameru na bod v bunkách (akcia „Ukázať“); bez neho toasty akciu nemajú. */
  readonly centerOn?: (cellX: number, cellY: number) => void;
  /** Po koľkých ms sa zobrazený toast zavrie; predvolene `TOAST_AUTO_CLOSE_MS`. */
  readonly autoCloseMs?: number;
  /** Časovače; v testoch nahraditeľné. */
  readonly timers?: TimerHost;
}

const globalTimers: TimerHost = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

interface QueuedToast {
  readonly id: number;
  readonly key: string;
  readonly data: ToastData;
  /** Časovač automatického zatvorenia; `null`, kým toast čaká vo fronte. */
  timer: unknown;
}

export class ToastCenter {
  private readonly queue: QueuedToast[] = [];
  private snapshot: readonly ToastData[] = Object.freeze([]);
  private nextId = 1;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly centerOn: ToastCenterOptions['centerOn'];
  private readonly autoCloseMs: number;
  private readonly timers: TimerHost;
  private readonly stopEvents: Unsubscribe;

  constructor(
    private readonly bridge: Pick<SimBridge, 'world' | 'onEvents'>,
    options: ToastCenterOptions = {},
  ) {
    this.centerOn = options.centerOn;
    this.autoCloseMs = options.autoCloseMs ?? TOAST_AUTO_CLOSE_MS;
    this.timers = options.timers ?? globalTimers;
    this.stopEvents = bridge.onEvents((events) => {
      for (const spec of toastSpecsForEvents(this.bridge.world, events)) this.push(spec);
    });
  }

  /** Toasty v poradí príchodu (aj čakajúce; `Toasts` ukáže prvých `MAX_TOASTS`). Referencia je stabilná do zmeny. */
  readonly get = (): readonly ToastData[] => this.snapshot;

  /** Odber zmien zásobníka (pre `useSyncExternalStore`). */
  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Zaradí oznámenie, ak s rovnakým `key` už nie je v zásobníku. @returns `true`, ak sa pridalo. */
  push(spec: ToastSpec): boolean {
    if (this.disposed || this.queue.some((toast) => toast.key === spec.key)) return false;
    const id = this.nextId;
    this.nextId += 1;
    const { focus } = spec;
    const { centerOn } = this;
    const data: ToastData = {
      id,
      tone: spec.tone,
      icon: spec.icon,
      title: spec.title,
      text: spec.text,
      onClose: (toastId) => {
        this.close(toastId);
      },
      ...(focus !== undefined && centerOn !== undefined
        ? {
            onShow: () => {
              centerOn(focus.x, focus.y);
            },
            showLabel: TOAST_SHOW_ON_MAP_LABEL,
          }
        : {}),
    };
    this.queue.push({ id, key: spec.key, data, timer: null });
    this.changed();
    return true;
  }

  /** Zatvorí toast (tlačidlo ×, automaticky); neznáme id sa ignoruje. */
  close(id: ToastId): void {
    const index = this.queue.findIndex((toast) => toast.id === id);
    const found = this.queue[index];
    if (found === undefined) return;
    if (found.timer !== null) this.timers.clearTimeout(found.timer);
    this.queue.splice(index, 1);
    this.changed();
  }

  /** Odpojí sa od udalostí, zruší časovače a vyprázdni zásobník. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopEvents();
    for (const toast of this.queue) {
      if (toast.timer !== null) this.timers.clearTimeout(toast.timer);
    }
    this.queue.length = 0;
    this.snapshot = Object.freeze([]);
    this.listeners.clear();
  }

  /** Spustí odpočet zobrazeným toastom, obnoví snapshot a upozorní odberateľov. */
  private changed(): void {
    for (const toast of this.queue.slice(0, MAX_TOASTS)) {
      if (toast.timer !== null) continue;
      toast.timer = this.timers.setTimeout(() => {
        this.close(toast.id);
      }, this.autoCloseMs);
    }
    this.snapshot = Object.freeze(this.queue.map((toast) => toast.data));
    for (const listener of [...this.listeners]) listener();
  }
}
