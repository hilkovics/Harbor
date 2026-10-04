/**
 * Ozdoba depa prázdnych kontajnerov (`ModuleVM.depot`, F6c, ADR-034 bod 3, 7): sprite depa je prefarbený dvor (sivé kontajnery,
 * `sprites.empty_depot` v manifeste) a táto ozdoba pridáva stav kontroly a opráv — odznak poškodených kontajnerov čakajúcich na
 * opravu (`--cargo-empty-damaged`, počet) a odznak opráv (`--ui-warning`, `v oprave / miesta opráv`). Odznaky sedia v ľavom hornom rohu
 * footprintu vedľa seba (pravý horný roh patrí odznaku hold) a sú vzpriamené pri každej rotácii modulu; nulový počet = bez odznaku.
 * Portálový žeriav depa kreslí `yard-crane-decor.ts` (sivý kontajner na spreaderi).
 */
import { Container } from 'pixi.js';
import { WARNING_BADGE_SIZE, manifestScale } from './entity-assets';
import { DepotBadge, damagedBadgeLabel, repairBadgeLabel, type DepotBadgeKind } from './depot-badge';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';
import type { ModuleVM } from './view-models';

/** Odsadenie odznaku od okraja footprintu a medzera medzi odznakmi v px zdroja (bunka 64 px). */
export const DEPOT_BADGE_INSET_PX = 2;
export const DEPOT_BADGE_GAP_PX = 10;

/** Jeden odznak: druh, poloha v lokálnom rámci modulu (px sveta pri rot 0) a text štítku. */
export interface DepotMark {
  readonly kind: DepotBadgeKind;
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

/**
 * Odznaky pre depo `vm.depot`: poškodené (ak sú) pri ľavom hornom rohu, opravy (ak niečo v oprave) hneď vedľa nich (alebo na jeho
 * mieste, keď poškodených niet). Čistá funkcia — `DepotDecor` ich len kreslí.
 */
export function depotMarks(vm: ModuleVM, context: ModuleDecorContext): DepotMark[] {
  const depot = vm.depot;
  if (depot === undefined) return [];
  const { cellPx } = context.deps;
  const unit = manifestScale(cellPx);
  const half = (WARNING_BADGE_SIZE.w / 2 + DEPOT_BADGE_INSET_PX) * unit;
  const step = (WARNING_BADGE_SIZE.w + DEPOT_BADGE_GAP_PX) * unit;
  const left = (-context.pose.baseW * cellPx) / 2;
  const top = (-context.pose.baseH * cellPx) / 2;
  const wanted: { kind: DepotBadgeKind; label: string }[] = [
    { kind: 'damaged' as const, label: damagedBadgeLabel(depot.damaged) },
    { kind: 'repair' as const, label: repairBadgeLabel(depot.inRepair, depot.repairBays) },
  ].filter((badge) => badge.label !== '');
  return wanted.map((badge, index) => ({ ...badge, x: left + half + index * step, y: top + half }));
}

export class DepotDecor implements ModuleDecor {
  readonly view = new Container({ label: 'depot-decor' });
  private readonly badges = new Map<DepotBadgeKind, DepotBadge>();
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

  /** Odznak druhu `kind` (`undefined`, ak nie je viditeľný) — pre testy. */
  badge(kind: DepotBadgeKind): DepotBadge | undefined {
    return this.badges.get(kind);
  }

  update(vm: ModuleVM): void {
    const marks = depotMarks(vm, this.context);
    const wanted = new Set(marks.map((mark) => mark.kind));
    this.badges.forEach((badge, kind) => {
      if (wanted.has(kind)) return;
      badge.destroy({ children: true });
      this.badges.delete(kind);
    });
    for (const mark of marks) {
      let badge = this.badges.get(mark.kind);
      if (badge === undefined) {
        badge = new DepotBadge(this.context.deps, mark.kind, -this.context.pose.angle, this.badgeScale);
        this.badges.set(mark.kind, badge);
        this.view.addChild(badge);
      }
      badge.position.set(mark.x, mark.y);
      badge.setLabel(mark.label);
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

export const depotDecorFactory: ModuleDecorFactory = {
  id: 'depot',
  applies: (vm) => vm.depot !== undefined,
  create: (vm, context) => new DepotDecor(vm, context),
};
