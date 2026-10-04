/**
 * SaveController — všetka logika ukladania a načítania hry bez Reactu (ADR-030): sloty, ručné a rýchle uloženie
 * (`Ctrl+S`), automatické uloženie, načítanie, export a import súboru, nastavenia. UI (`SettingsPanel`,
 * `SaveLoadPanel`) je len tenký wrapper: číta `getState()` (cez `subscribe`) a volá metódy.
 *
 * Princípy:
 * - **Nič nevyhadzuje do UI.** Každá akcia vráti `ActionResult`; zlyhanie (úložisko plné či nedostupné, súbor nie je
 *   save, poškodený svet) sa zároveň ohlási toastom s dôvodom a hra beží ďalej.
 * - **Autosave mimo ticku.** `handleEvents` sa volá z `SimBridge.onEvents`, teda po dokončení framu (po `world.tick()`),
 *   nikdy z vnútra ticku. Pri `DayClosed` každého `autosaveEveryDays`-teho dňa uloží do slotu `auto`.
 * - **Načítanie nemení bežiaci svet.** Najprv `World.deserialize` (fail-fast, `WorldStateError` s cestou); až keď prejde,
 *   odovzdá nový svet `loadWorld` (reštart cez `runGame`, hra štartuje pozastavená). Chybný save/import teda nechá
 *   aktuálny svet nedotknutý.
 * - **Fronta príkazov.** `World.serialize` vyžaduje prázdnu frontu, preto sa pred uložením zvyšné príkazy aplikujú
 *   (`applyPending`) a ich udalosti sa publikujú do mosta, aby o nich UI aj render vedeli (ADR-030 bod 1).
 */
import type { SimEvent } from '@sim/events';
import { World, WorldStateError, type WorldOptions } from '@sim/world';
import { formatClock, formatDayAndClock } from '@ui/format';
import { APP_WORLD_OPTIONS, QUIET_TOAST_AUTO_CLOSE_MS } from '../config';
import type { Settings, SettingsStore } from '../settings';
import { createSettingsStore } from '../settings';
import type { SimBridge } from '../sim-bridge';
import type { ToastSpec } from '../toast-center';
import { exportSaveFile, readSaveFile, browserDownloader, type FileDownloader, type ReadableFile } from './save-file';
import { SaveError, encodeSave, type SaveGame, type SaveSlotId } from './save-game';
import { createSaveStore, type SaveSlotInfo, type SaveStore } from './save-store';
import { StorageError, browserStorage, type StorageProvider } from './storage';

// ---- texty (prezentácia; komentáre a UI po slovensky) ----

/** Názvy slotov pre toasty (UI panel má vlastné). */
export const SLOT_NAMES: Readonly<Record<SaveSlotId, string>> = Object.freeze({
  auto: 'Automatické uloženie',
  '1': 'Slot 1',
  '2': 'Slot 2',
  '3': 'Slot 3',
});

/** Štítok (`SaveGame.label`) podľa spôsobu uloženia. */
export const SAVE_LABELS = Object.freeze({
  manual: 'Ručné uloženie',
  quick: 'Rýchle uloženie',
  auto: 'Automatické uloženie',
  export: 'Exportovaná hra',
});

export const SAVED_TOAST_TITLE = 'Uložené';
export const AUTOSAVED_TOAST_TITLE = 'Automaticky uložené';
export const EXPORTED_TOAST_TITLE = 'Exportované';
export const LOADED_TOAST_TITLE = 'Načítané';
export const SAVE_FAILED_TOAST_TITLE = 'Uloženie zlyhalo';
export const AUTOSAVE_FAILED_TOAST_TITLE = 'Automatické uloženie zlyhalo';
export const LOAD_FAILED_TOAST_TITLE = 'Načítanie zlyhalo';
export const IMPORT_FAILED_TOAST_TITLE = 'Import zlyhal';
export const EXPORT_FAILED_TOAST_TITLE = 'Export zlyhal';
export const REMOVE_FAILED_TOAST_TITLE = 'Zmazanie zlyhalo';
export const SETTINGS_FAILED_TOAST_TITLE = 'Nastavenia sa neuložili';

