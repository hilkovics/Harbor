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
import { SIDES, type Side } from '../defs/types';
import { DIRECTIONS_4 } from '../grid/grid';
import { rotateLocalCell } from '../grid/rotation';
import { BerthModule } from '../modules/berth-module';
import { CraneModule } from '../modules/crane-module';
import { hookCellCoord } from '../modules/hook-cell';
import type { Module } from '../modules/module';
import { edgeCells, rotateSide } from '../modules/module-geometry';
import { RtgBlock } from '../modules/rtg-block';
import { HANDOVERS } from '../systems/crane-handover';
import type { QuayCells } from './pathfinder';

/** Čo `QuayLanes` číta zo sveta (`World` to spĺňa). */
export interface QuaySource {
  readonly moduleVersion: number;
  readonly modules: ReadonlyMap<EntityId, Module>;
}

/**
 * Má modul jazdné bunky mimo cestnej siete: kotvisko s nábrežím pod hákom (režim odovzdávania s vozidlom pod žeriavom), alebo RTG blok
 * s pruhom pre ťahače (ADR-040, TR3-02)?
 */
export function hasQuayLane(module: Module): boolean {
  return module instanceof RtgBlock || module instanceof BerthModule;
}

/** Má kotvisko jazdné nábrežie pod hákom (`under_hook`)? V režime `apron` je z kotviska jazdná len obchádzka (pevninský riadok), vozidlo v ňom nestojí. */
function hasHookCells(berth: BerthModule): boolean {
  return HANDOVERS[berth.params.handoverMode].vehiclesUnderHook;
}

/** Bitová maska všetkých štyroch smerov (`DIRECTIONS_4[i].bit`): bunka bez obmedzenia smeru. */
const ALL_DIRECTIONS = DIRECTIONS_4.reduce((mask, direction) => mask | direction.bit, 0);

/** Bit smeru s indexom `side` (poradie `Side` n, e, s, w = poradie `DIRECTIONS_4`). */
const bitOf = (sideIndex: number): number => DIRECTIONS_4[sideIndex].bit;

/** Smer pruhov kotviska: o štvrťotáčku v smere hodín od strany pri vode (rot 0: voda `n` → pruhy idú `e`, zľava doprava). */
const BERTH_LANE_TURN = 90;
/** Smer pruhu RTG bloku: od vjazdu (bay 0) k výjazdu, pri rotácii 0 smerom `s`. */
const RTG_LANE_SIDE: Side = 's';
/** Otočenie o pol otáčky: pevninská hrana kotviska je opačná k hrane pri vode. */
const HALF_TURN = 180;

/** Index strany v poradí `n, e, s, w`. */
function sideIndex(side: Side): number {
  return SIDES.indexOf(side);
}

