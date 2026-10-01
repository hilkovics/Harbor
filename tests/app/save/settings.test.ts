// T06-03: nastavenia (mh.settings) — predvolené hodnoty, validácia po poliach, zápis a zlyhanie úložiska.
import { describe, expect, it } from 'vitest';
import timeJson from '@data/defs/time.json';
import {
  DEFAULT_SETTINGS,
  MAX_AUTOSAVE_EVERY_DAYS,
  SETTINGS_KEY,
  SETTINGS_SPEEDS,
  createSettingsStore,
  loadSettings,
  normalizeSettings,
  saveSettings,
  type Settings,
} from '@app/settings';
import { StorageError } from '@app/save/storage';
import { FakeStorage } from './save-fixtures';

const provide = (storage: FakeStorage) => () => storage;

describe('predvolené hodnoty', () => {
  it('rýchlosť 1×, autosave každý deň, bez zvuku', () => {
    expect(DEFAULT_SETTINGS).toEqual({ settingsVersion: 1, defaultSpeed: 1, autosaveEveryDays: 1, sound: false });
    expect(SETTINGS_KEY).toBe('mh.settings');
  });

  it('SETTINGS_SPEEDS sa zhoduje s time.speeds (jediný zdroj pravdy je def)', () => {
    expect([...SETTINGS_SPEEDS]).toEqual(timeJson.speeds);
  });
});

describe('normalizeSettings', () => {
  it('platné nastavenia prejdú nezmenené', () => {
    const settings: Settings = { settingsVersion: 1, defaultSpeed: 4, autosaveEveryDays: 3, sound: false };
    expect(normalizeSettings(settings)).toEqual(settings);
  });

  it('0 dní = autosave vypnutý je platné; pauza ako predvolená rýchlosť tiež', () => {
    expect(normalizeSettings({ settingsVersion: 1, defaultSpeed: 0, autosaveEveryDays: 0, sound: false })).toEqual({
      settingsVersion: 1,
      defaultSpeed: 0,
      autosaveEveryDays: 0,
      sound: false,
    });
  });

  it.each([null, undefined, 5, 'x', [], true])('hodnota %j nie je objekt → predvolené', (raw) => {
    expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('iná alebo chýbajúca settingsVersion → všetko predvolené', () => {
    expect(normalizeSettings({ settingsVersion: 2, defaultSpeed: 8, autosaveEveryDays: 5 })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ defaultSpeed: 8, autosaveEveryDays: 5 })).toEqual(DEFAULT_SETTINGS);
  });

  it('neplatné polia sa nahradia po jednom, platné ostanú', () => {
    expect(normalizeSettings({ settingsVersion: 1, defaultSpeed: 3, autosaveEveryDays: 5 })).toEqual({ ...DEFAULT_SETTINGS, autosaveEveryDays: 5 });
    expect(normalizeSettings({ settingsVersion: 1, defaultSpeed: 8, autosaveEveryDays: -1 })).toEqual({ ...DEFAULT_SETTINGS, defaultSpeed: 8 });
    expect(normalizeSettings({ settingsVersion: 1, defaultSpeed: '2', autosaveEveryDays: 1.5 })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ settingsVersion: 1, defaultSpeed: 2, autosaveEveryDays: MAX_AUTOSAVE_EVERY_DAYS + 1 })).toEqual({ ...DEFAULT_SETTINGS, defaultSpeed: 2 });
    expect(normalizeSettings({ settingsVersion: 1, defaultSpeed: 2, autosaveEveryDays: Number.NaN })).toEqual({ ...DEFAULT_SETTINGS, defaultSpeed: 2 });
  });

  it('sound je vždy false; neznáme polia sa zahodia', () => {
    const result = normalizeSettings({ settingsVersion: 1, defaultSpeed: 2, autosaveEveryDays: 2, sound: true, theme: 'dark' });
    expect(result).toEqual({ settingsVersion: 1, defaultSpeed: 2, autosaveEveryDays: 2, sound: false });
  });
});

describe('loadSettings / saveSettings', () => {
  it('prázdne úložisko → predvolené', () => {
    expect(loadSettings(provide(new FakeStorage()))).toEqual(DEFAULT_SETTINGS);
  });

  it('roundtrip cez úložisko', () => {
    const storage = new FakeStorage();
    const settings: Settings = { settingsVersion: 1, defaultSpeed: 2, autosaveEveryDays: 7, sound: false };
    saveSettings(settings, provide(storage));
    expect(JSON.parse(storage.data.get('mh.settings') ?? '')).toEqual(settings);
    expect(loadSettings(provide(storage))).toEqual(settings);
  });

  it('poškodený JSON → predvolené (nevyhodí)', () => {
    const storage = new FakeStorage();
    storage.data.set('mh.settings', '{nie json');
    expect(loadSettings(provide(storage))).toEqual(DEFAULT_SETTINGS);
  });

  it('nedostupné úložisko alebo chyba čítania → predvolené (nevyhodí)', () => {
    expect(
      loadSettings(() => {
        throw new Error('SecurityError');
      }),
    ).toEqual(DEFAULT_SETTINGS);
    const storage = new FakeStorage();
    storage.failReads = true;
    expect(loadSettings(provide(storage))).toEqual(DEFAULT_SETTINGS);
  });

  it('saveSettings pri plnom úložisku hodí StorageError quota', () => {
    const storage = new FakeStorage();
    storage.quotaChars = 5;
    expect(() => {
      saveSettings(DEFAULT_SETTINGS, provide(storage));
    }).toThrow(StorageError);
  });
});

describe('createSettingsStore', () => {
  it('get načíta uložené nastavenia pri vzniku', () => {
    const storage = new FakeStorage();
    saveSettings({ settingsVersion: 1, defaultSpeed: 8, autosaveEveryDays: 0, sound: false }, provide(storage));
    expect(createSettingsStore(provide(storage)).get()).toEqual({ settingsVersion: 1, defaultSpeed: 8, autosaveEveryDays: 0, sound: false });
  });

  it('set znormalizuje, zapíše a ďalší store nad rovnakým úložiskom ich vidí', () => {
    const storage = new FakeStorage();
    const store = createSettingsStore(provide(storage));
    const result = store.set({ settingsVersion: 1, defaultSpeed: 99 as never, autosaveEveryDays: 2, sound: false });
    expect(result).toEqual({ ok: true });
    expect(store.get()).toEqual({ settingsVersion: 1, defaultSpeed: 1, autosaveEveryDays: 2, sound: false });
    expect(createSettingsStore(provide(storage)).get()).toEqual(store.get());
  });

  it('zápis zlyhá (plné) → výsledok s chybou, nastavenia platia v pamäti', () => {
    const storage = new FakeStorage();
    storage.quotaChars = 5;
    const store = createSettingsStore(provide(storage));
    const result = store.set({ settingsVersion: 1, defaultSpeed: 4, autosaveEveryDays: 3, sound: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('quota');
    expect(store.get().defaultSpeed).toBe(4);
    expect(storage.data.size).toBe(0);
  });

  it('nedostupné úložisko → predvolené a set vráti unavailable (bez výnimky)', () => {
    const store = createSettingsStore(() => {
      throw new Error('SecurityError');
    });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const result = store.set({ ...DEFAULT_SETTINGS, autosaveEveryDays: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('unavailable');
    expect(store.get().autosaveEveryDays).toBe(5);
  });
});
