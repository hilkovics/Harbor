import { describe, expect, it } from 'vitest';
import { Grid, loadBundledMap, terrainFromChar } from '@sim/grid';
import { coastTile, coastWaterMask, type CoastTileId } from '@render/coast';
import { terrain as terrainManifest } from '../../assets/manifest.json';

/** Mriežka podľa riadkov znakov mapy: `~` hlboká, `=` plytká voda, `Q` nábrežie, `.` pevnina, `#` blokované. */
function gridOf(rows: readonly string[]): Grid {
  return new Grid(rows[0].length, rows.length, (x, y) => {
    const terrain = terrainFromChar(rows[y][x]);
    if (terrain === undefined) throw new Error(`neznámy znak ${rows[y][x]}`);
    return { terrain };
  });
}

/**
 * Pevnina v strede 5×5 (bunka (2, 2)) s vodou (`=`) len na zadaných 4-susedoch (N, E, S, W) a diagonálach (NE, NW, SE, SW).
 * Šachovnica sa v strede 5×5 nemení: (2,2) je vždy `land` (⌊2/2⌋ + ⌊2/2⌋ = 2, párne).
 */
function landAround(water: readonly ('N' | 'E' | 'S' | 'W' | 'NE' | 'NW' | 'SE' | 'SW')[]): CoastTileId {
  const offsets: Record<string, [number, number]> = {
    N: [0, -1],
    E: [1, 0],
    S: [0, 1],
    W: [-1, 0],
    NE: [1, -1],
    NW: [-1, -1],
    SE: [1, 1],
    SW: [-1, 1],
  };
  const wet = new Set(water.map((name) => `${2 + offsets[name][0]},${2 + offsets[name][1]}`));
  const rows = Array.from({ length: 5 }, (_, y) =>
    Array.from({ length: 5 }, (_, x) => (wet.has(`${x},${y}`) ? '=' : '.')).join(''),
  );
  return coastTile(gridOf(rows), 2, 2);
}

describe('coastTile: typy terénu', () => {
  const grid = gridOf(['~=Q.#']);

  it.each([
    [0, 'water_deep'],
    [1, 'water_shallow'],
    [4, 'blocked'],
  ] as const)('bunka %i → %s', (x, expected) => {
    expect(coastTile(grid, x, 0)).toBe(expected);
  });

  it('blocked ostáva blocked aj pri vode vedľa', () => {
    expect(coastTile(gridOf(['=#=']), 1, 0)).toBe('blocked');
  });
});

describe('coastTile: nábrežie', () => {
  it('voda na severe (hlboká aj plytká) → quay_edge_n', () => {
    expect(coastTile(gridOf(['~', 'Q']), 0, 1)).toBe('quay_edge_n');
    expect(coastTile(gridOf(['=', 'Q']), 0, 1)).toBe('quay_edge_n');
  });

  it('bez vody na severe → quay (pevnina, nábrežie, okraj mapy)', () => {
    expect(coastTile(gridOf(['.', 'Q']), 0, 1)).toBe('quay');
    expect(coastTile(gridOf(['Q', 'Q']), 0, 1)).toBe('quay');
    expect(coastTile(gridOf(['Q']), 0, 0)).toBe('quay');
  });

  it('voda len na východe, juhu alebo západe → quay (hrana je iba na severe)', () => {
    expect(coastTile(gridOf(['=Q=']), 1, 0)).toBe('quay');
    expect(coastTile(gridOf(['.', 'Q', '=']), 0, 1)).toBe('quay');
  });
});

describe('coastTile: pevnina — jedna strana s vodou', () => {
  it.each([
    [['N'], 'water_edge_n'],
    [['E'], 'water_edge_e'],
    [['S'], 'water_edge_s'],
    [['W'], 'water_edge_w'],
  ] as const)('voda %j → %s', (water, expected) => {
    expect(landAround(water)).toBe(expected);
  });

  it('diagonálna voda vedľa strany s vodou nič nemení (strana vyhráva)', () => {
    expect(landAround(['N', 'SE'])).toBe('water_edge_n');
    expect(landAround(['W', 'NE', 'SE'])).toBe('water_edge_w');
  });
});

