import { describe, expect, it } from 'vitest';
import harbor01Json from '@data/maps/harbor_01.json';
import type { EntityId } from '@sim/core/entity-id';
import {
  Grid,
  MapError,
  DEFAULT_ANCHORAGE_HEADING,
  loadBundledMap,
  loadMap,
  parseMapDef,
  terrainFromChar,
  type LoadedMap,
  type MapDef,
} from '@sim/grid';

type MapJson = typeof harbor01Json;

/** Čerstvá hlboká kópia harbor_01; negatívne testy v nej upravia jedno pole. */
function rawMap(): MapJson {
  return structuredClone(harbor01Json);
}

function load(raw: unknown): LoadedMap {
  return loadMap(parseMapDef(raw));
}

/** Nastaví hodnotu na JSON pointeri (`/parcels/1/rect/x`); posledný segment `-` pridá na koniec poľa. */
function setAt(root: unknown, pointer: string, value: unknown): void {
  const segments = pointer.slice(1).split('/');
  const last = segments.pop() as string;
  let target = root as Record<string, unknown>;
  for (const segment of segments) target = target[segment] as Record<string, unknown>;
  if (Array.isArray(target) && last === '-') target.push(value);
  else target[last] = value;
}

function deleteAt(root: unknown, pointer: string): void {
  const segments = pointer.slice(1).split('/');
  const last = segments.pop() as string;
  let target = root as Record<string, unknown>;
  for (const segment of segments) target = target[segment] as Record<string, unknown>;
  delete target[last];
}

/** `fn` musí hodiť `MapError` s danou cestou a správou `<mapId><path>: …`. */
function expectMapError(fn: () => unknown, path: string, mapId = 'harbor_01'): MapError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `očakávaná MapError na ${path}`).toBeInstanceOf(MapError);
  const error = caught as MapError;
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('MapError');
  expect(error.path).toBe(path);
  expect(error.mapId).toBe(mapId);
  expect(error.message).toBe(`${mapId}${path}: ${error.problem}`);
  expect(error.problem.length).toBeGreaterThan(0);
  return error;
}

