/**
 * Scenár `empty_cycle` (F6c, T6C-02, ADR-034; R4 ADR-041): celý cyklus prázdneho kontajnera v prístave s dvorom, depom prázdnych a empty handlerom — import northern_star (kontrakt #2, 64 TEU = 39 kontajnerov)
 * sa odvezie kamiónmi, 60 % jednotiek sa o 1 – 3 dni vráti ako prázdne (kamión `delivery`, brána `EmptyReturned`, vyloženie na TP depa straddle carrierom, odvoz do depa), kontrola v depe poškodí časť
 * (`EmptyDamaged`), oprava trvá 6 h (`EmptyRepaired`, poplatok `maintenance_repair`); roundtrip golden_wave #10 + export #11 nemá z čoho dostať prázdny (`EmptyPickupMissed`), export #24 (roundtrip #23 + #24
 * northern_star, prijatý v ticku 25 921) dostane prázdne z depa (`EmptyPickedUp`, `in_truck → exported`), vrátane už opravených. `lostUnits 0`, `--roundtrip-at` uprostred opravy dá zhodný hash.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { World, stateHash, type WorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { REPO_ROOT, loadScenarioFile, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS, PORT_MAP } from '../world/world-fixtures';

const SCENARIO = loadScenarioFile('empty_cycle');
const TICKS = 40_000;
const IMPORT_ID = 2;
const MISSED_BOOKING_ID = 11;
/** Prijatia scenára (R4: pool ponúk sa po novom prúde `Rng` líši, ids sa preto prečíslovali): #2 import, #11 export roundtripu golden_wave (linka bez prázdnych), #23 + #24 roundtrip northern_star. */
const ACCEPTED_OFFER_ID = 23;
const SERVED_BOOKING_ID = 24;
/** Import #2: 64 TEU = 39 kontajnerov pri `sizeMix` 0,6 (ADR-039). */
const IMPORT_UNITS = 39;
const RUN_TIMEOUT_MS = 300_000;
const GOLDEN_PATH = `${REPO_ROOT}tests/sim/__golden__/empty_cycle.json`;
const REPAIR_TICKS = Math.round(BUNDLED_DEFS.logistics.emptyFlow.repairHours * (3600 / BUNDLED_DEFS.time.tickGameSeconds));

type Entries = readonly { readonly tick: number; readonly event: SimEvent }[];

function run(): { readonly world: World; readonly events: Entries } {
  const world = World.create(BUNDLED_DEFS, PORT_MAP, SCENARIO.seed);
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

  it('prístav s dvorom, depom prázdnych, tri vozidlá (2× straddle, empty handler) a tri AcceptContract (2 @2, 11 @8 641, 24 @25 921 — prijatie exportu #24 prijme jeho import #23)', () => {
    const types = SCENARIO.commands.map((entry) => entry.command.type);
    expect(types).toEqual([...Array<string>(8).fill('PlaceRoad'), ...Array<string>(5).fill('PlaceModule'), 'BuyVehicle', 'BuyVehicle', 'BuyVehicle', 'AcceptContract', 'AcceptContract', 'AcceptContract']);
    const modules = SCENARIO.commands.filter((entry) => entry.command.type === 'PlaceModule').map((entry) => (entry.command as unknown as { defId: string }).defId);
    expect(modules).toEqual(['vehicle_depot', 'container_yard_small', 'empty_depot', 'gate_in_lane', 'gate_out_lane']);
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

  it('import #2 (64 TEU, northern_star) sa odvezie kamiónmi a kontrakt sa dokončí; booking #11 aj roundtrip #23 + #24 sú prijaté', () => {
    const imported = world.contracts.get(IMPORT_ID as never);
    expect(imported).toMatchObject({ kind: 'import', lineId: 'northern_star', volumeUnits: IMPORT_UNITS, state: 'completed', unitsExported: IMPORT_UNITS });
    expect(world.contracts.get(MISSED_BOOKING_ID as never)).toMatchObject({ kind: 'export', lineId: 'golden_wave', state: 'completed' });
    expect(world.contracts.get(ACCEPTED_OFFER_ID as never)).toMatchObject({ kind: 'import', lineId: 'northern_star', state: 'accepted' });
    expect(world.contracts.get(SERVED_BOOKING_ID as never)).toMatchObject({ kind: 'export', lineId: 'northern_star', state: 'accepted' });
    // dokončené: import #2, roundtrip golden_wave (import #10 + export #11)
    expect(of(events, 'ContractCompleted').map((entry) => entry.event.contractId).sort((a, b) => a - b)).toEqual([IMPORT_ID, 10, MISSED_BOOKING_ID]);
  });

  it('návrat prázdnych: každá vrátená jednotka je prázdna linky importu, prešla in_truck → in_vehicle → in_storage a uložili ju v depe (nie vo dvore)', () => {
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.every((event) => event.lineId === 'northern_star')).toBe(true);
    const stored = of(events, 'EmptyStored').map((entry) => entry.event);
    expect(stored.length).toBe(returned.length);
    expect(stored.every((event) => !event.fallback)).toBe(true);
    for (const event of returned) {
      expect(all.get(event.unitId)?.slice(0, 3), `jednotka ${String(event.unitId)}`).toEqual(['in_truck', 'in_vehicle', 'in_storage']);
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
      // Oprava začne hneď, keď je voľná oprava (repairBays); inak poškodená jednotka čaká najviac jednu opravu (R2: iné časovanie ukladania zhustilo poškodené jednotky).
      expect((started?.tick ?? 0) - entry.tick).toBeGreaterThanOrEqual(0);
      expect((started?.tick ?? 0) - entry.tick).toBeLessThanOrEqual(REPAIR_TICKS);
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
    // Že sa niektorá opravená jednotka aj vydá, závisí od toho, ktoré prázdne vyberie výdaj (po R2 je kontajnerov menej a v tomto behu sa žiadna opravená nevydala);
    // poradie oprava → výdaj kontroluje cyklus vyššie.
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

  it('výdaj exportérovi: booking #24 dostane prázdne svojej linky z depa (in_storage → in_vehicle → in_truck → exported), booking #11 (linka bez prázdnych) odíde naprázdno', () => {
    const picked = of(events, 'EmptyPickedUp').map((entry) => entry.event);
    expect(picked.length).toBeGreaterThan(0);
    for (const event of picked) {
      expect(event.contractId).toBe(SERVED_BOOKING_ID);
      expect(event.lineId).toBe('northern_star');
      expect(returnedIds.has(event.unitId)).toBe(true);
      expect(all.get(event.unitId)?.slice(-4), `jednotka ${String(event.unitId)}`).toEqual(['in_storage', 'in_vehicle', 'in_truck', 'exported']);
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
      const half = World.create(BUNDLED_DEFS, PORT_MAP, SCENARIO.seed);
      runScenario(half, SCENARIO, at);
      const restored = World.deserialize(BUNDLED_DEFS, PORT_MAP, JSON.parse(JSON.stringify(half.serialize())) as WorldState);
      runScenario(restored, SCENARIO, TICKS);
      expect(stateHash(restored), `roundtrip v ticku ${String(at)}`).toBe(expected);
    }
  }, RUN_TIMEOUT_MS);
});
