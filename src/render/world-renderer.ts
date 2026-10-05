/**
 * WorldRenderer (ARCHITECTURE §15.1): PixiJS aplikácia, kontajner sveta, vrstvy a kamera.
 *
 * Vstup je `LoadedMap` (a živá mriežka sveta), nie `World` — renderer sim iba číta. Zmeny sveta sa prenášajú
 * verejnými metódami (`updateRoads` z udalosti `RoadChanged`); napojenie na SimBridge robí bootstrap (T01-11).
 *
 * Vrstvy (zdola, ARCHITECTURE §15.1): terén → cesty → cestné značky (šípky jednosmeriek) → obrysy parciel → portály →
 * moduly → základne žeriavov → červené bunky zápchy (R1) → lode a vozidlá → odznaky zápchy → žeriavy (výložník, vozík, náklad) → ghost stavby (`BuildLayer`). Základňa žeriava je pod vozidlami
 * (F6d): vozidlo stojace pri odovzdaní pod žeriavom je v portáli vidieť, vozík s kontajnerom je nad ním. Entity (moduly, lode, vozidlá, žeriavy) sa synchronizujú z view-modelov cez
 * `syncEntities(vm, alpha)`,
 * ghost modulu cez `setModuleGhost`. Sprity sa načítajú z `assets/manifest.json` (`SpriteAtlas`); bez nich
 * (`textures: null`) vrstvy kreslia dočasné `Graphics` z tokenov.
 * Kamera je čistá matematika (`camera.ts`); tu sa jej `transform()` prenáša na `world`, keď sa pohľad zmení.
 */
import { Application, Container } from 'pixi.js';
import type { CellCoord, Grid, LoadedMap, Parcel, Rect } from '@sim/grid';
import { BuildLayer, loadGhostPalette } from './build-layer';
import { Camera } from './camera';
import { CraneLayer } from './crane-layer';
import { EntityLayer } from './entity-layer';
import { createRoadKindAt, createRoadMaskAt } from './lane';
import { ConnectorArmIndex } from './module-connectors';
import { ModuleLayer } from './module-layer';
import { ParcelLayer } from './parcel-layer';
import { PortalLayer } from './portal-layer';
import { RoadLayer } from './road-layer';
import { RoadMarkLayer } from './road-mark-layer';
import { TrafficJamLayer } from './traffic-jam-layer';
import { SPRITE_RASTER_RESOLUTION, SpriteAtlas, type SpriteTextures } from './sprite-atlas';
import { TerrainLayer } from './terrain-layer';
import {
  documentTokenResolver,
  loadEntityPalette,
  loadRenderPalette,
  type EntityPalette,
  type RenderPalette,
  type TokenResolver,
} from './tokens';
import type { EntitiesVM, ModuleGhostVM, TruckVM, VehicleVM } from './view-models';

export interface WorldRendererOptions {
  /** Prvok, do ktorého sa vloží canvas; renderer sa prispôsobí jeho veľkosti. */
  readonly host: HTMLElement;
  /** Načítaná mapa: úvodný pohľad sa centruje na starter parcelu. */
  readonly map: LoadedMap;
  /** Živá mriežka sveta (`World.grid`) — z nej sa kreslia cesty; predvolene nová `map.createGrid()` (počiatočný stav mapy). */
  readonly grid?: Grid;
  /**
   * Živé parcely sveta (`[...World.parcels.values()]`) — z nich sa kreslia obrysy podľa `ownership`;
   * predvolene `map.parcels` (počiatočný stav mapy).
   */
  readonly parcels?: readonly Readonly<Parcel>[];
  /**
   * Sprity terénu a ciest: `undefined` = načíta sa `SpriteAtlas` z manifestu (chyba načítania je chyba spustenia),
   * `null` = bez spritov, vrstvy kreslia `Graphics` z tokenov, alebo hotové textúry (testy). Sprity entít (moduly,
   * lode, žeriavy, náklad) sa berú z atlasu len pri `undefined`; inak sa kreslia `Graphics` z tokenov.
   */
  readonly textures?: SpriteTextures | null;
  /** Čítanie CSS tokenov; predvolene `getComputedStyle(document.documentElement)`. */
  readonly resolveToken?: TokenResolver;
  /**
   * Hodiny v ms pre animácie, ktoré nejdú podľa ticku simu (závora brány, žeriav dvora, manéver kamióna pri rampe);
   * predvolene `performance.now`. Demo a testy podávajú riadené hodiny, aby boli screenshoty deterministické.
   */
  readonly now?: () => number;
  /** `true` = bez dekoratívnych animácií (`prefers-reduced-motion`); predvolene sa číta z `matchMedia`. */
  readonly reducedMotion?: () => boolean;
}

