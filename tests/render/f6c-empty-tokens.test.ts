// F6c (T6C-04): tokeny prázdnych kontajnerov a liniek, ich mapovanie v paletách a prefarbené placeholder assety (depo, empty handler,
// vozidlá s prázdnym kontajnerom) podľa tokenov — žiadna farba nie je v kóde ani v assete mimo tokenov.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { entities, sprites } from '../../assets/manifest.json';
import { LINE_COLOR_TOKENS, lineColorOf, loadEntityPalette, parseCssColor, tokenResolverFromCss } from '@render/tokens';
import { ENTITY_PALETTE, TOKENS } from './stub-textures';
import { readAsset } from './svg-geometry';

const LINES = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/defs/lines.json', import.meta.url)), 'utf8')) as {
  items: { id: string; colorToken: string }[];
};

/** Farba tokenu ako `#RRGGBB` (veľké písmená), tak ako je zapísaná v SVG assetoch. */
function hex(token: string): string {
  return `#${parseCssColor(TOKENS(token)).color.toString(16).padStart(6, '0').toUpperCase()}`;
}

describe('tokeny F6c v design/tokens.css', () => {
  it.each([
    '--cargo-import',
    '--cargo-export',
    '--cargo-empty',
    '--cargo-empty-light',
    '--cargo-empty-dark',
    '--cargo-empty-damaged',
    '--line-blue',
    '--line-amber',
    '--line-teal',
  ])('%s existuje a je platná farba', (token) => {
    expect(TOKENS(token), token).not.toBe('');
    expect(() => parseCssColor(TOKENS(token))).not.toThrow();
  });

  it('import a export majú vlastné tokeny s hodnotou pôvodného dočasného mapovania (kontajner, accent)', () => {
    expect(parseCssColor(TOKENS('--cargo-import'))).toEqual(parseCssColor(TOKENS('--cargo-container')));
    expect(parseCssColor(TOKENS('--cargo-export'))).toEqual(parseCssColor(TOKENS('--ui-accent')));
  });

  it('prázdny kontajner je neutrálna sivá: svetlý > základ > tmavý a nízka sýtosť', () => {
    const luminance = (token: string): number => {
      const { color } = parseCssColor(TOKENS(token));
      return ((color >> 16) & 0xff) + ((color >> 8) & 0xff) + (color & 0xff);
    };
    expect(luminance('--cargo-empty-light')).toBeGreaterThan(luminance('--cargo-empty'));
    expect(luminance('--cargo-empty')).toBeGreaterThan(luminance('--cargo-empty-dark'));
    const { color } = parseCssColor(TOKENS('--cargo-empty'));
    const channels = [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThanOrEqual(24); // sivá, nie farebná
  });

  it('prázdny kontajner sa odlišuje od importu aj exportu a odznak poškodeného od farby prázdneho', () => {
    const colors = ['--cargo-import', '--cargo-export', '--cargo-empty', '--cargo-empty-damaged'].map((token) => hex(token));
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe('EntityPalette: smer, stav prázdneho a linky z tokenov', () => {
  it('direction.import / export / empty berú tokeny --cargo-import, --cargo-export a --cargo-empty*', () => {
    const { direction } = ENTITY_PALETTE;
    expect(direction.import.base).toEqual(parseCssColor(TOKENS('--cargo-import')));
    expect(direction.export.base).toEqual(parseCssColor(TOKENS('--cargo-export')));
    expect(direction.empty.base).toEqual(parseCssColor(TOKENS('--cargo-empty')));
    expect(direction.empty.dark).toEqual(parseCssColor(TOKENS('--cargo-empty-dark')));
    expect(direction.empty.light).toEqual(parseCssColor(TOKENS('--cargo-empty-light')));
  });

  it('emptyState: poškodený = --cargo-empty-damaged, oprava = --ui-warning, značka = --ui-text', () => {
    const { emptyState } = ENTITY_PALETTE;
    expect(emptyState.damaged).toEqual(parseCssColor(TOKENS('--cargo-empty-damaged')));
    expect(emptyState.repair).toEqual(parseCssColor(TOKENS('--ui-warning')));
    expect(emptyState.glyph).toEqual(parseCssColor(TOKENS('--ui-text')));
  });

  it('každý `colorToken` z data/defs/lines.json má farbu v palete aj token v tokens.css', () => {
    expect(LINES.items.length).toBeGreaterThan(0);
    for (const { id, colorToken } of LINES.items) {
      expect(LINE_COLOR_TOKENS, `linka ${id}`).toContain(colorToken);
      expect(TOKENS(`--${colorToken}`), colorToken).not.toBe('');
      expect(lineColorOf(ENTITY_PALETTE, colorToken), colorToken).toEqual(parseCssColor(TOKENS(`--${colorToken}`)));
    }
  });

  it('farby liniek sú navzájom rôzne; neznámy token (aj kľúč z prototypu) → undefined', () => {
    const colors = LINE_COLOR_TOKENS.map((token) => lineColorOf(ENTITY_PALETTE, token)?.color);
    expect(new Set(colors).size).toBe(LINE_COLOR_TOKENS.length);
    expect(lineColorOf(ENTITY_PALETTE, 'line-pink')).toBeUndefined();
    expect(lineColorOf(ENTITY_PALETTE, 'constructor')).toBeUndefined();
    expect(lineColorOf(ENTITY_PALETTE, undefined)).toBeUndefined();
  });

  it('chýbajúci token prázdneho kontajnera → chyba s jeho menom', () => {
    const css = readFileSync(fileURLToPath(new URL('../../design/tokens.css', import.meta.url)), 'utf8').replace(/--cargo-empty-dark\s*:[^;]*;/, '');
    expect(() => loadEntityPalette(tokenResolverFromCss(css))).toThrow('--cargo-empty-dark');
  });
});

describe('prefarbené placeholder assety (F6c)', () => {
  const ORANGE = [hex('--cargo-container'), hex('--cargo-container-dark'), hex('--cargo-container-light'), '#924D09', '#F4A14E'];
  const files = (svg: string): string[] => [...svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g)].map((match) => match[1].toUpperCase());

  it('depo prázdnych: sivé kontajnery (--cargo-empty, obrys --cargo-empty-dark) na svetlejšej ploche, žiadna oranžová', () => {
    for (const state of Object.values(sprites.empty_depot.states)) {
      const colors = files(readAsset(state));
      for (const orange of ORANGE) expect(colors, `${state}: ${orange}`).not.toContain(orange);
      expect(colors).toContain(hex('--module-roof')); // plocha depa
      expect(colors).not.toContain(hex('--module-base')); // dvor má plochu --module-base
    }
    const full = files(readAsset(sprites.empty_depot.states.fill100));
    expect(full).toContain(hex('--cargo-empty'));
    expect(full).toContain(hex('--cargo-empty-dark'));
  });

  it('depo má rovnakú geometriu ako malý dvor (4×4, päť stavov, rovnaký počet políčok)', () => {
    const yardStates = sprites.container_yard_small.states;
    for (const key of Object.keys(yardStates) as (keyof typeof yardStates)[]) {
      const depot = readAsset(sprites.empty_depot.states[key]);
      const yard = readAsset(yardStates[key]);
      expect(depot.match(/<rect /g)?.length, key).toBe(yard.match(/<rect /g)?.length);
      expect(/viewBox="([^"]*)"/.exec(depot)?.[1]).toBe(/viewBox="([^"]*)"/.exec(yard)?.[1]);
    }
  });

  it('empty handler: modrá karoséria (--truck-cab), `loaded` nesie sivý kontajner, `empty` nie', () => {
    const empty = files(readAsset(entities.empty_handler.states.empty));
    const loaded = files(readAsset(entities.empty_handler.states.loaded));
    expect(empty).toContain(hex('--truck-cab'));
    expect(empty).not.toContain(hex('--vehicle-body'));
    expect(loaded).toContain(hex('--truck-cab'));
    expect(loaded).toContain(hex('--cargo-empty'));
    for (const orange of ORANGE) expect(loaded, orange).not.toContain(orange);
    expect(empty).not.toContain(hex('--cargo-empty'));
  });

  it.each([
    ['straddle_carrier', entities.straddle_carrier.states],
    ['truck_container', entities.truck_container.states],
  ] as const)('%s: stav `carries_empty` je `loaded` so sivým kontajnerom (rovnaký rozmer a počet tvarov)', (_id, states) => {
    const loaded = readAsset(states.loaded);
    const gray = readAsset(states.carries_empty);
    expect(/viewBox="([^"]*)"/.exec(gray)?.[1]).toBe(/viewBox="([^"]*)"/.exec(loaded)?.[1]);
    expect(gray.match(/<(rect|path) /g)?.length).toBe(loaded.match(/<(rect|path) /g)?.length);
    const colors = files(gray);
    expect(colors).toContain(hex('--cargo-empty'));
    for (const orange of ORANGE) expect(colors, orange).not.toContain(orange);
    expect(files(loaded)).toContain(hex('--cargo-container')); // plný kontajner ostáva oranžový
  });
});
