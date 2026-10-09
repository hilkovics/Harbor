import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Grid, ROTATIONS, rotateFootprint, type CellCoord, type Rotation } from '@sim/grid';
import { connectorOutside, connectorsOf } from '@sim/modules';
import { autotileMask, autotileTile } from '@render/autotile';
import { moduleSprite } from '@render/entity-assets';
import { createRoadMaskAt } from '@render/lane';
import { ConnectorArmIndex, connectorArm, worldConnectors, type ConnectorHost } from '@render/module-connectors';
import { RoadLayer } from '@render/road-layer';
import { loadRenderPalette, tokenResolverFromCss } from '@render/tokens';
import { MODULE_DEFS } from '../sim/modules/module-fixtures';

const PALETTE = loadRenderPalette(
  tokenResolverFromCss(readFileSync(fileURLToPath(new URL('../../design/tokens.css', import.meta.url)), 'utf8')),
);

const N = 1;
const E = 2;
const S = 4;
const W = 8;

/** Modul `defId` s ľavým horným rohom (x, y) PO rotácii; rozmer z manifestu. */
function host(defId: string, x: number, y: number, rotation: Rotation): ConnectorHost {
  const footprint = moduleSprite(defId)?.footprint;
  if (footprint === undefined) throw new Error(`${defId} nie je v manifeste`);
  const size = rotateFootprint(footprint.w, footprint.h, rotation);
  return { defId, x, y, w: size.w, h: size.h, rotation };
}

function grid(size: number, roads: readonly CellCoord[]): Grid {
  const result = new Grid(size, size, () => ({ terrain: 'land' }));
  for (const { x, y } of roads) result.at(x, y).road = 'road';
  return result;
}

/** Modul, ktorý má v manifeste aspoň jeden konektor (brány, stojiská, rampy, dvory, depo, kotviská…). */
const DEF_IDS_WITH_CONNECTORS = MODULE_DEFS.modules.items
  .map((def) => def.id)
  .filter((id) => (moduleSprite(id)?.connectors.length ?? 0) > 0);

describe('worldConnectors (konektory z manifestu) sa zhodujú s konektormi simu (`connectorsOf`)', () => {
  it('existujú moduly s konektormi, ktoré manifest pozná', () => {
    expect(DEF_IDS_WITH_CONNECTORS).toEqual(expect.arrayContaining(['gate_in_lane', 'gate_out_lane', 'truck_waiting_area', 'loading_ramp_container', 'container_yard_small', 'vehicle_depot']));
  });

  it.each(DEF_IDS_WITH_CONNECTORS)('%s: všetky rotácie', (defId) => {
    const def = MODULE_DEFS.modules.get(defId);
    for (const rotation of ROTATIONS) {
      const moduleHost = host(defId, 20, 30, rotation);
      const expected = connectorsOf(def, moduleHost.x, moduleHost.y, rotation).map(({ x, y, side, type }) => ({ x, y, side, type }));
      expect(worldConnectors(moduleHost), `${defId} @ ${String(rotation)}`).toEqual(expected);
    }
  });

  it('modul bez záznamu v manifeste nemá konektory', () => {
    expect(worldConnectors({ defId: 'neexistuje', x: 0, y: 0, w: 1, h: 1, rotation: 0 })).toEqual([]);
  });
});

describe('connectorArm', () => {
  it.each([
    ['n', 0, -1, S],
    ['s', 0, 1, N],
    ['e', 1, 0, W],
    ['w', -1, 0, E],
  ] as const)('strana %s: vonkajšia bunka o krok von a bit späť k modulu', (side, dx, dy, bit) => {
    expect(connectorArm({ x: 5, y: 5, side })).toEqual({ x: 5 + dx, y: 5 + dy, bit });
  });

  it('zhoduje sa so simom: vonkajšia bunka je `connectorOutside`', () => {
    for (const defId of DEF_IDS_WITH_CONNECTORS) {
      for (const connector of worldConnectors(host(defId, 10, 10, 90))) {
        const arm = connectorArm(connector);
        expect({ x: arm.x, y: arm.y }).toEqual(connectorOutside(connector));
      }
    }
  });
});

describe('ConnectorArmIndex', () => {
  it('brána (44; 32) rot 0: cesta pred južným konektorom dostane rameno na sever, pred severným na juh', () => {
    const g = new Grid(60, 60, () => ({ terrain: 'land' }));
    const index = new ConnectorArmIndex(g);
    const changed = index.update([host('truck_gate', 44, 32, 0)]);
    expect(changed).toEqual([
      { x: 44, y: 31 },
      { x: 44, y: 34 },
    ]);
    expect(index.maskAt(44, 34)).toBe(N);
    expect(index.maskAt(44, 31)).toBe(S);
    expect(index.maskAt(44, 33)).toBe(0); // bunka konektora je v module, nie cesta
  });

  it('bez zmeny modulov vráti prázdny zoznam; po odstránení modulu vráti bunky, ktorým ramená zanikli', () => {
    const g = new Grid(60, 60, () => ({ terrain: 'land' }));
    const index = new ConnectorArmIndex(g);
    const gate = host('truck_gate', 44, 32, 0);
    index.update([gate]);
    expect(index.update([{ ...gate }])).toEqual([]);
    expect(index.update([])).toEqual([
      { x: 44, y: 31 },
      { x: 44, y: 34 },
    ]);
    expect(index.maskAt(44, 34)).toBe(0);
  });

  it('presun modulu zmení rameno na starej aj novej bunke', () => {
    const g = new Grid(60, 60, () => ({ terrain: 'land' }));
    const index = new ConnectorArmIndex(g);
    index.update([host('vehicle_depot', 10, 10, 0)]); // konektor (1; 2) strana s → vonkajšia (11; 13)
    expect(index.maskAt(11, 13)).toBe(N);
    const changed = index.update([host('vehicle_depot', 20, 10, 0)]);
    expect(changed).toEqual([
      { x: 11, y: 13 },
      { x: 21, y: 13 },
    ]);
  });

  it('ramená mimo mapy sa ignorujú', () => {
    const g = new Grid(10, 10, () => ({ terrain: 'land' }));
    const index = new ConnectorArmIndex(g);
    expect(index.update([host('vehicle_depot', 0, 7, 0)])).toEqual([]); // vonkajšia bunka (1; 10) leží mimo mapy
  });

  it('ignoruje konektory iného typu než vrstva indexu', () => {
    const g = new Grid(60, 60, () => ({ terrain: 'land' }));
    const rails = new ConnectorArmIndex(g, 'rail');
    expect(rails.update([host('truck_gate', 44, 32, 0)])).toEqual([]);
  });
});