describe('coastTile: pevnina — dve susedné strany (vnútorný roh)', () => {
  it.each([
    [['N', 'E'], 'water_inner_ne'],
    [['E', 'S'], 'water_inner_se'],
    [['S', 'W'], 'water_inner_sw'],
    [['W', 'N'], 'water_inner_nw'],
  ] as const)('voda %j → %s', (water, expected) => {
    expect(landAround(water)).toBe(expected);
  });
});

describe('coastTile: pevnina — protiľahlé strany alebo ≥ 3 strany (hrana prvej strany v poradí N, E, S, W)', () => {
  it.each([
    [['N', 'S'], 'water_edge_n'],
    [['E', 'W'], 'water_edge_e'],
    [['N', 'E', 'S'], 'water_edge_n'],
    [['N', 'E', 'W'], 'water_edge_n'],
    [['N', 'S', 'W'], 'water_edge_n'],
    [['E', 'S', 'W'], 'water_edge_e'],
    [['N', 'E', 'S', 'W'], 'water_edge_n'],
  ] as const)('voda %j → %s', (water, expected) => {
    expect(landAround(water)).toBe(expected);
  });
});

describe('coastTile: pevnina — voda len na diagonále (prvá v poradí NE, NW, SE, SW)', () => {
  it.each([
    [['NE'], 'water_corner_ne'],
    [['NW'], 'water_corner_nw'],
    [['SE'], 'water_corner_se'],
    [['SW'], 'water_corner_sw'],
    [['SW', 'SE'], 'water_corner_se'],
    [['SW', 'NW'], 'water_corner_nw'],
    [['SE', 'NW'], 'water_corner_nw'],
    [['SW', 'NE'], 'water_corner_ne'],
    [['NE', 'NW', 'SE', 'SW'], 'water_corner_ne'],
  ] as const)('voda %j → %s', (water, expected) => {
    expect(landAround(water)).toBe(expected);
  });
});

describe('coastTile: pevnina bez vody v okolí (šachovnica 2×2)', () => {
  const grid = gridOf(Array.from({ length: 6 }, () => '.'.repeat(6)));

  it.each([
    [0, 0, 'land'],
    [1, 1, 'land'],
    [2, 0, 'land_alt'],
    [3, 1, 'land_alt'],
    [0, 2, 'land_alt'],
    [1, 3, 'land_alt'],
    [2, 2, 'land'],
    [3, 3, 'land'],
    [4, 2, 'land_alt'],
    [5, 5, 'land'],
  ] as const)('(%i, %i) → %s', (x, y, expected) => {
    expect(coastTile(grid, x, y)).toBe(expected);
  });

  it('bunky mimo mapy nie sú voda: pevnina na okraji mapy zostáva šachovnicou', () => {
    expect(coastTile(gridOf(['.']), 0, 0)).toBe('land');
    expect(coastTile(grid, 0, 0)).toBe('land');
    expect(coastTile(grid, 5, 2)).toBe('land_alt');
  });
});

describe('coastWaterMask', () => {
  const grid = gridOf(['.=.', '=.=', '.=.']);

  it('bity N=1, E=2, S=4, W=8 podľa vody v 4-susedoch', () => {
    expect(coastWaterMask(grid, 1, 1)).toBe(1 | 2 | 4 | 8);
    expect(coastWaterMask(grid, 2, 1)).toBe(0);
    expect(coastWaterMask(grid, 0, 2)).toBe(1 | 2);
  });

  it('susedia mimo mapy nie sú voda', () => {
    expect(coastWaterMask(grid, 0, 0)).toBe(2 | 4);
    expect(coastWaterMask(gridOf(['.']), 0, 0)).toBe(0);
  });
});

