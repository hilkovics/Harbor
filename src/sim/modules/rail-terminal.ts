/**
 * Železničný terminál (R6, ADR-043; docs/TERMINAL_2.md §4.1, §6.9) — blok `rmg_rail_block` (16 bays × 6): `tracks` koľají (stĺpce `trackCol …`), buffer stohu `bays × rows × maxTier`
 * (4 rady × 4 vrstvy) a jednosmerný pruh pre ťahače (`laneCol`) s TP pod rámom RMG. Obsluhuje ho `RmgCrane` (TR6-02); táto trieda dodáva geometriu koľají pre vlak a buffer (`YardBlock`).
 *
 * **Koľaj** má pre každý bay jednu bunku footprintu (lokálne `y = bay`, pri rotácii 0 zhora nadol); vlak do nej vchádza zo **vonkajšej bunky** koľajového konektora (strana `n`, bay 0), kde musí byť
 * koľaj mapy (`Cell.road = 'rail'`). Koľaj je slepá (vlak ide dnu a vychádza tou istou cestou). Bunky koľají nie sú vrstva `rail` mapy (leží na nich modul), preto ich dodáva `trackCells`.
 *
 * Je to RTG blok s koľajami (`extends RtgBlock`): pruh pre ťahače, TP a stroj bloku (`RmgCrane`, krok 6c) sú rovnaké; plánovač doň ukladá len jednotky určené na odvoz vlakom a export privezený vlakom.
 */
import type { CargoDirection } from '../cargo/cargo-unit';
import type { CellCoord } from '../grid/grid';
import { rotateLocalCell } from '../grid/rotation';
import { ModuleError } from './module-error';
import type { ModuleInit } from './module';
import { connectorOutside } from './module-geometry';
import { RtgBlock } from './rtg-block';

/** Kategória nákladu terminálu. */
export const RAIL_TERMINAL_CATEGORY = 'container';

export class RailTerminal extends RtgBlock {
  /** Prvý stĺpec koľají vo footprinte pri rotácii 0 (`params.trackCol`). */
  readonly trackCol: number;
  /** Počet koľají (`params.tracks`). */
  readonly tracks: number;
  private readonly trackCellList: readonly (readonly CellCoord[])[];
  private readonly entryList: readonly CellCoord[];

  /** Def musí mať `params.role = 'rail_terminal'`, geometriu bloku, pruh, `trackCol`, `tracks` a presne `tracks` koľajových konektorov na strane vjazdu (inak `ModuleError('invalid_input')`). */
  constructor(init: ModuleInit) {
    super(init);
    const { role, bays, trackCol, tracks } = this.params;
    if (role !== 'rail_terminal' || bays === undefined || trackCol === undefined || tracks === undefined) {
      throw new ModuleError('invalid_input', `${this.label}: železničný terminál vyžaduje params.role 'rail_terminal', geometriu bloku, laneCol, tpSpacingBays, trackCol a tracks`);
    }
    this.trackCol = trackCol;
    this.tracks = tracks;
    const { w, h } = this.def.footprint;
    this.trackCellList = Object.freeze(
      Array.from({ length: tracks }, (_, track) =>
        Object.freeze(
          Array.from({ length: bays }, (_unused, bay): CellCoord => {
            const local = rotateLocalCell(trackCol + track, bay, w, h, this.rotation);
            return Object.freeze({ x: this.origin.x + local.x, y: this.origin.y + local.y });
          }),
        ),
      ),
    );
    const railConnectors = this.connectors.filter((connector) => connector.type === 'rail');
    if (railConnectors.length !== tracks) {
      throw new ModuleError('invalid_input', `${this.label}: železničný terminál s ${String(tracks)} koľajami vyžaduje presne toľko koľajových konektorov, má ${String(railConnectors.length)}`);
    }
    this.entryList = Object.freeze(railConnectors.map((connector) => Object.freeze(connectorOutside(connector))));
  }

  /**
   * Terminál prijíma import (buffer pre vlak) a export (z vlaku do bufferu, kým ho neodvezie loď); o jednotke rozhoduje plánovač (`acceptsUnit`): len jednotky určené na odvoz vlakom
   * (`logistics/rail-units.ts`), nie kamiónový tok.
   */
  override acceptsDirection(direction: CargoDirection): boolean {
    return direction === 'import' || direction === 'export';
  }

  /** Bunky koľaje `track` vo svete od vjazdu (bay 0) po koniec (bay `bays − 1`). */
  trackCells(track: number): readonly CellCoord[] {
    const cells = this.trackCellList[track];
    if (cells === undefined) throw new ModuleError('invalid_input', `${this.label}: koľaj ${String(track)} neexistuje`);
    return cells;
  }

  /** Vonkajšia bunka vjazdu koľaje `track` (leží mimo footprintu; má na nej byť koľaj mapy). */
  trackEntry(track: number): CellCoord {
    const cell = this.entryList[track];
    if (cell === undefined) throw new ModuleError('invalid_input', `${this.label}: koľaj ${String(track)} neexistuje`);
    return cell;
  }
}
