import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { AUTOTILE_SHAPE_BASE_MASK, AUTOTILE_TABLE } from '@render/autotile';
import { parseCssPx, tokenResolverFromCss } from '@render/tokens';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ASSETS_DIR = join(ROOT, 'assets');
const SCHEMA_PATH = join(ROOT, 'data', 'schemas', 'asset-manifest.schema.json');
const TOKENS_PATH = join(ROOT, 'design', 'tokens.css');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const manifest = JSON.parse(readFileSync(join(ASSETS_DIR, 'manifest.json'), 'utf8')) as JsonObject;
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object;
const validate = new Ajv2020({ allErrors: true }).compile(schema);

/** Hlboká kópia manifestu na úpravu v negatívnych testoch. */
function cloneManifest(): JsonObject {
  return JSON.parse(JSON.stringify(manifest)) as JsonObject;
}

function errorsOf(value: unknown): string[] {
  validate(value);
  return (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`.trim());
}

/** Všetky reťazce s príponou `.svg` v manifeste (rekurzívne), so zdrojovou cestou pre chybové hlásenie. */
function referencedSvgFiles(value: Json, path = ''): { path: string; file: string }[] {
  if (typeof value === 'string') return value.endsWith('.svg') ? [{ path, file: value }] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => referencedSvgFiles(item, `${path}[${String(i)}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => referencedSvgFiles(item, `${path}/${key}`));
  }
  return [];
}

/** Cesty všetkých `*.svg` pod `dir`, relatívne k `assets/` s lomkou `/`. */
function svgFilesOnDisk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...svgFilesOnDisk(full));
    else if (entry.name.endsWith('.svg')) found.push(relative(ASSETS_DIR, full).split(sep).join('/'));
  }
  return found;
}

/** Koreňový `<svg …>` súboru assetu: `width`, `height` a `viewBox`. */
function svgHeader(file: string): { width: number; height: number; viewBox: string } {
  const head = /<svg\b[^>]*>/.exec(readFileSync(join(ASSETS_DIR, file), 'utf8'))?.[0] ?? '';
  const attribute = (name: string): string => new RegExp(`\\s${name}="([^"]*)"`).exec(head)?.[1] ?? '';
  return { width: Number(attribute('width')), height: Number(attribute('height')), viewBox: attribute('viewBox') };
}

