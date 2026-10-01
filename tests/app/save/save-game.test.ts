// T06-03: obálka SaveGame v1 — encode/decode roundtrip, preview, verzie a chybné vstupy (SaveError s dôvodom).
import { describe, expect, it } from 'vitest';
import { SetGameSpeedCommand } from '@sim/commands';
import { GAME_VERSION } from '@app/config';
import { SAVE_FORMAT, SAVE_SLOT_IDS, SAVE_VERSION, SaveError, decodeSave, encodeSave, isSaveSlotId, type SaveErrorReason } from '@app/save/save-game';
import { formatClock, formatGameTime } from '@ui/format';
import { previewTimeText } from '@ui/save-load-panel';
import { version as packageVersion } from '../../../package.json';
import { createWorld } from '../app-fixtures';

const NOW = '2026-10-01T08:30:00.000Z';

describe('encodeSave', () => {
  it('zloží obálku z živého sveta: formát, verzie, čas uloženia a štítok', () => {
    const world = createWorld();
    const save = encodeSave(world, 'Ručné uloženie', NOW);
    expect(save.format).toBe(SAVE_FORMAT);
    expect(save.format).toBe('modular-harbor-save');
    expect(save.saveVersion).toBe(SAVE_VERSION);
    expect(save.saveVersion).toBe(1);
    expect(save.gameVersion).toBe(packageVersion);
    expect(GAME_VERSION).toBe(packageVersion);
    expect(save.savedAtIso).toBe(NOW);
    expect(save.label).toBe('Ručné uloženie');
  });

  it('world je presne serialize() sveta; version, seed a tick žijú len vo world (nie v obálke)', () => {
    const world = createWorld();
    for (let i = 0; i < 25; i += 1) world.tick();
    const save = encodeSave(world, 'x', NOW);
    expect(save.world).toEqual(world.serialize());
    expect(save.world.clock.tick).toBe(25);
    expect(Object.keys(save).sort()).toEqual(['format', 'gameVersion', 'label', 'preview', 'saveVersion', 'savedAtIso', 'world']);
  });

  it('preview: deň (0-based), čas dňa HH:MM zvlášť, hotovosť a XP', () => {
    const world = createWorld();
    expect(encodeSave(world, 'x', NOW).preview).toEqual({ day: 0, timeLabel: '00:00', cashCents: world.cashCents, xp: 0 });
    const ticks = world.clock.ticksPerDay + world.clock.ticksPerHour * 2 + 7;
    for (let i = 0; i < ticks; i += 1) world.tick();
    const { preview } = encodeSave(world, 'x', NOW);
    expect(preview.day).toBe(1);
    expect(preview.timeLabel).toBe(formatClock(world.clock.hourOfDay, world.clock.minuteOfHour));
    expect(preview.timeLabel).toMatch(/^02:\d\d$/);
    expect(preview.cashCents).toBe(world.cashCents);
  });

  it('preview je v zhode s UI: zoznam slotov ukáže presne ten istý „Deň N · HH:MM“ ako HUD (bez zdvojeného dňa)', () => {
    const world = createWorld();
    const ticks = world.clock.ticksPerDay * 3 + world.clock.ticksPerHour * 14 + world.clock.ticksPerHour / 3;
    for (let i = 0; i < ticks; i += 1) world.tick();
    const { preview } = encodeSave(world, 'x', NOW);
    const hud = formatGameTime({ day: world.clock.gameDay, hour: world.clock.hourOfDay, minute: world.clock.minuteOfHour });
    expect(preview.day).toBe(world.clock.gameDay); // 0-based, ako `WorldSnapshot.day`
    expect(hud.startsWith('Deň 4 · 14:')).toBe(true);
    expect(previewTimeText(preview)).toBe(hud);
    expect((previewTimeText(preview).match(/Deň/g) ?? []).length).toBe(1);
  });

  it('neprázdna fronta príkazov: serialize odmietne (volajúci ju musí najprv vyprázdniť)', () => {
    const world = createWorld();
    world.enqueue(new SetGameSpeedCommand(2));
    expect(() => encodeSave(world, 'x', NOW)).toThrow(/neaplikovaných príkazov/);
    world.applyPending();
    expect(() => encodeSave(world, 'x', NOW)).not.toThrow();
  });

  it('JSON roundtrip: decodeSave(JSON.parse(JSON.stringify(save))) je rovný pôvodnej obálke', () => {
    const world = createWorld();
    for (let i = 0; i < 100; i += 1) world.tick();
    const save = encodeSave(world, 'Rýchle uloženie', NOW);
    expect(decodeSave(JSON.parse(JSON.stringify(save)))).toEqual(save);
  });
});