const SAVE_ICON = 'ic_save';
const WARNING_ICON = 'ic_warning';

// ---- závislosti a výsledky ----

/** Úložisko slotov a nastavení, ktoré zdieľa celá aplikácia (prežíva reštart hry). */
export interface PersistenceServices {
  readonly store: SaveStore;
  readonly settings: SettingsStore;
}

export function createPersistence(provider: StorageProvider = browserStorage): PersistenceServices {
  return { store: createSaveStore(provider), settings: createSettingsStore(provider) };
}

export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

const OK: ActionResult = Object.freeze({ ok: true });

/** Stav pre UI (`useSyncExternalStore`): referencia je stabilná, kým sa nezmení zoznam slotov alebo nastavenia. */
export interface SaveControllerState {
  readonly slots: readonly SaveSlotInfo[];
  readonly settings: Settings;
}

export interface SaveControllerDeps {
  /** Most bežiacej hry: svet, ktorý sa ukladá, a `publish` na rozoslanie udalostí príkazov vyprázdnených pred uložením. */
  readonly bridge: Pick<SimBridge, 'world' | 'publish'>;
  readonly persistence: PersistenceServices;
  /** Zaradí toast (typicky `ToastCenter.push`). */
  readonly notify: (spec: ToastSpec) => void;
  /**
   * Spustí hru nad načítaným svetom (`runGame`: zruší bežiacu, štartuje novú v pauze). Bez neho načítanie a import
   * zlyhajú s vysvetlením (napr. samostatný `bootstrap` v testoch).
   */
  readonly loadWorld?: (world: World) => void;
  /** Reálny čas ako ISO 8601 (sim ho čítať nesmie); predvolene systémové hodiny. */
  readonly now?: () => string;
  /** Stiahnutie súboru pri exporte; predvolene `<a download>`. */
  readonly downloader?: FileDownloader;
  /** Voľby obnoveného sveta; predvolene `APP_WORLD_OPTIONS` (invarianty len v DEV). */
  readonly worldOptions?: WorldOptions;
}

/**
 * Toast po načítaní uloženej hry alebo importe súboru. Zaraďuje ho až nový `bootstrap` (`BootstrapOptions.startToast`),
 * lebo `ToastCenter` pôvodnej hry sa pri reštarte ruší.
 */
export function loadedToastSpec(world: World): ToastSpec {
  const { clock } = world;
  const when = formatDayAndClock(clock.gameDay, formatClock(clock.hourOfDay, clock.minuteOfHour));
  return { key: 'loaded', tone: 'success', icon: SAVE_ICON, title: LOADED_TOAST_TITLE, text: `${when} · hra je pozastavená` };
}

/** Text chyby pre hráča (toast). */
export function describeError(error: unknown): string {
  if (error instanceof WorldStateError) {
    const where = error.path === '' ? 'celý stav' : error.path;
    return `Stav hry je neplatný (${where}): ${error.problem}`;
  }
  if (error instanceof SaveError || error instanceof StorageError || error instanceof Error) return error.message;
  return String(error);
}

export class SaveController {
  private readonly world: World;
  private readonly bridge: SaveControllerDeps['bridge'];
  private readonly store: SaveStore;
  private readonly settings: SettingsStore;
  private readonly notify: SaveControllerDeps['notify'];
  private readonly loadWorld: SaveControllerDeps['loadWorld'];
  private readonly now: () => string;
  private readonly downloader: FileDownloader;
  private readonly worldOptions: WorldOptions;
  private readonly listeners = new Set<() => void>();
  private state: SaveControllerState;
  private disposed = false;

