// WaterNavigator — A* lodí po vode (T5B-02, ADR-029): priechodnosť celého obdĺžnika lode, prekážky, otočenie
// a posun bokom, lexikografická cena (pohyby, potom manévre), deterministický výsledok a stredy buniek ako body trasy.
import { describe, expect, it } from 'vitest';
import { terrainFromChar, type TerrainType } from '@sim/grid';
import { AXIS_OF_HEADING, TrafficArea, WaterNavigator, boxHitsArea, shipBox, sweepRoute, type CellBox, type ShipPoint, type WaterGrid } from '@sim/ships';

const FEEDER = { lengthCells: 6, widthCells: 2 };

/** Mriežka z riadkov znakov mapy (`~` voda, `.` pevnina). */
function gridOf(rows: readonly string[]): WaterGrid {
  const width = rows[0].length;
  const cells: TerrainType[] = rows.flatMap((row) =>
    [...row].map((char) => {
      const terrain = terrainFromChar(char);
      if (terrain === undefined) throw new Error(`neznámy znak '${char}'`);
      return terrain;
    }),
  );
  return { width, height: rows.length, cellCount: cells.length, atIndex: (index) => ({ terrain: cells[index] }) };
}

const water = (width: number, height: number): string[] => Array.from({ length: height }, () => '~'.repeat(width));

/** Pózy lode po trase (bez zabratia), aby sa dali overiť body a kurzy. */
function areaOf(route: readonly ShipPoint[], start: ShipPoint, heading: 0 | 90 | 180 | 270): TrafficArea {
  const area = new TrafficArea();
  sweepRoute(area, FEEDER, { x: start.x, y: start.y, heading }, route);
  return area;
}

describe('WaterNavigator — geometria vody', () => {
  it('isWater: obdĺžnik celý v mape a na vode (prefixové súčty), inak false', () => {
    const nav = new WaterNavigator(gridOf(['~~~~', '~.~~', '~~~~']));
    expect(nav.isWater({ x0: 2, y0: 0, x1: 4, y1: 3 })).toBe(true);
    expect(nav.isWater({ x0: 0, y0: 0, x1: 2, y1: 2 })).toBe(false); // (1,1) je pevnina
    expect(nav.isWater({ x0: -1, y0: 0, x1: 1, y1: 1 })).toBe(false);
    expect(nav.isWater({ x0: 3, y0: 2, x1: 5, y1: 3 })).toBe(false);
  });

  it('cellOf oreže bod do mapy; centerOf a boxAt = stred bunky a obdĺžnik lode s osou', () => {
    const nav = new WaterNavigator(gridOf(water(10, 8)));
    expect(nav.cellOf({ x: 3.9, y: 2.1 })).toBe(2 * 10 + 3);
    expect(nav.cellOf({ x: -4, y: 99 })).toBe(7 * 10);
    expect(nav.centerOf(2 * 10 + 3)).toEqual({ x: 3.5, y: 2.5 });
    expect(nav.boxAt(FEEDER, 2 * 10 + 3, 0)).toEqual(shipBox(FEEDER, 3.5, 2.5, 90));
    expect(nav.boxAt(FEEDER, 2 * 10 + 3, 1)).toEqual(shipBox(FEEDER, 3.5, 2.5, 0));
    expect([AXIS_OF_HEADING[0], AXIS_OF_HEADING[90], AXIS_OF_HEADING[180], AXIS_OF_HEADING[270]]).toEqual([1, 0, 1, 0]);
  });
});

describe('WaterNavigator — tabuľka priechodnosti vody (T06-07)', () => {
  it('tabuľka stavu (bunka × os) = isWater(boxAt) pre párne aj nepárne rozmery lode, aj pri okraji mapy a pevnine', () => {
    const nav = new WaterNavigator(gridOf(['~~~~~~~~~', '~~.~~~~~~', '~~~~~~.~~', '~~~~~~~~~', '.~~~~~~~~', '~~~~~~~~~', '~~~~~~~..']));
    const grid = (nav as unknown as { grid: WaterGrid }).grid;
    const fits = (dims: { lengthCells: number; widthCells: number }): Uint8Array => (nav as unknown as { fits(d: typeof dims): Uint8Array }).fits(dims);
    for (const dims of [FEEDER, { lengthCells: 3, widthCells: 1 }, { lengthCells: 4, widthCells: 3 }, { lengthCells: 1, widthCells: 1 }, { lengthCells: 10, widthCells: 2 }]) {
      const table = fits(dims);
      expect(table).toHaveLength(grid.cellCount * 2);
      for (let cell = 0; cell < grid.cellCount; cell++) {
        for (const axis of [0, 1] as const) {
          expect(table[cell * 2 + axis], `${String(dims.lengthCells)}×${String(dims.widthCells)} bunka ${String(cell)} os ${String(axis)}`).toBe(nav.isWater(nav.boxAt(dims, cell, axis)) ? 1 : 0);
        }
      }
      expect(fits(dims)).toBe(table);
    }
  });
});