describe('assets/manifest.json vs. data/schemas/asset-manifest.schema.json', () => {
  it('kanonický manifest je platný', () => {
    expect(errorsOf(manifest)).toEqual([]);
  });

  it('obsahuje všetky sekcie: conventions, terrain, infra, sprites, entities, cargo, overlay, icons', () => {
    expect(Object.keys(manifest)).toEqual(
      expect.arrayContaining(['schemaVersion', 'cellPx', 'conventions', 'terrain', 'infra', 'sprites', 'entities', 'cargo', 'overlay', 'icons']),
    );
  });

  it('cellPx zodpovedá tokenu --cell', () => {
    const resolve = tokenResolverFromCss(readFileSync(TOKENS_PATH, 'utf8'));
    expect(manifest.cellPx).toBe(parseCssPx(resolve('--cell')));
  });

  describe('schéma odmieta poškodený manifest', () => {
    const mutate = (change: (copy: JsonObject) => void): string[] => {
      const copy = cloneManifest();
      change(copy);
      return errorsOf(copy);
    };
    const section = (copy: JsonObject, name: string): JsonObject => copy[name] as JsonObject;

    it('chýbajúca sekcia', () => {
      expect(mutate((m) => delete m.overlay).join('\n')).toContain('must have required property \'overlay\'');
    });

    it('iná verzia schémy', () => {
      expect(mutate((m) => (m.schemaVersion = 2)).length).toBeGreaterThan(0);
    });

    it('neznáma sekcia navyše', () => {
      expect(mutate((m) => (m.audio = {})).join('\n')).toContain('must NOT have additional properties');
    });

    it('cesta súboru mimo vzoru {adresár}/{id}.svg', () => {
      const errors = mutate((m) => ((section(m, 'terrain').quay as JsonObject).file = 'Terrain/Quay.svg'));
      expect(errors.some((error) => error.startsWith('/terrain/quay/file'))).toBe(true);
    });

    it('neznáme pole v dlaždici terénu', () => {
      const errors = mutate((m) => ((section(m, 'terrain').quay as JsonObject).colour = 'red'));
      expect(errors.some((error) => error.startsWith('/terrain/quay'))).toBe(true);
    });

    it('neplatná strana v connectsAtRot0', () => {
      const errors = mutate((m) => {
        const tiles = (section(m, 'infra').road as JsonObject).tiles as JsonObject;
        (tiles.corner as JsonObject).connectsAtRot0 = ['n', 'x'];
      });
      expect(errors.some((error) => error.startsWith('/infra/road/tiles/corner/connectsAtRot0'))).toBe(true);
    });

    it('dlaždica infraštruktúry bez connectsAtRot0', () => {
      const errors = mutate((m) => {
        const tiles = (section(m, 'infra').road as JsonObject).tiles as JsonObject;
        delete (tiles.end as JsonObject).connectsAtRot0;
      });
      expect(errors.join('\n')).toContain("must have required property 'connectsAtRot0'");
    });

    it('sprite modulu bez file / states / parts', () => {
      const errors = mutate((m) => {
        const yard = section(m, 'sprites').container_yard_small as JsonObject;
        delete yard.states;
      });
      expect(errors.some((error) => error.startsWith('/sprites/container_yard_small'))).toBe(true);
    });

    it('konektor s neznámym typom', () => {
      const errors = mutate((m) => {
        const berth = section(m, 'sprites').berth_standard as JsonObject;
        ((berth.connectors as JsonObject[])[0]).type = 'sea';
      });
      expect(errors.some((error) => error.startsWith('/sprites/berth_standard/connectors/0/type'))).toBe(true);
    });

    it('ikona mimo vzoru ic_*', () => {
      const errors = mutate((m) => {
        ((section(m, 'icons').symbols as string[])[0]) = 'container';
      });
      expect(errors.some((error) => error.startsWith('/icons/symbols/0'))).toBe(true);
    });
  });
});

describe('súbory assetov', () => {
  // `conventions` je textový popis (obsahuje šablónu názvu `{id}[_{variant}][_{state}].svg`), nie odkaz na súbor.
  const assetSections = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'conventions'));
  const referenced = referencedSvgFiles(assetSections);
  const onDisk = svgFilesOnDisk(ASSETS_DIR);

  it('každý súbor odkazovaný z manifestu existuje', () => {
    const missing = referenced.filter(({ file }) => !existsSync(join(ASSETS_DIR, file)));
    expect(missing).toEqual([]);
  });

  it('každé SVG v assets/ je v manifeste', () => {
    const listed = new Set(referenced.map(({ file }) => file));
    expect(onDisk.filter((file) => !listed.has(file)).sort()).toEqual([]);
  });

  it('manifest neodkazuje jeden súbor z dvoch rôznych sprite ids (okrem stavov zdieľaných zámerne)', () => {
    const counts = new Map<string, string[]>();
    for (const { path, file } of referenced) counts.set(file, [...(counts.get(file) ?? []), path]);
    const duplicated = [...counts.entries()].filter(([, paths]) => paths.length > 1);
    expect(duplicated).toEqual([]);
  });

  it('dlaždice terénu a infraštruktúry majú 24 a 15 súborov (DESIGN_BRIEF §5.1, §5.2)', () => {
    expect(onDisk.filter((file) => file.startsWith('terrain/'))).toHaveLength(24);
    expect(onDisk.filter((file) => file.startsWith('infra/'))).toHaveLength(15);
  });

  it('SVG dlaždice terénu a infraštruktúry majú rozmer footprint × cellPx (viewBox 0 0 w h)', () => {
    const cellPx = manifest.cellPx as number;
    const tiles: { id: string; file: string; footprint: { w: number; h: number } }[] = [];
    for (const [id, entry] of Object.entries(manifest.terrain as Record<string, { file: string; footprint: { w: number; h: number } }>)) {
      tiles.push({ id: `terrain/${id}`, file: entry.file, footprint: entry.footprint });
    }
    type InfraLayer = { footprint: { w: number; h: number }; tiles: Record<string, { file: string }> };
    for (const [layer, entry] of Object.entries(manifest.infra as Record<string, InfraLayer>)) {
      for (const [tile, { file }] of Object.entries(entry.tiles)) tiles.push({ id: `infra/${layer}/${tile}`, file, footprint: entry.footprint });
    }
    expect(tiles).toHaveLength(24 + 15);
    for (const { id, file, footprint } of tiles) {
      const w = footprint.w * cellPx;
      const h = footprint.h * cellPx;
      expect(svgHeader(file), id).toEqual({ width: w, height: h, viewBox: `0 0 ${String(w)} ${String(h)}` });
    }
  });

  it('názvy súborov dlaždíc infraštruktúry sú infra/{vrstva}_{tvar}.svg', () => {
    type InfraLayer = { tiles: Record<string, { file: string }> };
    for (const [layer, entry] of Object.entries(manifest.infra as Record<string, InfraLayer>)) {
      for (const [tile, { file }] of Object.entries(entry.tiles)) expect(file).toBe(`infra/${layer}_${tile}.svg`);
    }
  });

  it('názvy súborov terénu sú terrain/{id}.svg', () => {
    for (const [id, entry] of Object.entries(manifest.terrain as Record<string, { file: string }>)) {
      expect(entry.file).toBe(`terrain/${id}.svg`);
    }
  });
});

