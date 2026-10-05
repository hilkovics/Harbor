/**
 * Natívne savy v1 … v6 (`tests/sim/__fixtures__/saves/*.json`) s `loadBundledDefs()` — predvolený režim odovzdávania kotviska je
 * `under_hook` (ADR-033). Save spred F6a vznikol v režime `apron`: žeriav uprostred vykládky môže držať rezervovaný slot apronu.
 * Obnova ho musí načítať (cyklus vykládky sa deterministicky prevedie na stav `under_hook`, `adaptCraneRuntime` vo
 * `world-restore.ts`), svet beží 2 000 tickov bez porušenia invariantov a bez straty nákladu (T6A-09b, review src/sim, blocking 1).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadBundledDefs } from '@sim/defs';
import { loadBundledMap } from '@sim/grid';
import { BerthModule, CraneModule } from '@sim/modules';
import { World, stateHash, type AnyWorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';

const FIXTURE_DIR = fileURLToPath(new URL('../__fixtures__/saves/', import.meta.url));
const RUN_TICKS = 2_000;
const INVARIANT_EVERY = 100;
const HEAVY_TIMEOUT_MS = 120_000;

const BUNDLED = loadBundledDefs();
const MAP = loadBundledMap();
const FILES = readdirSync(FIXTURE_DIR).filter((file) => file.endsWith('.json')).sort();

function readFixture(file: string): AnyWorldState {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')) as AnyWorldState;
}

function runChecked(world: World, ticks: number): void {
  for (let i = 1; i <= ticks; i++) {
    world.tick();
    assertCargoConservation(world);
    if (i % INVARIANT_EVERY === 0) world.assertInvariants();
  }
}

describe('savy v1 … v6 s bundled defmi (predvolený režim under_hook)', () => {
  it('fixtures existujú', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(7);
  });

  it.each(FILES)(
    '%s: načíta sa s loadBundledDefs() a beží 2 000 tickov bez porušenia invariantov, rovnaký vstup dá rovnaký hash',
    (file) => {
      const raw = readFixture(file);
      const world = World.deserialize(BUNDLED, MAP, raw);
      expect(() => world.assertInvariants()).not.toThrow();
      runChecked(world, RUN_TICKS);
      expect(world.cargo.createdCount - world.cargo.exportedCount - world.cargo.shippedCount).toBe(world.cargo.liveCount);

      const second = World.deserialize(BUNDLED, MAP, readFixture(file));
      runChecked(second, RUN_TICKS);
      expect(stateHash(second)).toBe(stateHash(world));
    },
    HEAVY_TIMEOUT_MS,
  );
});

/** Jediný žeriav sveta (fixtures majú jeden). */
function onlyCrane(world: World): CraneModule {
  const cranes = [...world.modules.values()].filter((module): module is CraneModule => module instanceof CraneModule);
  expect(cranes).toHaveLength(1);
  return cranes[0];
}

describe('prevod cyklu vykládky z režimu apron na under_hook pri obnove (ADR-033 dodatok, T6A-09b)', () => {
  it('save-v5-anchorage (grabbing so slotom): cyklus sa zruší — idle bez slotu, apron nemá rezerváciu', () => {
    const raw = readFixture('save-v5-anchorage.json');
    const before = (raw as unknown as { modules: { defId: string; runtime: Record<string, unknown> }[] }).modules.find((m) => m.defId.includes('crane'));
    expect([before?.runtime['state'], typeof before?.runtime['reservedSlot']]).toEqual(['grabbing', 'number']);
    const world = World.deserialize(BUNDLED, MAP, raw);
    const crane = onlyCrane(world);
    expect([crane.state, crane.cycle, crane.reservedSlot, crane.targetUnitId, crane.phaseTicksLeft, crane.phaseTicksTotal]).toEqual(['idle', 'unload', null, null, 0, 0]);
    const berth = world.modules.get(crane.berthId);
    expect(berth).toBeInstanceOf(BerthModule);
    expect((berth as BerthModule).apron.reservedSlots()).toEqual([]);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('save-v2.json (placing so slotom, bez vozidiel): slot sa uvoľní, jednotka v ruke je cieľ cyklu a žeriav s bufferom 0 čaká na vozidlo (nemá komu odovzdať)', () => {
    const world = World.deserialize(BUNDLED, MAP, readFixture('save-v2.json'));
    const crane = onlyCrane(world);
    const held = crane.heldUnitId;
    expect(held).not.toBeNull();
    expect(world.vehicles.size).toBe(0);
    expect([crane.state, crane.cycle, crane.reservedSlot, crane.targetUnitId]).toEqual(['placing', 'unload', null, held]);
    expect((world.modules.get(crane.berthId) as BerthModule).apron.reservedSlots()).toEqual([]);
    for (let i = 0; i < 200; i++) {
      world.tick();
      assertCargoConservation(world);
    }
    // Predvolený buffer 0 (T6D-02): bez vozidla sa jednotka neodloží na apron — žeriav ju drží a počíta čakanie.
    expect(crane.heldUnitId).toBe(held);
    expect(crane.waitForVehicleTicks).toBeGreaterThan(0);
    expect(world.cargo.get(held as never)?.location.kind).toBe('in_crane');
    world.assertInvariants();
  });

  it.each(['save-v3.json', 'save-v5.json', 'save-v6.json'])(
    '%s (placing so slotom, jednotka v žeriave): slot sa uvoľní, jednotka v ruke je cieľ cyklu a žeriav ju odovzdá',
    (file) => {
      const world = World.deserialize(BUNDLED, MAP, readFixture(file));
      const crane = onlyCrane(world);
      const held = crane.heldUnitId;
      expect(held).not.toBeNull();
      expect([crane.state, crane.cycle, crane.reservedSlot, crane.targetUnitId]).toEqual(['placing', 'unload', null, held]);
      expect((world.modules.get(crane.berthId) as BerthModule).apron.reservedSlots()).toEqual([]);

      let done = false;
      for (let i = 0; i < RUN_TICKS && !done; i++) {
        done = world.tick().some((event) => event.type === 'CraneCycleDone' && event.unitId === held);
        assertCargoConservation(world);
      }
      expect(done, `žeriav neodovzdal jednotku #${String(held)}`).toBe(true);
      expect(world.cargo.get(held as never)?.location.kind).not.toBe('in_crane');
      world.assertInvariants();
    },
  );
});
