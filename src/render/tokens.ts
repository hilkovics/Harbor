/**
 * Čítanie dizajnových tokenov (`design/tokens.css`) pre render (DESIGN_BRIEF §3).
 *
 * Farby a rozmer bunky sa nikdy nepíšu do kódu — `RenderPalette` ich načíta raz pri štarte rendereru.
 * V prehliadači čítame `getComputedStyle(document.documentElement)`; v Node (unit testy) sa injektuje `TokenResolver`,
 * napr. `tokenResolverFromCss(<obsah tokens.css>)`.
 *
 * Chýbajúci alebo nečitateľný token je chyba (žiadny tichý fallback): vzhľad sveta má jeden zdroj pravdy.
 */

/** Vráti surovú hodnotu custom property (`--terrain-land`) alebo prázdny reťazec, ak neexistuje. */
export type TokenResolver = (name: string) => string;

/** Farba pre Pixi: `0xRRGGBB` + samostatná priehľadnosť 0…1. */
export interface ColorValue {
  readonly color: number;
  readonly alpha: number;
}

/** Vypočítaný štýl koreňa dokumentu; mimo prehliadača (bez `document`) vyhodí chybu — treba injektovať resolver. */
export const documentTokenResolver: TokenResolver = (name) => {
  if (typeof document === 'undefined') {
    throw new Error(`Token ${name}: bez DOM treba injektovať TokenResolver (napr. tokenResolverFromCss).`);
  }
  return getComputedStyle(document.documentElement).getPropertyValue(name);
};

const COMMENT = /\/\*[\s\S]*?\*\//g;
const DECLARATION = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]*?)\s*;/g;

/** Resolver nad textom CSS: prečíta deklarácie `--meno: hodnota;` (neskoršie prepíše skoršie), komentáre ignoruje. */
export function tokenResolverFromCss(css: string): TokenResolver {
  const tokens = new Map<string, string>();
  for (const match of css.replace(COMMENT, '').matchAll(DECLARATION)) {
    tokens.set(match[1], match[2]);
  }
  return (name) => tokens.get(name) ?? '';
}

const HEX_COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i;

/** Rozparsuje CSS farbu `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)` alebo `rgba(r,g,b,a)`; iné je chyba. */
export function parseCssColor(value: string): ColorValue {
  const text = value.trim();
  const hex = HEX_COLOR.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join('');
    const color = parseInt(digits.slice(0, 6), 16);
    const alpha = digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1;
    return { color, alpha };
  }
  const rgb = RGB_COLOR.exec(text);
  if (rgb) {
    const channels = [rgb[1], rgb[2], rgb[3]].map(Number);
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if (channels.every((channel) => channel <= 255) && alpha >= 0 && alpha <= 1) {
      return { color: (channels[0] << 16) | (channels[1] << 8) | channels[2], alpha };
    }
  }
  throw new Error(`Neplatná CSS farba: "${value}"`);
}

const PX_LENGTH = /^(\d+(?:\.\d+)?)px$/;

/** Rozparsuje kladnú dĺžku v px (`64px`); iné jednotky sú chyba. */
export function parseCssPx(value: string): number {
  const match = PX_LENGTH.exec(value.trim());
  const px = match ? Number(match[1]) : 0;
  if (px <= 0) throw new Error(`Neplatná dĺžka v px: "${value}"`);
  return px;
}

function readRaw(name: string, resolve: TokenResolver): string {
  const raw = resolve(name).trim();
  if (raw === '') throw new Error(`Token ${name} nie je definovaný (je design/tokens.css načítaný?).`);
  return raw;
}

/** Farba z tokenu (`--terrain-land`). */
export function readColorToken(name: string, resolve: TokenResolver = documentTokenResolver): ColorValue {
  return parseCssColor(readRaw(name, resolve));
}

/** Dĺžka v px z tokenu (`--cell`). */
export function readLengthToken(name: string, resolve: TokenResolver = documentTokenResolver): number {
  return parseCssPx(readRaw(name, resolve));
}

/** Farby terénu (DESIGN_BRIEF §3 „Herný svet“). */
export interface TerrainPalette {
  readonly waterDeep: ColorValue;
  readonly waterShallow: ColorValue;
  readonly waterFoam: ColorValue;
  readonly quay: ColorValue;
  readonly quayEdge: ColorValue;
  readonly land: ColorValue;
  readonly landAlt: ColorValue;
  readonly blocked: ColorValue;
}

/** Farby ciest (DESIGN_BRIEF §3 „Infraštruktúra“). */
export interface RoadPalette {
  readonly base: ColorValue;
  readonly marking: ColorValue;
}

/** Farby obrysov parciel podľa vlastníctva (DESIGN_BRIEF §3 „Herný svet“). */
export interface ParcelPalette {
  readonly forSale: ColorValue;
  readonly owned: ColorValue;
  readonly leased: ColorValue;
}

/** Všetko, čo vrstvy sveta potrebujú z tokenov; načíta sa raz pri štarte. */
export interface RenderPalette {
  /** Veľkosť bunky v px pri zoome 1 (`--cell`). */
  readonly cellPx: number;
  readonly terrain: TerrainPalette;
  readonly road: RoadPalette;
  readonly parcel: ParcelPalette;
}

/** Načíta paletu sveta z tokenov; chýbajúci token → chyba s jeho menom. */
export function loadRenderPalette(resolve: TokenResolver = documentTokenResolver): RenderPalette {
  const color = (name: string): ColorValue => readColorToken(name, resolve);
  return {
    cellPx: readLengthToken('--cell', resolve),
    terrain: {
      waterDeep: color('--terrain-water-deep'),
      waterShallow: color('--terrain-water-shallow'),
      waterFoam: color('--terrain-water-foam'),
      quay: color('--terrain-quay'),
      quayEdge: color('--terrain-quay-edge'),
      land: color('--terrain-land'),
      landAlt: color('--terrain-land-alt'),
      blocked: color('--terrain-blocked'),
    },
    road: {
      base: color('--road-base'),
      marking: color('--road-marking'),
    },
    parcel: {
      forSale: color('--parcel-for-sale'),
      owned: color('--parcel-owned'),
      leased: color('--parcel-leased'),
    },
  };
}
