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
 * - `NoWaitingBay` → „Chýba čakacia plocha“ (k rampe nevedie trasa cez stojisko), inak „Stojisko je plné“ (warning) s akciou
 *   „Ukázať“ na rampu (T04-08). Kľúč `no_waiting_bay:<rampId>`; sim ju hlási najviac raz za hernú hodinu.
 *
 * - Kontrakty (F5, T05-07): `ContractOffered` → jeden toast „Nové ponuky“ za herný deň (zlúčené, info, akcia „Zobraziť“
 *   otvorí panel kontraktov); `ContractAccepted` (info); `ContractCompleted` → výplata (success, `+$… a +N XP`);
 *   `PenaltyApplied` → penalizácia (warning, dedup podľa kontraktu a druhu, sumy z jednej dávky sa sčítajú);
 *   `ContractFailed` (danger); `MonthlyReport` (info). Zánik ponuky (`ContractExpired`) a `GameOver` (modál) toast nemajú.
 *
 * Pravidlá zásobníka:
 * - Rovnaký `key` (napr. `no_storage:1`) sa naraz nezobrazí dvakrát — opakovaná udalosť pre to isté kotvisko nezaplaví panel.
 * - Naraz sa ukáže najviac `MAX_TOASTS` (4); ďalšie čakajú a ukážu sa, keď sa niektorý zavrie.
 * - Zobrazený toast sa zatvorí sám po `autoCloseMs` (`TOAST_AUTO_CLOSE_MS`, reálny čas); odpočet začína až pri zobrazení.
 */
import { sumTotals } from '@sim/economy';
import type { ContractId, EntityId } from '@sim/core';
import type { CargoCategory } from '@sim/defs';
import type { PenaltyKind, SimEvent } from '@sim/events';
import { LoadingRamp, type RampInoperativeReason } from '@sim/modules';
import type { World } from '@sim/world';
import { formatDuration, formatMoney, formatMoneyDelta, formatXp } from '@ui/format';
import { moduleCode } from '@ui/module-inspector';
import { MAX_TOASTS, type ToastData, type ToastId, type ToastTone } from '@ui/toasts';
import { TOAST_AUTO_CLOSE_MS } from './config';
import { hasRoadConnector } from './entities-vm';
import type { PanelId } from './panel-selection';
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
  /** Panel, ktorý akcia „Zobraziť“ otvorí (kontrakty); bez neho (alebo bez `openPanel`) toast túto akciu nemá. */
  readonly panel?: PanelId;
  /** Vlastný čas do automatického zatvorenia v ms (nenápadné oznámenia, napr. „Automaticky uložené“); predvolene `autoCloseMs` zásobníka. */
  readonly autoCloseMs?: number;
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

/** Popis akcie „Zobraziť“ (otvorenie panelu kontraktov). */
export const TOAST_SHOW_PANEL_LABEL = 'Zobraziť';

export const NO_STORAGE_TITLE = 'Chýba sklad';
export const DISCONNECTED_TOAST_TITLE = 'Nepripojené';
export const RAMP_INOPERATIVE_TOAST_TITLE = 'Rampa neprevádzková';
export const NO_WAITING_AREA_TITLE = 'Chýba čakacia plocha';
export const WAITING_AREA_FULL_TITLE = 'Stojisko je plné';

export const OFFERS_TOAST_TITLE = 'Nové ponuky kontraktov';
export const ACCEPTED_TOAST_TITLE = 'Kontrakt prijatý';
export const COMPLETED_TOAST_TITLE = 'Kontrakt splnený';
export const COMPLETED_LATE_TOAST_TITLE = 'Kontrakt splnený s meškaním';
export const FAILED_TOAST_TITLE = 'Kontrakt zlyhal';
export const MONTHLY_TOAST_TITLE = 'Mesačný výkaz';

/** Názov penalizácie podľa druhu (`demurrage` = státie lode nad limit, `late` = meškanie exportu po SLA). */
export const PENALTY_TOAST_TITLE: Readonly<Record<PenaltyKind, string>> = Object.freeze({
  demurrage: 'Penalizácia: státie lode',
  late: 'Penalizácia: meškanie exportu',
});

/** „1 nová ponuka“, „2 nové ponuky“, „5 nových ponúk“. */
export function newOffersText(count: number): string {
  if (count === 1) return '1 nová ponuka';
  return count >= 2 && count <= 4 ? `${String(count)} nové ponuky` : `${String(count)} nových ponúk`;
}

