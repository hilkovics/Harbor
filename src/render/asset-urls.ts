/**
 * Adresy SVG assetov sveta (`assets/{terrain,infra,overlay}/*.svg`) podľa cesty zo `assets/manifest.json`.
 *
 * Názvy súborov sa nepíšu do kódu: berú sa z manifestu (`<sekcia>.<id>.file`, napr. `terrain/quay.svg`). URL rieši Vite
 * (`?url` cez `import.meta.glob`), takže funguje v dev aj v builde (s hashom v názve). Jediné miesto, kde sa
 * assety mapujú na URL — `overlay-assets.ts` a `sprite-atlas.ts` ho iba používajú.
 */

/** Kľúč = cesta relatívne k tomuto súboru, hodnota = URL, ktorú vydá Vite. */
const ASSET_URLS = import.meta.glob<string>('../../assets/{terrain,infra,overlay}/*.svg', {
  query: '?url',
  import: 'default',
  eager: true,
});

/** URL assetu podľa cesty z manifestu (napr. `terrain/quay.svg`); chýbajúci súbor je chyba (fail-fast). */
export function assetUrl(file: string): string {
  const url = ASSET_URLS[`../../assets/${file}`];
  if (url === undefined) {
    throw new Error(`asset: súbor assets/${file} z manifestu sa nenašiel medzi zabalenými SVG`);
  }
  return url;
}
