import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Texture } from 'pixi.js';
import type { TerrainSpriteId } from '@render/coast';
import type { InfraLayerId, InfraTileId, SpriteTextures } from '@render/sprite-atlas';
import { loadRenderPalette, tokenResolverFromCss, type RenderPalette } from '@render/tokens';

/** Paleta z reálneho `design/tokens.css` (bez DOM). */
export const PALETTE: RenderPalette = loadRenderPalette(
  tokenResolverFromCss(readFileSync(fileURLToPath(new URL('../../design/tokens.css', import.meta.url)), 'utf8')),
);

/**
 * Atrapa `SpriteTextures` pre testy bez DOM: pre každý kľúč (`terrain/<id>`, `infra/<vrstva>/<tvar>`) vráti vlastnú
 * prázdnu `Texture`, takže test vie overiť, KTORÝ sprite vrstva vybrala (`sprite.texture === stub.textureFor(kľúč)`).
 */
export class StubTextures implements SpriteTextures {
  private readonly cache = new Map<string, Texture>();
  /** Kľúče v poradí požiadaviek (s opakovaním). */
  readonly requests: string[] = [];

  terrain(id: TerrainSpriteId): Texture {
    return this.request(`terrain/${id}`);
  }

  infra<L extends InfraLayerId>(layer: L, tile: InfraTileId<L>): Texture {
    return this.request(`infra/${layer}/${String(tile)}`);
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