/** Dôvod neprevádzkovosti rampy (kód zo simu) → krátky text do oznámenia (úplná mapa: nový dôvod v sime = chyba kompilácie). */
export const RAMP_INOPERATIVE_TOAST_REASON: Readonly<Record<RampInoperativeReason, string>> = Object.freeze({
  not_connected: 'chýba súvislá cesta k rampe',
  no_gate: 'chýba brána na ceste',
  no_waiting_area: 'chýba stojisko',
  no_return_path: 'kamióny sa nemajú ako vrátiť cez bránu k portálu',
});

/** Kód modulu pre text oznámenia (`BRT-01`); zaniknutý modul → kód z druhu `fallbackKind`. */
function codeOf(world: World, moduleId: EntityId, fallbackKind: string): string {
  return moduleCode(world.modules.get(moduleId)?.kind ?? fallbackKind, moduleId);
}

/** Popis kontraktu pre text oznámenia: `#3 · 120 TEU` (zaniknutá ponuka → len `#3`). */
function contractLabel(world: World, contractId: ContractId): string {
  const contract = world.contracts.get(contractId);
  if (contract === undefined) return `#${String(contractId)}`;
  return `#${String(contractId)} · ${String(contract.volumeUnits)} ${world.defs.cargoTypes.get(contract.cargoTypeId).unitName}`;
}

/**
 * Oznámenia o kontraktoch pre jednu udalosť. `offers` (počet `ContractOffered` dávky) a `penalties` (súčet
 * `PenaltyApplied` podľa kontraktu a druhu) sa zlučujú: dávka dá jeden toast, nie jeden na udalosť.
 */
function contractSpec(world: World, event: SimEvent, batch: ContractBatch): ToastSpec | null {
  switch (event.type) {
    case 'ContractOffered': {
      if (batch.offersShown) return null;
      batch.offersShown = true;
      return {
        key: `contracts_offered:${String(world.clock.gameDay)}`,
        tone: 'info',
        icon: 'ic_contract',
        title: OFFERS_TOAST_TITLE,
        text: newOffersText(batch.offers),
        panel: 'contracts',
      };
    }
    case 'ContractAccepted': {
      const arrival = world.contracts.get(event.contractId)?.shipArrivalTick;
      const eta = arrival === undefined ? '' : ` — loď príde o ${formatDuration(arrival - world.clock.tick, world.clock)}`;
      return {
        key: `contract_accepted:${String(event.contractId)}`,
        tone: 'info',
        icon: 'ic_check',
        title: ACCEPTED_TOAST_TITLE,
        text: `${contractLabel(world, event.contractId)}${eta}`,
        panel: 'contracts',
      };
    }
    case 'ContractCompleted': {
      const paid = event.rewardCents - event.penaltiesCents;
      const penalties = event.penaltiesCents > 0 ? ` (penalizácie ${formatMoney(-event.penaltiesCents)})` : '';
      return {
        key: `contract_completed:${String(event.contractId)}`,
        tone: 'success',
        icon: 'ic_check',
        title: event.onTime ? COMPLETED_TOAST_TITLE : COMPLETED_LATE_TOAST_TITLE,
        text: `${contractLabel(world, event.contractId)} · ${formatMoneyDelta(paid)} a +${formatXp(event.xp)}${penalties}`,
        panel: 'contracts',
      };
    }
    case 'PenaltyApplied': {
      const id = `${String(event.contractId)}:${event.kind}`;
      if (batch.penaltiesShown.has(id)) return null;
      batch.penaltiesShown.add(id);
      const amount = batch.penalties.get(id) ?? event.amountCents;
      return {
        key: `penalty:${id}`,
        tone: 'warning',
        icon: 'ic_warning',
        title: PENALTY_TOAST_TITLE[event.kind],
        text: `${contractLabel(world, event.contractId)} · ${formatMoney(-amount)}`,
        panel: 'contracts',
      };
    }
    case 'ContractFailed':
      return {
        key: `contract_failed:${String(event.contractId)}`,
        tone: 'danger',
        icon: 'ic_close',
        title: FAILED_TOAST_TITLE,
        text: `${contractLabel(world, event.contractId)} · odmena prepadla, penalizácia ${formatMoney(-event.penaltiesCents)}`,
        panel: 'contracts',
      };
    case 'MonthlyReport':
      return {
        key: `monthly:${String(event.month)}`,
        tone: 'info',
        icon: 'ic_cash',
        title: MONTHLY_TOAST_TITLE,
        text: `Mesiac ${String(event.month + 1)}: príjmy ${formatMoney(sumTotals(event.summary.incomeCents))}, výdavky ${formatMoney(sumTotals(event.summary.expenseCents))}, hotovosť ${formatMoney(event.summary.cashEndCents)}`,
      };
    default:
      return null;
  }
}