/**
 * Obdĺžnik starter parcely: prvá parcela s `ownership === 'owned'` (loader nastaví z `startOwned`).
 * Mapa bez vlastnenej parcely → celá mapa (kamera sa vycentruje na jej stred).
 */
export function starterParcelRect(map: LoadedMap): Rect {
  const owned = map.parcels.find((parcel) => parcel.ownership === 'owned');
  return owned ? owned.rect : { x: 0, y: 0, w: map.width, h: map.height };
}

/** Prázdny zoznam vozidiel pre VM bez poľa `vehicles` (jedna zdieľaná inštancia, žiadna alokácia za frame). */
const NO_VEHICLES: readonly VehicleVM[] = Object.freeze([]);

/** Prázdny zoznam kamiónov pre VM bez poľa `trucks` (F2/F3). */
const NO_TRUCKS: readonly TruckVM[] = Object.freeze([]);

export class WorldRenderer {
  readonly app: Application;
  readonly camera: Camera;
  readonly palette: RenderPalette;
  /** Kontajner sveta: kamera ho posúva a škáluje; vrstvy sú jeho deti (súradnice v px pri zoome 1). */
  readonly world = new Container({ label: 'world' });
  readonly terrain: TerrainLayer;
  readonly roads: RoadLayer;
  /** Cestné značky nad cestami a pod entitami: šípky smeru jednosmeriek. */
  readonly roadMarks: RoadMarkLayer;
  readonly parcels: ParcelLayer;
  readonly portals: PortalLayer;
  readonly modules: ModuleLayer;
  /** Lode, vozidlá aj kamióny (`EntityLayer`): `ships.shipCount`, `ships.vehicleCount`; alias `entities`. */
  readonly ships: EntityLayer;
  readonly cranes: CraneLayer;
  /** Zvýraznenie zápchy (R1): červené bunky pod vozidlami (`cells`) a odznaky nad nimi (`badges`). */
  readonly jams: TrafficJamLayer;
  /** Ghost stavby: cesty (`setGhost`, `GhostView`) aj modulu (`setModuleGhost`); je navrchu nad žeriavmi. */
  readonly build: BuildLayer;
  readonly entityPalette: EntityPalette;
  /** Ramená ciest k konektorom modulov (cesta sa na modul napája, nekončí zaoblene pred ním). */
  private readonly connectorArms: ConnectorArmIndex;
  private syncedVersion = -1;
  private destroyed = false;

  /** Použi `WorldRenderer.create` — inicializácia Pixi je asynchrónna. */
  private constructor(
    app: Application,
    palette: RenderPalette,
    options: WorldRendererOptions,
    private readonly atlas: SpriteAtlas | null,
    textures: SpriteTextures | null,
    entityPalette: EntityPalette,
    build: BuildLayer,
  ) {
    const grid = options.grid ?? options.map.createGrid();
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
    this.connectorArms = new ConnectorArmIndex(grid);
    this.roads = new RoadLayer(grid, palette, textures, this.connectorArms.maskAt);
    this.roadMarks = new RoadMarkLayer(grid, palette, textures?.overlay('path_arrow') ?? null);
    this.parcels = new ParcelLayer(options.parcels ?? options.map.parcels, palette, textures);
    this.portals = new PortalLayer(options.map, grid.width, grid.height, palette, textures);
    this.entityPalette = entityPalette;
    // Typ cesty pod vozidlom (pruh) a tvar zákrut (oblúk) sa čítajú z živej mriežky; vozidlá vidia zmeny ciest hneď.
    const entityDeps = {
      cellPx: palette.cellPx,
      palette: entityPalette,
      textures: atlas,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
      roadKindAt: createRoadKindAt(grid),
      roadMaskAt: createRoadMaskAt(grid, this.connectorArms.maskAt),
      // číslo v odznaku fronty brány sa rasterizuje pre najväčší zoom a hustotu displeja, aby ostalo ostré
      textResolution: Math.ceil(SPRITE_RASTER_RESOLUTION * window.devicePixelRatio),
    };
    this.modules = new ModuleLayer(entityDeps);
    this.ships = new EntityLayer(entityDeps);
    this.cranes = new CraneLayer(entityDeps);
    this.jams = new TrafficJamLayer(entityDeps);
    this.build = build;
    this.world.addChild(
      this.terrain.view,
      this.roads.view,
      this.roadMarks.view,
      this.parcels.view,
      this.portals.view,
      this.modules.view,
      this.cranes.baseView,
      this.jams.cells,
      this.ships.view,
      this.jams.badges,
      this.cranes.view,
      this.build.view,
    );
    app.stage.addChild(this.world);
    this.syncCamera();
    app.ticker.add(this.onTick, this);
  }

