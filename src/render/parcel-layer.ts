/**
 * ParcelLayer (DESIGN_BRIEF §5.1): obrys každej parcely po jej obvode, farba a štýl podľa vlastníctva.
 *
 * - `none` → `parcel_outline_for_sale` (prerušovaný, `--parcel-for-sale`), `owned` → `parcel_outline_owned`,
 *   `leased` → `parcel_outline_leased`;
 * - sprite je 9-slice (`terrain.parcel_outline_*.nineSlice` z manifestu, 8 px): rohy sa nemenia, hrany sa natiahnu
 *   na rozmer parcely, takže rám má vždy rovnakú hrúbku 2 px bez ohľadu na veľkosť parcely.
 *
 * Len vizuál (bez interakcie — ParcelPanel je vo F7). Dôvod: stavba ciest podľa parciel (ADR-008), hráč musí vidieť,
 * kde parcela na predaj začína. Vlastníctvo sa vo F1 nemení; `refresh()` znova prečíta `parcel.ownership` (volať pri
 * zmene vlastníctva) a prekreslí len zmenené obrysy.
 *
 * Hrúbka: pri zoome pod 1 by 2 px rám (0,5 px pri zoome 0,25) zanikol, preto `setZoom` sprite zväčší (scale = 1 / zoom)
 * a zmenší jeho `width`/`height` o rovnaký podiel — obrys ostáva 2 px NA OBRAZOVKE, rozmer parcely sa nemení.
 * Pri zoome ≥ 1 je rám v pôvodnej veľkosti (2 px sveta).
 *
 * Bez textúr (`textures === null`, napr. testy bez DOM) padá na plný obrys z `Graphics` v tokenoch `--parcel-*`.
 * Vrstva je vlastná render group: mení sa iba pri zmene vlastníctva.
 */
import { Container, Graphics, NineSliceSprite } from 'pixi.js';
import { terrain as terrainManifest } from '../../assets/manifest.json';
import type { Parcel, ParcelOwnership } from '@sim/grid';
import type { SpriteTextures } from './sprite-atlas';
import type { ParcelPalette, RenderPalette } from './tokens';

/** Sprity obrysov parcely v manifeste (`terrain.parcel_outline_*`). */
export type ParcelOutlineId = 'parcel_outline_for_sale' | 'parcel_outline_owned' | 'parcel_outline_leased';

/** Sprite obrysu podľa vlastníctva (parcela bez vlastníka je na predaj). */
const OUTLINE_BY_OWNERSHIP: Readonly<Record<ParcelOwnership, ParcelOutlineId>> = Object.freeze({
  none: 'parcel_outline_for_sale',
  owned: 'parcel_outline_owned',
  leased: 'parcel_outline_leased',
});

/** Farba fallbacku (token `--parcel-*`) podľa vlastníctva. */
const PALETTE_KEY_BY_OWNERSHIP: Readonly<Record<ParcelOwnership, keyof ParcelPalette>> = Object.freeze({
  none: 'forSale',
  owned: 'owned',
  leased: 'leased',
});

/** Hrúbka obrysu vo fallbacku ako zlomok bunky (`--cell`); 2 px pri 64 px, rovnako ako v sprite. */
export const PARCEL_OUTLINE_CELLS = 1 / 32;

/** Id sprity obrysu pre vlastníctvo parcely. */
export function parcelOutlineId(ownership: ParcelOwnership): ParcelOutlineId {
  return OUTLINE_BY_OWNERSHIP[ownership];
}

interface OutlineItem {
  readonly parcel: Readonly<Parcel>;
  /** Vlastníctvo, s ktorým je obrys práve nakreslený. */
  ownership: ParcelOwnership;
  /** `NineSliceSprite` (textúra z atlasu) alebo `Graphics` (fallback). */
  readonly display: NineSliceSprite | Graphics;
}

/** Násobok veľkosti rámu, aby ostal čitateľný: 1 pri zoome ≥ 1, inak `1 / zoom` (hrúbka na obrazovke je konštantná). */
export function outlineScaleForZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError(`outlineScaleForZoom: zoom musí byť kladný, dostal ${String(zoom)}`);
  return Math.max(1, 1 / zoom);
}

export class ParcelLayer {
  /** Kontajner vrstvy; pridaj ho do sveta (súradnice v px pri zoome 1). */
  readonly view = new Container({ label: 'parcels', isRenderGroup: true });
  private readonly items: OutlineItem[] = [];
  /** Aktuálny násobok veľkosti rámu (`outlineScaleForZoom`). */
  private frameScale = 1;

