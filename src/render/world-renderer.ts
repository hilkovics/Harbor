/**
 * WorldRenderer (ARCHITECTURE §15.1): PixiJS aplikácia, kontajner sveta, vrstvy a kamera.
 *
 * Vstup je `LoadedMap` (a živá mriežka sveta), nie `World` — renderer sim iba číta. Zmeny sveta sa prenášajú
 * verejnými metódami (`updateRoads` z udalosti `RoadChanged`); napojenie na SimBridge robí bootstrap (T01-11).
 *
 * Vrstvy (zdola): terén → cesty → obrysy parciel → portály. Ďalšie (moduly, entity, ghost) pridávajú neskoršie fázy
 * do `world`. Sprity terénu a ciest sa načítajú z `assets/manifest.json` (`SpriteAtlas`); bez nich (`textures: null`)
 * vrstvy kreslia dočasné `Graphics` z tokenov.
 * Kamera je čistá matematika (`camera.ts`); tu sa jej `transform()` prenáša na `world`, keď sa pohľad zmení.
 */
import { Application, Container } from 'pixi.js';
import type { CellCoord, Grid, LoadedMap, Parcel, Rect } from '@sim/grid';
import { Camera } from './camera';
import { ParcelLayer } from './parcel-layer';
import { PortalLayer } from './portal-layer';
import { RoadLayer } from './road-layer';
import { SpriteAtlas, type SpriteTextures } from './sprite-atlas';
import { TerrainLayer } from './terrain-layer';
import { documentTokenResolver, loadRenderPalette, type RenderPalette, type TokenResolver } from './tokens';

export interface WorldRendererOptions {
  /** Prvok, do ktorého sa vloží canvas; renderer sa prispôsobí jeho veľkosti. */
  readonly host: HTMLElement;
  /** Načítaná mapa: úvodný pohľad sa centruje na starter parcelu. */
  readonly map: LoadedMap;
  /** Živá mriežka sveta (`World.grid`) — z nej sa kreslia cesty; predvolene `map.grid` (šablóna). */
  readonly grid?: Grid;
  /**
   * Živé parcely sveta (`[...World.parcels.values()]`) — z nich sa kreslia obrysy podľa `ownership`;
   * predvolene `map.parcels` (počiatočný stav mapy).
   */
  readonly parcels?: readonly Readonly<Parcel>[];
  /**
   * Sprity terénu a ciest: `undefined` = načíta sa `SpriteAtlas` z manifestu (chyba načítania je chyba spustenia),
   * `null` = bez spritov, vrstvy kreslia `Graphics` z tokenov, alebo hotové textúry (testy).
   */
  readonly textures?: SpriteTextures | null;
  /** Čítanie CSS tokenov; predvolene `getComputedStyle(document.documentElement)`. */
  readonly resolveToken?: TokenResolver;
}

/**
 * Obdĺžnik starter parcely: prvá parcela s `ownership === 'owned'` (loader nastaví z `startOwned`).
 * Mapa bez vlastnenej parcely → celá mapa (kamera sa vycentruje na jej stred).
 */
export function starterParcelRect(map: LoadedMap): Rect {
  const owned = map.parcels.find((parcel) => parcel.ownership === 'owned');
  return owned ? owned.rect : { x: 0, y: 0, w: map.grid.width, h: map.grid.height };
}

export class WorldRenderer {
  readonly app: Application;
  readonly camera: Camera;
  readonly palette: RenderPalette;
  /** Kontajner sveta: kamera ho posúva a škáluje; vrstvy sú jeho deti (súradnice v px pri zoome 1). */
  readonly world = new Container({ label: 'world' });
  readonly terrain: TerrainLayer;
  readonly roads: RoadLayer;
  readonly parcels: ParcelLayer;
  readonly portals: PortalLayer;
  private syncedVersion = -1;
  private destroyed = false;

  /** Použi `WorldRenderer.create` — inicializácia Pixi je asynchrónna. */
  private constructor(
    app: Application,
    palette: RenderPalette,
    options: WorldRendererOptions,
    private readonly atlas: SpriteAtlas | null,
    textures: SpriteTextures | null,
  ) {
    const grid = options.grid ?? options.map.grid;
    this.app = app;
    this.palette = palette;
    this.camera = new Camera({
      cellPx: palette.cellPx,
      mapWidth: grid.width,
      mapHeight: grid.height,
      viewportWidth: app.screen.width,
      viewportHeight: app.screen.height,
      focus: starterParcelRect(options.map),
    });
    this.terrain = new TerrainLayer(grid, palette, textures);
    this.roads = new RoadLayer(grid, palette, textures);
    this.parcels = new ParcelLayer(options.parcels ?? options.map.parcels, palette, textures);
    this.portals = new PortalLayer(options.map, grid.width, grid.height, palette, textures);
    this.world.addChild(this.terrain.view, this.roads.view, this.parcels.view, this.portals.view);
    app.stage.addChild(this.world);
    this.syncCamera();
    app.ticker.add(this.onTick, this);
  }

  /** Vytvorí Pixi aplikáciu v `host`, načíta tokeny a sprity a nakreslí terén, cesty, obrysy parciel a portály. */
  static async create(options: WorldRendererOptions): Promise<WorldRenderer> {
    const palette = loadRenderPalette(options.resolveToken ?? documentTokenResolver);
    const app = new Application();
    await app.init({
      resizeTo: options.host,
      background: palette.terrain.waterDeep.color,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio,
    });
    let atlas: SpriteAtlas | null = null;
    let textures: SpriteTextures | null;
    if (options.textures === undefined) {
      try {
        atlas = await SpriteAtlas.load({ deviceScale: window.devicePixelRatio });
      } catch (error) {
        app.destroy({ removeView: true }, { children: true });
        throw error;
      }
      textures = atlas;
    } else {
      textures = options.textures;
    }
    options.host.appendChild(app.canvas);
    return new WorldRenderer(app, palette, options, atlas, textures);
  }

  /** Prekreslí cesty po `RoadChanged`: zmenené bunky a ich susedov. @returns počet zmenených dlaždíc */
  updateRoads(cells: readonly CellCoord[]): number {
    return this.roads.updateRoads(cells);
  }

  /** Prekreslí obrysy parciel po zmene vlastníctva (kúpa, prenájom); @returns počet prekreslených obrysov */
  refreshParcels(): number {
    return this.parcels.refresh();
  }

  /** Prenesie kameru na kontajner sveta (a dorovná veľkosť obrazovky); volá sa každý tick, robí niečo len pri zmene. */
  syncCamera(): void {
    this.camera.resize(this.app.screen.width, this.app.screen.height);
    if (this.camera.version === this.syncedVersion) return;
    const { x, y, scale } = this.camera.transform();
    this.world.position.set(x, y);
    this.world.scale.set(scale);
    this.parcels.setZoom(this.camera.zoom); // obrysy parciel držia hrúbku na obrazovke aj pri malom zoome
    this.syncedVersion = this.camera.version;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app.ticker.remove(this.onTick, this);
    this.terrain.destroy();
    this.roads.destroy();
    this.parcels.destroy();
    this.portals.destroy();
    this.app.destroy({ removeView: true }, { children: true });
    void this.atlas?.destroy();
  }

  private onTick(): void {
    this.syncCamera();
  }
}