describe('decodeSave', () => {
  const valid = () => JSON.parse(JSON.stringify(encodeSave(createWorld(), 'x', NOW))) as Record<string, unknown>;

  it('zahodí neznáme kľúče obálky (dopredná kompatibilita)', () => {
    const raw = { ...valid(), futureField: 1 };
    expect(Object.keys(decodeSave(raw)).sort()).toEqual(['format', 'gameVersion', 'label', 'preview', 'saveVersion', 'savedAtIso', 'world']);
  });

  it('preview sa voči svetu neoveruje (nie je druhým zdrojom pravdy)', () => {
    const raw = valid();
    raw['preview'] = { day: 99, timeLabel: 'iné', cashCents: -1, xp: 5 };
    expect(decodeSave(raw).preview).toEqual({ day: 99, timeLabel: 'iné', cashCents: -1, xp: 5 });
  });

  it('obálka v1 prijme aj world staršej verzie (obsah overí World.deserialize)', () => {
    const raw = valid();
    raw['world'] = { version: 3, mapId: 'harbor_01' };
    expect(decodeSave(raw).world.version).toBe(3);
  });

  const cases: ReadonlyArray<readonly [string, (raw: Record<string, unknown>) => unknown, SaveErrorReason, RegExp]> = [
    ['null', () => null, 'not_object', /objekt JSON/],
    ['číslo', () => 42, 'not_object', /objekt JSON/],
    ['pole', () => [], 'not_object', /objekt JSON/],
    ['reťazec', () => 'save', 'not_object', /objekt JSON/],
    ['chýba format', (raw) => ({ ...raw, format: undefined }), 'format', /Nie je to uložená hra/],
    ['iný format', (raw) => ({ ...raw, format: 'iná-hra' }), 'format', /modular-harbor-save/],
    ['saveVersion 2', (raw) => ({ ...raw, saveVersion: 2 }), 'version', /saveVersion 2/],
    ['saveVersion ako reťazec', (raw) => ({ ...raw, saveVersion: '1' }), 'version', /saveVersion 1/],
    ['chýba saveVersion', (raw) => ({ ...raw, saveVersion: undefined }), 'version', /neznáma/],
    ['chýba world', (raw) => ({ ...raw, world: undefined }), 'world', /chýba stav sveta/],
    ['world null', (raw) => ({ ...raw, world: null }), 'world', /chýba stav sveta/],
    ['world je pole', (raw) => ({ ...raw, world: [] }), 'world', /chýba stav sveta/],
    ['world bez verzie', (raw) => ({ ...raw, world: { mapId: 'harbor_01' } }), 'world', /chýba stav sveta/],
    ['gameVersion nie je reťazec', (raw) => ({ ...raw, gameVersion: 1 }), 'fields', /\/gameVersion/],
    ['savedAtIso nie je reťazec', (raw) => ({ ...raw, savedAtIso: null }), 'fields', /\/savedAtIso/],
    ['label nie je reťazec', (raw) => ({ ...raw, label: 5 }), 'fields', /\/label/],
    ['chýba preview', (raw) => ({ ...raw, preview: undefined }), 'fields', /\/preview/],
    ['preview.cashCents nie je číslo', (raw) => ({ ...raw, preview: { day: 0, timeLabel: 'x', cashCents: 'veľa', xp: 0 } }), 'fields', /\/preview\/cashCents/],
    ['preview.day je NaN', (raw) => ({ ...raw, preview: { day: Number.NaN, timeLabel: 'x', cashCents: 0, xp: 0 } }), 'fields', /\/preview\/day/],
  ];

  it.each(cases)('odmietne: %s', (_name, mutate, reason, message) => {
    let thrown: unknown;
    try {
      decodeSave(mutate(valid()));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SaveError);
    expect((thrown as SaveError).reason).toBe(reason);
    expect((thrown as SaveError).message).toMatch(message);
  });
});

describe('sloty', () => {
  it('auto, 1, 2, 3 v poradí zobrazenia; isSaveSlotId rozpozná len tieto', () => {
    expect(SAVE_SLOT_IDS).toEqual(['auto', '1', '2', '3']);
    for (const slot of SAVE_SLOT_IDS) expect(isSaveSlotId(slot)).toBe(true);
    for (const other of ['0', '4', 'AUTO', '', 1, null, undefined]) expect(isSaveSlotId(other)).toBe(false);
  });
});
