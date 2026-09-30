/**
 * Polohy stojísk čakacej plochy a dokov rampy vo svete (F4): stred obdĺžnika `stalls[i]` / `docks[i]` z manifestu
 * (`sprites.<defId>`, px súboru pri rot 0) po rotácii modulu, v bunkách.
 *
 * Kamión stojí v stojisku alebo v doku vizuálne (sprite v strede obdĺžnika), hoci ho sim vedie na bunke cesty
 * (vstupná bunka stojiska, vonkajšia bunka konektora docku). Zdieľajú to demo renderu (`__demo__/f4-render.fixtures.ts`)
 * aj app vrstva (`TruckVM` v stave `waiting` / `loading`), preto to nie je v `__demo__`. Čisté funkcie bez Pixi.
 */
import { MANIFEST_CELL_PX, moduleSprite, type ManifestRect } from './entity-assets';
import { footprintPose, rotateOffset, type FootprintBox } from './footprint-pose';

/** Modul, ktorého stojiská / doky sa hľadajú: id defu (kľúč v manifeste) a footprint PO rotácii (ľavý horný roh, rozmery). */
export interface SlotHost extends FootprintBox {
  readonly defId: string;
}

/** Stred obdĺžnika `rect` (px súboru pri rot 0) modulu `host` vo svete v bunkách — stred stojiska / doku po rotácii modulu. */
export function rectCenterCells(host: SlotHost, rect: ManifestRect): { x: number; y: number } {
  const pose = footprintPose(host, 1);
  const rotated = rotateOffset(
    (rect.x + rect.w / 2) / MANIFEST_CELL_PX - pose.baseW / 2,
    (rect.y + rect.h / 2) / MANIFEST_CELL_PX - pose.baseH / 2,
    host.rotation,
  );
  return { x: pose.cx + rotated.x, y: pose.cy + rotated.y };
}

/** Stred stojiska `index` čakacej plochy vo svete (bunky), alebo `undefined`, ak ho manifest nepozná. */
export function findStallCenter(host: SlotHost, index: number): { x: number; y: number } | undefined {
  const stall = moduleSprite(host.defId)?.stalls?.[index];
  return stall === undefined ? undefined : rectCenterCells(host, stall);
}

/** Stred doku `index` rampy vo svete (bunky), alebo `undefined`, ak ho manifest nepozná. */
export function findDockCenter(host: SlotHost, index: number): { x: number; y: number } | undefined {
  const dock = moduleSprite(host.defId)?.docks?.[index];
  return dock === undefined ? undefined : rectCenterCells(host, dock);
}

/** Stred stojiska `index` čakacej plochy vo svete (bunky); modul alebo stojisko bez záznamu v manifeste → chyba. */
export function stallCenter(host: SlotHost, index: number): { x: number; y: number } {
  const center = findStallCenter(host, index);
  if (center === undefined) throw new Error(`module-slots: ${host.defId} nemá stojisko ${String(index)}`);
  return center;
}

/** Stred doku `index` rampy vo svete (bunky); modul alebo dok bez záznamu v manifeste → chyba. */
export function dockCenter(host: SlotHost, index: number): { x: number; y: number } {
  const center = findDockCenter(host, index);
  if (center === undefined) throw new Error(`module-slots: ${host.defId} nemá dok ${String(index)}`);
  return center;
}
