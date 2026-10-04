/**
 * Ozdoba „jednotky vo VGM hold“ (`ModuleVM.held`, F6a, ADR-032 bod 7): exportná jednotka bez VGM sa pri bráne zdrží a nesmie sa
 * naložiť na loď. Sklad kreslí zrnitosť len ako fill stav (jednotky na slotoch sa nekreslia), preto je odznak `overlay.warning_badge`
 * s počtom na module; kde manifest pozná konkrétne miesto, sedí odznak pri ňom:
 *  - rampa: pri doku `docks[i]` (`held.docks[i] > 0`), v osi docku tesne za zadkom kamióna, ktorý v doku stojí (kamión cúva do docku,
 *    jeho zadok presahuje horný okraj docku o polovicu dĺžky kamióna mínus polovicu docku) — odznak neprekrýva kamión,
 *    ktorý sa kreslí nad modulmi, a odznaky susedných dokov sú oddelené;
 *  - berth: pri slote apronu `apronSlots[slot]` (`held.slots`), pravý horný roh bunky slotu;
 *  - inak (sklad, dock/slot bez záznamu v manifeste) jeden odznak s `held.count` v pravom hornom rohu footprintu.
 * Odznak je vzpriamený pri každej rotácii modulu a drží čitateľnú veľkosť pri zoome (`setBadgeScale`).
 */
import { Container } from 'pixi.js';
import { HoldBadge } from './badges';
import { WARNING_BADGE_SIZE, manifestScale, type ManifestPoint } from './entity-assets';
import { localCellCenter } from './footprint-pose';
import { TRUCK_LENGTH_PX } from './world-scale';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';
import type { ModuleVM } from './view-models';

/** Odsadenie odznaku od rohu footprintu / doku dovnútra v px zdroja (bunka 64 px). */
export const HOLD_BADGE_INSET_PX = 2;

/** Jeden odznak: stabilný kľúč, poloha v lokálnom rámci modulu (px sveta pri rot 0) a počet jednotiek. */
export interface HoldMark {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly count: number;
}

/**
 * Odznaky pre modul: z `vm.held` a manifestu (`context.entry`, `context.pose`). Čistá funkcia — rozhoduje, kde odznaky sú;
 * `HoldDecor` ich len kreslí.
 */
export function holdMarks(vm: ModuleVM, context: ModuleDecorContext): HoldMark[] {
  const held = vm.held;
  if (held === undefined || held.count <= 0) return [];
  const { cellPx } = context.deps;
  const { pose, entry } = context;
  const unit = manifestScale(cellPx);
  const half = (WARNING_BADGE_SIZE.w / 2 + HOLD_BADGE_INSET_PX) * unit;
  const left = (-pose.baseW * cellPx) / 2;
  const top = (-pose.baseH * cellPx) / 2;
  const marks: HoldMark[] = [];
  held.docks?.forEach((count, index) => {
    const dock = entry?.docks?.[index];
    if (count <= 0 || dock === undefined) return;
    const rear = dock.y + dock.h / 2 - TRUCK_LENGTH_PX / 2; // zadok kamióna v doku (px zdroja, lokálny rámec modulu)
    marks.push({ key: `dock-${String(index)}`, x: left + (dock.x + dock.w / 2) * unit, y: top + Math.max(half / unit, rear - half / unit) * unit, count });
  });
  held.slots?.forEach((slot) => {
    const cell = entry?.apronSlots?.[slot];
    if (cell === undefined) return;
    const at: ManifestPoint = localCellCenter(cell, pose.baseW, pose.baseH, cellPx);
    marks.push({ key: `slot-${String(slot)}`, x: at.x + cellPx / 2 - half, y: at.y - cellPx / 2 + half, count: 1 });
  });
  if (marks.length === 0) {
    marks.push({ key: 'module', x: -left - half, y: top + half, count: held.count });
  }
  return marks;
}

export class HoldDecor implements ModuleDecor {
  readonly view = new Container({ label: 'hold-decor' });
  private readonly badges = new Map<string, HoldBadge>();
  private badgeScale = 1;

  constructor(
    vm: ModuleVM,
    private readonly context: ModuleDecorContext,
  ) {
    this.update(vm);
  }

  /** Počet viditeľných odznakov — pre testy. */
  get badgeCount(): number {
    return this.badges.size;
  }

  /** Odznak s kľúčom (`module`, `dock-<i>`, `slot-<i>`) — pre testy. */
  badge(key: string): HoldBadge | undefined {
    return this.badges.get(key);
  }

  update(vm: ModuleVM): void {
    const marks = holdMarks(vm, this.context);
    const wanted = new Set(marks.map((mark) => mark.key));
    this.badges.forEach((badge, key) => {
      if (wanted.has(key)) return;
      badge.destroy({ children: true });
      this.badges.delete(key);
    });
    for (const mark of marks) {
      let badge = this.badges.get(mark.key);
      if (badge === undefined) {
        badge = new HoldBadge(this.context.deps, -this.context.pose.angle, this.badgeScale);
        this.badges.set(mark.key, badge);
        this.view.addChild(badge);
      }
      badge.position.set(mark.x, mark.y);
      badge.setCount(mark.count);
    }
  }

  setBadgeScale(scale: number): void {
    this.badgeScale = scale;
    this.badges.forEach((badge) => {
      badge.scale.set(scale);
    });
  }

  destroy(): void {
    this.badges.clear();
    this.view.destroy({ children: true });
  }
}

export const holdDecorFactory: ModuleDecorFactory = {
  id: 'hold',
  applies: (vm) => vm.held !== undefined,
  create: (vm, context) => new HoldDecor(vm, context),
};