  /** Vytvorí Pixi aplikáciu v `host`, načíta tokeny a sprity a nakreslí terén, cesty, obrysy parciel a portály. */
  static async create(options: WorldRendererOptions): Promise<WorldRenderer> {
    const resolveToken = options.resolveToken ?? documentTokenResolver;
    const palette = loadRenderPalette(resolveToken);
    const entityPalette = loadEntityPalette(resolveToken);
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
    let build: BuildLayer;
    try {
      if (options.textures === undefined) {
        atlas = await SpriteAtlas.load({ deviceScale: window.devicePixelRatio });
        textures = atlas;
      } else {
        textures = options.textures;
      }
      // Bez spritov (`textures: null`, testy) sa ghost kreslí bez šrafy a s `Graphics` značkami konektorov.
      build =
        textures === null
          ? new BuildLayer({
              cellPx: palette.cellPx,
              palette: loadGhostPalette(resolveToken),
              hatch: null,
            })
          : await BuildLayer.create({ resolveToken });
    } catch (error) {
      app.destroy({ removeView: true }, { children: true });
      throw error;
    }
    options.host.appendChild(app.canvas);
    return new WorldRenderer(app, palette, options, atlas, textures, entityPalette, build);
  }

  /** Vrstva pohyblivých entít (lode, vozidlá, kamióny) — pomenovanie bez zavádzajúceho „ships“ pre vozidlá. */
  get entities(): EntityLayer {
    return this.ships;
  }

  /**
   * Zosúladí moduly, lode, vozidlá, kamióny a žeriavy s view-modelmi (volá sa každý frame): views vznikajú / zanikajú podľa
   * `id`, nezmenené entity sa nealokujú. `alpha` (0…1) je podiel medzi predchádzajúcim a aktuálnym tickom simu
   * (interpolácia polohy lodí, vozidiel a kamiónov). `vm.vehicles` chýbajúce vo VM z F2 a `vm.trucks` chýbajúce vo VM
   * z F2/F3 sa berú ako prázdne.
   */
  syncEntities(vm: EntitiesVM, alpha: number): void {
    this.roads.updateRoads(this.connectorArms.update(vm.modules)); // nový / odstránený modul zmení rameno cesty pred konektorom
    this.modules.sync(vm.modules);
    this.ships.sync(vm.ships, alpha);
    this.ships.syncVehicles(vm.vehicles ?? NO_VEHICLES, alpha);
    this.ships.syncTrucks(vm.trucks ?? NO_TRUCKS, alpha);
    this.jams.sync(vm.vehicles ?? NO_VEHICLES, vm.trucks ?? NO_TRUCKS, alpha);
    this.cranes.sync(vm.cranes);
  }

  /** Zobrazí ghost modulu (footprint + konektory), alebo ho skryje (`null`). */
  setModuleGhost(ghost: ModuleGhostVM | null): void {
    this.build.setModuleGhost(ghost);
  }

  /**
   * Prekreslí cesty po `RoadChanged`: zmenené bunky a ich susedov (tvar, typ cesty, lieviky) a šípky jednosmeriek zmenených
   * buniek. @returns počet zmenených dlaždíc ciest
   */
  updateRoads(cells: readonly CellCoord[]): number {
    this.roadMarks.updateCells(cells);
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
    this.cranes.setZoom(this.camera.zoom); // odznaky žeriavov ostávajú čitateľné pri malom zoome
    this.modules.setZoom(this.camera.zoom); // odznaky „nepripojené“ a VGM hold tiež
    this.ships.setZoom(this.camera.zoom); // odznak lashingu lode tiež
    this.jams.setZoom(this.camera.zoom); // odznaky zápchy tiež
    this.syncedVersion = this.camera.version;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app.ticker.remove(this.onTick, this);
    this.terrain.destroy();
    this.roads.destroy();
    this.roadMarks.destroy();
    this.parcels.destroy();
    this.portals.destroy();
    this.modules.destroy();
    this.ships.destroy();
    this.cranes.destroy();
    this.jams.destroy();
    this.build.destroy();
    this.app.destroy({ removeView: true }, { children: true });
    void this.atlas?.destroy();
  }

  private onTick(): void {
    this.syncCamera();
  }
}
