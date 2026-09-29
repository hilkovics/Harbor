/**
 * Konfigurácia aplikácie (vrstva `src/app`, nie sim): seed novej hry, výber mapy a ladenie ovládania.
 *
 * Herné hodnoty (ceny, rýchlosti, trvania) sem nepatria — tie sú v `data/defs/*.json`. Tu je len to, čo je
 * vlastné aplikácii: ktorú hru spustiť a ako citlivé je ovládanie.
 */
import { loadBundledMap, type LoadedMap } from '@sim/grid';
import { loadBundledDefs } from '@sim/defs';
import { World } from '@sim/world';

/** Seed novej hry (uint32, ARCHITECTURE §3 / Rng); ten istý seed + rovnaké príkazy = rovnaká hra. */
export const GAME_SEED = 20260929;

/** Mapa, ktorú aplikácia spúšťa (zabalená v `data/maps/`). */
export const APP_MAP_ID = 'harbor_01';

/** Rýchlosť posunu kamery klávesmi WASD/šípky v obrazovkových px za sekundu (nezávislá od zoomu). */
export const KEY_PAN_PX_PER_SECOND = 720;

/** Najdlhší krok posunu klávesmi v ms: po návrate z neaktívnej karty (dlhý dt) kamera neskočí cez pol mapy. */
export const KEY_PAN_MAX_DT_MS = 100;

/** Citlivosť kolieska: zoom sa násobí `exp(−delta × WHEEL_ZOOM_PER_PX)`; bežný krok kolieska (100 px) ≈ ×1,16. */
export const WHEEL_ZOOM_PER_PX = 0.0015;

/** Prepočet `WheelEvent.deltaMode` → px (0 = pixely, 1 = riadky, 2 = stránky). */
export const WHEEL_DELTA_MODE_PX: readonly [number, number, number] = [1, 16, 100];

/** Načíta mapu aplikácie; nesúlad s `APP_MAP_ID` je chyba konfigurácie (fail-fast). */
export function loadAppMap(): LoadedMap {
  const map = loadBundledMap();
  if (map.id !== APP_MAP_ID) {
    throw new Error(`config: zabalená mapa má id "${map.id}", aplikácia očakáva "${APP_MAP_ID}"`);
  }
  return map;
}

/** Nová hra aplikácie: zabalené defy + mapa aplikácie + `GAME_SEED`. */
export function createAppWorld(seed: number = GAME_SEED): World {
  return World.create(loadBundledDefs(), loadAppMap(), seed);
}