describe('loadMap(harbor_01)', () => {
  const map = load(harbor01Json);
  const grid = map.createGrid();

  it('id a rozmery 96×64 (§4.7)', () => {
    expect(map.id).toBe('harbor_01');
    expect(grid.width).toBe(96);
    expect(grid.height).toBe(64);
    expect(grid.cellCount).toBe(96 * 64);
  });

  it('terén každej bunky zodpovedá znaku v mape', () => {
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        expect(grid.at(x, y).terrain).toBe(terrainFromChar(harbor01Json.terrain[y][x]));
      }
    }
  });

  it('vzorky terénu: voda na severe, nábrežie, pevnina, blocked', () => {
    expect(grid.at(0, 0).terrain).toBe('deep_water');
    expect(grid.at(48, 9).terrain).toBe('deep_water');
    expect(grid.at(10, 10).terrain).toBe('shallow_water');
    expect(grid.at(0, 12).terrain).toBe('shallow_water'); // západné more vedľa móla W1
    expect(grid.at(0, 54).terrain).toBe('land'); // južná pevnina
    expect(grid.at(6, 12).terrain).toBe('quay'); // hlava móla W1
    expect(grid.at(10, 25).terrain).toBe('land'); // vnútro móla W1
    expect(grid.at(81, 30).terrain).toBe('quay'); // východný okraj móla E1
    expect(grid.at(82, 30).terrain).toBe('shallow_water'); // zátoka východne od móla E1
    expect(grid.at(28, 14).terrain).toBe('quay'); // verejný ostrôžok nábrežia pri starteri
    expect(grid.at(25, 20).terrain).toBe('shallow_water'); // kanál medzi mólom W1 a výbežkom
    expect(grid.at(12, 47).terrain).toBe('blocked');
    expect(grid.at(14, 56).terrain).toBe('blocked');
  });

  it('depthClass: nábrežie podľa zón depth (mimo zón 1), voda a pevnina 0', () => {
    const expectedQuayDepth = (x: number, y: number): number => {
      if (x >= 6 && x < 14 && y >= 12 && y < 15) return 2; // "6,12,8,3": 2 (hlava móla W1, západná polovica)
      if (x >= 14 && x < 22 && y >= 12 && y < 15) return 1; // "14,12,8,3": 1 (hlava móla W1, východná polovica)
      if (x >= 6 && x < 9 && y >= 15 && y < 47) return 2; // "6,15,3,32": 2 (západný okraj móla W1)
      if (x >= 19 && x < 22 && y >= 15 && y < 47) return 1; // "19,15,3,32": 1 (východný okraj móla W1, kanál)
      if (x >= 30 && x < 58 && y >= 14 && y < 17) return 1; // "30,14,28,3": 1 (starter)
      if (x >= 66 && x < 82 && y >= 12 && y < 47) return 3; // "66,12,16,35": 3 (mólo E1)
      return 1; // mimo zón → predvolená trieda 1 (verejné ostrôžky x 28–29 a 58–59)
    };
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const cell = grid.at(x, y);
        expect(cell.depthClass).toBe(cell.terrain === 'quay' ? expectedQuayDepth(x, y) : 0);
      }
    }
    expect(grid.at(58, 15).depthClass).toBe(1);
    expect(grid.at(10, 13).depthClass).toBe(2);
    expect(grid.at(18, 13).depthClass).toBe(1);
    expect(grid.at(70, 13).depthClass).toBe(3);
  });

  it('parcelId každej bunky podľa obdĺžnikov parciel, inak null', () => {
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const owner = harbor01Json.parcels.find(
          ({ rect }) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h,
        );
        expect(grid.at(x, y).parcelId).toBe(owner?.id ?? null);
      }
    }
    expect(grid.at(30, 14).parcelId).toBe('starter');
    expect(grid.at(57, 33).parcelId).toBe('starter');
    expect(grid.at(29, 14).parcelId).toBeNull();
    expect(grid.at(66, 12).parcelId).toBe('east_yard');
    expect(grid.at(6, 12).parcelId).toBe('west_quay');
    expect(grid.at(60, 14).parcelId).toBeNull();
  });

  it('parcely s ownership zo startOwned', () => {
    expect(map.parcels.map(({ id, ownership }) => ({ id, ownership }))).toEqual([
      { id: 'starter', ownership: 'owned' },
      { id: 'west_quay', ownership: 'none' },
      { id: 'east_yard', ownership: 'none' },
    ]);
    expect(map.parcels[0]).toEqual({
      id: 'starter',
      rect: { x: 30, y: 14, w: 28, h: 20 },
      priceCents: 60000000,
      leasable: false,
      ownership: 'owned',
    });
    expect(map.parcels[1].leasable).toBe(true);
  });

  it('starter cesty zapísané do mriežky (road), inde none; moduly a traffic prázdne', () => {
    const roadCells = new Set(harbor01Json.starter.roads.map(({ x, y }) => grid.index(x, y)));
    expect(roadCells.size).toBe(30);
    for (let i = 0; i < grid.cellCount; i++) {
      const cell = grid.atIndex(i);
      expect(cell.road).toBe(roadCells.has(i) ? 'road' : 'none');
      expect(cell.moduleId).toBeNull();
      expect(cell.traffic).toBe(0);
    }
    expect(grid.at(44, 63).road).toBe('road');
    expect(grid.at(44, 34).road).toBe('road');
    expect(grid.at(44, 33).road).toBe('none');
    expect(map.starter.roads).toEqual(harbor01Json.starter.roads);
  });

  it('starter moduly = Root modul: berth_standard (40, 14) a crane_container_gantry (43, 14), rotácia 0 (T02-01)', () => {
    expect(map.starter.modules).toEqual([
      { defId: 'berth_standard', x: 40, y: 14, rotation: 0 },
      { defId: 'crane_container_gantry', x: 43, y: 14, rotation: 0 },
    ]);
    expect(map.starter.modules).toEqual(harbor01Json.starter.modules);
  });

  it('loader moduly do mriežky nezapisuje (umiestni ich World.create)', () => {
    for (const [x, y] of [[40, 14], [43, 14], [47, 16]] as const) expect(grid.at(x, y).moduleId).toBeNull();
  });

  it('portály, seaLane a anchorage prevzaté z mapy', () => {
    expect(map.roadPortals).toEqual([{ id: 'road_south', cell: { x: 44, y: 63 } }]);
    expect(map.railPortals).toEqual([{ id: 'rail_east', cell: { x: 95, y: 24 } }]);
    expect(map.seaLane).toEqual(harbor01Json.seaLane);
    expect(map.anchorage).toEqual(harbor01Json.anchorage);
  });

  it('width a height zodpovedajú mapě a mriežke', () => {
    expect([map.width, map.height]).toEqual([96, 64]);
    expect([grid.width, grid.height]).toEqual([map.width, map.height]);
  });

  it('mapa je hlboko zmrazená', () => {
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(map.starter.modules)).toBe(true);
    expect(Object.isFrozen(map.starter.modules[0])).toBe(true);
    expect(Object.isFrozen(map.parcels)).toBe(true);
    expect(Object.isFrozen(map.parcels[0])).toBe(true);
    expect(Object.isFrozen(map.parcels[0].rect)).toBe(true);
    expect(Object.isFrozen(map.roadPortals[0].cell)).toBe(true);
    expect(Object.isFrozen(map.seaLane)).toBe(true);
    expect(Object.isFrozen(map.anchorage[0])).toBe(true);
    expect(Object.isFrozen(map.starter.roads)).toBe(true);
  });
});

