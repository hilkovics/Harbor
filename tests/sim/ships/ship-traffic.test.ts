// ShipTraffic — lodná doprava bez prekrývania (T5B-02, ADR-029) na syntetickej mape so slepým kanálom
// (`channel-map.ts`): anchorage pridelená pred vstupom, čakanie pred vstupom, obchádzka dokovanej lode, kotvisko
// a anchorage, ktoré by zatarasili cestu von inej lodi, odchod čakajúci na voľnú trasu, FIFO kotvísk, invariant
// „dve lode nezdieľajú bunku" a nezávislosť priebehu od memo (save/load uprostred dopravy).
import { describe, expect, it } from 'vitest';
import { SpawnShipDebugCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { BerthModule } from '@sim/modules';
import { SHIP_STATE_TRAITS, Ship, cellCenter, dockPoint, shipBox, shipCells, shipOverlapProblem, type ShipState } from '@sim/ships';
import { World, findWorldViolation, type WorldState } from '@sim/world';
import { DEFS, hashState } from '../world/world-fixtures';
import { ANCHORAGE_AT_MOUTH, ANCHORAGE_ON_LANE, ANCHORAGE_OPEN, CHANNEL_BERTHS, CHANNEL_MAP } from './channel-map';

type BerthKey = keyof typeof CHANNEL_BERTHS;
const SEED = 2902;
/** Toľko jednotiek, že apron sa zaplní a bez vozidiel loď pri kotvisku ostane (žeriav čaká na slot). */
const STAYS_DOCKED = 40;

interface Harbor {
  readonly world: World;
  readonly berths: Partial<Record<BerthKey, BerthModule>>;
}

/** Kotvisko s kontajnerovým žeriavom (priamo, bez pravidiel príkazu). */
function build(world: World, key: BerthKey): BerthModule {
  const spec = CHANNEL_BERTHS[key];
  const berth = world.placeModule({ defId: 'berth_standard', x: spec.x, y: spec.y, rotation: spec.rotation }, 0);
  world.placeModule({ defId: 'crane_container_gantry', x: spec.x, y: spec.y + 2, rotation: spec.rotation }, 0);
  return berth as BerthModule;
}

function harbor(keys: readonly BerthKey[]): Harbor {
  const world = World.create(DEFS, CHANNEL_MAP, SEED);
  const berths: Partial<Record<BerthKey, BerthModule>> = {};
  for (const key of keys) berths[key] = build(world, key);
  return { world, berths };
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} chýba`);
  return value;
}

function spawn(world: World, shipClassId: string, units: number): Ship {
  world.enqueue(new SpawnShipDebugCommand({ shipClassId, cargoTypeId: 'container_teu', units }));
  const event = world.applyPending().find((candidate) => candidate.type === 'ShipSpawned');
  if (event?.type !== 'ShipSpawned') throw new Error('ShipSpawned chýba');
  return must(world.ships.get(event.shipId), `loď #${String(event.shipId)}`);
}

/** Po každom ticku overí, že žiadne dve lode na mape nezdieľajú bunku (nezávisle od kroku 12). */
function tickChecked(world: World, n: number, each?: () => void): void {
  for (let i = 0; i < n; i++) {
    world.tick();
    expect(sharedCell(world), `tick ${String(world.clock.tick)}`).toBeUndefined();
    each?.();
  }
}

/** Prvá bunka zdieľaná dvoma loďami na mape (cez `shipCells`, nie cez implementáciu invariantu). */
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

function tickUntilState(world: World, ship: Ship, state: ShipState, max: number): void {
  for (let i = 0; i < max && ship.state !== state; i++) tickChecked(world, 1);
  expect(ship.state, `${ship.label} do ${String(max)} tickov`).toBe(state);
}

const center = (index: number) => cellCenter(must(CHANNEL_MAP.anchorage[index], `anchorage ${String(index)}`));

describe('ShipTraffic — anchorage pred vstupom, čakanie pred vstupom', () => {
  it('bez kotviska dostane loď anchorage už pri vstupe (nie tú na dráhe); keď nie je žiadna dostupná, čaká pred mapou a nezaberá bunky', () => {
    const { world } = harbor([]);
    const first = spawn(world, 'feeder', 2);
    expect(first).toMatchObject({ state: 'inbound', anchorageIndex: ANCHORAGE_AT_MOUTH, berthIds: [] });
    expect(first.route.at(-1)).toMatchObject(center(ANCHORAGE_AT_MOUTH));
    const second = spawn(world, 'feeder', 2);
    const third = spawn(world, 'handy', 2);
    // Dráhu drží prvá loď → ostatné čakajú pred vstupom (FIFO podľa id v kroku 3).
    expect([second.state, third.state]).toEqual(['arriving', 'arriving']);
    expect(SHIP_STATE_TRAITS.arriving.onMap).toBe(false);

    const inbound: number[] = [];
    tickChecked(world, 1500, () => inbound.push([...world.ships.values()].filter((ship) => ship.state === 'inbound').length));
    expect(Math.max(...inbound)).toBe(1); // na dráhe je naraz najviac jedna loď
    expect([first.state, second.state, third.state]).toEqual(['waiting_anchorage', 'waiting_anchorage', 'arriving']);
    // Anchorage 3 je za loďami na 1 a 2 nedostupná (A* po vode ich obchádza, priechod nie je) → handy čaká pred mapou.
    expect([first.anchorageIndex, second.anchorageIndex, third.anchorageIndex]).toEqual([ANCHORAGE_AT_MOUTH, ANCHORAGE_OPEN, null]);
    expect([first.x, first.y]).toEqual([center(ANCHORAGE_AT_MOUTH).x, center(ANCHORAGE_AT_MOUTH).y]);
    expect([second.x, second.y]).toEqual([center(ANCHORAGE_OPEN).x, center(ANCHORAGE_OPEN).y]);
    expect([...world.ships.values()].some((ship) => ship.anchorageIndex === ANCHORAGE_ON_LANE)).toBe(false);
    expect(findWorldViolation(world)).toBeUndefined();
  });
});

