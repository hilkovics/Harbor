// T06-03: SaveController — ručné a rýchle uloženie, autosave po DayClosed (mimo ticku), načítanie (rovnaký stateHash),
// export a import (chybný súbor nechá svet nezmenený), nastavenia a chyby úložiska (toast s dôvodom, nie výnimka).
import { describe, expect, it, vi } from 'vitest';
import { SetGameSpeedCommand } from '@sim/commands';
import type { SimEvent } from '@sim/events';
import { World, hashWorldState, stateHash } from '@sim/world';
import { QUIET_TOAST_AUTO_CLOSE_MS } from '@app/config';
import {
  AUTOSAVED_TOAST_TITLE,
  AUTOSAVE_FAILED_TOAST_TITLE,
  EXPORTED_TOAST_TITLE,
  EXPORT_FAILED_TOAST_TITLE,
  IMPORT_FAILED_TOAST_TITLE,
  LOAD_FAILED_TOAST_TITLE,
  SAVED_TOAST_TITLE,
  SAVE_FAILED_TOAST_TITLE,
  SETTINGS_FAILED_TOAST_TITLE,
  SaveController,
  createPersistence,
  describeError,
} from '@app/save/save-controller';
import { decodeSave, type SaveGame } from '@app/save/save-game';
import { WorldStateError } from '@sim/world';
import { DEFAULT_SETTINGS } from '@app/settings';
import { SimBridge } from '@app/sim-bridge';
import { createApp, createWorld } from '../app-fixtures';
import { FIXED_NOW, FakeStorage, saveHarness } from './save-fixtures';

/** JSON súboru ako text pre import. */
const asFile = (value: unknown): Blob => new Blob([typeof value === 'string' ? value : JSON.stringify(value)]);

describe('stav pre UI', () => {
  it('na začiatku prázdne sloty a predvolené nastavenia; referencia stavu je stabilná', () => {
    const { controller } = saveHarness();
    const state = controller.getState();
    expect(state.slots).toEqual([]);
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(controller.getState()).toBe(state);
  });

  it('uloženie obnoví zoznam slotov a upozorní odberateľov; odber sa dá zrušiť', () => {
    const { controller } = saveHarness();
    const listener = vi.fn();
    const stop = controller.subscribe(listener);
    controller.save('2');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getState().slots.map((slot) => slot.slot)).toEqual(['2']);
    stop();
    controller.save('3');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('refreshSlots prečíta úložisko znova (zmena z inej karty)', () => {
    const { controller, storage } = saveHarness();
    controller.save('1');
    storage.data.delete('mh.save.1');
    expect(controller.getState().slots).toHaveLength(1);
    controller.refreshSlots();
    expect(controller.getState().slots).toEqual([]);
  });
});

describe('ručné a rýchle uloženie', () => {
  it('save(slot) zapíše obálku so svetom a ohlási „Uložené“', () => {
    const { controller, world, storage, toasts } = saveHarness();
    expect(controller.save('2')).toEqual({ ok: true });
    const stored = decodeSave(JSON.parse(storage.data.get('mh.save.2') ?? ''));
    expect(stored.label).toBe('Ručné uloženie');
    expect(stored.savedAtIso).toBe(FIXED_NOW);
    expect(stored.world).toEqual(world.serialize());
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ tone: 'success', icon: 'ic_save', title: SAVED_TOAST_TITLE, text: 'Slot 2 · Deň 1 · 00:00' });
    expect(toasts[0]?.title).toBe('Uložené');
  });

  it('quickSave (Ctrl+S) ukladá do slotu 1 so štítkom „Rýchle uloženie“', () => {
    const { controller, storage, toasts } = saveHarness();
    expect(controller.quickSave()).toEqual({ ok: true });
    expect([...storage.data.keys()]).toEqual(['mh.save.1']);
    expect(decodeSave(JSON.parse(storage.data.get('mh.save.1') ?? '')).label).toBe('Rýchle uloženie');
    expect(toasts[0]?.title).toBe('Uložené');
  });

  it('pred uložením vyprázdni frontu príkazov a ich udalosti publikuje do mosta', () => {
    const { controller, world, bridge, storage } = saveHarness();
    const seen: SimEvent[] = [];
    bridge.onEvents((events) => {
      seen.push(...events);
    });
    bridge.dispatch(new SetGameSpeedCommand(4));
    expect(world.pendingCommandCount).toBe(1);
    expect(controller.save('1')).toEqual({ ok: true });
    expect(world.pendingCommandCount).toBe(0);
    expect(seen.some((event) => event.type === 'GameSpeedChanged' && event.speed === 4)).toBe(true);
    expect(decodeSave(JSON.parse(storage.data.get('mh.save.1') ?? '')).world.clock.speed).toBe(4);
  });

  it('plné úložisko → výsledok s dôvodom a toast, nie výnimka; predošlé uloženie ostane', () => {
    const { controller, storage, toasts } = saveHarness();
    expect(controller.save('1').ok).toBe(true);
    const before = storage.data.get('mh.save.1');
    storage.quotaChars = 100;
    const result = controller.save('1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/plné/);
    expect(storage.data.get('mh.save.1')).toBe(before);
    const failure = toasts[toasts.length - 1];
    expect(failure).toMatchObject({ tone: 'danger', title: SAVE_FAILED_TOAST_TITLE });
    expect(failure?.text).toMatch(/plné/);
  });

  it('nedostupné úložisko → toast s dôvodom, hra beží ďalej', () => {
    const persistence = createPersistence(() => {
      throw new Error('SecurityError');
    });
    const { controller, toasts, world } = saveHarness({ persistence });
    const result = controller.quickSave();
    expect(result.ok).toBe(false);
    expect(toasts[0]).toMatchObject({ tone: 'danger', title: SAVE_FAILED_TOAST_TITLE });
    expect(toasts[0]?.text).toMatch(/nie je dostupné/);
    expect(() => world.tick()).not.toThrow();
  });
});

