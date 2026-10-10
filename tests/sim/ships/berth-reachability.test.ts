// Statická dosiahnuteľnosť kotviska (T06-08b, review src/sim po T06-07; ADR-031 dodatok):
//  1. `berthReadiness` (AcceptContract) hodnotil len tvar úseku (dĺžka, hĺbka, pás vody, žeriav) — kotvisko v plytkej
//     zátoke alebo v lagúne za úzkym hrdlom bolo `ready`, kontrakt sa prijal a loď navždy čakala na anchorage;
//  2. `ShipTraffic.berthCandidates` po prvom tvarom vyhovujúcom úseku skupiny vynechal dlhšie úseky tej istej skupiny,
//     aj keď k najkratšiemu úseku loď staticky nedopláva.
// Dosiahnuteľnosť = `berthLeg` z konca dráhy aj `exitLeg` späť na prázdnej vode (lode sú dočasné prekážky).
import { describe, expect, it } from 'vitest';
import { SpawnShipDebugCommand, commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { ContractId } from '@sim/core';
import { loadMap, parseMapDef, type CellCoord, type LoadedMap } from '@sim/grid';
import type { BerthModule } from '@sim/modules';
import type { Ship } from '@sim/ships';
import { World } from '@sim/world';
import { must } from '../helpers/harbor';
import { assertCargoConservation } from '../helpers/invariants';
import { DEFS, acceptContract, commandReasons, offeredContracts, stateOfContract } from '../helpers/f5';

const BAY_WIDTH = 48;
const BAY_HEIGHT = 40;
const SEED = 6082;

/**
 * Syntetická mapa „bay_test" 48×40 (kotviská rot 0, voda na sever, nábrežie y 14–16, pod ním pevnina):
 *  - otvorená voda x 0–23, y 0–13; sea lane (4, 0) → (4, 5), anchorage (12, 3);
 *  - **plytká zátoka** x 24–31, y 11–13 — presne pás vody kotviska C (3 riadky); bod priblíženia C (obdĺžnik lode
 *    o `frontWaterCells` ďalej od brehu, y 9–10) leží na súši;
 *  - **lagúna** x 34–45, y 4–13 za hrdlom širokým 1 bunku (x 32–33, y 12) — bod priblíženia D je na vode, ale feeder
 *    (šírka 2) hrdlom neprepláva.
 * Kotviská: B (16, 14) na otvorenej vode, C (24, 14) v zátoke — B a C tvoria jednu skupinu; D (36, 14) v lagúne.
 */
function bayTerrain(x: number, y: number): string {
  if (y >= 17) return '.';
  if (y >= 14) return 'Q';
  if (x <= 23) return '~';
  if (x <= 31) return y >= 11 ? '~' : '.';
  if (x <= 33) return y === 12 ? '~' : '.';
  if (x <= 45) return y >= 4 ? '~' : '.';
  return '.';
}

const BAY_MAP: LoadedMap = loadMap(
  parseMapDef({
    schemaVersion: 1,
    id: 'bay_test',
    width: BAY_WIDTH,
    height: BAY_HEIGHT,
    terrain: Array.from({ length: BAY_HEIGHT }, (_, y) => Array.from({ length: BAY_WIDTH }, (_, x) => bayTerrain(x, y)).join('')),
    depth: {},
    parcels: [{ id: 'dock', rect: { x: 0, y: 0, w: BAY_WIDTH, h: BAY_HEIGHT - 1 }, priceCents: 0, leasable: false, startOwned: true }],
    roadPortals: [{ id: 'south', cell: { x: BAY_WIDTH - 1, y: BAY_HEIGHT - 1 } }],
    railPortals: [],
    seaLane: [
      { x: 4, y: 0 },
      { x: 4, y: 5 },
    ],
    anchorage: [{ x: 12, y: 3 }],
    starter: { modules: [], roads: [] },
  }),
);

const OPEN_B: CellCoord = { x: 16, y: 14 };
const BAY_C: CellCoord = { x: 24, y: 14 };
const LAGOON_D: CellCoord = { x: 36, y: 14 };
/** Posun žeriavu od ľavého horného rohu kotviska (rot 0). */
const CRANE_OFFSET = 3;
/** Koniec dráhy (stred bunky (4, 5)), kurz na juh. */
const HUB = { x: 4.5, y: 5.5, heading: 180 } as const;
/** Strop tickov na príchod lode kontraktu (najneskôr `arrivalDaysRange[1]` = 2 dni) a plavbu ku kotvisku. */
const CONTRACT_SHIP_LIMIT = 20_000;
/** Strop tickov, za ktoré ladiaca loď z konca dráhy zakotví. */
const DEBUG_SHIP_LIMIT = 1_500;

const feeder = DEFS.ships.get('feeder');

/** Kotvisko (overené pravidlami `PlaceModule` okrem ceny) a voliteľne kontajnerový žeriav na ňom. */
function berth(world: World, cell: CellCoord, crane: boolean): BerthModule {
  const place = (defId: string, x: number): SerializedCommand => ({ type: 'PlaceModule', defId, x, y: cell.y, rotation: 0 });
  const rules = (command: SerializedCommand): readonly string[] => commandReasons(world, command).filter((reason) => reason !== 'insufficient_funds');
  expect(rules(place('berth_standard', cell.x)), `kotvisko ${String(cell.x)},${String(cell.y)}`).toEqual([]);
  const placed = world.placeModule({ defId: 'berth_standard', x: cell.x, y: cell.y, rotation: 0 }, 0) as BerthModule;
  if (crane) {
    expect(rules(place('crane_container_gantry', cell.x + CRANE_OFFSET))).toEqual([]);
    world.placeModule({ defId: 'crane_container_gantry', x: cell.x + CRANE_OFFSET, y: cell.y, rotation: 0 }, 0);
  }
  return placed;
}

/** Svet zátoky s kotviskami a naplneným poolom ponúk (prvý tick). */
function bayWorld(build: (world: World) => void): World {
  const world = World.create(DEFS, BAY_MAP, SEED);
  build(world);
  world.tick();
  return world;
}

function firstOffer(world: World): number {
  return must(offeredContracts(world)[0], 'ponuka').id;
}

function spawnFeeder(world: World, units: number): Ship {
  world.enqueue(new SpawnShipDebugCommand({ shipClassId: 'feeder', cargoTypeId: 'container_teu', units }));
  const event = world.applyPending().find((candidate) => candidate.type === 'ShipSpawned');
  if (event?.type !== 'ShipSpawned') throw new Error('ShipSpawned chýba');
  return must(world.ships.get(event.shipId), 'loď');
}

describe('dosiahnuteľnosť kotviska v pripravenosti prístavu (AcceptContract)', () => {
  it('plytká zátoka: bod priblíženia C na súši → berth_unreachable (predtým ponuka prešla a loď čakala navždy)', () => {
    let c: BerthModule | undefined;
    const world = bayWorld((w) => {
      c = berth(w, BAY_C, true);
    });
    const bay = must(c, 'C');
    expect(world.shipTraffic.berthLeg(feeder, HUB, bay, [])).toBeNull();
    expect(world.shipTraffic.reachesBerth(feeder, bay)).toBe(false);
    expect(commandReasons(world, acceptContract(firstOffer(world)))).toEqual(['berth_unreachable']);
  });

  it('lagúna za hrdlom širokým 1 bunku: cesta po vode k D nevedie → berth_unreachable', () => {
    let d: BerthModule | undefined;
    const world = bayWorld((w) => {
      d = berth(w, LAGOON_D, true);
    });
    const lagoon = must(d, 'D');
    expect(world.shipTraffic.berthLeg(feeder, HUB, lagoon, [])).toBeNull();
    expect(world.shipTraffic.exitLeg(feeder, lagoon, [])).toBeNull();
    expect(commandReasons(world, acceptContract(firstOffer(world)))).toEqual(['berth_unreachable']);
  });

  it('dosiahnuteľné kotvisko bez žeriavu a nedosiahnuteľné so žeriavom (rôzne skupiny) → no_crane_for_category', () => {
    const world = bayWorld((w) => {
      berth(w, OPEN_B, false);
      berth(w, LAGOON_D, true);
    });
    expect(world.berthGroups).toHaveLength(2);
    expect(commandReasons(world, acceptContract(firstOffer(world)))).toEqual(['no_crane_for_category']);
  });

  it('B na otvorenej vode (bez žeriavu) + C v zátoke (so žeriavom) = skupina [B, C] s dosiahnuteľným prvým kotviskom → OK', () => {
    const world = bayWorld((w) => {
      berth(w, OPEN_B, false);
      berth(w, BAY_C, true);
    });
    expect(world.berthGroups.map((group) => group.totalLength)).toEqual([16]);
    expect(commandReasons(world, acceptContract(firstOffer(world)))).toEqual([]);
  });
});

describe('kandidáti na kotviská: najkratší úsek skupiny len spomedzi dosiahnuteľných', () => {
  it('ladiaca loď: [C] je nedosiahnuteľný → loď zakotví pri [B, C] (predtým [C] zablokoval dlhší úsek a loď čakala navždy)', () => {
    const world = World.create(DEFS, BAY_MAP, SEED);
    const b = berth(world, OPEN_B, false);
    const c = berth(world, BAY_C, true);
    const ship = spawnFeeder(world, 4);
    for (let i = 0; i < DEBUG_SHIP_LIMIT && ship.state !== 'docked'; i++) {
      world.tick();
      assertCargoConservation(world);
    }
    expect(ship.state).toBe('docked');
    expect(ship.berthIds).toEqual([b.id, c.id]);
  });

  it('scenár: prijatý kontrakt na [B, C] — loď kontraktu zakotví a vykladá (unloading), náklad sa nestratí', () => {
    let b: BerthModule | undefined;
    let c: BerthModule | undefined;
    const world = bayWorld((w) => {
      b = berth(w, OPEN_B, false);
      c = berth(w, BAY_C, true);
    });
    const id = firstOffer(world);
    world.enqueue(commandFromJSON(acceptContract(id)));
    expect(world.applyPending().some((event) => event.type === 'CommandRejected')).toBe(false);
    for (let i = 0; i < CONTRACT_SHIP_LIMIT && stateOfContract(world, id) !== 'unloading'; i++) {
      world.tick();
      assertCargoConservation(world);
    }
    expect(stateOfContract(world, id)).toBe('unloading');
    const shipId = must(world.contracts.get(id as ContractId)?.shipId, 'loď kontraktu');
    const ship = must(world.ships.get(shipId), 'loď kontraktu na mape');
    expect(ship.berthIds).toEqual([must(b, 'B').id, must(c, 'C').id]);
  });

  it('dosiahnuteľnosť je statická: loď pri B ju nemení (dočasná prekážka), výsledok je stály', () => {
    const world = World.create(DEFS, BAY_MAP, SEED);
    const b = berth(world, OPEN_B, false);
    const c = berth(world, BAY_C, true);
    expect(world.shipTraffic.reachesBerth(feeder, b)).toBe(true);
    const ship = spawnFeeder(world, 40);
    for (let i = 0; i < DEBUG_SHIP_LIMIT && ship.state !== 'docked'; i++) world.tick();
    expect(ship.state).toBe('docked');
    expect(world.shipTraffic.reachesBerth(feeder, b)).toBe(true);
    expect(world.shipTraffic.reachesBerth(feeder, c)).toBe(false);
    // Nový modul (zmena verzie modulov) memo zneplatní; výsledok sa nemení.
    berth(world, LAGOON_D, true);
    expect(world.shipTraffic.reachesBerth(feeder, b)).toBe(true);
    expect(world.shipTraffic.reachesBerth(feeder, c)).toBe(false);
  });
});
