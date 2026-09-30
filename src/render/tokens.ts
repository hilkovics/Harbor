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

/** Surová textová hodnota tokenu (`--font-ui`, `--fw-semibold`); prázdna hodnota je chyba. */
export function readStringToken(name: string, resolve: TokenResolver = documentTokenResolver): string {
  return readRaw(name, resolve);
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

/**
 * Podiel farby asfaltu (`--road-base`), ktorý ostane v okraji cesty (obrubník): sprity `road_*.svg` majú okraj #101113
 * pri asfalte #4B5058 (16/75, 17/80, 19/88 ≈ 0,215). Token pre okraj v `design/tokens.css` nie je (backlog), preto sa
 * okraj procedurálnych úzkych ciest odvodzuje z `--road-base`; `tests/render/road-layer-narrow.test.ts` hlási, ak sa
 * odvodená farba rozíde od okraja v spritoch.
 */
export const ROAD_EDGE_SHADE = 0.215;

/** Farby ciest (DESIGN_BRIEF §3 „Infraštruktúra“). */
export interface RoadPalette {
  readonly base: ColorValue;
  readonly marking: ColorValue;
  /** Okraj (obrubník) procedurálnych úzkych ciest: `--road-base` stmavený o `ROAD_EDGE_SHADE`. */
  readonly edge: ColorValue;
  /** Šípka smeru jednosmerky bez sprite `overlay.path_arrow` (`--ui-accent`, farba sprite). */
  readonly arrow: ColorValue;
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

/** Stmaví farbu na `factor` (0…1) jej jasu — každý kanál sa vynásobí a zaokrúhli; priehľadnosť ostáva. */
export function shadeColor(value: ColorValue, factor: number): ColorValue {
  const channel = (shift: number): number => Math.round(((value.color >> shift) & 0xff) * factor);
  return { color: (channel(16) << 16) | (channel(8) << 8) | channel(0), alpha: value.alpha };
}

/** Načíta paletu sveta z tokenov; chýbajúci token → chyba s jeho menom. */
export function loadRenderPalette(resolve: TokenResolver = documentTokenResolver): RenderPalette {
  const color = (name: string): ColorValue => readColorToken(name, resolve);
  const roadBase = color('--road-base');
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
      base: roadBase,
      marking: color('--road-marking'),
      edge: shadeColor(roadBase, ROAD_EDGE_SHADE),
      arrow: color('--ui-accent'),
    },
    parcel: {
      forSale: color('--parcel-for-sale'),
      owned: color('--parcel-owned'),
      leased: color('--parcel-leased'),
    },
  };
}

/** Farby fallbacku entít sveta (moduly, žeriavy, lode, vozidlá, náklad) — používajú sa, len keď chýba sprite. */
export interface EntityPalette {
  readonly module: { readonly base: ColorValue; readonly outline: ColorValue };
  readonly crane: { readonly frame: ColorValue; readonly boom: ColorValue };
  readonly ship: { readonly hull: ColorValue; readonly deck: ColorValue };
  /** Vozidlá na cestách (`--vehicle-body`, `--vehicle-dark`). */
  readonly vehicle: { readonly body: ColorValue; readonly dark: ColorValue };
  /** Kamióny bez sprite (`--truck-cab`, `--truck-trailer`). */
  readonly truck: { readonly cab: ColorValue; readonly trailer: ColorValue };
  /** Zvýraznenie obsadeného stojiska a obrys odznaku fronty (`--ui-accent`). */
  readonly accent: ColorValue;
  /** Výplň odznaku fronty bez sprite (`--ui-surface`). */
  readonly surface: ColorValue;
  /** Číslo v odznaku fronty: farba (`--ui-text`), písmo (`--font-ui`, `--fw-semibold`) a veľkosť (`--fs-xs`) v px pri 64 px bunke. */
  readonly label: {
    readonly color: ColorValue;
    readonly fontFamily: string;
    readonly fontWeight: string;
    readonly sizePx: number;
  };
  readonly cargo: { readonly base: ColorValue; readonly dark: ColorValue };
  /** Odznak zablokovania a stavový signál chyby (`--ui-danger`). */
  readonly danger: ColorValue;
  /** Značka konektora v build móde (`--module-connector`). */
  readonly connector: ColorValue;
  /** Odznak „nepripojené“ (`--module-disconnected`). */
  readonly disconnected: ColorValue;
}

/**
 * Načíta farby fallbacku entít z tokenov (DESIGN_BRIEF §3 „Moduly“, „Entity“, „Kategórie nákladu“); chýbajúci token →
 * chyba s jeho menom. Náklad používa farbu kategórie kontajnerov (`--cargo-container*`) — vo F2 jediná kategória.
 */
export function loadEntityPalette(resolve: TokenResolver = documentTokenResolver): EntityPalette {
  const color = (name: string): ColorValue => readColorToken(name, resolve);
  return {
    module: { base: color('--module-base'), outline: color('--module-outline') },
    crane: { frame: color('--crane-frame'), boom: color('--crane-boom') },
    ship: { hull: color('--ship-hull'), deck: color('--ship-deck') },
    vehicle: { body: color('--vehicle-body'), dark: color('--vehicle-dark') },
    truck: { cab: color('--truck-cab'), trailer: color('--truck-trailer') },
    accent: color('--ui-accent'),
    surface: color('--ui-surface'),
    label: {
      color: color('--ui-text'),
      fontFamily: readStringToken('--font-ui', resolve),
      fontWeight: readStringToken('--fw-semibold', resolve),
      sizePx: readLengthToken('--fs-xs', resolve),
    },
    cargo: { base: color('--cargo-container'), dark: color('--cargo-container-dark') },
    danger: color('--ui-danger'),
    connector: color('--module-connector'),
    disconnected: color('--module-disconnected'),
  };
}
