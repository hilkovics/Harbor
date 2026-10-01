// T06-03: úložisko slotov nad falošným localStorage — plné, nedostupné, poškodený JSON; nikdy surová výnimka prehliadača.
import { describe, expect, it } from 'vitest';
import { SAVE_KEY_PREFIX, createSaveStore, saveKey, type SaveStore } from '@app/save/save-store';
import { SAVE_SLOT_IDS, encodeSave, type SaveGame } from '@app/save/save-game';
import { StorageError } from '@app/save/storage';
import { createWorld } from '../app-fixtures';
import { FIXED_NOW, FakeStorage } from './save-fixtures';

function makeSave(label: string, ticks = 0): SaveGame {
  const world = createWorld();
  for (let i = 0; i < ticks; i += 1) world.tick();
  return encodeSave(world, label, FIXED_NOW);
}

function storeOver(storage: FakeStorage): SaveStore {
  return createSaveStore(() => storage);
}

function catchError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('kľúče', () => {
  it('mh.save.auto a mh.save.1 … mh.save.3', () => {
    expect(SAVE_KEY_PREFIX).toBe('mh.save.');
    expect(SAVE_SLOT_IDS.map(saveKey)).toEqual(['mh.save.auto', 'mh.save.1', 'mh.save.2', 'mh.save.3']);
  });
});

describe('save / load / remove', () => {
  it('zapíše JSON obálky pod kľúč slotu a načíta ju späť rovnakú', () => {
    const storage = new FakeStorage();
    const store = storeOver(storage);
    const save = makeSave('Ručné uloženie', 50);
    store.save('2', save);
    expect([...storage.data.keys()]).toEqual(['mh.save.2']);
    expect(JSON.parse(storage.data.get('mh.save.2') ?? '')).toEqual(JSON.parse(JSON.stringify(save)));
    expect(store.load('2')).toEqual(save);
  });

  it('prázdny slot → load vráti null', () => {
    expect(storeOver(new FakeStorage()).load('3')).toBeNull();
  });

  it('save prepíše obsah slotu, ostatné sloty nechá', () => {
    const storage = new FakeStorage();
    const store = storeOver(storage);
    store.save('1', makeSave('prvé'));
    store.save('2', makeSave('druhé'));
    store.save('1', makeSave('tretie'));
    expect(store.load('1')?.label).toBe('tretie');
    expect(store.load('2')?.label).toBe('druhé');
  });

  it('remove zmaže slot; mazanie prázdneho slotu je v poriadku', () => {
    const storage = new FakeStorage();
    const store = storeOver(storage);
    store.save('1', makeSave('x'));
    store.remove('1');
    expect(store.load('1')).toBeNull();
    expect(storage.data.size).toBe(0);
    expect(() => {
      store.remove('3');
    }).not.toThrow();
  });
});

describe('list', () => {
  it('obsadené sloty v poradí auto, 1, 2, 3 s údajmi z obálky (bez sveta)', () => {
    const store = storeOver(new FakeStorage());
    store.save('3', makeSave('tri'));
    store.save('auto', makeSave('auto', 20));
    store.save('1', makeSave('jedna'));
    const infos = store.list();
    expect(infos.map((info) => info.slot)).toEqual(['auto', '1', '3']);
    expect(infos[0]).toEqual({
      slot: 'auto',
      label: 'auto',
      savedAtIso: FIXED_NOW,
      preview: expect.objectContaining({ day: 0, timeLabel: 'Deň 1 · 00:03' }) as unknown,
    });
    expect(Object.keys(infos[0] ?? {}).sort()).toEqual(['label', 'preview', 'savedAtIso', 'slot']);
  });

  it('prázdne úložisko → prázdny zoznam; cudzie kľúče sa ignorujú', () => {
    const storage = new FakeStorage();
    storage.data.set('mh.settings', '{}');
    storage.data.set('mh.save.9', 'x');
    expect(storeOver(storage).list()).toEqual([]);
  });

  it('poškodený JSON alebo obálka vynechá len ten slot; ostatné ostanú', () => {
    const storage = new FakeStorage();
    const store = storeOver(storage);
    store.save('1', makeSave('dobré'));
    storage.data.set('mh.save.2', '{"format": "modular-harbor-save", ');
    storage.data.set('mh.save.3', JSON.stringify({ format: 'iná-hra' }));
    expect(store.list().map((info) => info.slot)).toEqual(['1']);
  });

  it('nedostupné úložisko (provider vyhodí) → prázdny zoznam, nevyhodí', () => {
    const store = createSaveStore(() => {
      throw new Error('SecurityError');
    });
    expect(store.list()).toEqual([]);
  });

  it('chyba čítania → prázdny zoznam, nevyhodí', () => {
    const storage = new FakeStorage();
    const store = storeOver(storage);
    store.save('1', makeSave('x'));
    storage.failReads = true;
    expect(store.list()).toEqual([]);
  });
});

describe('chyby úložiska (StorageError s dôvodom, nikdy surová výnimka)', () => {
  it('plné úložisko → quota; pôvodné uloženie ostane nedotknuté', () => {
    const storage = new FakeStorage();
    const store = storeOver(storage);
    const first = makeSave('prvé');
    store.save('1', first);
    storage.quotaChars = 100;
    const error = catchError(() => {
      store.save('1', makeSave('druhé', 10));
    });
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).reason).toBe('quota');
    expect((error as StorageError).message).toMatch(/plné/);
    storage.quotaChars = Number.POSITIVE_INFINITY;
    expect(store.load('1')).toEqual(first);
  });

  it('úložisko nie je dostupné → unavailable pre save, load aj remove', () => {
    const store = createSaveStore(() => {
      throw new Error('SecurityError');
    });
    for (const action of [
      () => {
        store.save('1', makeSave('x'));
      },
      () => store.load('1'),
      () => {
        store.remove('1');
      },
    ]) {
      const error = catchError(action);
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).reason).toBe('unavailable');
      expect((error as StorageError).message).toMatch(/nie je dostupné/);
    }
  });

  it('chyba čítania pri load → failed', () => {
    const storage = new FakeStorage();
    storage.failReads = true;
    const error = catchError(() => storeOver(storage).load('1'));
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).reason).toBe('failed');
  });

  it('poškodený JSON v slote → load hodí corrupt s číslom slotu', () => {
    const storage = new FakeStorage();
    storage.data.set('mh.save.2', 'toto nie je json');
    const error = catchError(() => storeOver(storage).load('2'));
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).reason).toBe('corrupt');
    expect((error as StorageError).message).toMatch(/slot 2/);
  });

  it('platný JSON, ale nie obálka → corrupt s dôvodom z decodeSave', () => {
    const storage = new FakeStorage();
    storage.data.set('mh.save.1', JSON.stringify({ format: 'modular-harbor-save', saveVersion: 7 }));
    const error = catchError(() => storeOver(storage).load('1'));
    expect((error as StorageError).reason).toBe('corrupt');
    expect((error as StorageError).message).toMatch(/saveVersion 7/);
  });
});
