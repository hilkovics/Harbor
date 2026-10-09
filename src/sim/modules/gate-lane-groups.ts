/**
 * Zoskupenie susedných pruhov brány pre strechu v renderi (R4, ADR-041 bod 9; GDD 2): pruhy rovnakého smeru (`in` / `out`) a rovnakej rotácie, ktoré majú rovnaký
 * rozsah pozdĺž jazdy a ležia tesne vedľa seba (kolmo na smer jazdy), tvoria jednu strechu. `adjacentLaneGroups` vráti pre každý pruh jeho miesto v skupine:
 * `single` (samostatný pruh, strecha sa kreslí samostatne), `left` (prvý pruh skupiny — menšia kolmá súradnica), `mid` (vnútorný) a `right` (posledný). Čistá
 * funkcia modulov (bez stavu sveta), takže ju render číta zo snapshotu aj zo simu rovnako.
 */
import type { EntityId } from '../core/entity-id';
import type { Rotation } from '../grid/rotation';
import { TruckGate } from './truck-gate';
import type { Module } from './module';

export const LANE_ROOF_POSITIONS = ['single', 'left', 'mid', 'right'] as const;
export type LaneRoofPosition = (typeof LANE_ROOF_POSITIONS)[number];

/** Strecha jedného pruhu: poradie v skupine (`position`), index skupiny (`group`, od 0 podľa poradia súradníc) a veľkosť skupiny. */
export interface LaneRoofPlacement {
  readonly position: LaneRoofPosition;
  readonly group: number;
  readonly groupSize: number;
}

/** Os jazdy pruhu: rotácie 90 a 270 idú po x (pruh 4×1), 0 a 180 po y (pruh 1×4). */
const isHorizontal = (rotation: Rotation): boolean => rotation === 90 || rotation === 270;

interface LaneBox {
  readonly id: EntityId;
  readonly key: string;
  /** Začiatok a koniec pozdĺž jazdy (včítane). */
  readonly from: number;
  readonly to: number;
  /** Súradnica kolmo na jazdu a hrúbka (v bunkách). */
  readonly across: number;
  readonly thickness: number;
}

function boxOf(gate: TruckGate): LaneBox {
  const horizontal = isHorizontal(gate.rotation);
  const along = horizontal ? gate.origin.x : gate.origin.y;
  const across = horizontal ? gate.origin.y : gate.origin.x;
  const length = horizontal ? gate.size.w : gate.size.h;
  const thickness = horizontal ? gate.size.h : gate.size.w;
  return { id: gate.id, key: `${gate.direction}|${String(gate.rotation)}|${String(along)}|${String(length)}`, from: along, to: along + length - 1, across, thickness };
}

/**
 * Pre každý pruh brány (`TruckGate`) z `modules` vráti miesto na streche. Pruhy iných druhov sa ignorujú. Skupina = reťaz pruhov s rovnakým kľúčom
 * (smer, rotácia, začiatok a dĺžka pozdĺž jazdy), ktorých kolmé súradnice na seba bezprostredne nadväzujú (`across + thickness === ďalší across`).
 */
export function adjacentLaneGroups(modules: Iterable<Module>): ReadonlyMap<EntityId, LaneRoofPlacement> {
  const byKey = new Map<string, LaneBox[]>();
  for (const module of modules) {
    if (!(module instanceof TruckGate)) continue;
    const box = boxOf(module);
    const list = byKey.get(box.key);
    if (list === undefined) byKey.set(box.key, [box]);
    else list.push(box);
  }
  const chains: LaneBox[][] = [];
  for (const boxes of byKey.values()) {
    boxes.sort((a, b) => a.across - b.across || (a.id as number) - (b.id as number));
    let chain: LaneBox[] = [];
    for (const box of boxes) {
      const last = chain[chain.length - 1];
      if (last !== undefined && last.across + last.thickness !== box.across) {
        chains.push(chain);
        chain = [];
      }
      chain.push(box);
    }
    if (chain.length > 0) chains.push(chain);
  }
  chains.sort((a, b) => a[0].from - b[0].from || a[0].across - b[0].across || (a[0].id as number) - (b[0].id as number));
  const out = new Map<EntityId, LaneRoofPlacement>();
  chains.forEach((chain, group) => {
    chain.forEach((box, index) => {
      const position: LaneRoofPosition = chain.length === 1 ? 'single' : index === 0 ? 'left' : index === chain.length - 1 ? 'right' : 'mid';
      out.set(box.id, { position, group, groupSize: chain.length });
    });
  });
  return out;
}
