/**
 * Skupiny kotvísk (ARCHITECTURE §5.4, ADR-014). Kotviská s rovnakou `waterSide`, ktorých hrany pri vode ležia na
 * tej istej línii pobrežia a ktorých krátke hrany sa dotýkajú, tvoria `BerthGroup` — loď dlhšia než jedno kotvisko
 * môže obsadiť súvislý úsek skupiny.
 *
 * Geometria podľa strany (tabuľka `COAST_AXES`, nie switch):
 * - `n`/`s`: línia = riadok hrany pri vode (`origin.y`, resp. `origin.y + h − 1`), poloha po pobreží = `x`;
 * - `e`/`w`: línia = stĺpec hrany pri vode (`origin.x + w − 1`, resp. `origin.x`), poloha po pobreží = `y`.
 * Dva berthy sa dotýkajú, keď koniec prvého (`start + lengthCells`) = začiatok druhého.
 *
 * Deterministické poradie (nezávislé od poradia stavby): berthy v skupine stúpajúco podľa polohy po pobreží
 * (`x` pri n/s, `y` pri e/w); skupiny zoradené podľa (`waterSide` v poradí `SIDES`, línia, začiatok) a číslované
 * od 1.
 */
import type { EntityId } from '../core/entity-id';
import { SIDES, type Side } from '../defs/types';
import type { CellCoord } from '../grid/grid';
import type { BerthModule } from './berth-module';

export interface BerthGroup {
  /** Id skupiny (1, 2, …) — platí do ďalšieho prepočtu (place/remove berthu). */
  readonly id: number;
  /** Berthy v poradí po pobreží. */
  readonly berthIds: readonly EntityId[];
  /** Súčet `lengthCells`. */
  readonly totalLength: number;
  /** Najmenšia efektívna `depthClass` v skupine. */
  readonly minDepth: number;
}

/** Poloha hrany pri vode: línia pobrežia a začiatok úseku po pobreží. */
interface CoastPosition {
  readonly line: number;
  readonly start: number;
}

type CoastAxis = (origin: CellCoord, size: { readonly w: number; readonly h: number }) => CoastPosition;

const COAST_AXES: { readonly [S in Side]: CoastAxis } = {
  n: (origin) => ({ line: origin.y, start: origin.x }),
  e: (origin, size) => ({ line: origin.x + size.w - 1, start: origin.y }),
  s: (origin, size) => ({ line: origin.y + size.h - 1, start: origin.x }),
  w: (origin) => ({ line: origin.x, start: origin.y }),
};

interface CoastEntry {
  readonly berth: BerthModule;
  readonly side: number;
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

function coastEntry(berth: BerthModule): CoastEntry {
  const { line, start } = COAST_AXES[berth.waterSide](berth.origin, berth.size);
  return { berth, side: SIDES.indexOf(berth.waterSide), line, start, end: start + berth.lengthCells };
}

/** Poradie (strana, línia, začiatok) — úplné, lebo dva berthy na tej istej línii nemôžu mať rovnaký začiatok. */
function compareCoast(a: CoastEntry, b: CoastEntry): number {
  return a.side - b.side || a.line - b.line || a.start - b.start;
}

/**
 * Skupiny zo zoznamu berthov (čistá funkcia, berthy nemení). Každý berth je v práve jednej skupine; poradie
 * skupín, ich id aj poradie `berthIds` je deterministické (viď hlavička súboru).
 */
export function computeBerthGroups(berths: Iterable<BerthModule>): readonly BerthGroup[] {
  const entries = [...berths].map(coastEntry).sort(compareCoast);
  const chains: CoastEntry[][] = [];
  let previous: CoastEntry | undefined;
  for (const entry of entries) {
    const touches = previous !== undefined && previous.side === entry.side && previous.line === entry.line && previous.end === entry.start;
    if (touches) chains[chains.length - 1].push(entry);
    else chains.push([entry]);
    previous = entry;
  }
  return Object.freeze(
    chains.map((chain, index): BerthGroup =>
      Object.freeze({
        id: index + 1,
        berthIds: Object.freeze(chain.map((entry) => entry.berth.id)),
        totalLength: chain.reduce((sum, entry) => sum + entry.berth.lengthCells, 0),
        minDepth: Math.min(...chain.map((entry) => entry.berth.depthClass)),
      }),
    ),
  );
}
