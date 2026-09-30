/**
 * Konfigurácia aplikácie (vrstva `src/app`, nie sim): seed novej hry, výber mapy a ladenie ovládania.
 *
 * Herné hodnoty (ceny, rýchlosti, trvania) sem nepatria — tie sú v `data/defs/*.json`. Tu je len to, čo je
 * vlastné aplikácii: ktorú hru spustiť a ako citlivé je ovládanie.
 */
import { isWater, loadBundledMap, type Grid, type LoadedMap, type Rect } from '@sim/grid';
import { loadBundledDefs } from '@sim/defs';
import { World, type WorldOptions } from '@sim/world';

/** Seed novej hry (uint32, ARCHITECTURE §3 / Rng); ten istý seed + rovnaké príkazy = rovnaká hra. */
export const GAME_SEED = 20260929;

/** Mapa, ktorú aplikácia spúšťa (zabalená v `data/maps/`). */
export const APP_MAP_ID = 'harbor_01';

/** Rýchlosť posunu kamery klávesmi WASD/šípky v obrazovkových px za sekundu (nezávislá od zoomu). */
export const KEY_PAN_PX_PER_SECOND = 720;

/** Najdlhší krok posunu klávesmi v ms: po návrate z neaktívnej karty (dlhý dt) kamera neskočí cez pol mapy. */
export const KEY_PAN_MAX_DT_MS = 100;

/**
 * Najväčší posun myši v obrazovkových px medzi stlačením a pustením ľavého tlačidla v `idle` móde, ktorý sa ešte
 * berie ako klik (výber modulu), nie ako ťah kamery. Väčší posun je posun mapy a výber sa nemení.
 */
export const CLICK_SLOP_PX = 4;

/** Citlivosť kolieska: zoom sa násobí `exp(−delta × WHEEL_ZOOM_PER_PX)`; bežný krok kolieska (100 px) ≈ ×1,16. */
export const WHEEL_ZOOM_PER_PX = 0.0015;

/** Prepočet `WheelEvent.deltaMode` → px (0 = pixely, 1 = riadky, 2 = stránky). */
export const WHEEL_DELTA_MODE_PX: readonly [number, number, number] = [1, 16, 100];

/**
 * Podiel výšky obrazovky (0 = horný okraj), na ktorý pri štarte pripadne pobrežie starter parcely. Nad ním ostáva
 * pás vody (vrátane lišty HUD), pod ním parcela — na 1280×720 aj 1920×1080 je tak vidno more aj nábrežie.
 */
export const START_SHORE_SCREEN_FRACTION = 1 / 3;

/**
 * Prvý riadok pobrežia v obdĺžniku `focus`: horný riadok, v ktorom je aspoň jedna bunka mimo vody (nábrežie, pevnina).
 * Obdĺžnik bez súše → jeho horný riadok.
 */
export function shoreRow(grid: Grid, focus: Rect): number {
  for (let y = focus.y; y < focus.y + focus.h; y += 1) {
    for (let x = focus.x; x < focus.x + focus.w; x += 1) {
      if (grid.inBounds(x, y) && !isWater(grid.at(x, y).terrain)) return y;
    }
  }
  return focus.y;
}

/**
 * Stred úvodného pohľadu kamery v bunkách: vodorovne stred `focus` (starter parcely), zvislo tak, aby pobrežie
 * ležalo na `START_SHORE_SCREEN_FRACTION` výšky obrazovky. `visibleRows` = koľko riadkov buniek sa zmestí na výšku
 * obrazovky (`viewportHeight / (zoom × cellPx)`). Hranice mapy dorovná kamera (clamp).
 */
export function startViewCenter(grid: Grid, focus: Rect, visibleRows: number): { readonly x: number; readonly y: number } {
  return {
    x: focus.x + focus.w / 2,
    y: shoreRow(grid, focus) + (0.5 - START_SHORE_SCREEN_FRACTION) * visibleRows,
  };
}

/**
 * Ladiaca loď z DEV tlačidla „Spawn feeder (DEV)“ (`SpawnShipDebug`, ADR-016). Jednotiek je ≤ `apronSlots` kotviska
 * (4), aby sa loď vyložila celá a odplávala — vo F2 ešte nejazdia vozidlá, ktoré by apron uvoľnili.
 */
export const DEV_SPAWN_SHIP = { shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 } as const;

/** Načíta mapu aplikácie; nesúlad s `APP_MAP_ID` je chyba konfigurácie (fail-fast). */
export function loadAppMap(): LoadedMap {
  const map = loadBundledMap();
  if (map.id !== APP_MAP_ID) {
    throw new Error(`config: zabalená mapa má id "${map.id}", aplikácia očakáva "${APP_MAP_ID}"`);
  }
  return map;
}

/**
 * Voľby sveta aplikácie: invarianty (krok 12 ticku: konzervácia nákladu, konzistencia modulov a lodí) sú zapnuté len
 * vo vývojovom builde (`import.meta.env.DEV`), v produkcii ich vypína kvôli výkonu (ADR-016).
 */
export const APP_WORLD_OPTIONS: WorldOptions = Object.freeze({ checkInvariants: import.meta.env.DEV });

/** Nová hra aplikácie: zabalené defy + mapa aplikácie + `GAME_SEED` + `APP_WORLD_OPTIONS`. */
export function createAppWorld(seed: number = GAME_SEED, options: WorldOptions = APP_WORLD_OPTIONS): World {
  return World.create(loadBundledDefs(), loadAppMap(), seed, options);
}
