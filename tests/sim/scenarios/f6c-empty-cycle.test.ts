/**
 * Scenár `empty_cycle` (F6c, T6C-02, ADR-034): celý cyklus prázdneho kontajnera v prístave F4 s depom prázdnych (na mieste blízkeho
 * dvora) a empty handlerom — import northern_star (kontrakt #2, 64 TEU) sa odvezie kamiónmi, 60 % jednotiek sa o 1 – 3 dni vráti ako
 * prázdne (kamión `delivery`, brána `EmptyReturned`, vykládka na rampe, empty handler odvezie do depa), kontrola v depe poškodí časť
 * (`EmptyDamaged`), oprava trvá 6 h (`EmptyRepaired`, poplatok `maintenance_repair`); export booking #10 (golden_wave) nemá z čoho dostať
 * prázdny (14× `EmptyPickupMissed`), booking #22 (northern_star, prijatý v ticku 25 921) dostane prázdne z depa (`EmptyPickedUp`,
 * `in_truck → exported`), vrátane už opravených. `lostUnits 0`, `--roundtrip-at` uprostred opravy dá zhodný hash.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { World, stateHash, type AnyWorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { MAP, lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { REPO_ROOT, loadScenarioFile, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS } from '../world/world-fixtures';

const SCENARIO = loadScenarioFile('empty_cycle');
const TICKS = 40_000;
const IMPORT_ID = 2;
const MISSED_BOOKING_ID = 10;
const SERVED_BOOKING_ID = 22;
const IMPORT_UNITS = 64;
const RUN_TIMEOUT_MS = 300_000;
const GOLDEN_PATH = `${REPO_ROOT}tests/sim/__golden__/empty_cycle.json`;
const REPAIR_TICKS = Math.round(BUNDLED_DEFS.logistics.emptyFlow.repairHours * (3600 / BUNDLED_DEFS.time.tickGameSeconds));

type Entries = readonly { readonly tick: number; readonly event: SimEvent }[];

function run(): { readonly world: World; readonly events: Entries } {
  const world = World.create(BUNDLED_DEFS, MAP, SCENARIO.seed);
  const events: { tick: number; event: SimEvent }[] = [];
  runScenario(world, SCENARIO, TICKS, {
    afterTick: (w, tickEvents) => {
      assertCargoConservation(w);
      for (const event of tickEvents) events.push({ tick: w.clock.tick, event });
    },
  });
  return { world, events };
}

const of = <T extends SimEvent['type']>(events: Entries, type: T): { tick: number; event: Extract<SimEvent, { type: T }> }[] =>
  events.filter((entry): entry is { tick: number; event: Extract<SimEvent, { type: T }> } => entry.event.type === type);

/** Reťaz polôh každej jednotky z `CargoMoved` (`kind → kind → …`). */
function chains(events: Entries): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const entry of of(events, 'CargoMoved')) {
    const chain = out.get(entry.event.unitId) ?? [entry.event.from.kind];
    chain.push(entry.event.to.kind);
    out.set(entry.event.unitId, chain);
  }
  return out;
}

describe('scenár empty_cycle: súbor', () => {
  it('má tvar { id, seed, map, commands }, seed 5011, mapu harbor_01', () => {
    expect(Object.keys(SCENARIO).sort()).toEqual(['commands', 'id', 'map', 'seed']);
    expect([SCENARIO.id, SCENARIO.seed, SCENARIO.map]).toEqual(['empty_cycle', 5011, 'data/maps/harbor_01.json']);
  });

  it('prístav F4 s depom prázdnych na mieste blízkeho dvora, tri vozidlá (2× straddle, empty handler) a tri AcceptContract (2 @2, 10 @8 641, 22 @25 921)', () => {
    const types = SCENARIO.commands.map((entry) => entry.command.type);
    expect(types).toEqual([...Array<string>(10).fill('PlaceRoad'), ...Array<string>(6).fill('PlaceModule'), 'BuyVehicle', 'BuyVehicle', 'BuyVehicle', 'AcceptContract', 'AcceptContract', 'AcceptContract']);
    const modules = SCENARIO.commands.filter((entry) => entry.command.type === 'PlaceModule').map((entry) => (entry.command as unknown as { defId: string }).defId);
    expect(modules).toEqual(['vehicle_depot', 'empty_depot', 'container_yard_small', 'truck_gate', 'truck_waiting_area', 'loading_ramp_container']);
    const vehicles = SCENARIO.commands.filter((entry) => entry.command.type === 'BuyVehicle').map((entry) => (entry.command as unknown as { vehicleDefId: string }).vehicleDefId);
    expect(vehicles).toEqual(['straddle_carrier', 'straddle_carrier', 'empty_handler']);
    const accepts = SCENARIO.commands.filter((entry) => entry.command.type === 'AcceptContract').map((entry) => [entry.atTick, (entry.command as unknown as { contractId: number }).contractId]);
    expect(accepts).toEqual([[2, IMPORT_ID], [8_641, MISSED_BOOKING_ID], [25_921, SERVED_BOOKING_ID]]);
  });
});