describe('loadMap — čistota a determinizmus', () => {
  it('dve načítania → nezávislé mriežky s rovnakým obsahom', () => {
    const a = load(harbor01Json).createGrid();
    const b = load(harbor01Json).createGrid();
    expect(a).not.toBe(b);
    for (let i = 0; i < a.cellCount; i++) expect(b.atIndex(i)).toEqual(a.atIndex(i));
    a.at(40, 30).road = 'road';
    expect(b.at(40, 30).road).toBe('none');
  });

  describe('createGrid — šablóna počiatočného stavu sa nikdy nevydáva', () => {
    it('každé volanie vráti novú mriežku s rovnakým obsahom (terén, depthClass, parcelId, starter cesty)', () => {
      const map = load(harbor01Json);
      const first = map.createGrid();
      const second = map.createGrid();
      expect(second).not.toBe(first);
      expect(second.cellCount).toBe(first.cellCount);
      for (let i = 0; i < first.cellCount; i++) {
        expect(second.atIndex(i)).not.toBe(first.atIndex(i));
        expect(second.atIndex(i)).toEqual(first.atIndex(i));
      }
      expect(first.at(44, 63).road).toBe('road');
    });

    it('zápis do vydanej mriežky (cesta, modul, doprava) sa neprenesie do ďalšej', () => {
      const map = load(harbor01Json);
      const dirty = map.createGrid();
      dirty.at(40, 30).road = 'rail';
      dirty.at(44, 63).road = 'none';
      dirty.at(40, 14).moduleId = 7 as EntityId;
      dirty.at(41, 30).traffic = 99;
      const clean = map.createGrid();
      expect(clean.at(40, 30).road).toBe('none');
      expect(clean.at(44, 63).road).toBe('road');
      expect(clean.at(40, 14).moduleId).toBeNull();
      expect(clean.at(41, 30).traffic).toBe(0);
    });

    it('LoadedMap nevystavuje meniteľnú šablónu — žiadne pole `grid`, len `createGrid()` (BACKLOG P2)', () => {
      const map = load(harbor01Json);
      expect(Object.hasOwn(map, 'grid')).toBe(false);
      expect(Object.values(map).some((value) => value instanceof Grid)).toBe(false);
    });

    it('funguje aj po rozklade mapy ({ ...map }) — nepoužíva `this`', () => {
      const map = load(harbor01Json);
      const copy = { ...map };
      expect(copy.createGrid().at(44, 63).road).toBe('road');
    });
  });

  it('výsledok nezdieľa objekty so vstupom; vstup sa nemení', () => {
    const def: MapDef = structuredClone(parseMapDef(harbor01Json)); // nezmrazená kópia
    const snapshot = structuredClone(def);
    const map = loadMap(def);
    expect(def).toEqual(snapshot);
    expect(map.parcels[0].rect).not.toBe(def.parcels[0].rect);
    expect(map.seaLane[0]).not.toBe(def.seaLane[0]);
    (def.parcels[0].rect as { x: number }).x = 0;
    (def.starter.roads[0] as { x: number }).x = 0;
    expect(map.parcels[0].rect.x).toBe(30);
    expect(map.starter.roads[0].x).toBe(44);
  });

  it('loadBundledMap = loadMap(parseMapDef(harbor_01.json))', () => {
    const bundled = loadBundledMap();
    const direct = load(harbor01Json);
    expect(bundled.id).toBe('harbor_01');
    const withoutGrids = ({ createGrid: _create, ...rest }: LoadedMap) => {
      void _create;
      return rest;
    };
    expect(withoutGrids(bundled)).toEqual(withoutGrids(direct));
    const bundledGrid = bundled.createGrid();
    const directGrid = direct.createGrid();
    for (let i = 0; i < directGrid.cellCount; i++) expect(bundledGrid.atIndex(i)).toEqual(directGrid.atIndex(i));
  });
});

