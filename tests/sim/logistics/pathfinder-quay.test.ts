// Nábrežie pod hákom v A* (F6d, ADR-033 dodatok T6D-02): bunky kotviska bez cesty sú uzlami len v hľadaní, ktorého začiatok alebo koniec leží
// v nábreží toho istého kotviska. Cestná sieť sa cez nábrežie nespája; bez nábrežia je A* zhodný s F3–F6c.
import { describe, expect, it } from 'vitest';
import { Pathfinder, type QuayCells } from '@sim/logistics';
import { roadGrid } from './road-fixtures';

/**
 * Cesta `.` pozdĺž y = 0 s medzerou na x = 2 (`#`), pod ňou nábrežie `Q` (bunky bez cesty, kotvisko 7) a vzdialené kotvisko `R` (kotvisko 9):
 * cestná sieť je prerušená, nábrežie by ju spojilo.
 */
const ROWS = [
  '..#..', // y0
  'QQQQ.', // y1: nábrežie kotviska 7 (x 0–3), cesta na x 4
  '.....', // y2
  'R....', // y3: nábrežie kotviska 9 na x 0
];
const WIDTH = 5;
const at = (x: number, y: number): number => y * WIDTH + x;

function quayOf(): QuayCells {
  const owners = new Int32Array(WIDTH * ROWS.length);
  ROWS.forEach((row, y) => {
    for (let x = 0; x < WIDTH; x++) {
      if (row[x] === 'Q') owners[at(x, y)] = 7;
      if (row[x] === 'R') owners[at(x, y)] = 9;
    }
  });
  return { owners: () => owners };
}

/** Mriežka: `.` cesta, `Q` / `R` pevnina bez cesty (nábrežie ide cez `QuayCells`). */
const grid = roadGrid(ROWS.map((row) => row.replace(/[QR]/g, '#')));

describe('Pathfinder s nábrežím: koniec hľadania v nábreží', () => {
  const pathfinder = new Pathfinder(grid, undefined, quayOf());

  it('z cestnej bunky do bunky nábrežia vedie cesta (nábrežie ako posledné bunky trasy)', () => {
    const path = pathfinder.findPath(at(1, 0), at(2, 1));
    expect(path).not.toBeNull();
    expect(path?.[0]).toBe(at(1, 0));
    expect(path?.at(-1)).toBe(at(2, 1));
  });

  it('z nábrežia na cestu: opačný smer, rovnaká dĺžka', () => {
    const there = pathfinder.findPath(at(1, 0), at(2, 1)) ?? [];
    const back = pathfinder.findPath(at(2, 1), at(1, 0)) ?? [];
    expect(back).toHaveLength(there.length);
  });

  it('cesta do nábrežia vedie po nábreží len toho istého kotviska (cez cudzie nábrežie 9 nie)', () => {
    // (0,2) je cesta pod nábrežím 7 aj nad nábrežím 9; do bunky (0,3) (nábrežie 9) sa ide priamo, nie cez nábrežie 7
    const path = pathfinder.findPath(at(0, 2), at(0, 3));
    expect(path).toEqual([at(0, 2), at(0, 3)]);
    // do nábrežia 7 z cesty y = 2 (cez nábrežie 7 hore)
    expect(pathfinder.findPath(at(0, 2), at(0, 1))).toEqual([at(0, 2), at(0, 1)]);
  });

  it('cesta medzi dvoma cestnými bunkami nábrežím nikdy neprejde: sieť prerušená medzerou ostáva neprepojená (null)', () => {
    expect(pathfinder.findPath(at(1, 0), at(3, 0))).toBeNull();
    expect(pathfinder.findPath(at(0, 0), at(4, 0))).toBeNull();
  });

  it('cesta medzi cestnými bunkami, ktorá nábrežie obchádza, vedie len po cestách', () => {
    const path = pathfinder.findPath(at(4, 1), at(0, 2)) ?? [];
    expect(path.length).toBeGreaterThan(0);
    for (const cell of path) expect(grid.atIndex(cell).road).toBe('road');
  });

  it('bunka bez cesty a mimo nábrežia nie je ani začiatkom, ani koncom (null)', () => {
    expect(pathfinder.findPath(at(2, 0), at(0, 2))).toBeNull(); // (2,0) = medzera bez cesty a bez nábrežia
    expect(pathfinder.findPath(at(0, 2), at(2, 0))).toBeNull();
  });
});

describe('Pathfinder bez nábrežia (režim apron): bitovo zhodné správanie ako pred F6d', () => {
  const pathfinder = new Pathfinder(grid);

  it('bunky nábrežia nie sú cesta: začiatok / koniec v nich → null, medzera ostáva neprejazdná', () => {
    expect(pathfinder.findPath(at(1, 0), at(2, 1))).toBeNull();
    expect(pathfinder.findPath(at(2, 1), at(1, 0))).toBeNull();
    expect(pathfinder.findPath(at(1, 0), at(3, 0))).toBeNull();
  });

  it('QuayCells bez jedinej bunky nábrežia dáva rovnaké cesty ako Pathfinder bez nábrežia (všetky dvojice cestných buniek)', () => {
    const empty = new Pathfinder(grid, undefined, { owners: () => new Int32Array(WIDTH * ROWS.length) });
    for (let from = 0; from < grid.cellCount; from++) {
      for (let to = 0; to < grid.cellCount; to++) expect(empty.findPath(from, to)).toEqual(pathfinder.findPath(from, to));
    }
  });
});