  constructor(deps: SaveControllerDeps) {
    this.bridge = deps.bridge;
    this.world = deps.bridge.world;
    this.store = deps.persistence.store;
    this.settings = deps.persistence.settings;
    this.notify = deps.notify;
    this.loadWorld = deps.loadWorld;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.downloader = deps.downloader ?? browserDownloader;
    this.worldOptions = deps.worldOptions ?? APP_WORLD_OPTIONS;
    this.state = { slots: this.store.list(), settings: this.settings.get() };
  }

  // ---- stav pre UI ----

  readonly getState = (): SaveControllerState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Znova prečíta sloty z úložiska (napr. pri otvorení panelu — úložisko mohla zmeniť iná karta). */
  refreshSlots(): void {
    this.update(this.store.list());
  }

  // ---- uloženie ----

  /** Ručné uloženie do slotu `auto`/`1`/`2`/`3` (prepíše obsah). */
  save(slot: SaveSlotId, label: string = SAVE_LABELS.manual): ActionResult {
    return this.persist(slot, label, 'manual');
  }

  /** `Ctrl+S`: rýchle uloženie do slotu 1. */
  quickSave(): ActionResult {
    return this.persist('1', SAVE_LABELS.quick, 'manual');
  }

  /** Automatické uloženie do slotu `auto` (nenápadný toast). */
  autosave(): ActionResult {
    return this.persist('auto', SAVE_LABELS.auto, 'auto');
  }

  /**
   * Volá sa z `SimBridge.onEvents` po každom framu so svojimi udalosťami: pri `DayClosed` každého
   * `autosaveEveryDays`-teho dňa sa hra automaticky uloží (jedenkrát za dávku). Po bankrote sa neukladá — prepísal by
   * posledné dobré uloženie hrou, ktorá už nejde hrať.
   */
  handleEvents(events: readonly SimEvent[]): void {
    if (this.disposed || this.world.gameOver) return;
    const every = this.settings.get().autosaveEveryDays;
    if (every <= 0) return;
    const { ticksPerDay } = this.world.clock;
    let due = false;
    for (const event of events) {
      if (event.type === 'DayClosed' && Math.round(event.tick / ticksPerDay) % every === 0) due = true;
    }
    if (due) this.autosave();
  }

  private persist(slot: SaveSlotId, label: string, kind: 'manual' | 'auto'): ActionResult {
    let save: SaveGame;
    try {
      this.flushPending();
      save = encodeSave(this.world, label, this.now());
      this.store.save(slot, save);
    } catch (error) {
      return this.fail(kind === 'auto' ? AUTOSAVE_FAILED_TOAST_TITLE : SAVE_FAILED_TOAST_TITLE, `save_failed:${slot}`, error);
    }
    this.refreshSlots();
    const when = formatDayAndClock(save.preview.day, save.preview.timeLabel);
    if (kind === 'auto') {
      this.notify({
        key: 'autosaved',
        tone: 'info',
        icon: SAVE_ICON,
        title: AUTOSAVED_TOAST_TITLE,
        text: when,
        autoCloseMs: QUIET_TOAST_AUTO_CLOSE_MS,
      });
    } else {
      this.notify({
        key: `saved:${slot}:${String(this.world.clock.tick)}`,
        tone: 'success',
        icon: SAVE_ICON,
        title: SAVED_TOAST_TITLE,
        text: `${SLOT_NAMES[slot]} · ${when}`,
      });
    }
    return OK;
  }

  /** Aplikuje príkazy čakajúce vo fronte (inak `serialize` vyhodí) a publikuje ich udalosti do mosta. */
  private flushPending(): void {
    if (this.world.pendingCommandCount > 0) this.bridge.publish(this.world.applyPending());
  }

  // ---- načítanie ----