export class QuayLanes implements QuayCells {
  private readonly cells: Int32Array;
  /** Povolené smery vstupu do bunky a výstupu z nej (maska `DIRECTIONS_4[i].bit`); bunka mimo pruhov má všetky. */
  private readonly masks: Uint8Array;
  /** Priechodné bunky (obchádzka kotviska): vozidlo ich smie použiť na tranzit, aj keď cieľ ani začiatok trasy v kotvisku nie je. */
  private readonly through: Uint8Array;
  /** Bunky pruhu RTG bloku podľa id bloku: index bunky bayu `b` na pozícii `b`. */
  private readonly laneCells = new Map<EntityId, Int32Array>();
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
    this.masks = new Uint8Array(cellCount).fill(ALL_DIRECTIONS);
    this.through = new Uint8Array(cellCount);
  }

  /** Je bunka obchádzkou kotviska (pevninský riadok, tranzit bez zastavovania)? Cestná sieť sa cez ňu spája (ADR-040, TR3-02). */
  isThrough(index: number): boolean {
    this.refresh();
    return this.through[index] !== 0;
  }

  /**
   * Smie vozidlo urobiť krok `from → to` v smere `direction` (index v `DIRECTIONS_4`)? Pruhy sú jednosmerné (ADR-040): z bunky pruhu aj do nej
   * sa ide len v smere pruhu (kotvisko: proti smeru jazdy nie, kolmo medzi pruhmi áno; pruh RTG bloku: len pozdĺž), bunky mimo pruhov krok neobmedzujú.
   */
  stepAllowed(from: number, to: number, direction: number): boolean {
    this.refresh();
    const bit = DIRECTIONS_4[direction].bit;
    return (this.masks[from] & bit) !== 0 && (this.masks[to] & bit) !== 0;
  }

  /** Bunky pruhu RTG bloku (index bunky bayu `b` na pozícii `b`); `undefined` pre neznámy blok. */
  laneCellsOf(blockId: EntityId): Int32Array | undefined {
    this.refresh();
    return this.laneCells.get(blockId);
  }

  /** Smer pruhov kotviska `berth` (strana `n/e/s/w` v svete): zľava doprava pri rotácii 0, otočený s modulom. */
  static berthLaneSide(berth: BerthModule): Side {
    return rotateSide(berth.waterSide, BERTH_LANE_TURN);
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
    this.masks.fill(ALL_DIRECTIONS);
    this.through.fill(0);
    this.hooks.clear();
    this.laneCells.clear();
    for (const module of this.source.modules.values()) {
      if (!hasQuayLane(module)) continue;
      if (module instanceof BerthModule) this.markBerth(module);
      else if (module instanceof RtgBlock) this.markBlockLane(module);
    }
    for (const module of this.source.modules.values()) {
      if (!(module instanceof CraneModule)) continue;
      const berth = this.source.modules.get(module.berthId);
      if (!(berth instanceof BerthModule) || !hasHookCells(berth)) continue;
      const { x, y } = hookCellCoord(module, berth);
      this.hooks.set(module.id, y * this.width + x);
    }
  }

  /**
   * Nábrežie kotviska: všetky bunky footprintu okrem riadku pri vode (tam stoja nohy žeriavov, nie jazda). Riadky pod žeriavom sú dva jednosmerné
   * pruhy (TP je bunka pod hákom) a pevninský riadok je obchádzka bez zastavovania (TP tam nikdy nie je); všetky idú v smere pruhov.
   */
  private markBerth(berth: BerthModule): void {
    const waterEdge = new Set(edgeCells(berth.origin, berth.size, berth.waterSide).map(({ x, y }) => y * this.width + x));
    const landEdge = new Set(edgeCells(berth.origin, berth.size, rotateSide(berth.waterSide, HALF_TURN)).map(({ x, y }) => y * this.width + x));
    const laneSide = QuayLanes.berthLaneSide(berth);
    const laneIndex = sideIndex(laneSide);
    const forbidden = bitOf((laneIndex + 2) % DIRECTIONS_4.length);
    // Kolmý prejazd medzi pruhmi je v prvej polovici kotviska (v smere pruhov) len k vode, v druhej len k pevnine: vozidlo vojde zľava, v druhej polovici sa vráti k obchádzke
    // a odíde — dve vozidlá sa tak v jednej bunke nikdy nestretnú čelne (ADR-040, TR3-02).
    const towardWater = bitOf(sideIndex(berth.waterSide));
    const towardLand = bitOf((sideIndex(berth.waterSide) + 2) % DIRECTIONS_4.length);
    const half = Math.floor((laneIndex % 2 === 1 ? berth.size.w : berth.size.h) / 2);
    for (const { x, y } of berth.cells) {
      const index = y * this.width + x;
      if (waterEdge.has(index)) continue;
      const along = this.alongLane(berth, laneSide, x, y);
      this.cells[index] = berth.id;
      this.masks[index] = ALL_DIRECTIONS & ~forbidden & ~(along < half ? towardLand : towardWater);
      if (landEdge.has(index)) this.through[index] = 1;
    }
  }

  /** Poloha bunky pozdĺž smeru pruhov (0 = začiatok kotviska, kde pruhy začínajú). */
  private alongLane(berth: BerthModule, laneSide: Side, x: number, y: number): number {
    const { origin, size } = berth;
    if (laneSide === 'e') return x - origin.x;
    if (laneSide === 'w') return origin.x + size.w - 1 - x;
    if (laneSide === 's') return y - origin.y;
    return origin.y + size.h - 1 - y;
  }

  /** Pruh RTG bloku: bunky stĺpca `laneCol` od vjazdu (bay 0) k výjazdu; vstup aj výstup len v smere pruhu. */
  private markBlockLane(block: RtgBlock): void {
    const { w, h } = block.def.footprint;
    const mask = bitOf(sideIndex(rotateSide(RTG_LANE_SIDE, block.rotation)));
    const lane = new Int32Array(block.geometry.bays);
    for (let bay = 0; bay < lane.length; bay++) {
      const local = rotateLocalCell(block.laneCol, bay, w, h, block.rotation);
      const index = (block.origin.y + local.y) * this.width + block.origin.x + local.x;
      this.cells[index] = block.id;
      this.masks[index] = mask;
      lane[bay] = index;
    }
    this.laneCells.set(block.id, lane);
  }
}