/** Zlučovanie udalostí kontraktov v rámci jednej dávky (viď `contractSpec`). */
interface ContractBatch {
  /** Počet `ContractOffered` v dávke. */
  offers: number;
  offersShown: boolean;
  /** Súčet `PenaltyApplied` podľa `kontrakt:druh`. */
  readonly penalties: Map<string, number>;
  readonly penaltiesShown: Set<string>;
}

function contractBatch(events: readonly SimEvent[]): ContractBatch {
  const batch: ContractBatch = { offers: 0, offersShown: false, penalties: new Map(), penaltiesShown: new Set() };
  for (const event of events) {
    if (event.type === 'ContractOffered') {
      batch.offers += 1;
    } else if (event.type === 'PenaltyApplied') {
      const id = `${String(event.contractId)}:${event.kind}`;
      batch.penalties.set(id, (batch.penalties.get(id) ?? 0) + event.amountCents);
    }
  }
  return batch;
}

/** Oznámenia pre udalosti jedného framu, v poradí udalostí; `world` je stav po frame (pripojenie sa číta z neho). */
export function toastSpecsForEvents(world: World, events: readonly SimEvent[]): ToastSpec[] {
  const specs: ToastSpec[] = [];
  const batch = contractBatch(events);
  for (const event of events) {
    const contract = contractSpec(world, event, batch);
    if (contract !== null) {
      specs.push(contract);
      continue;
    }
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
    } else if (event.type === 'NoWaitingBay') {
      const ramp = world.modules.get(event.rampId);
      if (!(ramp instanceof LoadingRamp)) continue;
      const code = moduleCode(ramp.kind, ramp.id);
      // Bez trasy cez stojisko chýba čakacia plocha na ceste k rampe; s trasou sú všetky jej stojiská plné.
      const missing = world.landsideRoutes(ramp).length === 0;
      specs.push({
        key: `no_waiting_bay:${String(ramp.id)}`,
        tone: 'warning',
        icon: 'ic_warning',
        title: missing ? NO_WAITING_AREA_TITLE : WAITING_AREA_FULL_TITLE,
        text: missing
          ? `${code} — k rampe nevedie trasa cez čakaciu plochu, kamión sa nemá kde zastaviť`
          : `${code} — všetky stojiská sú obsadené, ďalší kamión vznikne, keď sa jedno uvoľní`,
        focus: { x: ramp.origin.x + ramp.size.w / 2, y: ramp.origin.y + ramp.size.h / 2 },
      });
    }
  }
  return specs;
}

export interface ToastCenterOptions {
  /** Vycentruje kameru na bod v bunkách (akcia „Ukázať“); bez neho toasty akciu nemajú. */
  readonly centerOn?: (cellX: number, cellY: number) => void;
  /** Otvorí pravý panel (akcia „Zobraziť“ pri toastoch kontraktov); bez neho tieto toasty akciu nemajú. */
  readonly openPanel?: (panel: PanelId) => void;
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
  /** Čas do automatického zatvorenia v ms (vlastný z `ToastSpec.autoCloseMs`, inak predvolený zásobníka). */
  readonly autoCloseMs: number;
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
  private readonly openPanel: ToastCenterOptions['openPanel'];
  private readonly autoCloseMs: number;
  private readonly timers: TimerHost;
  private readonly stopEvents: Unsubscribe;

  constructor(
    private readonly bridge: Pick<SimBridge, 'world' | 'onEvents'>,
    options: ToastCenterOptions = {},
  ) {
    this.centerOn = options.centerOn;
    this.openPanel = options.openPanel;
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
    const { centerOn, openPanel } = this;
    const { panel } = spec;
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
        : panel !== undefined && openPanel !== undefined
          ? {
              onShow: () => {
                openPanel(panel);
              },
              showLabel: TOAST_SHOW_PANEL_LABEL,
            }
          : {}),
    };
    this.queue.push({ id, key: spec.key, data, autoCloseMs: spec.autoCloseMs ?? this.autoCloseMs, timer: null });
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
      }, toast.autoCloseMs);
    }
    this.snapshot = Object.freeze(this.queue.map((toast) => toast.data));
    for (const listener of [...this.listeners]) listener();
  }
}