  /**
   * @param parcels parcely v poradí mapy; berú sa ŽIVÉ objekty (`World.parcels`), aby `refresh()` videl nové `ownership`
   * @param textures sprity obrysov z `SpriteAtlas`; `null` = plný obrys z `Graphics`
   */
  constructor(
    parcels: readonly Readonly<Parcel>[],
    private readonly palette: RenderPalette,
    private readonly textures: SpriteTextures | null = null,
  ) {
    for (const parcel of parcels) {
      const item: OutlineItem = { parcel, ownership: parcel.ownership, display: this.createDisplay(parcel) };
      this.items.push(item);
      this.view.addChild(item.display);
      this.paint(item);
    }
  }

  /** Počet nakreslených obrysov (jeden na parcelu). */
  get outlineCount(): number {
    return this.items.length;
  }

  /** Sprite obrysu parcely `parcelId`, alebo `undefined` (neznáma parcela / režim `Graphics` fallback). */
  outlineOf(parcelId: string): ParcelOutlineId | undefined {
    const item = this.items.find((candidate) => candidate.parcel.id === parcelId);
    return item !== undefined && this.textures !== null ? parcelOutlineId(item.ownership) : undefined;
  }

  /** Násobok veľkosti rámu pre aktuálny zoom (1 = pôvodná hrúbka). */
  get scale(): number {
    return this.frameScale;
  }

  /**
   * Prispôsobí hrúbku rámu zoomu kamery (volá `WorldRenderer.syncCamera`); rozmer parcely sa nemení.
   * @returns `true`, ak sa hrúbka zmenila (pri zoome ≥ 1 sa nemení, kým sa zoom nezníži pod 1)
   */
  setZoom(zoom: number): boolean {
    const next = outlineScaleForZoom(zoom);
    if (next === this.frameScale) return false;
    this.frameScale = next;
    for (const item of this.items) this.paint(item);
    return true;
  }

  /**
   * Znova prečíta `ownership` parciel a prekreslí obrysy, ktorým sa zmenilo (kúpa, prenájom, ukončenie).
   * @returns počet prekreslených obrysov
   */
  refresh(): number {
    let changed = 0;
    for (const item of this.items) {
      if (item.ownership === item.parcel.ownership) continue;
      item.ownership = item.parcel.ownership;
      this.paint(item);
      changed += 1;
    }
    return changed;
  }

  destroy(): void {
    this.items.length = 0;
    this.view.destroy({ children: true });
  }

  private createDisplay(parcel: Readonly<Parcel>): NineSliceSprite | Graphics {
    const { cellPx } = this.palette;
    const { x, y, w, h } = parcel.rect;
    if (this.textures === null) return new Graphics();
    const display = new NineSliceSprite({
      texture: this.textures.terrain(parcelOutlineId(parcel.ownership)),
      width: w * cellPx,
      height: h * cellPx,
    });
    display.position.set(x * cellPx, y * cellPx);
    return display;
  }

  /** Nastaví textúru + 9-slice (sprite) alebo prekreslí obrys (fallback) podľa `item.ownership`. */
  private paint(item: OutlineItem): void {
    const { cellPx, parcel: colors } = this.palette;
    const { x, y, w, h } = item.parcel.rect;
    const { display, ownership } = item;
    if (display instanceof NineSliceSprite && this.textures !== null) {
      const id = parcelOutlineId(ownership);
      const { left, top, right, bottom } = terrainManifest[id].nineSlice;
      display.texture = this.textures.terrain(id);
      display.leftWidth = left;
      display.topHeight = top;
      display.rightWidth = right;
      display.bottomHeight = bottom;
      // Zväčšený rám (zoom < 1) zaberá rovnakú plochu: lokálny rozmer sa zmenší o rovnaký podiel.
      display.scale.set(this.frameScale);
      display.width = (w * cellPx) / this.frameScale;
      display.height = (h * cellPx) / this.frameScale;
    } else if (display instanceof Graphics) {
      const width = PARCEL_OUTLINE_CELLS * cellPx * this.frameScale;
      const { color, alpha } = colors[PALETTE_KEY_BY_OWNERSHIP[ownership]];
      display
        .clear()
        .rect(x * cellPx + width / 2, y * cellPx + width / 2, w * cellPx - width, h * cellPx - width)
        .stroke({ width, color, alpha });
    }
  }
}
