/**
 * Adresy overlay assetov (`assets/overlay/*.svg`) podľa mena zo `assets/manifest.json`.
 *
 * Názvy súborov sa nepíšu do kódu: berú sa z manifestu (`overlay.<id>.file`); URL vydá `asset-urls.ts` (Vite `?url`).
 */
import { overlay as overlayManifest } from '../../assets/manifest.json';
import { assetUrl } from './asset-urls';

export type OverlayAssetId = keyof typeof overlayManifest;

/** Rozmer opakujúceho sa vzoru v px (manifest: `overlay.ghost_hatch.pattern`). */
export interface PatternSize {
  readonly w: number;
  readonly h: number;
}

/** URL overlay assetu podľa id z manifestu (napr. `ghost_hatch`); neznáme id alebo chýbajúci súbor je chyba. */
export function overlayAssetUrl(id: OverlayAssetId): string {
  const entry: { readonly file: string } = overlayManifest[id];
  return assetUrl(entry.file);
}

/** Rozmer vzoru `ghost_hatch` z manifestu (šrafa nad `--ghost-invalid`). */
export const GHOST_HATCH_PATTERN: PatternSize = overlayManifest.ghost_hatch.pattern;

/** Okraje 9-slice `selection_ring` v px zdrojovej textúry (`overlay.selection_ring.nineSlice`). */
export const SELECTION_RING_SLICE: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } =
  overlayManifest.selection_ring.nineSlice;

/** Rozmer `overlay.path_arrow` v bunkách (manifest: `footprint`, 1×1; šípka smeruje na sever pri rotácii 0). */
export const PATH_ARROW_FOOTPRINT: { readonly w: number; readonly h: number } = overlayManifest.path_arrow.footprint;
