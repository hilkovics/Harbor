import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Texture } from 'pixi.js';
import type { TerrainSpriteId } from '@render/coast';
import type { EntityTextures, InfraLayerId, InfraTileId, SpriteTextures } from '@render/sprite-atlas';
import {
  loadEntityPalette,
  loadRenderPalette,
  tokenResolverFromCss,
  type EntityPalette,
  type RenderPalette,
} from '@render/tokens';

/** Tokeny z reálneho `design/tokens.css` (bez DOM). */
export const TOKENS = tokenResolverFromCss(
  readFileSync(fileURLToPath(new URL('../../design/tokens.css', import.meta.url)), 'utf8'),
);

/** Paleta z reálneho `design/tokens.css` (bez DOM). */
export const PALETTE: RenderPalette = loadRenderPalette(TOKENS);

/** Farby fallbacku entít z reálneho `design/tokens.css`. */
export const ENTITY_PALETTE: EntityPalette = loadEntityPalette(TOKENS);

/**
 * Atrapa `SpriteTextures` a `EntityTextures` pre testy bez DOM: pre každý kľúč (`terrain/<id>`, `infra/<vrstva>/<tvar>`,
 * `file/<cesta súboru z manifestu>`) vráti vlastnú prázdnu `Texture`, takže test vie overiť, KTORÝ sprite vrstva
 * vybrala (`sprite.texture === stub.textureFor(kľúč)`).
 */
export class StubTextures implements SpriteTextures, EntityTextures {
  private readonly cache = new Map<string, Texture>();
  /** Kľúče v poradí požiadaviek (s opakovaním). */
  readonly requests: string[] = [];

  terrain(id: TerrainSpriteId): Texture {
    return this.request(`terrain/${id}`);
  }

  infra<L extends InfraLayerId>(layer: L, tile: InfraTileId<L>): Texture {
    return this.request(`infra/${layer}/${String(tile)}`);
  }

  file(path: string): Texture {
    return this.request(`file/${path}`);
  }

  /** Textúra pre kľúč (vytvorí sa pri prvom použití, rovnaký objekt aj neskôr). */
  textureFor(key: string): Texture {
    let texture = this.cache.get(key);
    if (texture === undefined) {
      texture = new Texture({ label: key });
      this.cache.set(key, texture);
    }
    return texture;
  }

  private request(key: string): Texture {
    this.requests.push(key);
    return this.textureFor(key);
  }
}