describe('loadMap — povolené prípady', () => {
  it('starter cesta na startOwned parcele a na verejnom nábreží', () => {
    const raw = rawMap();
    raw.starter.roads.push({ x: 44, y: 30 }, { x: 28, y: 14 });
    const grid = load(raw).createGrid();
    expect(grid.at(44, 30).road).toBe('road');
    expect(grid.at(28, 14).road).toBe('road');
  });

  it('starter cesta na parcele, ktorá je startOwned (nie na predaj)', () => {
    const raw = rawMap();
    setAt(raw, '/parcels/1/startOwned', true);
    raw.starter.roads.push({ x: 20, y: 20 });
    const map = load(raw);
    expect(map.createGrid().at(20, 20).road).toBe('road');
    expect(map.parcels[1].ownership).toBe('owned');
  });

  it('startOwned: false = na predaj', () => {
    const raw = rawMap();
    setAt(raw, '/parcels/0/startOwned', false);
    expect(load(raw).parcels[0].ownership).toBe('none');
  });

  it('zóna depth môže zahŕňať aj bunky mimo nábrežia (tie majú triedu 0)', () => {
    const raw = rawMap();
    setAt(raw, '/depth/58,12,2,6', 2);
    const grid = load(raw).createGrid();
    expect(grid.at(58, 14).depthClass).toBe(2);
    expect(grid.at(58, 12).depthClass).toBe(0);
    expect(grid.at(58, 17).depthClass).toBe(0);
  });
});

interface InvariantCase {
  readonly name: string;
  readonly mutate: (raw: MapJson) => void;
  readonly path: string;
}

