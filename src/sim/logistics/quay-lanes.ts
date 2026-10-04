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
 */
import type { EntityId } from '../core/entity-id';
import { BerthModule } from '../modules/berth-module';
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

  /** Je bunka jazdným nábrežím nejakého kotviska? */
  isQuay(index: number): boolean {
    return this.ownerAt(index) !== 0;
  }

  private refresh(): void {
    const version = this.source.moduleVersion;
    if (version === this.version) return;
    this.version = version;
    this.cells.fill(0);
    for (const module of this.source.modules.values()) {
      if (!hasQuayLane(module)) continue;
      for (const { x, y } of module.cells) this.cells[y * this.width + x] = module.id;
    }
  }
}
