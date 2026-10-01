import { describe, expect, it } from 'vitest';
import { assetUrl } from '@render/asset-urls';
import { CAMERA_MAX_ZOOM } from '@render/camera';
import { overlayAssetUrl } from '@render/overlay-assets';
import { SPRITE_RASTER_RESOLUTION } from '@render/sprite-atlas';
import { infra, overlay, terrain } from '../../assets/manifest.json';
import { PALETTE } from './stub-textures';

describe('assetUrl (Vite ?url podľa cesty z manifestu)', () => {
  const infraFiles = Object.values(infra).flatMap((layer) => Object.values(layer.tiles).map((tile) => tile.file));
  const terrainFiles = Object.values(terrain).map((entry) => entry.file);
  const overlayFiles = Object.values(overlay).map((entry) => entry.file);

  it('rozpozná každý súbor terénu, infraštruktúry a overlayov z manifestu', () => {
    expect(terrainFiles).toHaveLength(24);
    expect(infraFiles).toHaveLength(15);
    for (const file of [...terrainFiles, ...infraFiles, ...overlayFiles]) {
      expect(assetUrl(file), file).toMatch(/\.svg/);
    }
  });

  it('rôzne súbory majú rôzne URL', () => {
    const urls = new Set([...terrainFiles, ...infraFiles].map(assetUrl));
    expect(urls.size).toBe(terrainFiles.length + infraFiles.length);
  });

  it('súbor mimo manifestu je chyba (fail-fast)', () => {
    expect(() => assetUrl('terrain/neexistuje.svg')).toThrow(/neexistuje\.svg/);
  });

  it('overlayAssetUrl používa ten istý zdroj URL', () => {
    expect(overlayAssetUrl('ghost_hatch')).toBe(assetUrl(overlay.ghost_hatch.file));
  });

  it('šípka smeru jednosmerky (`overlay.path_arrow`) je v manifeste ako otáčateľný sprite 1×1 s reálnym súborom', () => {
    expect(overlay.path_arrow.file).toBe('overlay/path_arrow.svg');
    expect(overlay.path_arrow.rotatable).toBe(true);
    expect(overlay.path_arrow.footprint).toEqual({ w: 1, h: 1 });
    expect(assetUrl(overlay.path_arrow.file)).toMatch(/path_arrow.*\.svg/);
  });
});

describe('rasterizácia SVG', () => {
  it('pri zoome 2,0 (`CAMERA_MAX_ZOOM`) je na bunku 128 px', () => {
    expect(SPRITE_RASTER_RESOLUTION).toBe(CAMERA_MAX_ZOOM);
    expect(PALETTE.cellPx * SPRITE_RASTER_RESOLUTION).toBe(128);
  });
});