describe('WaterNavigator.findRoute', () => {
  it('rovno po osi: jediný bod = stred cieľovej bunky; štart = cieľ so správnou osou → prázdna trasa', () => {
    const nav = new WaterNavigator(gridOf(water(24, 10)));
    expect(nav.findRoute(FEEDER, 5 * 24 + 4, 90, 5 * 24 + 18, null, [])).toEqual([{ x: 18.5, y: 5.5 }]);
    expect(nav.findRoute(FEEDER, 5 * 24 + 4, 90, 5 * 24 + 4, 0, [])).toEqual([]);
  });

  it('najkratšia trasa s najmenej manévrami: jedno otočenie v rohu (kurz úseku podľa smeru, bez pevného kurzu)', () => {
    const nav = new WaterNavigator(gridOf(water(30, 30)));
    const route = nav.findRoute(FEEDER, 5 * 30 + 5, 90, 20 * 30 + 20, null, []);
    expect(route).toEqual([
      { x: 20.5, y: 5.5 },
      { x: 20.5, y: 20.5 },
    ]);
  });

  it('cieľová os: loď dorazí s dĺžkou pozdĺž požadovanej osi (otočenie na mieste v cieli sa vyjadrí ďalším bodom trasy)', () => {
    const nav = new WaterNavigator(gridOf(water(30, 30)));
    const route = nav.findRoute(FEEDER, 15 * 30 + 5, 90, 15 * 30 + 20, 1, []);
    expect(route).not.toBeNull();
    expect(route?.at(-1)).toMatchObject({ x: 20.5, y: 15.5 });
  });

  it('obíde prekážku (obdĺžnik lode, ktorá stojí): žiadna poloha na trase sa jej nedotkne', () => {
    const nav = new WaterNavigator(gridOf(water(30, 20)));
    const obstacle: CellBox = { x0: 12, y0: 6, x1: 16, y1: 14 };
    const start = nav.centerOf(10 * 30 + 4);
    const route = nav.findRoute(FEEDER, 10 * 30 + 4, 90, 10 * 30 + 25, null, [obstacle]);
    expect(route).not.toBeNull();
    expect(route?.length).toBeGreaterThan(1);
    expect(boxHitsArea(obstacle, areaOf(route ?? [], start, 90))).toBe(false);
    expect(route?.at(-1)).toEqual({ x: 25.5, y: 10.5 });
  });

  it('úzky prieliv, v ktorom sa loď neotočí: posun bokom s pevným kurzom lode', () => {
    // Pás vody výšky 3 (y 1–3) pre loď pozdĺž x; cieľ je o riadok nižšie v tej istej dĺžke pásu → bokom, nie otočenie.
    const rows = ['................', '~~~~~~~~~~~~~~~~', '~~~~~~~~~~~~~~~~', '~~~~~~~~~~~~~~~~', '................'];
    const nav = new WaterNavigator(gridOf(rows));
    const route = nav.findRoute({ lengthCells: 6, widthCells: 1 }, 1 * 16 + 5, 90, 3 * 16 + 5, null, []);
    expect(route).toEqual([{ x: 5.5, y: 3.5, heading: 90 }]);
  });

  it('cieľ mimo dosahu (oddelená voda alebo zatarasená prekážkou) → null', () => {
    const rows = ['~~~~~~~~~~~~.~~~~~~~~~~~', ...Array.from({ length: 9 }, () => '~~~~~~~~~~~~.~~~~~~~~~~~')];
    const nav = new WaterNavigator(gridOf(rows));
    expect(nav.findRoute(FEEDER, 5 * 24 + 4, 90, 5 * 24 + 18, null, [])).toBeNull();
    const open = new WaterNavigator(gridOf(water(24, 10)));
    expect(open.findRoute(FEEDER, 5 * 24 + 4, 90, 5 * 24 + 18, null, [{ x0: 10, y0: 0, x1: 11, y1: 10 }])).toBeNull();
  });

  it('deterministický výsledok: to isté volanie dá tú istú trasu aj po iných hľadaniach (generačné pečiatky)', () => {
    const nav = new WaterNavigator(gridOf(water(30, 30)));
    const obstacle: CellBox = { x0: 10, y0: 10, x1: 20, y1: 20 };
    const first = nav.findRoute(FEEDER, 5 * 30 + 5, 90, 25 * 30 + 25, null, [obstacle]);
    nav.findRoute(FEEDER, 25 * 30 + 25, 0, 5 * 30 + 5, null, []);
    nav.findRoute({ lengthCells: 10, widthCells: 2 }, 15 * 30 + 3, 0, 15 * 30 + 26, 0, []);
    expect(nav.findRoute(FEEDER, 5 * 30 + 5, 90, 25 * 30 + 25, null, [obstacle])).toEqual(first);
    expect(new WaterNavigator(gridOf(water(30, 30))).findRoute(FEEDER, 5 * 30 + 5, 90, 25 * 30 + 25, null, [obstacle])).toEqual(first);
  });

  it('body trasy sú stredy buniek a každý úsek je osový (pohyb dopredu alebo bokom, nikdy šikmo)', () => {
    const nav = new WaterNavigator(gridOf(water(40, 30)));
    const route = nav.findRoute(FEEDER, 4 * 40 + 3, 180, 25 * 40 + 36, null, [{ x0: 8, y0: 0, x1: 12, y1: 22 }, { x0: 20, y0: 8, x1: 24, y1: 30 }]);
    expect(route).not.toBeNull();
    let previous = nav.centerOf(4 * 40 + 3);
    for (const point of route ?? []) {
      expect((point.x - 0.5) % 1).toBe(0);
      expect((point.y - 0.5) % 1).toBe(0);
      expect(point.x === previous.x || point.y === previous.y).toBe(true);
      previous = point;
    }
  });

  it('štart: obdĺžnik lode v štarte zasahuje do prekážky → null (review T5B-04b); dotyk hranou štart neblokuje', () => {
    const nav = new WaterNavigator(gridOf(water(30, 20)));
    const from = 10 * 30 + 6; // stred (6,5; 10,5), feeder pozdĺž x → bunky x 3–8, y 9–10 (x0 3, x1 10 pri strede bunky)
    const box = nav.boxAt(FEEDER, from, AXIS_OF_HEADING[90]);
    const overlapping: CellBox = { x0: box.x1 - 1, y0: box.y0, x1: box.x1 + 2, y1: box.y1 };
    const touching: CellBox = { x0: box.x1, y0: box.y0, x1: box.x1 + 2, y1: box.y1 };
    expect(nav.findRoute(FEEDER, from, 90, 3 * 30 + 20, null, [overlapping])).toBeNull();
    expect(nav.findRoute(FEEDER, from, 90, 3 * 30 + 20, null, [touching])).not.toBeNull();
    // Štart = cieľ: prázdna trasa len vtedy, keď štart nie je v prekážke.
    expect(nav.findRoute(FEEDER, from, 90, from, null, [])).toEqual([]);
    expect(nav.findRoute(FEEDER, from, 90, from, null, [overlapping])).toBeNull();
  });

  it('prekážky v pracovnom poli (bez alokácií): veľa prekážok a nepárne rozmery lode — trasa sa žiadnej nedotkne a končí v cieli', () => {
    const nav = new WaterNavigator(gridOf(water(60, 40)));
    const odd = { lengthCells: 5, widthCells: 3 };
    // Hrebeň 40 malých prekážok (viac než počiatočná kapacita) s medzerou v strede.
    const obstacles: CellBox[] = Array.from({ length: 40 }, (_, i) => ({ x0: 29, y0: i, x1: 31, y1: i + 1 })).filter((b) => b.y0 < 17 || b.y0 > 23);
    expect(obstacles.length).toBeGreaterThan(16);
    const from = 20 * 60 + 8;
    const route = nav.findRoute(odd, from, 90, 20 * 60 + 52, null, obstacles);
    expect(route?.at(-1)).toEqual({ x: 52.5, y: 20.5 });
    const start = nav.centerOf(from);
    const area = new TrafficArea();
    sweepRoute(area, odd, { x: start.x, y: start.y, heading: 90 }, route ?? []);
    for (const obstacle of obstacles) expect(boxHitsArea(obstacle, area), `prekážka y ${String(obstacle.y0)}`).toBe(false);
  });
});