describe('scenár empty_cycle: beh', () => {
  const { world, events } = run();
  const returned = of(events, 'EmptyReturned').map((entry) => entry.event);
  const returnedIds = new Set(returned.map((event) => event.unitId));
  const all = chains(events);

  it('import #2 (64 TEU, northern_star) sa odvezie kamiónmi a kontrakt sa dokončí; booking #10 aj #22 sú prijaté', () => {
    const imported = world.contracts.get(IMPORT_ID as never);
    expect(imported).toMatchObject({ kind: 'import', lineId: 'northern_star', volumeUnits: IMPORT_UNITS, state: 'completed', unitsExported: IMPORT_UNITS });
    expect(world.contracts.get(MISSED_BOOKING_ID as never)).toMatchObject({ kind: 'export', lineId: 'golden_wave', state: 'completed' });
    expect(world.contracts.get(SERVED_BOOKING_ID as never)?.lineId).toBe('northern_star');
    expect(of(events, 'ContractCompleted').map((entry) => entry.event.contractId)).toEqual([IMPORT_ID, MISSED_BOOKING_ID]);
  });

  it('návrat prázdnych: každá vrátená jednotka je prázdna linky importu, prešla in_truck → at_ramp → in_vehicle → in_storage a uložili ju v depe (nie vo dvore)', () => {
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.every((event) => event.lineId === 'northern_star')).toBe(true);
    const stored = of(events, 'EmptyStored').map((entry) => entry.event);
    expect(stored.length).toBe(returned.length);
    expect(stored.every((event) => !event.fallback)).toBe(true);
    for (const event of returned) {
      expect(all.get(event.unitId)?.slice(0, 4), `jednotka ${String(event.unitId)}`).toEqual(['in_truck', 'at_ramp', 'in_vehicle', 'in_storage']);
    }
    // návratov je najviac toľko, koľko importných jednotiek odišlo kamiónmi (emptyReturnRate 0,6 ⇒ menej)
    expect(returned.length).toBeLessThan(IMPORT_UNITS);
    expect(returned.length).toBeGreaterThan(IMPORT_UNITS / 4);
    // každý návrat je po odchode importu (nie skôr než deň po prvom exporte)
    const firstExport = of(events, 'TruckExited').find((entry) => entry.event.units > 0)?.tick ?? Infinity;
    expect(of(events, 'EmptyReturned')[0].tick).toBeGreaterThan(firstExport);
  });

  it('kontrola a M&R: poškodené jednotky prejdú damaged → in_repair → available o repairHours, poplatok maintenance_repair, a opravené sa neskôr vydajú', () => {
    const damaged = of(events, 'EmptyDamaged');
    expect(damaged.length).toBeGreaterThan(0);
    for (const entry of damaged) {
      const unitId = entry.event.unitId;
      const started = of(events, 'EmptyRepairStarted').find((candidate) => candidate.event.unitId === unitId);
      const repaired = of(events, 'EmptyRepaired').find((candidate) => candidate.event.unitId === unitId);
      expect(started, `oprava jednotky ${String(unitId)}`).toBeDefined();
      expect(repaired).toBeDefined();
      expect((started?.tick ?? 0) - entry.tick).toBeLessThanOrEqual(1);
      expect((repaired?.tick ?? 0) - (started?.tick ?? 0)).toBe(REPAIR_TICKS);
      expect(started?.event.untilTick).toBe(repaired?.tick);
      expect(repaired?.event.costCents).toBe(BUNDLED_DEFS.economy.repairCostCents);
    }
    const repairs = world.economy.entries.filter((entry) => entry.category === 'maintenance_repair');
    expect(repairs).toHaveLength(of(events, 'EmptyRepaired').length);
    expect(repairs.every((entry) => entry.amountCents === -BUNDLED_DEFS.economy.repairCostCents)).toBe(true);
    // poškodenú ani opravovanú jednotku nikto neodviezol: výdaj opravenej je po EmptyRepaired
    const pickedUp = of(events, 'EmptyPickedUp');
    for (const entry of pickedUp) {
      const unitId = entry.event.unitId;
      const damage = damaged.find((candidate) => candidate.event.unitId === unitId);
      if (damage === undefined) continue;
      const repaired = of(events, 'EmptyRepaired').find((candidate) => candidate.event.unitId === unitId);
      expect(entry.tick, `výdaj jednotky ${String(unitId)}`).toBeGreaterThan(repaired?.tick ?? Infinity);
    }
    expect(pickedUp.some((entry) => damaged.some((candidate) => candidate.event.unitId === entry.event.unitId))).toBe(true);
  });

  it('empty handler vozí len prázdne kontajnery a vozí ich prednostne (joby importu a exportu dostanú straddle carrier)', () => {
    const handler = [...world.vehicles.values()].find((vehicle) => vehicle.def.id === 'empty_handler');
    expect(handler).toBeDefined();
    const unitOfJob = new Map(of(events, 'JobCreated').map((entry) => [entry.event.jobId, entry.event.unitIds[0]]));
    const assigned = of(events, 'JobAssigned').map((entry) => entry.event);
    const handlerJobs = assigned.filter((event) => event.vehicleId === handler?.id);
    expect(handlerJobs.length).toBeGreaterThan(0);
    expect(handlerJobs.every((event) => returnedIds.has(unitOfJob.get(event.jobId) as EntityId))).toBe(true);
    const emptyJobs = assigned.filter((event) => returnedIds.has(unitOfJob.get(event.jobId) as EntityId));
    expect(handlerJobs.length / emptyJobs.length).toBeGreaterThan(0.5);
  });

  it('výdaj exportérovi: booking #22 dostane prázdne svojej linky z depa (in_storage → in_vehicle → at_ramp → in_truck → exported), booking #10 (linka bez prázdnych) odíde naprázdno', () => {
    const picked = of(events, 'EmptyPickedUp').map((entry) => entry.event);
    expect(picked.length).toBeGreaterThan(0);
    for (const event of picked) {
      expect(event.contractId).toBe(SERVED_BOOKING_ID);
      expect(event.lineId).toBe('northern_star');
      expect(returnedIds.has(event.unitId)).toBe(true);
      expect(all.get(event.unitId)?.slice(-5), `jednotka ${String(event.unitId)}`).toEqual(['in_storage', 'in_vehicle', 'at_ramp', 'in_truck', 'exported']);
    }
    const missed = of(events, 'EmptyPickupMissed').map((entry) => entry.event);
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((event) => event.contractId === MISSED_BOOKING_ID && event.lineId === 'golden_wave')).toBe(true);
    expect(world.emptyFlow.errands.every((errand) => errand.contractId === SERVED_BOOKING_ID)).toBe(true);
  });

  it('nič sa nestratilo: konzervácia každý tick, lostUnits 0, invarianty sveta bez porušenia', () => {
    expect(lostUnits(world)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
    const empties = [...world.cargo.liveUnits()].filter((unit) => unit.direction === 'empty');
    expect(empties.every((unit) => unit.location.kind === 'in_storage')).toBe(true);
    expect(world.storedCargo.emptySize).toBe(empties.length);
  });

  it('golden report tests/sim/__golden__/empty_cycle.json sa zhoduje s behom', () => {
    expect(existsSync(GOLDEN_PATH), 'chýba golden: pnpm simrun data/scenarios/empty_cycle.json --ticks 40000 --report').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, unknown>;
    const money = of(events, 'EmptyRepaired').reduce((sum, entry) => sum + entry.event.costCents, 0);
    expect({
      cashEnd: world.cashCents,
      exportedUnits: world.cargo.exportedCount,
      shippedUnits: world.cargo.shippedCount,
      contractsCompleted: of(events, 'ContractCompleted').length,
      xp: world.xp,
      emptyReturns: returned.length,
      emptyFallbackStored: of(events, 'EmptyStored').filter((entry) => entry.event.fallback).length,
      emptyDamaged: of(events, 'EmptyDamaged').length,
      emptyRepaired: of(events, 'EmptyRepaired').length,
      repairCostCents: money,
      emptyPickedUp: of(events, 'EmptyPickedUp').length,
      emptyPickupMisses: of(events, 'EmptyPickupMissed').length,
    }).toEqual(golden);
  });

  it('deterministický: rovnaký beh dá rovnaký stateHash; obnova pred opravou, uprostred opravy, uprostred výdajov a na konci dá zhodný stateHash', () => {
    const expected = stateHash(world);
    expect(stateHash(run().world)).toBe(expected);
    const repairing = of(events, 'EmptyRepairStarted')[0];
    const ticks = [repairing.tick - 50, repairing.tick + 1_000, 26_050, 36_500];
    for (const at of ticks) {
      const half = World.create(BUNDLED_DEFS, MAP, SCENARIO.seed);
      runScenario(half, SCENARIO, at);
      const restored = World.deserialize(BUNDLED_DEFS, MAP, JSON.parse(JSON.stringify(half.serialize())) as AnyWorldState);
      runScenario(restored, SCENARIO, TICKS);
      expect(stateHash(restored), `roundtrip v ticku ${String(at)}`).toBe(expected);
    }
  }, RUN_TIMEOUT_MS);
});