describe('ShipTraffic — trasa mimo stojacich lodí', () => {
  it('loď do hlbokého kotviska W3 obíde feeder pri W1 (priechod x ≥ 15) a zakotví presne pri W3', () => {
    const { world, berths } = harbor(['W1', 'W3']);
    const w1 = must(berths.W1, 'W1');
    const w3 = must(berths.W3, 'W3');
    const first = spawn(world, 'feeder', STAYS_DOCKED);
    tickUntilState(world, first, 'docked', 600);
    expect(first.berthIds).toEqual([w1.id]);
    const moored = shipBox(first.def, first.x, first.y, first.heading);

    const second = spawn(world, 'feeder', STAYS_DOCKED);
    let passedBeside = false;
    for (let i = 0; i < 800 && second.state !== 'docked'; i++) {
      tickChecked(world, 1);
      const box = shipBox(second.def, second.x, second.y, second.heading);
      if (box.y0 < moored.y1 && moored.y0 < box.y1) {
        expect(box.x0, `tick ${String(world.clock.tick)}`).toBeGreaterThanOrEqual(moored.x1);
        passedBeside = true;
      }
    }
    expect(second.state).toBe('docked');
    expect(second.berthIds).toEqual([w3.id]);
    expect([second.x, second.y]).toEqual([dockPoint(w3, second.def).x, dockPoint(w3, second.def).y]);
    expect(passedBeside).toBe(true);
  });

  it('vyložená loď čaká pri kotvisku, kým jej trasu von drží loď na ceste dnu; potom odpláva bez prekryvu', () => {
    const { world, berths } = harbor(['W3']);
    const leaving = spawn(world, 'feeder', 2);
    tickUntilState(world, leaving, 'docked', 800);
    build(world, 'W1');
    const arriving = spawn(world, 'feeder', STAYS_DOCKED);
    let waitedEmpty = 0;
    for (let i = 0; i < 1500 && world.ships.has(leaving.id); i++) {
      tickChecked(world, 1);
      const moving = arriving.state === 'inbound' || arriving.state === 'berthing';
      if (leaving.state === 'docked' && world.cargo.countAt('on_ship', leaving.id) === 0 && moving) waitedEmpty += 1;
    }
    expect(waitedEmpty).toBeGreaterThan(1);
    expect(world.ships.has(leaving.id)).toBe(false);
    expect(arriving.berthIds).toEqual([must(world.grid.at(CHANNEL_BERTHS.W1.x, CHANNEL_BERTHS.W1.y).moduleId, 'W1')]);
    expect(berths.W3?.dockedShipId).toBeNull();
  });
});

describe('ShipTraffic — bez uviaznutia: stojaca loď nezatarasí cestu von', () => {
  it('feedery pri W1 a W3 → E2 sa nepridelí (s W1 by zatarasilo kanál lodi pri W3), loď čaká na anchorage', () => {
    const { world, berths } = harbor(['W1', 'E2', 'W3']);
    const atW1 = spawn(world, 'feeder', STAYS_DOCKED);
    const atW3 = spawn(world, 'feeder', STAYS_DOCKED);
    tickChecked(world, 1500);
    expect([atW1.state, atW3.state]).toEqual(['docked', 'docked']);
    expect([atW1.berthIds, atW3.berthIds]).toEqual([[berths.W1?.id], [berths.W3?.id]]);

    const third = spawn(world, 'feeder', STAYS_DOCKED);
    tickChecked(world, 1000);
    expect(berths.E2?.dockedShipId).toBeNull();
    // Anchorage pred ústím by zatarasila kanál tiež → otvorená voda.
    expect(third).toMatchObject({ state: 'waiting_anchorage', anchorageIndex: ANCHORAGE_OPEN });
  });

  it('kontrola: bez lode pri W3 dostane druhý feeder E2 (odmietnutie vyššie spôsobuje len cesta von lode pri W3)', () => {
    const { world, berths } = harbor(['W1', 'E2']);
    spawn(world, 'feeder', STAYS_DOCKED);
    const second = spawn(world, 'feeder', STAYS_DOCKED);
    tickChecked(world, 1500);
    expect(second.state).toBe('docked');
    expect(second.berthIds).toEqual([berths.E2?.id]);
  });

  it('anchorage pred ústím kanála sa nepridelí, kým v kanáli stojí loď; inak áno', () => {
    const blocked = harbor(['W3']);
    const inside = spawn(blocked.world, 'feeder', STAYS_DOCKED);
    tickUntilState(blocked.world, inside, 'docked', 800);
    const waiting = spawn(blocked.world, 'handy', 2); // handy (10) nezakotví pri žiadnom kotvisku (8)
    tickChecked(blocked.world, 600);
    expect(waiting).toMatchObject({ state: 'waiting_anchorage', anchorageIndex: ANCHORAGE_OPEN });

    const free = harbor(['W3']);
    const handy = spawn(free.world, 'handy', 2);
    tickChecked(free.world, 600);
    expect(handy).toMatchObject({ state: 'waiting_anchorage', anchorageIndex: ANCHORAGE_AT_MOUTH });
  });
});

