// Jednosmerný prístav (R1, ADR-037 dodatok): cestný portál má smer (`in` = vjazd, kde vznikajú kamióny a odkiaľ sa určujú strany brán,
// `out` = výjazd, kde kamióny opúšťajú mapu, `both` / bez poľa = oboje ako doteraz). Rampa je prevádzková, len keď sa z vnútornej strany
// brány dá dôjsť k výjazdovému portálu.
import { describe, expect, it } from 'vitest';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { CellCoord } from '@sim/grid';
import { loadMap, parseMapDef } from '@sim/grid';
import { NO_ACCESS } from '@sim/logistics';
import { TruckGate, LoadingRamp } from '@sim/modules';
import { World } from '@sim/world';
import { DEFS, LEGACY_HARBOR_JSON, SEED } from './world-fixtures';

const IN_CELL: CellCoord = { x: 44, y: 63 };
const OUT_CELL: CellCoord = { x: 60, y: 63 };

function mapWith(roadPortals: readonly { id: string; cell: CellCoord; direction?: string }[], extraRoads: readonly CellCoord[] = []) {
  return loadMap(
    parseMapDef({
      ...LEGACY_HARBOR_JSON,
      roadPortals,
      starter: { ...LEGACY_HARBOR_JSON.starter, modules: [], roads: [...LEGACY_HARBOR_JSON.starter.roads, ...extraRoads] },
    }),
  );
}

const row = (y: number, x0: number, x1: number): CellCoord[] => Array.from({ length: x1 - x0 + 1 }, (_unused, i) => ({ x: x0 + i, y }));

function apply(world: World, ...commands: readonly SerializedCommand[]): void {
  for (const command of commands) world.enqueue(commandFromJSON(command));
  expect(world.applyPending().filter((event) => event.type === 'CommandRejected')).toEqual([]);
}

/** Pozemný reťazec (brána, stojisko, rampa) ako v `landside.test.ts`; výjazdový portál (60, 63) je spojený s trasou po y = 63, ak `linked`. */
function build(linked: boolean): World {
  const portals = [
    { id: 'road_in', cell: IN_CELL, direction: 'in' },
    { id: 'road_out', cell: OUT_CELL, direction: 'out' },
  ];
  const world = World.create(DEFS, mapWith(portals, [OUT_CELL, ...(linked ? row(63, 45, 59) : [])]), SEED);
  apply(
    world,
    { type: 'PlaceRoad', cells: [{ x: 44, y: 33 }] },
    { type: 'PlaceRoad', cells: [{ x: 47, y: 33 }, { x: 48, y: 33 }] },
    { type: 'PlaceRoad', cells: [{ x: 53, y: 31 }, { x: 53, y: 32 }, { x: 53, y: 33 }] },
    { type: 'PlaceRoad', cells: row(30, 51, 55) },
    { type: 'PlaceModule', defId: 'truck_gate', x: 45, y: 32, rotation: 270 },
    { type: 'PlaceModule', defId: 'truck_waiting_area', x: 49, y: 31, rotation: 0 },
    { type: 'PlaceModule', defId: 'loading_ramp_container', x: 53, y: 28, rotation: 0 },
  );
  return world;
}

const idx = (world: World, cell: CellCoord): number => world.grid.index(cell.x, cell.y);

describe('smer cestného portálu', () => {
  it('in a out: vjazd = portál in (vznik kamiónov), výjazd = portál out (opustenie mapy)', () => {
    const world = World.create(DEFS, mapWith([{ id: 'road_in', cell: IN_CELL, direction: 'in' }, { id: 'road_out', cell: OUT_CELL, direction: 'out' }], [OUT_CELL]), SEED);
    expect(world.landside.portalCell).toBe(idx(world, IN_CELL));
    expect(world.landside.exitPortalCell).toBe(idx(world, OUT_CELL));
  });

  it('bez poľa direction (staré mapy a scenáre) je portál both: vjazd aj výjazd na tej istej bunke', () => {
    const world = World.create(DEFS, mapWith([{ id: 'road_south', cell: IN_CELL }]), SEED);
    expect(world.landside.portalCell).toBe(idx(world, IN_CELL));
    expect(world.landside.exitPortalCell).toBe(idx(world, IN_CELL));
  });

  it('portál iba out nie je vjazd: kamióny nemajú kde vzniknúť (portalCell NO_ACCESS), výjazd platí', () => {
    const world = World.create(DEFS, mapWith([{ id: 'road_out_only', cell: IN_CELL, direction: 'out' }]), SEED);
    expect(world.landside.portalCell).toBe(NO_ACCESS);
    expect(world.landside.exitPortalCell).toBe(idx(world, IN_CELL));
  });

  it('portál iba in nie je výjazd: exitPortalCell NO_ACCESS', () => {
    const world = World.create(DEFS, mapWith([{ id: 'road_in_only', cell: IN_CELL, direction: 'in' }]), SEED);
    expect(world.landside.portalCell).toBe(idx(world, IN_CELL));
    expect(world.landside.exitPortalCell).toBe(NO_ACCESS);
  });

  it('prvý vhodný portál: vjazdom je prvý in/both, výjazdom prvý out/both', () => {
    const world = World.create(
      DEFS,
      mapWith([{ id: 'a', cell: OUT_CELL, direction: 'out' }, { id: 'b', cell: IN_CELL, direction: 'both' }], [OUT_CELL]),
      SEED,
    );
    expect(world.landside.portalCell).toBe(idx(world, IN_CELL));
    expect(world.landside.exitPortalCell).toBe(idx(world, OUT_CELL));
  });
});

describe('strany brány a prevádzkovosť rampy podľa vjazdu a výjazdu', () => {
  it('strany brány sa určujú z vjazdu: vstup (44, 33) je dosiahnuteľný z portálu in', () => {
    const world = build(true);
    const gate = [...world.modules.values()].find((module): module is TruckGate => module instanceof TruckGate);
    expect(gate).toBeDefined();
    const sides = world.gateSides(gate as TruckGate);
    expect([sides.entryCell, sides.exitCell]).toEqual([idx(world, { x: 44, y: 33 }), idx(world, { x: 47, y: 33 })]);
  });

  it('rampa je prevádzková, len keď sa z brány dá dôjsť k výjazdovému portálu', () => {
    const linked = build(true);
    const ramp = [...linked.modules.values()].find((module): module is LoadingRamp => module instanceof LoadingRamp) as LoadingRamp;
    expect(linked.rampStatus(ramp)).toMatchObject({ operational: true });

    const cut = build(false);
    const cutRamp = [...cut.modules.values()].find((module): module is LoadingRamp => module instanceof LoadingRamp) as LoadingRamp;
    expect(cut.rampStatus(cutRamp)).toMatchObject({ operational: false, reason: 'no_return_path' });
  });
});