const INVARIANT_CASES: readonly InvariantCase[] = [
  // Terén
  { name: 'menej riadkov terénu než height', mutate: (m) => void m.terrain.pop(), path: '/terrain' },
  { name: 'height nesedí s počtom riadkov', mutate: (m) => void (m.height = 63), path: '/terrain' },
  { name: 'kratší riadok terénu', mutate: (m) => void (m.terrain[5] = m.terrain[5].slice(1)), path: '/terrain/5' },
  { name: 'width nesedí s dĺžkou riadkov', mutate: (m) => void (m.width = 95), path: '/terrain/0' },
  {
    name: 'neznámy znak v teréne',
    mutate: (m) => void (m.terrain[20] = `${m.terrain[20].slice(0, 12)}X${m.terrain[20].slice(13)}`),
    path: '/terrain/20',
  },
  // Zóny hĺbky
  { name: 'kľúč zóny nie je x,y,w,h', mutate: (m) => setAt(m, '/depth/1,2,3', 2), path: '/depth/1,2,3' },
  { name: 'zóna s nulovou šírkou', mutate: (m) => setAt(m, '/depth/10,14,0,3', 2), path: '/depth/10,14,0,3' },
  { name: 'zóna presahuje mapu', mutate: (m) => setAt(m, '/depth/90,14,10,3', 2), path: '/depth/90,14,10,3' },
  { name: 'zóny sa prekrývajú', mutate: (m) => setAt(m, '/depth/20,14,15,3', 3), path: '/depth/20,14,15,3' },
  { name: 'zóna bez nábrežia', mutate: (m) => setAt(m, '/depth/0,0,5,5', 2), path: '/depth/0,0,5,5' },
  // Parcely
  { name: 'parcela mimo mapy', mutate: (m) => void (m.parcels[1].rect.x = 90), path: '/parcels/1/rect' },
  { name: 'parcela presahuje spodný okraj', mutate: (m) => void (m.parcels[0].rect.h = 51), path: '/parcels/0/rect' },
  { name: 'prekryv parciel', mutate: (m) => void (m.parcels[2].rect.x = 50), path: '/parcels/2/rect' },
  { name: 'duplicitné id parcely', mutate: (m) => void (m.parcels[2].id = 'starter'), path: '/parcels/2/id' },
  // Portály
  { name: 'cestný portál mimo mapy', mutate: (m) => void (m.roadPortals[0].cell = { x: 96, y: 63 }), path: '/roadPortals/0/cell' },
  { name: 'cestný portál nie na okraji', mutate: (m) => void (m.roadPortals[0].cell = { x: 44, y: 62 }), path: '/roadPortals/0/cell' },
  { name: 'cestný portál na vode', mutate: (m) => void (m.roadPortals[0].cell = { x: 0, y: 5 }), path: '/roadPortals/0/cell' },
  { name: 'železničný portál na plytkej vode', mutate: (m) => void (m.railPortals[0].cell = { x: 95, y: 10 }), path: '/railPortals/0/cell' },
  {
    name: 'železničný portál na blocked',
    mutate: (m) => void (m.terrain[24] = `${m.terrain[24].slice(0, 95)}#`),
    path: '/railPortals/0/cell',
  },
  { name: 'portál v parcele (parcela rozšírená k okraju)', mutate: (m) => void (m.parcels[2].rect.w = 30), path: '/railPortals/0/cell' },
  { name: 'duplicitné id portálu', mutate: (m) => void (m.railPortals[0].id = 'road_south'), path: '/railPortals/0/id' },
  {
    name: 'železničný portál na bunke cestného portálu',
    mutate: (m) => void (m.railPortals[0].cell = { x: 44, y: 63 }),
    path: '/railPortals/0/cell',
  },
  {
    name: 'dva cestné portály na jednej bunke',
    mutate: (m) => void m.roadPortals.push({ id: 'road_south_2', cell: { x: 44, y: 63 } }),
    path: '/roadPortals/1/cell',
  },
  {
    name: 'cestný portál na bunke železničného (id sa líši)',
    mutate: (m) => void m.roadPortals.push({ id: 'road_east', cell: { x: 95, y: 24 } }),
    path: '/railPortals/0/cell',
  },
  // Plavebná dráha a kotvisko
  { name: 'seaLane začína mimo okraja', mutate: (m) => void (m.seaLane[0] = { x: 48, y: 3 }), path: '/seaLane/0' },
  { name: 'vrchol seaLane na pevnine', mutate: (m) => void (m.seaLane[1] = { x: 48, y: 20 }), path: '/seaLane/1' },
  { name: 'vrchol seaLane mimo mapy', mutate: (m) => void (m.seaLane[1] = { x: 48, y: 70 }), path: '/seaLane/1' },
  {
    name: 'úsek seaLane prechádza pevninou (vrcholy na vode)',
    mutate: (m) => void m.seaLane.push({ x: 3, y: 11 }, { x: 24, y: 30 }),
    path: '/seaLane/4',
  },
  { name: 'anchorage na pevnine', mutate: (m) => void (m.anchorage[1] = { x: 52, y: 20 }), path: '/anchorage/1' },
  { name: 'anchorage na plytkej vode', mutate: (m) => void (m.anchorage[1] = { x: 52, y: 11 }), path: '/anchorage/1' },
  { name: 'anchorage na nábreží', mutate: (m) => void (m.anchorage[3] = { x: 60, y: 14 }), path: '/anchorage/3' },
  { name: 'anchorage mimo mapy', mutate: (m) => void (m.anchorage[1] = { x: 200, y: 7 }), path: '/anchorage/1' },
  // Starter moduly (def a placement overí World.create)
  {
    name: 'starter modul mimo mapy (x)',
    mutate: (m) => setAt(m, '/starter/modules/-', { defId: 'berth_standard', x: 96, y: 14, rotation: 0 }),
    path: '/starter/modules/2',
  },
  {
    name: 'starter modul mimo mapy (y)',
    mutate: (m) => setAt(m, '/starter/modules/-', { defId: 'berth_standard', x: 40, y: 64, rotation: 0 }),
    path: '/starter/modules/2',
  },
  // Starter cesty
  { name: 'starter cesta na vode', mutate: (m) => void (m.starter.roads[29] = { x: 44, y: 12 }), path: '/starter/roads/29' },
  { name: 'starter cesta na blocked', mutate: (m) => void (m.starter.roads[0] = { x: 2, y: 40 }), path: '/starter/roads/0' },
  { name: 'starter cesta na parcele na predaj', mutate: (m) => void (m.starter.roads[5] = { x: 65, y: 30 }), path: '/starter/roads/5' },
  { name: 'starter cesta mimo mapy', mutate: (m) => void (m.starter.roads[0] = { x: 44, y: 64 }), path: '/starter/roads/0' },
];