  /** Načíta hru zo slotu: svet sa obnoví a hra sa reštartuje v pauze; pri chybe ostáva bežiaca hra nezmenená. */
  load(slot: SaveSlotId): ActionResult {
    let save: SaveGame | null;
    try {
      save = this.store.load(slot);
    } catch (error) {
      return this.fail(LOAD_FAILED_TOAST_TITLE, 'load_failed', error);
    }
    if (save === null) return this.fail(LOAD_FAILED_TOAST_TITLE, 'load_failed', new Error(`${SLOT_NAMES[slot]} je prázdny`));
    return this.restore(save, LOAD_FAILED_TOAST_TITLE, 'load_failed');
  }

  /** Importuje vybraný súbor; chybný súbor → toast s dôvodom, bežiaca hra ostáva nezmenená. */
  async importFile(file: ReadableFile): Promise<ActionResult> {
    let save: SaveGame;
    try {
      save = await readSaveFile(file);
    } catch (error) {
      return this.fail(IMPORT_FAILED_TOAST_TITLE, 'import_failed', error);
    }
    if (this.disposed) return { ok: false, message: 'Hra sa medzitým reštartovala' };
    return this.restore(save, IMPORT_FAILED_TOAST_TITLE, 'import_failed');
  }

  private restore(save: SaveGame, failTitle: string, failKey: string): ActionResult {
    const { loadWorld } = this;
    if (loadWorld === undefined) return this.fail(failTitle, failKey, new Error('Načítanie hry nie je v tomto režime dostupné'));
    let world: World;
    try {
      world = World.deserialize(this.world.defs, this.world.map, save.world, this.worldOptions);
    } catch (error) {
      return this.fail(failTitle, failKey, error);
    }
    loadWorld(world);
    return OK;
  }

  // ---- export ----

  /**
   * Stiahne hru ako `modular-harbor-<deň>-<slot>.json`. Bez `slot` sa exportuje práve rozohraná hra (`current`),
   * so `slot` obsah uloženého slotu.
   */
  exportGame(slot?: SaveSlotId): ActionResult {
    let fileName: string;
    try {
      let save: SaveGame | null;
      if (slot === undefined) {
        this.flushPending();
        save = encodeSave(this.world, SAVE_LABELS.export, this.now());
      } else {
        save = this.store.load(slot);
        if (save === null) throw new Error(`${SLOT_NAMES[slot]} je prázdny`);
      }
      fileName = exportSaveFile(save, slot ?? 'current', this.downloader);
    } catch (error) {
      return this.fail(EXPORT_FAILED_TOAST_TITLE, 'export_failed', error);
    }
    this.notify({ key: `exported:${fileName}`, tone: 'success', icon: SAVE_ICON, title: EXPORTED_TOAST_TITLE, text: fileName });
    return OK;
  }

  // ---- sloty a nastavenia ----

  /** Zmaže uloženie v slote (potvrdenie rieši UI). */
  remove(slot: SaveSlotId): ActionResult {
    try {
      this.store.remove(slot);
    } catch (error) {
      return this.fail(REMOVE_FAILED_TOAST_TITLE, `remove_failed:${slot}`, error);
    }
    this.refreshSlots();
    return OK;
  }

  /** Uloží nastavenia (znormalizované); pri zlyhaní zápisu platia v pamäti, toast to oznámi. */
  setSettings(next: Settings): ActionResult {
    const result = this.settings.set(next);
    this.update(this.state.slots);
    if (result.ok) return OK;
    const message = `${describeError(result.error)} — nastavenia platia len do zatvorenia hry`;
    this.notify({ key: 'settings_failed', tone: 'warning', icon: WARNING_ICON, title: SETTINGS_FAILED_TOAST_TITLE, text: message });
    return { ok: false, message };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  // ---- interné ----

  private update(slots: readonly SaveSlotInfo[]): void {
    this.state = { slots, settings: this.settings.get() };
    for (const listener of [...this.listeners]) listener();
  }

  private fail(title: string, key: string, error: unknown): ActionResult {
    const message = describeError(error);
    this.notify({ key, tone: 'danger', icon: WARNING_ICON, title, text: message });
    return { ok: false, message };
  }
}
