// ADR-036 (clean break savov): save so svetom staršej verzie (v1–v9) sa nenačíta — slot, import súboru aj automatické uloženie;
// bežiaca hra sa nezmení, hráč dostane presne jednu hlášku a slot sa v zozname označí ako nekompatibilný.
import { describe, expect, it } from 'vitest';
import { UnsupportedSaveVersionError, WORLD_STATE_VERSION, stateHash } from '@sim/world';
import {
  IMPORT_FAILED_TOAST_TITLE,
  LOAD_FAILED_TOAST_TITLE,
  describeError,
} from '@app/save/save-controller';
import { OLD_WORLD_VERSION_MESSAGE, SAVE_FORMAT, SAVE_VERSION, decodeSave, isWorldVersionOlder, isWorldVersionSupported } from '@app/save/save-game';
import { createSaveStore } from '@app/save/save-store';
import { FIXED_NOW, saveHarness } from './save-fixtures';

const EXPECTED_MESSAGE = 'Uložená hra je zo staršej verzie a s novým terminálom sa nedá načítať.';

/** Obálka v1 so svetom starej verzie (stačí tvar ako v tej dobe: bez kľúčov dnešného stavu). */
function oldEnvelope(worldVersion: number): Record<string, unknown> {
  return {
    format: SAVE_FORMAT,
    saveVersion: SAVE_VERSION,
    gameVersion: '0.0.0',
    savedAtIso: FIXED_NOW,
    label: 'Starý save',
    preview: { day: 3, timeLabel: '08:00', cashCents: 1_000_000, xp: 10 },
    world: { version: worldVersion, mapId: 'harbor_01', seed: 1, cashCents: 1_000_000 },
  };
}

describe('hláška a konštanty', () => {
  it('text hlášky je presne daný', () => {
    expect(OLD_WORLD_VERSION_MESSAGE).toBe(EXPECTED_MESSAGE);
  });

  it('obálka so starým svetom prejde decodeSave (obálka v1 ostáva), ale nie je podporovaná a je „staršia“', () => {
    const save = decodeSave(oldEnvelope(9));
    expect(isWorldVersionSupported(save)).toBe(false);
    expect(isWorldVersionOlder(save)).toBe(true);
    const newer = decodeSave(oldEnvelope(WORLD_STATE_VERSION + 1));
    expect(isWorldVersionSupported(newer)).toBe(false);
    expect(isWorldVersionOlder(newer)).toBe(false);
    const current = decodeSave(oldEnvelope(WORLD_STATE_VERSION));
    expect(isWorldVersionSupported(current)).toBe(true);
  });

  it('describeError: UnsupportedSaveVersionError staršej verzie = hláška; novšej verzie ostáva technická chyba s cestou', () => {
    expect(describeError(new UnsupportedSaveVersionError(9))).toBe(EXPECTED_MESSAGE);
    expect(describeError(new UnsupportedSaveVersionError(WORLD_STATE_VERSION + 1))).toMatch(/Stav hry je neplatný \(\/version\)/);
  });
});

describe('zoznam slotov', () => {
  it('slot so starým svetom má príznak incompatible, aktuálny slot ho nemá (kľúč chýba)', () => {
    const { controller, storage } = saveHarness();
    storage.data.set('mh.save.2', JSON.stringify(oldEnvelope(5)));
    storage.data.set('mh.save.auto', JSON.stringify(oldEnvelope(9)));
    controller.save('1');
    const slots = controller.getState().slots;
    expect(slots.map((info) => [info.slot, info.incompatible])).toEqual([
      ['auto', true],
      ['1', undefined],
      ['2', true],
    ]);
    expect(slots.find((info) => info.slot === '1')).not.toHaveProperty('incompatible');
    expect(createSaveStore(() => storage).list().filter((info) => info.incompatible === true)).toHaveLength(2);
  });
});

describe('načítanie starého savu nezmení hru', () => {
  it.each(['1', 'auto'] as const)('slot %s: výsledok aj toast majú presnú hlášku, loadWorld sa nevolá, svet ostane', (slot) => {
    const { controller, world, storage, loaded, toasts } = saveHarness();
    storage.data.set(`mh.save.${slot}`, JSON.stringify(oldEnvelope(9)));
    const before = stateHash(world);
    const result = controller.load(slot);
    expect(result).toEqual({ ok: false, message: EXPECTED_MESSAGE });
    expect(loaded).toEqual([]);
    expect(stateHash(world)).toBe(before);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ tone: 'danger', title: LOAD_FAILED_TOAST_TITLE, text: EXPECTED_MESSAGE });
  });

  it.each([1, 2, 5, 8])('import súboru so svetom v%i: hláška, svet nezmenený', async (version) => {
    const { controller, world, loaded, toasts } = saveHarness();
    const before = stateHash(world);
    const result = await controller.importFile(new Blob([JSON.stringify(oldEnvelope(version))]));
    expect(result).toEqual({ ok: false, message: EXPECTED_MESSAGE });
    expect(loaded).toEqual([]);
    expect(stateHash(world)).toBe(before);
    expect(toasts[0]).toMatchObject({ title: IMPORT_FAILED_TOAST_TITLE, text: EXPECTED_MESSAGE });
  });

  it('aktuálny save sa načíta ďalej (starý nezablokoval ostatné)', () => {
    const { controller, world, storage, loaded } = saveHarness();
    storage.data.set('mh.save.2', JSON.stringify(oldEnvelope(9)));
    controller.save('1');
    expect(controller.load('2').ok).toBe(false);
    expect(controller.load('1').ok).toBe(true);
    expect(loaded).toHaveLength(1);
    expect(stateHash(loaded[0])).toBe(stateHash(world));
  });
});