describe('autosave po DayClosed', () => {
  const day = (tick: number): SimEvent => ({ type: 'DayClosed', tick });

  it('handleEvents: DayClosed → jedno uloženie do slotu auto s nenápadným toastom „Automaticky uložené“', () => {
    const { controller, world, storage, toasts } = saveHarness();
    controller.handleEvents([day(world.clock.ticksPerDay)]);
    expect([...storage.data.keys()]).toEqual(['mh.save.auto']);
    expect(decodeSave(JSON.parse(storage.data.get('mh.save.auto') ?? '')).label).toBe('Automatické uloženie');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ tone: 'info', icon: 'ic_save', title: AUTOSAVED_TOAST_TITLE, autoCloseMs: QUIET_TOAST_AUTO_CLOSE_MS });
    expect(toasts[0]?.title).toBe('Automaticky uložené');
  });

  it('iné udalosti autosave nespúšťajú; viac DayClosed v jednej dávke = jedno uloženie', () => {
    const { controller, world, storage } = saveHarness();
    controller.handleEvents([{ type: 'HourClosed', tick: world.clock.ticksPerHour }, { type: 'TickAdvanced', tick: 5 }]);
    expect(storage.data.size).toBe(0);
    controller.handleEvents([day(world.clock.ticksPerDay), day(2 * world.clock.ticksPerDay)]);
    expect(storage.data.size).toBe(1);
    expect(controller.getState().slots.map((slot) => slot.slot)).toEqual(['auto']);
  });

  it('autosaveEveryDays = N: ukladá len každý N-tý uzavretý deň; 0 = vypnuté', () => {
    const { controller, world, storage } = saveHarness();
    const perDay = world.clock.ticksPerDay;
    controller.setSettings({ ...DEFAULT_SETTINGS, autosaveEveryDays: 3 });
    controller.handleEvents([day(perDay)]);
    controller.handleEvents([day(2 * perDay)]);
    expect(storage.data.has('mh.save.auto')).toBe(false);
    controller.handleEvents([day(3 * perDay)]);
    expect(storage.data.has('mh.save.auto')).toBe(true);
    storage.data.delete('mh.save.auto');
    controller.handleEvents([day(4 * perDay)]);
    controller.handleEvents([day(5 * perDay)]);
    expect(storage.data.has('mh.save.auto')).toBe(false);
    controller.handleEvents([day(6 * perDay)]);
    expect(storage.data.has('mh.save.auto')).toBe(true);
    storage.data.delete('mh.save.auto');
    controller.setSettings({ ...DEFAULT_SETTINGS, autosaveEveryDays: 0 });
    controller.handleEvents([day(7 * perDay), day(8 * perDay)]);
    expect(storage.data.has('mh.save.auto')).toBe(false);
  });

  it('v hre: raz za deň, po flushi udalostí frameu a nikdy vnútri world.tick()', () => {
    const { controller, world, persistence, advance } = saveHarness({ checkInvariants: false });
    const calls: Array<{ slot: string; inTick: boolean; tick: number; hash: string }> = [];
    let inTick = false;
    const tick = world.tick.bind(world);
    world.tick = () => {
      inTick = true;
      try {
        return tick();
      } finally {
        inTick = false;
      }
    };
    const original = persistence.store.save;
    persistence.store.save = (slot, save) => {
      calls.push({ slot, inTick, tick: world.clock.tick, hash: hashWorldState(save.world) });
      original(slot, save);
    };
    const perDay = world.clock.ticksPerDay;
    advance(perDay - 100);
    expect(calls).toHaveLength(0); // deň ešte nebol uzavretý
    advance(200);
    expect(calls).toHaveLength(1);
    advance(2 * perDay);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.slot === 'auto' && !call.inTick)).toBe(true);
    // Každé uloženie vzniklo hneď po frame s hranicou dňa (najviac maxTicksPerFrame tickov za ňou).
    calls.forEach((call, index) => {
      const boundary = (index + 1) * perDay;
      expect(call.tick).toBeGreaterThanOrEqual(boundary);
      expect(call.tick - boundary).toBeLessThan(64);
    });
    expect(controller.getState().slots.map((slot) => slot.slot)).toEqual(['auto']);
  });

  it('uložený autosave sa dá načítať a svet má rovnaký stateHash ako v okamihu uloženia', () => {
    const { controller, world, advance, loaded, persistence } = saveHarness({ checkInvariants: false });
    let savedHash = '';
    const original = persistence.store.save;
    persistence.store.save = (slot, save) => {
      savedHash = hashWorldState(save.world);
      original(slot, save);
    };
    advance(world.clock.ticksPerDay + 5);
    expect(savedHash).not.toBe('');
    advance(300); // hra beží ďalej, živý svet sa od uloženia líši
    expect(stateHash(world)).not.toBe(savedHash);
    expect(controller.load('auto')).toEqual({ ok: true });
    expect(loaded).toHaveLength(1);
    expect(stateHash(loaded[0] as World)).toBe(savedHash);
  });

  it('po bankrote sa neukladá (neprepíše posledné dobré uloženie)', () => {
    const base = createWorld();
    const state = JSON.parse(JSON.stringify(base.serialize())) as ReturnType<World['serialize']> & { economy: { gameOver: boolean } };
    state.economy.gameOver = true;
    const world = World.deserialize(base.defs, base.map, state);
    expect(world.gameOver).toBe(true);
    const storage = new FakeStorage();
    const bridge = new SimBridge(world);
    const toasts: unknown[] = [];
    const controller = new SaveController({
      bridge,
      persistence: createPersistence(() => storage),
      notify: (spec) => toasts.push(spec),
    });
    controller.handleEvents([{ type: 'DayClosed', tick: world.clock.ticksPerDay }]);
    expect(storage.data.size).toBe(0);
    expect(toasts).toEqual([]);
  });

  it('zlyhanie autosave → toast „Automatické uloženie zlyhalo“ s dôvodom, bez výnimky', () => {
    const { controller, world, storage, toasts } = saveHarness();
    storage.quotaChars = 10;
    expect(() => {
      controller.handleEvents([day(world.clock.ticksPerDay)]);
    }).not.toThrow();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ tone: 'danger', title: AUTOSAVE_FAILED_TOAST_TITLE });
    expect(toasts[0]?.text).toMatch(/plné/);
  });

  it('po dispose sa autosave ani odber UI nevolajú', () => {
    const { controller, world, storage } = saveHarness();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.dispose();
    controller.handleEvents([day(world.clock.ticksPerDay)]);
    expect(storage.data.size).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('načítanie', () => {
  it('load(slot) obnoví svet s rovnakým stateHash a odovzdá ho loadWorld; živý svet sa nemení', () => {
    const { controller, world, advance, loaded } = saveHarness({ checkInvariants: false });
    advance(1500);
    controller.save('1');
    const savedHash = stateHash(world);
    advance(200);
    const liveHash = stateHash(world);
    expect(liveHash).not.toBe(savedHash);
    expect(controller.load('1')).toEqual({ ok: true });
    expect(loaded).toHaveLength(1);
    const restored = loaded[0] as World;
    expect(restored).not.toBe(world);
    expect(stateHash(restored)).toBe(savedHash);
    expect(restored.clock.tick).toBeGreaterThanOrEqual(1500);
    expect(stateHash(world)).toBe(liveHash);
  });

  it('obnovený svet pokračuje rovnako ako nepretržitý (hash po ďalších tickoch)', () => {
    const { controller, world, advance, loaded } = saveHarness({ checkInvariants: false });
    advance(700);
    const twin = World.deserialize(world.defs, world.map, JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>);
    controller.save('1');
    controller.load('1');
    const restored = loaded[0] as World;
    for (let i = 0; i < 500; i += 1) {
      restored.tick();
      twin.tick();
    }
    expect(stateHash(restored)).toBe(stateHash(twin));
  });

  it('prázdny slot → toast „Načítanie zlyhalo“, loadWorld sa nevolá', () => {
    const { controller, loaded, toasts } = saveHarness();
    const result = controller.load('3');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Slot 3 je prázdny/);
    expect(loaded).toEqual([]);
    expect(toasts[0]).toMatchObject({ tone: 'danger', title: LOAD_FAILED_TOAST_TITLE });
  });

  it('poškodený slot (neplatný JSON) → dôvod v toaste, loadWorld sa nevolá', () => {
    const { controller, storage, loaded, toasts } = saveHarness();
    storage.data.set('mh.save.1', '{"format": ');
    const result = controller.load('1');
    expect(result.ok).toBe(false);
    expect(loaded).toEqual([]);
    expect(toasts[0]?.text).toMatch(/poškodené/);
  });

  it('platná obálka s poškodeným svetom → WorldStateError s cestou, svet nezmenený', () => {
    const { controller, world, storage, loaded, toasts } = saveHarness();
    controller.save('1');
    const before = stateHash(world);
    const envelope = JSON.parse(storage.data.get('mh.save.1') ?? '') as { world: { cashCents: unknown } };
    envelope.world.cashCents = 'veľa';
    storage.data.set('mh.save.1', JSON.stringify(envelope));
    const result = controller.load('1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Stav hry je neplatný \(\/cashCents\)/);
    expect(loaded).toEqual([]);
    expect(stateHash(world)).toBe(before);
    expect(toasts[toasts.length - 1]?.title).toBe(LOAD_FAILED_TOAST_TITLE);
  });

  it('uloženie z inej mapy → zrozumiteľná chyba, svet nezmenený', () => {
    const { controller, world, storage, loaded } = saveHarness();
    controller.save('1');
    const envelope = JSON.parse(storage.data.get('mh.save.1') ?? '') as { world: { mapId: string } };
    envelope.world.mapId = 'iná_mapa';
    storage.data.set('mh.save.1', JSON.stringify(envelope));
    const before = stateHash(world);
    const result = controller.load('1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/mapId/);
    expect(loaded).toEqual([]);
    expect(stateHash(world)).toBe(before);
  });

  it('bez loadWorld (samostatný bootstrap) → chyba s vysvetlením, nie výnimka', () => {
    const { controller, toasts } = saveHarness({ withoutLoadWorld: true });
    controller.save('1');
    const result = controller.load('1');
    expect(result.ok).toBe(false);
    expect(toasts[toasts.length - 1]?.text).toMatch(/nie je v tomto režime dostupné/);
  });

  it('nedostupné úložisko pri načítaní → toast, nie výnimka', () => {
    const persistence = createPersistence(() => {
      throw new Error('SecurityError');
    });
    const { controller, loaded, toasts } = saveHarness({ persistence });
    expect(controller.load('1').ok).toBe(false);
    expect(loaded).toEqual([]);
    expect(toasts[0]?.text).toMatch(/nie je dostupné/);
  });
});

describe('export', () => {
  it('bez slotu exportuje rozohranú hru: modular-harbor-<deň>-current.json s dekódovateľnou obálkou', async () => {
    const { controller, world, downloads, toasts } = saveHarness({ checkInvariants: false });
    expect(controller.exportGame()).toEqual({ ok: true });
    expect(downloads.map((download) => download.fileName)).toEqual(['modular-harbor-1-current.json']);
    const exported = decodeSave(JSON.parse((await downloads[0]?.blob.text()) ?? ''));
    expect(exported.world).toEqual(world.serialize());
    expect(exported.label).toBe('Exportovaná hra');
    expect(toasts[0]).toMatchObject({ tone: 'success', title: EXPORTED_TOAST_TITLE, text: 'modular-harbor-1-current.json' });
  });

  it('názov nesie deň z hry (od 1)', () => {
    const { controller, world, downloads } = saveHarness({ checkInvariants: false });
    for (let i = 0; i < world.clock.ticksPerDay * 2; i += 1) world.tick();
    controller.exportGame();
    expect(downloads[0]?.fileName).toBe('modular-harbor-3-current.json');
  });

  it('exportGame(slot) stiahne uloženú obálku slotu', async () => {
    const { controller, world, downloads } = saveHarness({ checkInvariants: false });
    controller.save('2');
    for (let i = 0; i < world.clock.ticksPerDay; i += 1) world.tick(); // živá hra je už o deň ďalej
    expect(controller.exportGame('2')).toEqual({ ok: true });
    expect(downloads[0]?.fileName).toBe('modular-harbor-1-2.json');
    const exported = decodeSave(JSON.parse((await downloads[0]?.blob.text()) ?? ''));
    expect(exported.world.clock.tick).toBe(0);
  });

  it('prázdny slot → toast „Export zlyhal“', () => {
    const { controller, downloads, toasts } = saveHarness();
    const result = controller.exportGame('3');
    expect(result.ok).toBe(false);
    expect(downloads).toEqual([]);
    expect(toasts[0]).toMatchObject({ tone: 'danger', title: EXPORT_FAILED_TOAST_TITLE });
  });
});

describe('import', () => {
  it('platný exportovaný súbor → svet s rovnakým stateHash odovzdaný loadWorld', async () => {
    const { controller, world, advance, downloads, loaded } = saveHarness({ checkInvariants: false });
    advance(1200);
    controller.exportGame();
    const exportedHash = stateHash(world);
    const text = await downloads[0]?.blob.text();
    const result = await controller.importFile(asFile(text ?? ''));
    expect(result).toEqual({ ok: true });
    expect(stateHash(loaded[0] as World)).toBe(exportedHash);
  });

  const bad: ReadonlyArray<readonly [string, () => unknown, RegExp]> = [
    ['text, ktorý nie je JSON', () => 'toto nie je save', /nie je platný JSON/],
    ['prázdny súbor', () => '', /nie je platný JSON/],
    ['JSON bez formátu', () => ({ hello: 'world' }), /Nie je to uložená hra/],
    ['pole', () => [], /objekt JSON/],
    ['iná verzia obálky', () => ({ format: 'modular-harbor-save', saveVersion: 5 }), /saveVersion 5/],
    ['chýba svet', () => ({ format: 'modular-harbor-save', saveVersion: 1, gameVersion: '1', savedAtIso: FIXED_NOW, label: 'x', preview: { day: 0, timeLabel: 'x', cashCents: 0, xp: 0 } }), /chýba stav sveta/],
  ];

  it.each(bad)('chybný súbor (%s) → toast s dôvodom, loadWorld sa nevolá, svet nezmenený', async (_name, make, message) => {
    const { controller, world, loaded, toasts } = saveHarness();
    const before = stateHash(world);
    const result = await controller.importFile(asFile(make() as string));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
    expect(loaded).toEqual([]);
    expect(stateHash(world)).toBe(before);
    expect(world.pendingCommandCount).toBe(0);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ tone: 'danger', title: IMPORT_FAILED_TOAST_TITLE });
    expect(toasts[0]?.text).toMatch(message);
  });

  it('platná obálka s poškodeným svetom → chyba s cestou, svet nezmenený', async () => {
    const { controller, world, loaded, toasts } = saveHarness();
    const save = JSON.parse(JSON.stringify(controllerSave(world))) as { world: { clock: { tick: unknown } } };
    save.world.clock.tick = -5;
    const before = stateHash(world);
    const result = await controller.importFile(asFile(save));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Stav hry je neplatný \(\/clock/);
    expect(loaded).toEqual([]);
    expect(stateHash(world)).toBe(before);
    expect(toasts[0]?.title).toBe(IMPORT_FAILED_TOAST_TITLE);
  });

  it('po dispose (hra sa medzitým reštartovala) sa import nenačíta', async () => {
    const { controller, world, loaded } = saveHarness();
    const text = JSON.stringify(controllerSave(world));
    const pending = controller.importFile(asFile(text));
    controller.dispose();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(loaded).toEqual([]);
  });
});

/** Obálka z `World` bez úložiska (pre súbory importu). */
function controllerSave(world: World): SaveGame {
  return {
    format: 'modular-harbor-save',
    saveVersion: 1,
    gameVersion: '0.0.0',
    savedAtIso: FIXED_NOW,
    label: 'x',
    preview: { day: 0, timeLabel: 'Deň 1 · 00:00', cashCents: world.cashCents, xp: 0 },
    world: world.serialize(),
  };
}

describe('sloty a nastavenia', () => {
  it('remove zmaže slot a obnoví zoznam', () => {
    const { controller, storage } = saveHarness();
    controller.save('1');
    controller.save('2');
    expect(controller.remove('1')).toEqual({ ok: true });
    expect(storage.data.has('mh.save.1')).toBe(false);
    expect(controller.getState().slots.map((slot) => slot.slot)).toEqual(['2']);
  });

  it('remove pri nedostupnom úložisku → toast, nie výnimka', () => {
    const persistence = createPersistence(() => {
      throw new Error('SecurityError');
    });
    const { controller, toasts } = saveHarness({ persistence });
    expect(controller.remove('1').ok).toBe(false);
    expect(toasts[0]).toMatchObject({ tone: 'danger', title: 'Zmazanie zlyhalo' });
  });

  it('setSettings zapíše do mh.settings, znormalizuje a upozorní odberateľov', () => {
    const { controller, storage } = saveHarness();
    const listener = vi.fn();
    controller.subscribe(listener);
    expect(controller.setSettings({ settingsVersion: 1, defaultSpeed: 4, autosaveEveryDays: 5, sound: false })).toEqual({ ok: true });
    expect(controller.getState().settings).toEqual({ settingsVersion: 1, defaultSpeed: 4, autosaveEveryDays: 5, sound: false });
    expect(JSON.parse(storage.data.get('mh.settings') ?? '')).toEqual(controller.getState().settings);
    expect(listener).toHaveBeenCalledTimes(1);
    controller.setSettings({ settingsVersion: 1, defaultSpeed: 123 as never, autosaveEveryDays: -4, sound: false });
    expect(controller.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('zápis nastavení zlyhá → platia v pamäti, toast s dôvodom', () => {
    const { controller, storage, toasts } = saveHarness();
    storage.quotaChars = 5;
    const result = controller.setSettings({ ...DEFAULT_SETTINGS, defaultSpeed: 8 });
    expect(result.ok).toBe(false);
    expect(controller.getState().settings.defaultSpeed).toBe(8);
    expect(toasts[0]).toMatchObject({ tone: 'warning', title: SETTINGS_FAILED_TOAST_TITLE });
    expect(toasts[0]?.text).toMatch(/plné.*len do zatvorenia hry/);
  });

  it('nastavenia sa zdieľajú medzi hrami cez PersistenceServices (nová hra ich vidí)', () => {
    const first = saveHarness();
    first.controller.setSettings({ ...DEFAULT_SETTINGS, defaultSpeed: 2 });
    const second = new SaveController({
      bridge: createApp().bridge,
      persistence: first.persistence,
      notify: () => undefined,
    });
    expect(second.getState().settings.defaultSpeed).toBe(2);
  });
});

describe('describeError', () => {
  it('WorldStateError s cestou a koreňom', () => {
    expect(describeError(new WorldStateError('/economy/gameOver', 'musí byť boolean'))).toBe('Stav hry je neplatný (/economy/gameOver): musí byť boolean');
    expect(describeError(new WorldStateError('', 'verzia'))).toBe('Stav hry je neplatný (celý stav): verzia');
  });

  it('obyčajná Error a ne-Error hodnoty', () => {
    expect(describeError(new Error('zle'))).toBe('zle');
    expect(describeError('text')).toBe('text');
  });
});
