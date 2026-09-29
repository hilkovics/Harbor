/**
 * WorldRenderer (ARCHITECTURE §15.1): PixiJS aplikácia, kontajner sveta, vrstvy a kamera.
 *
 * Vstup je `LoadedMap` (a živá mriežka sveta), nie `World` — renderer sim iba číta. Zmeny sveta sa prenášajú
 * verejnými metódami (`updateRoads` z udalosti `RoadChanged`); napojenie na SimBridge robí bootstrap (T01-11).
 *
 * Vrstvy (zdola): terén → cesty. Ďalšie (parcely, moduly, entity, ghost) pridávajú neskoršie fázy do `world`.
 * Kamera je čistá matematika (`camera.ts`); tu sa jej `transform()` prenáša na `world`, keď sa pohľad zmení.
 */
import { Application, Container } from 'pixi.js';
import type { CellCoord, Grid, LoadedMap, Rect } from '@sim/grid';
import { Camera } from './camera';
import { RoadLayer } from './road-layer';
import { TerrainLayer } from './terrain-layer';
import { documentTokenResolver, loadRenderPalette, type RenderPalette, type TokenResolver } from './tokens';

export interface WorldRendererOptions {
  /** Prvok, do ktorého sa vloží canvas; renderer sa prispôsobí jeho veľkosti. */
  readonly host: HTMLElement;
  /** Načítaná mapa: úvodný pohľad sa centruje na starter parcelu. */
  readonly map: LoadedMap;
  /** Živá mriežka sveta (`World.grid`) — z nej sa kreslia cesty; predvolene `map.grid` (šablóna). */
  readonly grid?: Grid;
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
  private syncedVersion = -1;
  private destroyed = false;

  /** Použi `WorldRenderer.create` — inicializácia Pixi je asynchrónna. */
  private constructor(app: Application, palette: RenderPalette, options: WorldRendererOptions) {
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
    this.terrain = new TerrainLayer(grid, palette);
    this.roads = new RoadLayer(grid, palette);
    this.world.addChild(this.terrain.view, this.roads.view);
    app.stage.addChild(this.world);
    this.syncCamera();
    app.ticker.add(this.onTick, this);
  }

  /** Vytvorí Pixi aplikáciu v `host`, načíta tokeny a nakreslí terén a cesty. */
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
    options.host.appendChild(app.canvas);
    return new WorldRenderer(app, palette, options);
  }

  /** Prekreslí cesty po `RoadChanged`: zmenené bunky a ich susedov. @returns počet zmenených dlaždíc */
  updateRoads(cells: readonly CellCoord[]): number {
    return this.roads.updateRoads(cells);
  }

  /** Prenesie kameru na kontajner sveta (a dorovná veľkosť obrazovky); volá sa každý tick, robí niečo len pri zmene. */
  syncCamera(): void {
    this.camera.resize(this.app.screen.width, this.app.screen.height);
    if (this.camera.version === this.syncedVersion) return;
    const { x, y, scale } = this.camera.transform();
    this.world.position.set(x, y);
    this.world.scale.set(scale);
    this.syncedVersion = this.camera.version;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app.ticker.remove(this.onTick, this);
    this.terrain.destroy();
    this.roads.destroy();
    this.app.destroy({ removeView: true }, { children: true });
  }

  private onTick(): void {
    this.syncCamera();
  }
}
