/**
 * SpriteAtlas (DESIGN_BRIEF §4, §7): textúry terénu, infraštruktúry a entít sveta z `assets/manifest.json`.
 *
 * Zoznam spritov a súborov sa berie z manifestu (`terrain.<id>.file`, `infra.<vrstva>.tiles.<tvar>.file`,
 * `overlay.path_arrow.file` (šípka jednosmerky) a súbory
 * entít z `entity-assets.ts`: moduly vrátane stavov skladov `fill00…fill100`, časti žeriavov, lode, vozidlá, náklad
 * a odznaky), nie z kódu.
 * SVG sa rasterizuje pri načítaní na `SPRITE_RASTER_RESOLUTION` px na px zdroja (64 px bunka → 128 px pri zoome 2,0),
 * takže pri najväčšom zoome ostáva ostré; mipmapy držia čitateľné tenké línie (pena, obrysy) aj pri zoome 0,25.
 *
 * Vrstvy (`TerrainLayer`, `RoadLayer`, …) závisia iba od rozhrania `SpriteTextures`; skutočný atlas ho spĺňa,
 * testy bez DOM podstrčia atrapu a produkčný kód bez atlasu padá na `Graphics` fallback.
 */
import { Assets, Texture } from 'pixi.js';
import { infra as infraManifest, overlay as overlayManifest, terrain as terrainManifest } from '../../assets/manifest.json';
import { assetUrl } from './asset-urls';
import { CAMERA_MAX_ZOOM } from './camera';
import type { TerrainSpriteId } from './coast';
import { entitySpriteFiles } from './entity-assets';

/** Vrstva infraštruktúry v manifeste (`infra.road|rail|pipe`). */
export type InfraLayerId = keyof typeof infraManifest;

/** Tvar dlaždice infraštruktúry vrstvy `L` (`infra.<L>.tiles.<tvar>`), napr. `straight`, `corner`, `valve`. */
export type InfraTileId<L extends InfraLayerId = InfraLayerId> = keyof (typeof infraManifest)[L]['tiles'];

/** Overlay assety, ktoré atlas drží pre vrstvy sveta (`overlay.<id>` v manifeste): šípka smeru jednosmerky. */
export type WorldOverlayId = 'path_arrow';

/** Čo vrstvy sveta potrebujú od atlasu: textúru terénu, dlaždice infraštruktúry a overlaye sveta (cestné značky). */
export interface SpriteTextures {
  terrain(id: TerrainSpriteId): Texture;
  infra<L extends InfraLayerId>(layer: L, tile: InfraTileId<L>): Texture;
  overlay(id: WorldOverlayId): Texture;
}

/**
 * Textúry entít sveta (moduly, časti žeriavov, lode, vozidlá, náklad, odznaky) podľa cesty súboru z manifestu
 * (napr. `modules/berth_standard.svg`). Views závisia iba od tohto rozhrania; testy bez DOM podstrčia atrapu.
 */
export interface EntityTextures {
  /** Textúra súboru, alebo `undefined`, ak nie je načítaná (view potom kreslí `Graphics` fallback z tokenov). */
  file(path: string): Texture | undefined;
}

/** Rasterizácia SVG: px zdroja na 1 px SVG. Zoom 2,0 (`CAMERA_MAX_ZOOM`) → 128 px na bunku pri `--cell` = 64 px. */
export const SPRITE_RASTER_RESOLUTION = CAMERA_MAX_ZOOM;

export interface SpriteAtlasOptions {
  /** Pomer fyzických a CSS px displeja (`devicePixelRatio`); zvyšuje hustotu rasterizácie. Predvolene 1. */
  readonly deviceScale?: number;
}

/** Kľúč textúry infraštruktúry v mape atlasu. */
function infraKey(layer: string, tile: string): string {
  return `infra/${layer}/${tile}`;
}

function terrainKey(id: string): string {
  return `terrain/${id}`;
}

function overlayKey(id: string): string {
  return `overlay/${id}`;
}

/** Kľúč textúry entity: cesta súboru z manifestu. */
function fileKey(path: string): string {
  return `file/${path}`;
}

interface SpriteEntry {
  readonly key: string;
  readonly file: string;
}

/** Všetky sprity, ktoré atlas načíta: `terrain.*`, `infra.*.tiles.*` a súbory entít (`entitySpriteFiles`). */
function manifestEntries(): SpriteEntry[] {
  const entries: SpriteEntry[] = [];
  for (const [id, entry] of Object.entries<{ file: string }>(terrainManifest)) {
    entries.push({ key: terrainKey(id), file: entry.file });
  }
  for (const [layer, { tiles }] of Object.entries<{ tiles: Record<string, { file: string }> }>(infraManifest)) {
    for (const [tile, entry] of Object.entries(tiles)) entries.push({ key: infraKey(layer, tile), file: entry.file });
  }
  entries.push({ key: overlayKey('path_arrow'), file: overlayManifest.path_arrow.file });
  for (const file of entitySpriteFiles()) entries.push({ key: fileKey(file), file });
  return entries;
}

export class SpriteAtlas implements SpriteTextures, EntityTextures {
  private constructor(
    private readonly textures: ReadonlyMap<string, Texture>,
    private readonly urls: readonly string[],
  ) {}

  /** Načíta a rasterizuje sprity terénu, infraštruktúry a entít z manifestu (asynchrónne, potrebuje DOM). */
  static async load(options: SpriteAtlasOptions = {}): Promise<SpriteAtlas> {
    const resolution = Math.ceil(SPRITE_RASTER_RESOLUTION * (options.deviceScale ?? 1));
    const entries = manifestEntries().map((entry) => ({ ...entry, url: assetUrl(entry.file) }));
    const loaded = await Promise.all(
      entries.map((entry) =>
        Assets.load<Texture>({
          src: entry.url,
          // `data` sa prenáša do zdroja textúry: mipmapy s lineárnym filtrom (zoom 0,25 bez šumu na tenkých líniách).
          data: { resolution, autoGenerateMipmaps: true, scaleMode: 'linear', mipmapFilter: 'linear' },
        }),
      ),
    );
    const textures = new Map<string, Texture>();
    entries.forEach((entry, i) => textures.set(entry.key, loaded[i]));
    return new SpriteAtlas(textures, entries.map((entry) => entry.url));
  }

  /** Textúra terénu (`terrain.<id>`); id mimo manifestu je chyba. */
  terrain(id: TerrainSpriteId): Texture {
    return this.texture(terrainKey(id));
  }

  /** Textúra dlaždice infraštruktúry (`infra.<vrstva>.tiles.<tvar>`); tvar mimo manifestu je chyba. */
  infra<L extends InfraLayerId>(layer: L, tile: InfraTileId<L>): Texture {
    return this.texture(infraKey(layer, String(tile)));
  }

  /** Textúra overlayu sveta (`overlay.<id>`, napr. `path_arrow`); id mimo manifestu je chyba. */
  overlay(id: WorldOverlayId): Texture {
    return this.texture(overlayKey(id));
  }

  /** Textúra entity podľa cesty súboru z manifestu, alebo `undefined`, ak ju atlas nenačítal. */
  file(path: string): Texture | undefined {
    return this.textures.get(fileKey(path));
  }

  /** Uvoľní textúry z cache `Assets` (pri zrušení rendereru). */
  async destroy(): Promise<void> {
    await Promise.all(this.urls.map((url) => Assets.unload(url)));
  }

  private texture(key: string): Texture {
    const texture = this.textures.get(key);
    if (texture === undefined) throw new Error(`SpriteAtlas: sprite "${key}" nie je v manifeste`);
    return texture;
  }
}