describe('coastTile: harbor_01', () => {
  const grid = loadBundledMap().createGrid();

  it.each([
    [0, 0, 'water_deep'],
    [2, 8, 'water_shallow'],
    [6, 12, 'quay_edge_n'],
    [6, 13, 'quay'],
    [10, 15, 'land'],
    [9, 15, 'land_alt'],
    [28, 17, 'water_edge_w'],
    [59, 17, 'water_edge_e'],
    [29, 33, 'water_edge_s'],
    [92, 18, 'water_inner_nw'],
    [28, 33, 'water_inner_sw'],
    [59, 33, 'water_inner_se'],
    [34, 33, 'water_corner_sw'],
    [53, 33, 'water_corner_se'],
    [6, 50, 'water_corner_nw'],
    [21, 50, 'water_corner_ne'],
    [12, 47, 'blocked'],
  ] as const)('(%i, %i) → %s', (x, y, expected) => {
    expect(coastTile(grid, x, y)).toBe(expected);
  });

  it('každá bunka mapy dostane sprite, ktorý existuje v manifeste (terrain.*)', () => {
    const known = new Set(Object.keys(terrainManifest));
    const used = new Set<CoastTileId>();
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) used.add(coastTile(grid, x, y));
    }
    for (const id of used) expect(known.has(id), id).toBe(true);
    // Mapa má pobrežie zo všetkých strán, vnútorné aj vonkajšie rohy a nábrežie mól: aspoň tieto prechody sa reálne použijú.
    expect([...used]).toEqual(
      expect.arrayContaining([
        'water_deep',
        'water_shallow',
        'water_edge_n',
        'water_edge_e',
        'water_edge_s',
        'water_edge_w',
        'water_inner_nw',
        'water_inner_se',
        'water_inner_sw',
        'water_corner_ne',
        'water_corner_nw',
        'water_corner_se',
        'water_corner_sw',
        'quay',
        'quay_edge_n',
        'land',
        'land_alt',
        'blocked',
      ]),
    );
  });
});

describe('coastTile vs. manifest (waterSides / waterCorner / landCorner)', () => {
  const SIDE_NAME = { n: 'N', e: 'E', s: 'S', w: 'W' } as const;
  const OPPOSITE = { n: 's', e: 'w', s: 'n', w: 'e' } as const;
  const entries = Object.entries(terrainManifest) as [string, Record<string, unknown>][];

  it('sprite s `waterSides` (len pevnina) zodpovedá presne tým stranám, na ktorých je voda', () => {
    let checked = 0;
    for (const [id, entry] of entries) {
      const sides = entry.waterSides as ('n' | 'e' | 's' | 'w')[] | undefined;
      if (sides === undefined || id.startsWith('quay')) continue;
      expect(landAround(sides.map((side) => SIDE_NAME[side])), id).toBe(id);
      checked += 1;
    }
    expect(checked).toBe(8); // water_edge_{n,e,s,w} + water_inner_{ne,nw,se,sw}
  });

  it('sprite s `waterCorner` zodpovedá vode iba na danej diagonále', () => {
    let checked = 0;
    for (const [id, entry] of entries) {
      const corner = entry.waterCorner as string | undefined;
      if (corner === undefined) continue;
      expect(landAround([corner.toUpperCase() as 'NE' | 'NW' | 'SE' | 'SW']), id).toBe(id);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it('`landCorner` vnútorného rohu leží oproti dvom stranám s vodou', () => {
    let checked = 0;
    for (const [id, entry] of entries) {
      const sides = entry.waterSides as ('n' | 'e' | 's' | 'w')[] | undefined;
      if (!id.startsWith('water_inner_') || sides === undefined) continue;
      const letters = (text: string): string => text.split('').sort().join('');
      expect(letters(String(entry.landCorner)), id).toBe(letters(sides.map((side) => OPPOSITE[side]).join('')));
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it('`quay_edge_n` je nábrežie s vodou na severe', () => {
    expect((terrainManifest.quay_edge_n as { waterSides: string[] }).waterSides).toEqual(['n']);
    expect(coastTile(gridOf(['=', 'Q']), 0, 1)).toBe('quay_edge_n');
  });
});
