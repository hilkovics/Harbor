/**
 * Nábrežie pod hákom (F6d, ADR-033 dodatok T6D-02) — jazdné bunky kotvísk, pri ktorých sa jednotky odovzdávajú priamo vozidlu.
 *
 * V režime `under_hook` (`Handover.vehiclesUnderHook`) stojí vozidlo pri odovzdaní fyzicky **pod žeriavom**, nie na prístupovej bunke
 * cesty vedľa kotviska: celý footprint kotviska (nábrežie s apronom a žeriavmi) je pre vozidlo jazdný. Bunka nábrežia ostáva bez cesty
 * (`road === 'none'`, pod modulom cesta byť nesmie — invariant sveta); k A* (`Pathfinder`) a ku kontrole pohybu (`carrierMotionProblem`)
 * sa pridáva ako uzol len pri hľadaní s koncom v nábreží, takže cestná sieť sa cez nábrežie nespája (viď `pathfinder.ts`).
 * Režim `apron` nábrežie nemá — mriežka, cesty aj pohyb sú bitovo zhodné s F2–F6c.
 *
 * `QuayLanes` je odvodená cache (pole id kotviska podľa bunky): nie je stav simulácie ani časť save; pri zmene množiny modulov
 * (`World.moduleVersion`) sa pri najbližšom čítaní prepočíta. Pridanie / odstránenie takého kotviska zároveň zvyšuje `World.roadVersion`
 * (cache ciest a vzdialeností sa zneplatnia, vozidlá preplánujú).
 *
 * Do tej istej cache patrí aj **bunka pod hákom** každého žeriava takého kotviska (`hookCellOf`, T6D-05b): závisí len od geometrie, takže sa počíta pri prepočte
 * podľa `moduleVersion`, nie pri každom pláne trasy (`hookCellCoord` alokuje).
 */
import type { EntityId } from '../core/entity-id';
import { BerthModule } from '../modules/berth-module';
import { CraneModule } from '../modules/crane-module';
import { hookCellCoord } from '../modules/hook-cell';
import type { Module } from '../modules/module';
import { HANDOVERS } from '../systems/crane-handover';
import type { QuayCells } from './pathfinder';

/** Čo `QuayLanes` číta zo sveta (`World` to spĺňa). */
export interface QuaySource {
  readonly moduleVersion: number;
  readonly modules: ReadonlyMap<EntityId, Module>;
}

/** Má kotvisko jazdné nábrežie pod hákom (režim odovzdávania s vozidlom pod žeriavom)? */
export function hasQuayLane(module: Module): boolean {
  return module instanceof BerthModule && HANDOVERS[module.params.handoverMode].vehiclesUnderHook;
}

export class QuayLanes implements QuayCells {
  private readonly cells: Int32Array;
  /** Index bunky pod hákom podľa id žeriava (len žeriavy kotvísk s jazdným nábrežím). */
  private readonly hooks = new Map<EntityId, number>();
  private version = Number.NaN;

  /**
   * @param width šírka mriežky (index bunky = `y × width + x`)
   * @param cellCount počet buniek mriežky
   * @param source zdroj modulov a ich verzie (svet)
   */
  constructor(
    private readonly width: number,
    cellCount: number,
    private readonly source: QuaySource,
  ) {
    this.cells = new Int32Array(cellCount);
  }

  /** Pole `id kotviska` podľa indexu bunky (0 = bunka nie je nábrežím); po zmene modulov sa najprv prepočíta. */
  owners(): Readonly<Int32Array> {
    this.refresh();
    return this.cells;
  }

  /** Id kotviska, ktorého nábrežie bunku tvorí; 0 = žiadne. */
  ownerAt(index: number): number {
    return this.owners()[index] ?? 0;
  }

  /** Index bunky pod hákom žeriava `craneId`, ak jeho kotvisko má jazdné nábrežie; inak `undefined` (apron režim, neznámy žeriav). */
  hookCellOf(craneId: EntityId): number | undefined {
    this.refresh();
    return this.hooks.get(craneId);
  }

  /** Je bunka jazdným nábrežím nejakého kotviska? */
  isQuay(index: number): boolean {
    return this.ownerAt(index) !== 0;
  }

  private refresh(): void {
    const version = this.source.moduleVersion;
    if (version === this.version) return;
    this.version = version;
    this.cells.fill(0);
    this.hooks.clear();
    for (const module of this.source.modules.values()) {
      if (!hasQuayLane(module)) continue;
      for (const { x, y } of module.cells) this.cells[y * this.width + x] = module.id;
    }
    for (const module of this.source.modules.values()) {
      if (!(module instanceof CraneModule)) continue;
      const berth = this.source.modules.get(module.berthId);
      if (!(berth instanceof BerthModule) || !hasQuayLane(berth)) continue;
      const { x, y } = hookCellCoord(module, berth);
      this.hooks.set(module.id, y * this.width + x);
    }
  }
}
