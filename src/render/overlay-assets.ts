/**
 * Adresy overlay assetov (`assets/overlay/*.svg`) podľa mena zo `assets/manifest.json`.
 *
 * Názvy súborov sa nepíšu do kódu: berú sa z manifestu (`overlay.<id>.file`). URL rieši Vite (`?url` cez
 * `import.meta.glob`), takže funguje v dev aj v builde (s hashom v názve).
 */
import { overlay as overlayManifest } from '../../assets/manifest.json';

/** Kľúč = cesta relatívne k tomuto súboru, hodnota = URL, ktorú vydá Vite. */
const OVERLAY_URLS = import.meta.glob<string>('../../assets/overlay/*.svg', { query: '?url', import: 'default', eager: true });

export type OverlayAssetId = keyof typeof overlayManifest;

/** Rozmer opakujúceho sa vzoru v px (manifest: `overlay.ghost_hatch.pattern`). */
export interface PatternSize {
  readonly w: number;
  readonly h: number;
}

/** URL overlay assetu podľa id z manifestu (napr. `ghost_hatch`); neznáme id alebo chýbajúci súbor je chyba. */
export function overlayAssetUrl(id: OverlayAssetId): string {
  const entry: { readonly file: string } = overlayManifest[id];
  const url = OVERLAY_URLS[`../../assets/${entry.file}`];
  if (url === undefined) {
    throw new Error(`overlay asset "${id}": súbor assets/${entry.file} z manifestu sa nenašiel`);
  }
  return url;
}

/** Rozmer vzoru `ghost_hatch` z manifestu (šrafa nad `--ghost-invalid`). */
export const GHOST_HATCH_PATTERN: PatternSize = overlayManifest.ghost_hatch.pattern;