describe('ShipTraffic — poradie', () => {
  it('čakajúce lode dostanú kotviská vo FIFO podľa id; kotvisko drží loď už od vplávania (rezervácia pri vstupe)', () => {
    const { world } = harbor([]);
    const first = spawn(world, 'feeder', STAYS_DOCKED);
    const second = spawn(world, 'feeder', STAYS_DOCKED);
    tickChecked(world, 1200);
    expect([first.anchorageIndex, second.anchorageIndex]).toEqual([ANCHORAGE_AT_MOUTH, ANCHORAGE_OPEN]);
    const w1 = build(world, 'W1');
    tickChecked(world, 1);
    expect([first.state, second.state]).toEqual(['berthing', 'waiting_anchorage']);
    expect([first.berthIds, first.anchorageIndex]).toEqual([[w1.id], null]);

    // Nová loď s voľným kotviskom ho má rezervované od vstupu do prístavu.
    const w3 = build(world, 'W3');
    tickUntilState(world, first, 'docked', 800);
    tickUntilState(world, second, 'docked', 1200);
    expect(second.berthIds).toEqual([w3.id]);
  });
});

describe('shipOverlapProblem — invariant kroku 12 (ADR-029)', () => {
  const feeder = DEFS.ships.get('feeder');
  const container = DEFS.cargoTypes.get('container_teu');
  const ship = (id: number, state: ShipState, x: number, y: number): Ship =>
    new Ship({ id: id as EntityId, def: feeder, cargoType: container, state, x, y, heading: 90 });

  it('prekryv dvoch lodí na mape → správa s oboma loďami; bez výnimky pre protismerné lode na dráhe', () => {
    const ships = new Map([ship(1, 'inbound', 10.5, 5.5), ship(2, 'outbound', 12.5, 5.5)].map((s) => [s.id, s]));
    expect(shipOverlapProblem(ships)).toMatch(/feeder #1 \(inbound\) a feeder #2 \(outbound\) zdieľajú bunky/);
  });

  it('dotyk hranou nie je prekryv; loď pred vstupom (arriving) nezaberá bunky; tri lode — nájde aj dvojicu bez prvej', () => {
    expect(shipOverlapProblem(new Map([ship(1, 'docked', 10, 5), ship(2, 'docked', 16, 5)].map((s) => [s.id, s])))).toBeUndefined();
    expect(shipOverlapProblem(new Map([ship(1, 'arriving', 10.5, 0.5), ship(2, 'arriving', 10.5, 0.5), ship(3, 'inbound', 10.5, 0.5)].map((s) => [s.id, s])))).toBeUndefined();
    const three = new Map([ship(1, 'docked', 30, 5), ship(2, 'waiting_anchorage', 10.5, 5.5), ship(3, 'berthing', 11.5, 6.5)].map((s) => [s.id, s]));
    expect(shipOverlapProblem(three)).toMatch(/#2 .* a .*#3/);
  });
});

describe('ShipTraffic — memo nemení priebeh (save/load uprostred dopravy)', () => {
  it('obnovený svet v každej fáze dopravy pokračuje bitovo rovnako ako neprerušený', () => {
    const run = (probe: number | null): string => {
      let { world } = harbor(['W1', 'E2', 'W3']);
      const spawns = new Map<number, [string, number]>([
        [0, ['feeder', 3]],
        [0 + 1, ['feeder', STAYS_DOCKED]],
        [40, ['handy', 2]],
        [300, ['feeder', 5]],
        [700, ['feeder', 2]],
      ]);
      for (let t = 0; t < 2400; t++) {
        const spec = spawns.get(t);
        if (spec !== undefined) spawn(world, spec[0], spec[1]);
        if (t === probe) world = World.deserialize(DEFS, CHANNEL_MAP, JSON.parse(JSON.stringify(world.serialize())) as WorldState);
        world.tick();
      }
      return hashState(world.serialize());
    };
    const reference = run(null);
    for (const probe of [30, 120, 320, 800, 1500]) expect(run(probe), `save/load v ticku ${String(probe)}`).toBe(reference);
  });
});