describe('autotile (T01-08) vs. connectsAtRot0 z manifestu', () => {
  type Side = 'n' | 'e' | 's' | 'w';
  /** Poradie strán v smere hodinových ručičiek; rotácia o 90° posunie stranu o jedno miesto. */
  const CLOCKWISE: readonly Side[] = ['n', 'e', 's', 'w'];
  const BIT: Record<Side, number> = { n: 1, e: 2, s: 4, w: 8 };
  type Layer = { tiles: Record<string, { file: string; connectsAtRot0: Side[] }> };
  const infra = manifest.infra as unknown as Record<string, Layer>;

  /** Maska strán, na ktoré dlaždica nadväzuje po otočení o `rotation` stupňov v smere hodinových ručičiek. */
  function connectedMask(sides: readonly Side[], rotation: number): number {
    const turns = rotation / 90;
    return sides.reduce((mask, side) => mask | BIT[CLOCKWISE[(CLOCKWISE.indexOf(side) + turns) % 4]], 0);
  }

  it.each(['road', 'rail'])('%s: manifest má presne tvary autotile (end, straight, corner, t, cross)', (layer) => {
    expect(Object.keys(infra[layer].tiles).sort()).toEqual(Object.keys(AUTOTILE_SHAPE_BASE_MASK).sort());
  });

  it.each(['road', 'rail'])('%s: základná orientácia tvaru (rot 0) = AUTOTILE_SHAPE_BASE_MASK', (layer) => {
    for (const [shape, { connectsAtRot0 }] of Object.entries(infra[layer].tiles)) {
      expect(connectedMask(connectsAtRot0, 0), `${layer}/${shape}`).toBe(AUTOTILE_SHAPE_BASE_MASK[shape as keyof typeof AUTOTILE_SHAPE_BASE_MASK]);
    }
  });

  it.each(['road', 'rail'])('%s: pre každú masku 1…15 otočená dlaždica z tabuľky nadväzuje presne na strany masky', (layer) => {
    for (let mask = 1; mask < AUTOTILE_TABLE.length; mask++) {
      const { shape, rotation } = AUTOTILE_TABLE[mask];
      const tile = infra[layer].tiles[shape];
      expect(tile, `${layer}: tvar ${shape} pre masku ${String(mask)}`).toBeDefined();
      expect(connectedMask(tile.connectsAtRot0, rotation), `${layer}: maska ${String(mask)} → ${shape} @ ${String(rotation)}°`).toBe(mask);
    }
  });

  it('maska 0 (izolovaná cesta) sa kreslí ako `end` v základnej orientácii', () => {
    expect(AUTOTILE_TABLE[0]).toEqual({ shape: 'end', rotation: 0 });
  });
});