describe('loadMap — každé porušenie invariantu → MapError s cestou', () => {
  it.each(INVARIANT_CASES)('$name → $path', ({ mutate, path }) => {
    const raw = rawMap();
    mutate(raw);
    const def = parseMapDef(raw); // tvar je platný — chybu musí nájsť až loadMap
    expectMapError(() => loadMap(def), path);
  });

  it('úsek seaLane cez pevninu: správa uvádza bunku a terén', () => {
    const raw = rawMap();
    raw.seaLane.push({ x: 3, y: 11 }, { x: 24, y: 30 });
    const error = expectMapError(() => load(raw), '/seaLane/4');
    expect(error.problem).toContain('(6, 14)');
    expect(error.problem).toContain('quay');
  });

  it('prekryv parciel: správa uvádza druhú parcelu', () => {
    const raw = rawMap();
    raw.parcels[2].rect.x = 50;
    expect(expectMapError(() => load(raw), '/parcels/2/rect').problem).toContain("'starter' (/parcels/0)");
  });

  it('loadMap overí rozmery aj bez parseMapDef', () => {
    const def = parseMapDef(harbor01Json);
    expectMapError(() => loadMap({ ...def, width: 0 }), '/width');
    expectMapError(() => loadMap({ ...def, height: 1.5 }), '/height');
  });
});

