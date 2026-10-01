// Regresie z review src/sim po T5B-02 (karta T5B-04b, ADR-029 addendum):
//  1. posun bokom od kotviska na bod priblíženia je súčasťou cesty von — loď pri susednom kotvisku vo vnútornom rohu
//     nábrežia ho nesmie zatarasiť (predtým loď pri prvom kotvisku ostala `docked` naveky);
//  2. loď zo save v5, ktorá čakala na konci dráhy bez anchorage, sa normalizuje pred vstup (`arriving`) — predtým
//     zablokovala cestu von dokovanej lodi a anchorage pred ústím kanála dostala, lebo dokovaná loď „cestu von nemala";
//     loď, ktorá cestu von nemá pre dočasnú prekážku, sa pri pridelení anchorage nepreskočí;
//  3. obnova overí trasy podľa stavu a rezervácie lodí na mape (fail-fast namiesto porušenia kroku 12 o pár tickov);
//  + strážca FIFO: `heldBack` (neskoršie lode čakajú) vyvolá len pohybujúca sa loď, nie stojaca (dnešné defy).
import { describe, expect, it } from 'vitest';
import { SpawnShipDebugCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { loadMap, parseMapDef, type LoadedMap } from '@sim/grid';
import type { BerthModule } from '@sim/modules';
import { DOCKED_HEADING, SHIP_STATE_TRAITS, Ship, cellCenter, dockPoint, shipBox, shipCells, type SerializedShip } from '@sim/ships';
import { World, WorldStateError, type WorldState } from '@sim/world';
import { DEFS, MAP } from '../world/world-fixtures';
import { toV6State } from '../helpers/legacy-save';
import { ANCHORAGE_AT_MOUTH, ANCHORAGE_ON_LANE, ANCHORAGE_OPEN, CHANNEL_BERTHS, CHANNEL_MAP, CHANNEL_MAP_W1 } from './channel-map';

/** Toľko jednotiek, že apron sa zaplní a bez vozidiel loď pri kotvisku ostane. */
const STAYS_DOCKED = 40;

function spawn(world: World, shipClassId: string, units: number): Ship {
  world.enqueue(new SpawnShipDebugCommand({ shipClassId, cargoTypeId: 'container_teu', units }));
  const event = world.applyPending().find((candidate) => candidate.type === 'ShipSpawned');
  if (event?.type !== 'ShipSpawned') throw new Error('ShipSpawned chýba');
  const ship = world.ships.get(event.shipId);
  if (ship === undefined) throw new Error(`loď #${String(event.shipId)} chýba`);
  return ship;
}

/** Prvá bunka zdieľaná dvoma loďami na mape (nezávisle od implementácie invariantu). */
function sharedCell(world: World): string | undefined {
  const owner = new Map<string, EntityId>();
  for (const ship of world.ships.values()) {
    if (!SHIP_STATE_TRAITS[ship.state].onMap) continue;
    for (const cell of shipCells(ship)) {
      const key = `${String(cell.x)},${String(cell.y)}`;
      const other = owner.get(key);
      if (other !== undefined) return `${key}: #${String(other)} a #${String(ship.id)}`;
      owner.set(key, ship.id);
    }
  }
  return undefined;
}

function tickChecked(world: World, n: number, each?: () => void): void {
  for (let i = 0; i < n; i++) {
    world.tick();
    expect(sharedCell(world), `tick ${String(world.clock.tick)}`).toBeUndefined();
    each?.();
  }
}

/** Kotvisko s kontajnerovým žeriavom (priamo, bez pravidiel príkazu). */
function berthWithCrane(world: World, x: number, y: number, rotation: 0 | 90 | 180 | 270, craneOffset: { x: number; y: number }): BerthModule {
  const berth = world.placeModule({ defId: 'berth_standard', x, y, rotation }, 0) as BerthModule;
  world.placeModule({ defId: 'crane_container_gantry', x: x + craneOffset.x, y: y + craneOffset.y, rotation }, 0);
  return berth;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Vnútorný roh nábrežia: posun bokom je súčasťou cesty von
// ---------------------------------------------------------------------------------------------------------------

const CORNER_SIZE = 40;

/**
 * Syntetická mapa s vnútorným rohom nábrežia: otvorená voda y 0–9, nábrežie y 10–12 (x 7–36), pod ním bazén
 * x 10–36 × y 13–35 s nábrežím na západe (x 7–9); sea lane (30, 0) → (30, 5), anchorage (5, 3) a (5, 7).
 * Kotvisko H (rot 180 na (11, 10), voda na juh) a N (rot 90 na (7, 15), voda na východ) — feeder pri N
 * (x 10–11, y 15–20) leží v posune bokom feedera pri H (x 11–16, y 13–17).
 */
function cornerTerrain(x: number, y: number): string {
  if (y <= 9) return '~';
  if (y <= 12) return x >= 31 && x <= 36 ? '=' : x >= 7 ? 'Q' : '.';
  if (y <= 35) return x >= 10 && x <= 36 ? '=' : x >= 7 && x <= 9 ? 'Q' : x >= 37 ? 'Q' : '.';
  return '.';
}

const CORNER_MAP: LoadedMap = loadMap(
  parseMapDef({
    schemaVersion: 1,
    id: 'corner_test',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    terrain: Array.from({ length: CORNER_SIZE }, (_, y) => Array.from({ length: CORNER_SIZE }, (_, x) => cornerTerrain(x, y)).join('')),
    depth: {},
    parcels: [{ id: 'dock', rect: { x: 0, y: 0, w: CORNER_SIZE, h: CORNER_SIZE - 1 }, priceCents: 0, leasable: false, startOwned: true }],
    roadPortals: [{ id: 'south', cell: { x: 39, y: 39 } }],
    railPortals: [],
    seaLane: [
      { x: 30, y: 0 },
      { x: 30, y: 5 },
    ],
    anchorage: [
      { x: 5, y: 3 },
      { x: 5, y: 7 },
    ],
    starter: { modules: [], roads: [] },
  }),
);

const placeH = (world: World): BerthModule => berthWithCrane(world, 11, 10, 180, { x: 2, y: 0 });
const placeN = (world: World): BerthModule => berthWithCrane(world, 7, 15, 90, { x: 0, y: 2 });

describe('1. vnútorný roh nábrežia — posun bokom je súčasťou cesty von (ADR-029 B5)', () => {
  it('exitLeg: obdĺžnik lode pri N v posune bokom lode pri H → cesta von nie je; bez neho je', () => {
    const world = World.create(DEFS, CORNER_MAP, 7);
    const h = placeH(world);
    const n = placeN(world);
    const feeder = DEFS.ships.get('feeder');
    const atN = dockPoint(n, feeder);
    const boxAtN = shipBox(feeder, atN.x, atN.y, DOCKED_HEADING[n.waterSide]);
    const traffic = world.shipTraffic;
    expect(traffic.exitLeg(feeder, h, [])).not.toBeNull();
    expect(traffic.exitLeg(feeder, h, [boxAtN])).toBeNull();
    // Opačne: s loďou pri N nevedie cesta ku kotvisku H (posun bokom z bodu priblíženia k polohe pri H by do nej
    // narazil); k N s loďou pri H áno (posun bokom k N je mimo nej — rozhoduje cesta von lode pri H, viď vyššie).
    const atH = dockPoint(h, feeder);
    const boxAtH = shipBox(feeder, atH.x, atH.y, DOCKED_HEADING[h.waterSide]);
    const hub = { x: 30.5, y: 5.5, heading: 180 } as const;
    expect(traffic.berthLeg(feeder, hub, h, [])).not.toBeNull();
    expect(traffic.berthLeg(feeder, hub, h, [boxAtN])).toBeNull();
    expect(traffic.berthLeg(feeder, hub, n, [boxAtH])).not.toBeNull();
  });

  it('feeder A pri H, feeder B (40 TEU) príde, keď je N postavené → N sa B nepridelí, kým A drží H; A odpláva, B zakotví', () => {
    const world = World.create(DEFS, CORNER_MAP, 7);
    const h = placeH(world);
    const a = spawn(world, 'feeder', 4);
    for (let i = 0; i < 400 && a.state !== 'docked'; i++) tickChecked(world, 1);
    expect([a.state, a.berthIds]).toEqual(['docked', [h.id]]);
    const n = placeN(world);
    const b = spawn(world, 'feeder', STAYS_DOCKED);
    tickChecked(world, 3000, () => {
      const aHoldsH = world.ships.has(a.id) && a.berthIds.length > 0 && a.state !== 'undocking';
      if (aHoldsH) expect(n.dockedShipId, `tick ${String(world.clock.tick)}: N pridelené, kým A stojí pri H`).not.toBe(b.id);
    });
    expect(world.ships.has(a.id)).toBe(false);
    expect(b.state).toBe('docked');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. a 3. Save v5: normalizácia lode bez cieľa, trasy a rezervácie pri obnove
// ---------------------------------------------------------------------------------------------------------------

type ShipPatch = Partial<Omit<SerializedShip, 'route' | 'lashingTicksLeft'>>;

/** Save v5 zo save v6 (zhodeného z v7): lode bez `route`, s úpravami `patch` podľa id (ostatné polia v6 sa v5 nezmenili). */
function toV5(world: World, patch: ReadonlyMap<number, ShipPatch>): unknown {
  const v6 = toV6State(world.serialize()) as unknown as WorldState;
  return {
    ...v6,
    version: 5,
    ships: v6.ships.map((ship) => {
      const v5Ship: Record<string, unknown> = { ...ship, ...patch.get(ship.id) };
      delete v5Ship['route'];
      return v5Ship;
    }),
  };
}

const LANE_START = cellCenter(CHANNEL_MAP.seaLane[0]);
const LANE_END = cellCenter(CHANNEL_MAP.seaLane[CHANNEL_MAP.seaLane.length - 1]);
/** Feeder pri W1 (dockPoint, kurz 180). */
const AT_W1 = { x: 14, y: 15, heading: 180 } as const;

/** W1 (Root) s feederom D (8 TEU, vyložený) a feedery X, Y na anchorage 2 a 3; L (2 TEU) čaká pred vstupom. */
function legacyFleet(): { world: World; d: Ship; x: Ship; y: Ship; l: Ship } {
  const world = World.create(DEFS, CHANNEL_MAP_W1, 11);
  const d = spawn(world, 'feeder', 8);
  const x = spawn(world, 'feeder', 2);
  const y = spawn(world, 'feeder', 2);
  const l = spawn(world, 'feeder', 2);
  const resting = (ship: Ship): boolean => ship.state === 'waiting_anchorage' && ship.waypointIndex >= ship.route.length;
  for (let i = 0; i < 2000 && !(resting(x) && resting(y)); i++) world.tick();
  expect([resting(x), resting(y), l.state]).toEqual([true, true, 'arriving']);
  return { world, d, x, y, l };
}

/** Úpravy v5: D dokovaná pri W1 bez nákladu, X a Y v pokoji na anchorage (legacy trasa = [anchorage]). */
function legacyPatch(fleet: { d: Ship; x: Ship; y: Ship }): Map<number, ShipPatch> {
  return new Map<number, ShipPatch>([
    [fleet.d.id, { state: 'docked', ...AT_W1, berthIds: [1], anchorageIndex: null, waypointIndex: 0 }],
    [fleet.x.id, { waypointIndex: 1 }],
    [fleet.y.id, { waypointIndex: 1 }],
  ]);
}

describe('2. save v5: loď bez cieľa sa presunie pred vstup (ADR-029 addendum)', () => {
  it('waiting_anchorage bez anchorage na konci dráhy (plné anchorage, dokovaná loď) → arriving; dokovaná loď odpláva, nikto neuviazne', () => {
    const fleet = legacyFleet();
    const { d, x, l } = fleet;
    const patch = legacyPatch(fleet);
    patch.set(l.id, { state: 'waiting_anchorage', x: LANE_END.x, y: LANE_END.y, heading: 180, berthIds: [], anchorageIndex: null, waypointIndex: 0 });
    const restored = World.deserialize(DEFS, CHANNEL_MAP_W1, toV5(fleet.world, patch) as WorldState);
    const legacy = restored.ships.get(l.id);
    expect(legacy).toMatchObject({ state: 'arriving', x: LANE_START.x, y: LANE_START.y, heading: 180, anchorageIndex: null, waypointIndex: 0, route: [] });
    // v6 po normalizácii už `route: null` nemá a načíta sa znova bez zmeny.
    const v6 = JSON.parse(JSON.stringify(restored.serialize())) as WorldState;
    expect(JSON.stringify(World.deserialize(DEFS, CHANNEL_MAP_W1, v6).serialize())).toBe(JSON.stringify(v6));

    tickChecked(restored, 6000);
    expect(restored.ships.has(d.id)).toBe(false); // predtým `docked` naveky (L na konci dráhy zatarasila cestu von)
    expect(restored.ships.get(x.id)?.state).toBe('docked');
    expect(legacy?.state).toBe('waiting_anchorage');
    expect(legacy?.anchorageIndex).not.toBeNull();
  });

  it('inbound bez cieľa (plavba po dráhe podľa ADR-016) → arriving pred vstupom', () => {
    const fleet = legacyFleet();
    const patch = legacyPatch(fleet);
    patch.set(fleet.l.id, { state: 'inbound', x: LANE_START.x, y: 3.5, heading: 180, berthIds: [], anchorageIndex: null, waypointIndex: 1 });
    const restored = World.deserialize(DEFS, CHANNEL_MAP_W1, toV5(fleet.world, patch) as WorldState);
    expect(restored.ships.get(fleet.l.id)).toMatchObject({ state: 'arriving', x: LANE_START.x, y: LANE_START.y, route: [] });
  });
});

describe('3. obnova overí trasy a rezervácie lodí (fail-fast, ADR-029 addendum)', () => {
  it('v5: undocking (legacy trasa na koniec dráhy) a loď čakajúca na konci dráhy → načíta sa (normalizácia), krok 12 neporuší', () => {
    const fleet = legacyFleet();
    const patch = legacyPatch(fleet);
    patch.set(fleet.d.id, { state: 'undocking', x: 17, y: 15, heading: 180, berthIds: [], anchorageIndex: null, waypointIndex: 0 });
    patch.set(fleet.l.id, { state: 'waiting_anchorage', x: LANE_END.x, y: LANE_END.y, heading: 180, berthIds: [], anchorageIndex: null, waypointIndex: 0 });
    const restored = World.deserialize(DEFS, CHANNEL_MAP_W1, toV5(fleet.world, patch) as WorldState);
    expect(restored.ships.get(fleet.l.id)?.state).toBe('arriving');
    tickChecked(restored, 1500);
    expect(restored.ships.has(fleet.d.id)).toBe(false);
  });

  it('v5: undocking a loď na anchorage na sea lane (rezervácie sa prekrývajú) → WorldStateError na trase neskoršej lode pri deserialize', () => {
    const fleet = legacyFleet();
    const patch = legacyPatch(fleet);
    patch.set(fleet.d.id, { state: 'undocking', x: 17, y: 15, heading: 180, berthIds: [], anchorageIndex: null, waypointIndex: 0 });
    const onLane = cellCenter(CHANNEL_MAP.anchorage[ANCHORAGE_ON_LANE]);
    patch.set(fleet.l.id, { state: 'waiting_anchorage', x: onLane.x, y: onLane.y, heading: 180, berthIds: [], anchorageIndex: ANCHORAGE_ON_LANE, waypointIndex: 1 });
    let error: unknown;
    try {
      World.deserialize(DEFS, CHANNEL_MAP_W1, toV5(fleet.world, patch) as WorldState);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe('/ships/3/route');
    expect((error as WorldStateError).message).toMatch(/prekrýva s rezerváciou/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Loď, ktorá drží kotvisko a cestu von nemá pre dočasnú prekážku, sa nepreskočí
// ---------------------------------------------------------------------------------------------------------------

/** Dokovaná loď pri kotvisku `berth` s `units` jednotkami (priamo — stav, ktorý pridelenie kotvísk nevytvorí). */
function dockedAt(world: World, berth: BerthModule, units: number): Ship {
  const def = DEFS.ships.get('feeder');
  const at = dockPoint(berth, def);
  const ship = new Ship({
    id: world.ids.next(),
    def,
    cargoType: DEFS.cargoTypes.get('container_teu'),
    state: 'docked',
    x: at.x,
    y: at.y,
    heading: DOCKED_HEADING[berth.waterSide],
    berthIds: [berth.id],
  });
  world.addShip(ship);
  berth.dockedShipId = ship.id;
  for (let i = 0; i < units; i++) world.cargo.create('container_teu', { kind: 'on_ship', shipId: ship.id });
  return ship;
}

describe('keepsExits — loď bez cesty von sa nepreskočí (ADR-029 addendum; strážca vlastnosti, nie reprodukcia)', () => {
  it('feeder pri W3 nemá cestu von (W1 a E2 spolu zatarasia kanál) → handy nedostane anchorage pred ústím, ale otvorenú vodu', () => {
    const world = World.create(DEFS, CHANNEL_MAP, 2902);
    const crane = (key: keyof typeof CHANNEL_BERTHS): BerthModule => {
      const spec = CHANNEL_BERTHS[key];
      return berthWithCrane(world, spec.x, spec.y, spec.rotation, { x: 0, y: 2 });
    };
    const w1 = crane('W1');
    const e2 = crane('E2');
    const w3 = crane('W3');
    const inner = dockedAt(world, w3, STAYS_DOCKED);
    dockedAt(world, w1, STAYS_DOCKED);
    dockedAt(world, e2, STAYS_DOCKED);
    expect(world.shipTraffic.exitLeg(inner.def, w3, [])).not.toBeNull();
    const handy = spawn(world, 'handy', 2); // handy (10) nezakotví pri žiadnom kotvisku (8)
    tickChecked(world, 800);
    // Loď pri W3 cestu von teraz nemá (W1 a E2 sú dočasné prekážky), anchorage pred ústím by jej ju vzala natrvalo
    // (handy nezakotví nikde a čakala by tam naveky) → posúdi sa s prekážkami, ktoré ostanú, a ústie sa odmietne.
    expect(handy).toMatchObject({ state: 'waiting_anchorage', anchorageIndex: ANCHORAGE_OPEN });
    expect(handy.anchorageIndex).not.toBe(ANCHORAGE_AT_MOUTH);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Strážca FIFO: heldBack len pre pohybujúcu sa loď
// ---------------------------------------------------------------------------------------------------------------

/** Loď na mape, ktorá sa hýbe (má nedokončenú trasu) — len taká smie zdržať neskoršie lode (ADR-029 B6). */
function anyMoving(world: World): boolean {
  for (const ship of world.ships.values()) {
    if (SHIP_STATE_TRAITS[ship.state].onMap && ship.waypointIndex < ship.route.length) return true;
  }
  return false;
}

/** Spustí `ticks` tickov so spawnmi `spawns` (tick → trieda a počet) a overí: heldBack ⇒ pohybujúca sa loď pred alebo po ticku. */
function guardHeldBack(world: World, spawns: ReadonlyMap<number, readonly [string, number]>, ticks: number): number {
  let held = 0;
  for (let t = 0; t < ticks; t++) {
    const spec = spawns.get(t);
    if (spec !== undefined) spawn(world, spec[0], spec[1]);
    const movingBefore = anyMoving(world);
    world.tick();
    if (!world.shipTraffic.heldBackLastTick) continue;
    held += 1;
    expect(movingBefore || anyMoving(world), `tick ${String(world.clock.tick)}: heldBack bez pohybujúcej sa lode`).toBe(true);
  }
  return held;
}

describe('heldBack (ADR-029 B6) — stojaca loď nezdrží neskoršie lode (dnešné defy)', () => {
  it('kanál (W1, E2, W3), päť lodí feeder/handy', () => {
    const world = World.create(DEFS, CHANNEL_MAP, 2902);
    for (const key of ['W1', 'E2', 'W3'] as const) {
      const spec = CHANNEL_BERTHS[key];
      berthWithCrane(world, spec.x, spec.y, spec.rotation, { x: 0, y: 2 });
    }
    const spawns = new Map<number, readonly [string, number]>([
      [0, ['feeder', 3]],
      [1, ['feeder', STAYS_DOCKED]],
      [40, ['handy', 2]],
      [300, ['feeder', 5]],
      [700, ['feeder', 2]],
    ]);
    guardHeldBack(world, spawns, 4000);
  });

  it('harbor_01: tri kotviská v rade (x 32–55), dvanásť lodí feeder/handy každých 40 tickov', () => {
    const world = World.create(DEFS, MAP, 5202);
    for (const x of [32, 48]) berthWithCrane(world, x, 14, 0, { x: 3, y: 0 });
    const spawns = new Map<number, readonly [string, number]>(
      Array.from({ length: 12 }, (_, i): [number, readonly [string, number]] => [1 + i * 40, [i % 2 === 0 ? 'feeder' : 'handy', 1 + (i % 4)]]),
    );
    const held = guardHeldBack(world, spawns, 12_000);
    expect(held).toBeGreaterThan(0); // FIFO sa naozaj uplatnilo (lode čakali na pohybujúce sa lode)
  });
});