describe('autotile s ramenom k modulu', () => {
  it('rameno k modulu pridá smer do masky: `corner` sa zmení na `t`', () => {
    const g = grid(60, [
      { x: 44, y: 34 },
      { x: 44, y: 35 },
      { x: 45, y: 34 },
    ]);
    expect(autotileTile(g, 44, 35, 'road')).toEqual({ shape: 'end', rotation: 0 });
    // bunka (44; 34) má sama suseda S a E; rameno N ju zmení z `corner` (E S) na `t`
    expect(autotileTile(g, 44, 34, 'road')).toEqual({ shape: 'corner', rotation: 90 });
    expect(autotileTile(g, 44, 34, 'road', N)).toEqual({ shape: 't', rotation: 90 });
    expect(autotileMask(g, 44, 34, 'road', N)).toBe(N | E | S);
  });

  it('`createRoadMaskAt` s ramenami: vozidlo vchádzajúce do modulu zo zákruty vidí zákrutu', () => {
    const g = grid(20, [
      { x: 5, y: 8 },
      { x: 6, y: 8 },
    ]);
    const index = new ConnectorArmIndex(g);
    index.update([host('vehicle_depot', 4, 5, 0)]); // konektor (5; 7) s → vonkajšia (5; 8) s ramenom N
    expect(createRoadMaskAt(g)(5, 8)).toBe(E);
    expect(createRoadMaskAt(g, index.maskAt)(5, 8)).toBe(N | E);
    expect(createRoadMaskAt(g, index.maskAt)(6, 8)).toBe(W);
  });
});

describe('RoadLayer napojený na konektory modulov', () => {
  /** Cesta x = 44 od y = 34 dole; brána (44; 32) má južný konektor (44; 33) → vonkajšia bunka (44; 34). */
  function gateScene(): { g: Grid; index: ConnectorArmIndex; layer: RoadLayer } {
    const g = grid(
      64,
      Array.from({ length: 10 }, (_, i) => ({ x: 44, y: 34 + i })),
    );
    const index = new ConnectorArmIndex(g);
    const layer = new RoadLayer(g, PALETTE, null, index.maskAt);
    return { g, index, layer };
  }

  it('bez ramena končí cesta zaobleným koncom `end`; s ramenom sa napojí (`straight`)', () => {
    const { index, layer } = gateScene();
    expect(layer.tileAt(44, 34)).toEqual({ shape: 'end', rotation: 180 });
    layer.updateRoads(index.update([host('truck_gate', 44, 32, 0)]));
    expect(layer.tileAt(44, 34)).toEqual({ shape: 'straight', rotation: 0 });
    expect(layer.tileAt(44, 35)).toEqual({ shape: 'straight', rotation: 0 });
  });

  it('po odstránení modulu sa cesta vráti na zaoblený koniec', () => {
    const { index, layer } = gateScene();
    layer.updateRoads(index.update([host('truck_gate', 44, 32, 0)]));
    layer.updateRoads(index.update([]));
    expect(layer.tileAt(44, 34)).toEqual({ shape: 'end', rotation: 180 });
  });

  it('rampa otočená o 90°: rameno smeruje k modulu pri každej rotácii', () => {
    for (const rotation of ROTATIONS) {
      const moduleHost = host('loading_ramp_container', 20, 20, rotation);
      const g = new Grid(64, 64, () => ({ terrain: 'land' }));
      const arms = worldConnectors(moduleHost).map(connectorArm);
      for (const arm of arms) g.at(arm.x, arm.y).road = 'road';
      const index = new ConnectorArmIndex(g);
      const layer = new RoadLayer(g, PALETTE, null, index.maskAt);
      layer.updateRoads(index.update([moduleHost]));
      for (const arm of arms) {
        const tile = layer.tileAt(arm.x, arm.y);
        // osamotená bunka cesty s jediným ramenom k modulu (susedné vonkajšie bunky sa môžu dotýkať → priama čiara)
        expect(tile, `rot ${String(rotation)} @ ${String(arm.x)},${String(arm.y)}`).toBeDefined();
        expect(autotileMask(g, arm.x, arm.y, 'road', index.maskAt(arm.x, arm.y)) & arm.bit).toBe(arm.bit);
      }
    }
  });
});