describe('parseMapDef — tvar podľa map.schema.json', () => {
  it('harbor_01 → rovnaký obsah, hlboko zmrazená kópia', () => {
    const def = parseMapDef(harbor01Json);
    expect(def).toEqual(harbor01Json);
    expect(def).not.toBe(harbor01Json);
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.terrain)).toBe(true);
    expect(Object.isFrozen(def.depth)).toBe(true);
    expect(Object.isFrozen(def.parcels[0].rect)).toBe(true);
    expect(Object.isFrozen(def.starter.roads[0])).toBe(true);
    expect(Object.isFrozen(harbor01Json)).toBe(false);
  });

  it('startOwned chýba → ostane chýbať', () => {
    expect(Object.hasOwn(parseMapDef(harbor01Json).parcels[1], 'startOwned')).toBe(false);
  });

  it('anchorageHeading (T6D-03): harbor_01 ho uvádza, voliteľný — chýba = predvolený kurz, platné hodnoty 0/90/180/270 prejdú, iné → MapError', () => {
    expect(parseMapDef(harbor01Json).anchorageHeading).toBe(90);
    expect(load(harbor01Json).anchorageHeading).toBe(90);
    const without = rawMap() as Record<string, unknown>;
    delete without['anchorageHeading'];
    expect(Object.hasOwn(parseMapDef(without), 'anchorageHeading')).toBe(false);
    expect(load(without).anchorageHeading).toBe(DEFAULT_ANCHORAGE_HEADING);
    for (const heading of [0, 90, 180, 270]) {
      const raw = rawMap() as Record<string, unknown>;
      raw['anchorageHeading'] = heading;
      expect(load(raw).anchorageHeading).toBe(heading);
    }
    for (const heading of [45, '90', null, -90, 360]) {
      const raw = rawMap() as Record<string, unknown>;
      raw['anchorageHeading'] = heading;
      expectMapError(() => parseMapDef(raw), '/anchorageHeading');
    }
  });

  it('platný starter modul prejde', () => {
    const raw = rawMap();
    setAt(raw, '/starter/modules/-', { defId: 'berth_standard', x: 30, y: 14, rotation: 90 });
    expect(parseMapDef(raw).starter.modules).toEqual([
      { defId: 'berth_standard', x: 40, y: 14, rotation: 0 },
      { defId: 'crane_container_gantry', x: 43, y: 14, rotation: 0 },
      { defId: 'berth_standard', x: 30, y: 14, rotation: 90 },
    ]);
  });

  it.each([[null], [[]], ['harbor'], [42], [undefined]])('koreň nie je objekt (%j) → MapError s mapId "map"', (raw) => {
    expectMapError(() => parseMapDef(raw), '', 'map');
  });

  const SHAPE_CASES: readonly { name: string; mutate: (raw: MapJson) => void; path: string }[] = [
    { name: 'chýba anchorage', mutate: (m) => deleteAt(m, '/anchorage'), path: '/anchorage' },
    { name: 'chýba starter.roads', mutate: (m) => deleteAt(m, '/starter/roads'), path: '/starter/roads' },
    { name: 'neznámy kľúč v koreni', mutate: (m) => setAt(m, '/version', 1), path: '/version' },
    { name: 'chýba schemaVersion', mutate: (m) => deleteAt(m, '/schemaVersion'), path: '/schemaVersion' },
    { name: 'schemaVersion 2', mutate: (m) => setAt(m, '/schemaVersion', 2), path: '/schemaVersion' },
    { name: 'schemaVersion ako reťazec', mutate: (m) => setAt(m, '/schemaVersion', '1'), path: '/schemaVersion' },
    { name: 'schemaVersion null', mutate: (m) => setAt(m, '/schemaVersion', null), path: '/schemaVersion' },
    { name: 'neznámy kľúč v parcele', mutate: (m) => setAt(m, '/parcels/0/owner', 'me'), path: '/parcels/0/owner' },
    { name: 'width ako reťazec', mutate: (m) => setAt(m, '/width', '96'), path: '/width' },
    { name: 'height 0', mutate: (m) => setAt(m, '/height', 0), path: '/height' },
    { name: 'terrain nie je pole', mutate: (m) => setAt(m, '/terrain', 'x'), path: '/terrain' },
    { name: 'riadok terénu nie je reťazec', mutate: (m) => setAt(m, '/terrain/3', 5), path: '/terrain/3' },
    { name: 'hĺbka 4', mutate: (m) => setAt(m, '/depth/10,14,20,3', 4), path: '/depth/10,14,20,3' },
    { name: 'hĺbka 0', mutate: (m) => setAt(m, '/depth/10,14,20,3', 0), path: '/depth/10,14,20,3' },
    { name: 'depth je pole', mutate: (m) => setAt(m, '/depth', []), path: '/depth' },
    { name: 'parcels prázdne', mutate: (m) => setAt(m, '/parcels', []), path: '/parcels' },
    { name: 'id parcely nie je snake_case', mutate: (m) => setAt(m, '/parcels/1/id', 'West Quay'), path: '/parcels/1/id' },
    { name: 'rect.w 0', mutate: (m) => setAt(m, '/parcels/1/rect/w', 0), path: '/parcels/1/rect/w' },
    { name: 'rect.x záporné', mutate: (m) => setAt(m, '/parcels/1/rect/x', -1), path: '/parcels/1/rect/x' },
    { name: 'priceCents záporné', mutate: (m) => setAt(m, '/parcels/0/priceCents', -1), path: '/parcels/0/priceCents' },
    { name: 'leasable nie je boolean', mutate: (m) => setAt(m, '/parcels/0/leasable', 1), path: '/parcels/0/leasable' },
    { name: 'startOwned nie je boolean', mutate: (m) => setAt(m, '/parcels/0/startOwned', 'yes'), path: '/parcels/0/startOwned' },
    { name: 'roadPortals prázdne', mutate: (m) => setAt(m, '/roadPortals', []), path: '/roadPortals' },
    { name: 'portál bez cell', mutate: (m) => deleteAt(m, '/railPortals/0/cell'), path: '/railPortals/0/cell' },
    { name: 'seaLane s jedným bodom', mutate: (m) => setAt(m, '/seaLane', [{ x: 48, y: 0 }]), path: '/seaLane' },
    { name: 'bunka so zápornou súradnicou', mutate: (m) => setAt(m, '/anchorage/0/x', -1), path: '/anchorage/0/x' },
    { name: 'bunka s necelou súradnicou', mutate: (m) => setAt(m, '/starter/roads/0/y', 1.5), path: '/starter/roads/0/y' },
    { name: 'bunka s kľúčom navyše', mutate: (m) => setAt(m, '/seaLane/0/z', 0), path: '/seaLane/0/z' },
    {
      name: 'rotácia starter modulu 45',
      mutate: (m) => setAt(m, '/starter/modules/-', { defId: 'berth_standard', x: 30, y: 14, rotation: 45 }),
      path: '/starter/modules/2/rotation',
    },
    {
      name: 'defId starter modulu nie je snake_case',
      mutate: (m) => setAt(m, '/starter/modules/-', { defId: 'Berth', x: 30, y: 14, rotation: 0 }),
      path: '/starter/modules/2/defId',
    },
  ];

  it.each(SHAPE_CASES)('$name → $path', ({ mutate, path }) => {
    const raw = rawMap();
    mutate(raw);
    expectMapError(() => parseMapDef(raw), path);
  });

  it('neplatné id mapy → MapError na /id (mapId v správe = surové id)', () => {
    const raw = rawMap();
    setAt(raw, '/id', 'Harbor-01');
    expectMapError(() => parseMapDef(raw), '/id', 'Harbor-01');
  });

  it('JSON pointer escapuje ~ a / v kľúči', () => {
    const raw = rawMap();
    setAt(raw, '/parcels/0/a~b', 1);
    expectMapError(() => parseMapDef(raw), '/parcels/0/a~0b');
    const raw2 = rawMap();
    (raw2.depth as Record<string, unknown>)['1/2'] = 2;
    expectMapError(() => load(raw2), '/depth/1~12');
  });
});
