/**
 * Kontajnery podľa veľkosti, typu a linky (R2, TERMINAL_2 §3, rozhodnutie 11): výber sprite z manifestu `cargo.container_<sizeFt>_<dry|empty>` a farby
 * linky. Čisté funkcie bez Pixi (`CargoSprite`, `VehicleView` a `StacksDecor` ich len používajú), aby sa dali tabuľkovo testovať.
 *
 *  - **prázdny** (`direction: 'empty'`) je sivý sprite `container_<size>_empty` (netónuje sa);
 *  - **dry** (ostatné smery) je neutrálny sprite `container_<size>_dry` (`--container-neutral`), ktorý sa tónuje farbou linky (`--line-*`);
 *    kontajner bez linky (alebo s neznámou linkou) ostáva neutrálny;
 *  - iný `containerType` než `dry` (R5: `reefer`, `open_top`, `flat_rack`, `tank`) má vlastný sprite `container_<size>_<type>` (bez tónovania); typ bez sprite sa kreslí ako `dry`;
 *    `oog` → `container_<size>_<type>_oog`, ak existuje.
 *
 * Farba linky: `lineId` (`lines.json`, napr. `blue_anchor`) → `colorToken` (`line-blue`) → `EntityPalette.line`. Priamo zadaný token (`line-blue`) sa
 * akceptuje tiež.
 */
import lines from '../../data/defs/lines.json';
import { cargoSpriteEntry } from './entity-assets';
import { lineColorOf, type ColorValue, type EntityPalette } from './tokens';
import type { ContainerVM } from './view-models';

/** Typ kontajnera, ktorý sa tónuje farbou linky a ktorým sa kreslia typy bez vlastného sprite. */
export const DRY_CONTAINER_TYPE = 'dry';

/** Prípona sprite nadrozmerného kontajnera (`container_40_flat_rack_oog`). */
export const OOG_SUFFIX = '_oog';

/** `lineId` → `colorToken` z `data/defs/lines.json`. */
const LINE_TOKEN_OF_ID: ReadonlyMap<string, string> = new Map((lines as { items: readonly { id: string; colorToken: string }[] }).items.map((line) => [line.id, line.colorToken]));

/** Token farby linky (`line-blue`, …) pre `lineId` (alebo už zadaný token), alebo `undefined` pre neznámu / chýbajúcu linku. */
export function lineTokenOfId(lineId: string | null | undefined): string | undefined {
  if (lineId === null || lineId === undefined) return undefined;
  return LINE_TOKEN_OF_ID.get(lineId) ?? lineId;
}

/** Farba linky kontajnera (`EntityPalette.line`), alebo `undefined` — bez linky alebo s neznámou linkou. */
export function containerLineColor(palette: Pick<EntityPalette, 'line'>, lineId: string | null | undefined): ColorValue | undefined {
  return lineColorOf(palette, lineTokenOfId(lineId));
}

/** Id sprite v `manifest.cargo` pre kontajner: `container_20_empty`, `container_40_dry`, … (neznámy typ → `dry`). */
export function containerSpriteId(container: Pick<ContainerVM, 'sizeFt' | 'containerType' | 'direction'> & { readonly oog?: boolean }): string {
  const { sizeFt, containerType, direction } = container;
  if (direction === 'empty') return `container_${String(sizeFt)}_empty`;
  const typed = `container_${String(sizeFt)}_${containerType}`;
  if (container.oog === true && cargoSpriteEntry(`${typed}${OOG_SUFFIX}`) !== undefined) return `${typed}${OOG_SUFFIX}`;
  return cargoSpriteEntry(typed) !== undefined ? typed : `container_${String(sizeFt)}_${DRY_CONTAINER_TYPE}`;
}

/** Je kontajner prázdny (sivý, netónovaný)? */
export function isEmptyContainer(container: Pick<ContainerVM, 'direction'>): boolean {
  return container.direction === 'empty';
}

/** Kľúč štítkov kontajnera: dva kontajnery s rovnakým kľúčom sa kreslia rovnako (view sa vtedy nevytvára nanovo). */
export function containerKey(container: ContainerVM | null | undefined): string {
  if (container === null || container === undefined) return '';
  return `${String(container.sizeFt)}|${container.containerType}|${container.lineId ?? ''}|${container.direction}|${container.oog === true ? 'o' : ''}|${container.reefer ?? ''}`;
}
