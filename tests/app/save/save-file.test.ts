// T06-03: export a import súboru savu — názov, obsah Blobu, chybné súbory (SaveError s dôvodom).
import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_BYTES, exportSaveFile, readSaveFile, saveFileName } from '@app/save/save-file';
import { SaveError, decodeSave, encodeSave } from '@app/save/save-game';
import { createWorld } from '../app-fixtures';
import { FIXED_NOW, type Download } from './save-fixtures';

async function readReason(file: Parameters<typeof readSaveFile>[0]): Promise<SaveError> {
  try {
    await readSaveFile(file);
  } catch (error) {
    if (error instanceof SaveError) return error;
    throw error;
  }
  throw new Error('očakávala sa SaveError');
}

describe('saveFileName', () => {
  it('modular-harbor-<deň>-<slot>.json', () => {
    expect(saveFileName(12, '1')).toBe('modular-harbor-12-1.json');
    expect(saveFileName(3, 'auto')).toBe('modular-harbor-3-auto.json');
    expect(saveFileName(1, 'current')).toBe('modular-harbor-1-current.json');
  });
});

describe('exportSaveFile', () => {
  it('stiahne JSON obálky ako Blob s názvom podľa dňa (od 1) a slotu', async () => {
    const world = createWorld();
    for (let i = 0; i < world.clock.ticksPerDay * 2; i += 1) world.tick(); // deň 3
    const save = encodeSave(world, 'x', FIXED_NOW);
    const downloads: Download[] = [];
    const name = exportSaveFile(save, '2', {
      download: (fileName, blob) => {
        downloads.push({ fileName, blob });
      },
    });
    expect(name).toBe('modular-harbor-3-2.json');
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.fileName).toBe(name);
    expect(downloads[0]?.blob.type).toBe('application/json');
    const text = await downloads[0]?.blob.text();
    expect(decodeSave(JSON.parse(text ?? ''))).toEqual(save);
  });
});

describe('readSaveFile', () => {
  const file = (text: string) => new Blob([text], { type: 'application/json' });

  it('platný súbor → obálka rovnaká ako exportovaná', async () => {
    const save = encodeSave(createWorld(), 'x', FIXED_NOW);
    expect(await readSaveFile(file(JSON.stringify(save)))).toEqual(save);
  });

  it('text, ktorý nie je JSON → json', async () => {
    const error = await readReason(file('toto nie je json'));
    expect(error.reason).toBe('json');
    expect(error.message).toMatch(/nie je platný JSON/);
  });

  it('prázdny súbor → json', async () => {
    expect((await readReason(file(''))).reason).toBe('json');
  });

  it('JSON, ktorý nie je save → format; iná verzia obálky → version', async () => {
    expect((await readReason(file('{}'))).reason).toBe('format');
    expect((await readReason(file('[1,2]'))).reason).toBe('not_object');
    const save = JSON.parse(JSON.stringify(encodeSave(createWorld(), 'x', FIXED_NOW))) as Record<string, unknown>;
    expect((await readReason(file(JSON.stringify({ ...save, saveVersion: 9 })))).reason).toBe('version');
  });

  it('príliš veľký súbor sa nečíta → too_large', async () => {
    let read = false;
    const error = await readReason({
      size: MAX_IMPORT_BYTES + 1,
      text: () => {
        read = true;
        return Promise.resolve('{}');
      },
    });
    expect(error.reason).toBe('too_large');
    expect(read).toBe(false);
  });

  it('súbor sa nedá prečítať → read', async () => {
    const error = await readReason({ size: 10, text: () => Promise.reject(new Error('NotReadableError')) });
    expect(error.reason).toBe('read');
    expect(error.message).toMatch(/nepodarilo prečítať/);
  });
});
