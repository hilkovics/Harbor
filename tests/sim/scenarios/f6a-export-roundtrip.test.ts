/**
 * Scenár `export_roundtrip` (F6a, T6A-03/T6A-05, ADR-032, ADR-033): vertikálny rez celého roundtripu — roundtrip booking
 * (import 57 TEU + export 36 TEU, jedna voyage; kontrakty #7 a #8) prijatý v ticku 8 641, 36 delivery kamiónov prinesie export pred
 * cut-off (4 z nich s VGM hold), posledný kamión zablokuje chýbajúca cesta pred portálom (RemoveRoad 22 200, PlaceRoad 30 600),
 * takže prejde bránou po cut-off aj po začiatku lashingu (rolled, nenaloží sa), loď vyloží 57 TEU (žeriav, vozidlá, brána von),
 * naloží 35 TEU exportu v poradí stowage plánu, lashuje a odíde (`shipped`); rolled jednotka sa vráti odosielateľovi po súši.
 *
 * Beh sa overuje v oboch režimoch odovzdávania: predvolený `under_hook` (`BUNDLED_DEFS`, ADR-033) a `apron` (`DEFS`, F2–F5).
 * Režim `apron` ostáva v správaní zhodný s F6a — golden `tests/sim/__golden__/export_roundtrip.json`. Predvolený `under_hook` (od T6D-02: vozidlo
 * stojí pod žeriavom, buffer 0 — žeriav čaká na vozidlo) má pomalšiu vykládku — vlastný golden `tests/sim/__golden__/export_roundtrip_under_hook.json`.
 * Posledný kamión (zablokovaná cesta do 30 600, splatný od 22 239) po otvorení cesty nevojde hneď: od T6D-01 (ADR-035) potrebuje zaručené staging miesto
 * na docku. Príčina (T6D-05b): v ticku 30 601, prvom s prevádzkovou rampou, krok 5 (dispatcher) vytvorí 8× `JobCreated` pre import čakajúci na odvoz
 * a rezervuje všetkých 8 staging miest dockov skôr, než krok 8 čakajúci kamión vpustí — miesto sa uvoľní až po kamiónoch na odvoz importu. Prisľúbenie
 * miesta kamiónu (`DockIntake`, „príjem a odvoz majú každý vlastnú kapacitu“) platí až pre už vpustené kamióny, nie pre čakajúci kamión vo vnútrozemí.
 * Kamión tak vojde po začiatku lashingu v oboch režimoch (pod hákom 30 943, na aprone 30 699 — rozdiel je len v tom, kedy sa uvoľní prvé miesto) —
 * jednotka je rolled a vráti sa odosielateľovi po súši (35 odplávaných); pred T6D-01 dorazila ešte počas nakládky a naložila sa ako last minute
 * (to pokrýva `export-loading.test.ts`). Časovanie a `stateHash` sa líšia podľa režimu.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { World, stateHash, type WorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { MAP, lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { REPO_ROOT, loadScenarioFile, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS, DEFS } from '../world/world-fixtures';
import { itR1Interim } from '../helpers/r1-interim';

const SCENARIO = loadScenarioFile('export_roundtrip');
const TICKS = 40_000;
const IMPORT_ID = 7;
const EXPORT_ID = 8;
const IMPORT_UNITS = 57;
const BOOKED = 36;
const SHIPPED = BOOKED - 1;
const REMOVE_ROAD_TICK = 22_200;
const PLACE_ROAD_TICK = 30_600;
const RUN_TIMEOUT_MS = 300_000;
const GOLDEN_PATH = `${REPO_ROOT}tests/sim/__golden__/export_roundtrip.json`;
const GOLDEN_HOOK_PATH = `${REPO_ROOT}tests/sim/__golden__/export_roundtrip_under_hook.json`;

type Entries = readonly { readonly tick: number; readonly event: SimEvent }[];

interface Run {
  readonly world: World;
  readonly events: Entries;
}

function run(defs: DefRegistry): Run {
  const world = World.create(defs, MAP, SCENARIO.seed);
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

/** Reťaz polôh každej jednotky z `CargoMoved` (`kind → kind → …`), jednotka → reťaz. */
function chains(events: Entries): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const entry of of(events, 'CargoMoved')) {
    const chain = out.get(entry.event.unitId) ?? [entry.event.from.kind];
    chain.push(entry.event.to.kind);
    out.set(entry.event.unitId, chain);
  }
  return out;
}

/** Metriky zo svetu a udalostí (podmnožina reportu `simrun`, ktorú pinuje golden). */
function reportOf(run: Run): Record<string, unknown> {
  // Vrátený odosielateľovi = jednotka exportu (vznikla `in_truck`), ktorá skončila `exported` (opustila mapu po súši).
  const returned = [...chains(run.events).values()].filter((chain) => chain[0] === 'in_truck' && chain.at(-1) === 'exported').length;
  return {
    cashEnd: run.world.cashCents,
    exportedUnits: run.world.cargo.exportedCount,
    shippedUnits: run.world.cargo.shippedCount,
    rolledUnits: of(run.events, 'UnitRolled').length,
    returnedUnits: returned,
    contractsCompleted: of(run.events, 'ContractCompleted').length,
    xp: run.world.xp,
  };
}

describe('scenár export_roundtrip: súbor', () => {
  it('má tvar { id, seed, map, commands }, seed 5013, mapu harbor_01', () => {
    expect(Object.keys(SCENARIO).sort()).toEqual(['commands', 'id', 'map', 'seed']);
    expect(SCENARIO.id).toBe('export_roundtrip');
    expect(SCENARIO.seed).toBe(5013);
    expect(SCENARIO.map).toBe('data/maps/harbor_01.json');
  });

  it('prístav F4 (10 úsekov ciest, 6 modulov, 2 vozidlá), AcceptContract 7 v ticku 8 641 a zablokovanie cesty pred portálom', () => {
    const types = SCENARIO.commands.map((entry) => entry.command.type);
    expect(types).toEqual([...Array<string>(10).fill('PlaceRoad'), ...Array<string>(6).fill('PlaceModule'), 'BuyVehicle', 'BuyVehicle', 'AcceptContract', 'RemoveRoad', 'PlaceRoad']);
    const accept = SCENARIO.commands.find((entry) => entry.command.type === 'AcceptContract');
    expect(accept).toEqual({ atTick: 8641, command: { type: 'AcceptContract', contractId: IMPORT_ID } });
    expect(SCENARIO.commands.find((entry) => entry.command.type === 'RemoveRoad')?.atTick).toBe(REMOVE_ROAD_TICK);
    expect(SCENARIO.commands.find((entry) => entry.command.type === 'PlaceRoad' && entry.atTick > 0)?.atTick).toBe(PLACE_ROAD_TICK);
  });
});

/**
 * Režimy odovzdávania: v oboch príde rolled jednotka po začiatku lashingu (od T6D-01 vjazd z vnútrozemia len so zaručeným miestom na docku, viď hlavičku),
 * nenaloží sa a vráti sa odosielateľovi po súši (35 odplávaných, 1 vrátená). Naloženie rolled jednotky ako last minute pokrýva `export-loading.test.ts`.
 */
const MODES = [
  { name: 'under_hook (predvolený režim)', defs: BUNDLED_DEFS, goldenPath: GOLDEN_HOOK_PATH },
  { name: 'apron', defs: DEFS, goldenPath: GOLDEN_PATH },
] as const;

describe.each(MODES)('scenár export_roundtrip: režim $name', ({ defs, goldenPath }) => {
  const shippedUnits = SHIPPED;
  const returnedUnits = 1;
  const result = run(defs);
  const { world, events } = result;
  const exportContract = world.contracts.get(EXPORT_ID as never)!;
  const importContract = world.contracts.get(IMPORT_ID as never)!;

  itR1Interim('roundtrip: import 57 TEU a export 36 TEU jednej voyage, oba prijaté v ticku 8 641 a dokončené', () => {
    expect([importContract.kind, exportContract.kind]).toEqual(['import', 'export']);
    expect(importContract.voyageId).toBe(exportContract.voyageId);
    expect(importContract.volumeUnits).toBe(IMPORT_UNITS);
    expect(exportContract.volumeUnits).toBe(BOOKED);
    expect([importContract.acceptedTick, exportContract.acceptedTick]).toEqual([8641, 8641]);
    expect([importContract.state, exportContract.state]).toEqual(['completed', 'completed']);
    expect(of(events, 'ContractCompleted').map((entry) => entry.event.contractId).sort((a, b) => a - b)).toEqual([IMPORT_ID, EXPORT_ID]);
    expect(world.clock.tick).toBe(TICKS);
  });

  itR1Interim('36 kamiónov s exportom prešlo bránou, posledný prišiel po cut-off ako rolled (4 s VGM hold) až počas lashingu', () => {
    const cutoff = of(events, 'CutoffPassed');
    expect(cutoff).toHaveLength(1);
    expect(cutoff[0].event).toMatchObject({ contractId: EXPORT_ID, arrivedUnits: BOOKED - 1, bookedUnits: BOOKED });
    const arrivals = of(events, 'ExportArrived');
    expect(arrivals).toHaveLength(BOOKED);
    expect(arrivals.filter((entry) => entry.tick <= cutoff[0].tick)).toHaveLength(BOOKED - 1);
    const rolled = of(events, 'UnitRolled');
    expect(rolled).toHaveLength(1);
    expect(rolled[0].tick).toBeGreaterThan(PLACE_ROAD_TICK);
    expect(rolled[0].tick).toBeGreaterThan(of(events, 'ShipLashingStarted')[0].tick);
    expect(of(events, 'VgmHoldStarted')).toHaveLength(4);
    expect(of(events, 'VgmHoldReleased')).toHaveLength(4);
    expect(of(events, 'TruckUnloaded')).toHaveLength(BOOKED);
  });

  itR1Interim('loď vyloží 57 TEU importu a naloží exportu v poradí stowage plánu (žiadna jednotka mimo poradia)', () => {
    expect(of(events, 'CraneCycleDone')).toHaveLength(IMPORT_UNITS);
    const loaded = of(events, 'UnitLoaded');
    expect(loaded).toHaveLength(shippedUnits);
    expect(loaded.filter((entry) => entry.event.lastMinute)).toHaveLength(0);
    expect(loaded.some((entry) => entry.event.outOfOrder)).toBe(false);
    expect(of(events, 'DualCycle').length).toBeGreaterThan(0);
  });

  itR1Interim('lashing po poslednej naloženej jednotke: lashingTicksPerUnit × počet naložených + paperworkTicks, potom odchod lode s ExportShipped', () => {
    const { lashingTicksPerUnit, paperworkTicks } = defs.ships.get('feeder');
    const lashing = of(events, 'ShipLashingStarted');
    expect(lashing).toHaveLength(1);
    expect(lashing[0].event.loadedUnits).toBe(shippedUnits);
    expect(lashing[0].event.ticks).toBe(lashingTicksPerUnit * shippedUnits + paperworkTicks);
    const departed = of(events, 'ShipDeparted');
    expect(departed).toHaveLength(1);
    expect(of(events, 'ShipUndocked')[0].tick - lashing[0].tick).toBe(lashing[0].event.ticks);
    expect(of(events, 'ExportShipped').map((entry) => entry.event.units)).toEqual([shippedUnits]);
    expect(of(events, 'ExportShipped')[0].tick).toBe(departed[0].tick);
  });

  itR1Interim('každá naložená jednotka prešla legálnu cestu on_ship ← in_crane ← vozidlo ← sklad … → shipped (nič sa neteleportuje)', () => {
    const shipped = of(events, 'CargoMoved').filter((entry) => entry.event.to.kind === 'shipped');
    expect(shipped).toHaveLength(shippedUnits);
    const all = chains(events);
    const expected =
      defs.modules.get('berth_standard').params['handoverMode'] === 'under_hook'
        ? ['in_truck', 'at_ramp', 'in_vehicle', 'in_storage', 'in_vehicle', 'in_crane', 'on_ship', 'shipped']
        : ['in_truck', 'at_ramp', 'in_vehicle', 'in_storage', 'in_vehicle', 'on_apron', 'in_crane', 'on_ship', 'shipped'];
    for (const entry of shipped) expect(all.get(entry.event.unitId), `jednotka ${String(entry.event.unitId)}`).toEqual(expected);
  });

  itR1Interim('rolled jednotka: prišla po začiatku lashingu, nenaložená, vráti sa odosielateľovi po súši; booking s penalizáciou rolled', () => {
    const [rolled] = of(events, 'UnitRolled');
    const id = rolled.event.unitId;
    const loadedEntry = of(events, 'UnitLoaded').find((entry) => entry.event.unitId === id);
    const chain = chains(events).get(id) as string[];
    expect(loadedEntry).toBeUndefined();
    expect(chain.at(-1)).toBe('exported');
    expect(chain.includes('on_ship')).toBe(false);
    const penalties = of(events, 'BookingPenaltyApplied').map((entry) => entry.event);
    expect(penalties).toHaveLength(1);
    // Jednotka sa nenaložila (penalizácia rolled, nie last_minute).
    expect(penalties[0]).toMatchObject({ contractId: EXPORT_ID, kind: 'rolled', units: 1 });
    expect(penalties[0].amountCents).toBeGreaterThan(0);
    expect(exportContract.booking?.rolledUnitIds).toEqual([id]);
  });

  itR1Interim('žiadna jednotka sa nestratila: vytvorených 93 = 57 exportovaných importov + vrátený export (1) + odoslané lodou (35); invarianty bez porušenia', () => {
    expect(world.cargo.createdCount).toBe(IMPORT_UNITS + BOOKED);
    expect(world.cargo.exportedCount).toBe(IMPORT_UNITS + returnedUnits);
    expect(world.cargo.shippedCount).toBe(shippedUnits);
    expect(world.cargo.liveCount).toBe(0);
    expect(lostUnits(world)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('golden report (apron: export_roundtrip.json, under_hook: export_roundtrip_under_hook.json) sa zhoduje s behom', () => {
    expect(existsSync(goldenPath), `chýba golden ${goldenPath}: pnpm simrun data/scenarios/export_roundtrip.json --ticks 40000 --report`).toBe(true);
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(golden).sort()).toEqual(['cashEnd', 'contractsCompleted', 'exportedUnits', 'returnedUnits', 'rolledUnits', 'shippedUnits', 'xp']);
    expect(reportOf(result)).toEqual(golden);
  });

  it('deterministický: rovnaký beh dá rovnaký stateHash; ticks pred cut-off, uprostred nakládky a lashingu — obnova dá zhodný stateHash', () => {
    const expected = stateHash(world);
    expect(stateHash(run(defs).world)).toBe(expected);
    for (const at of [REMOVE_ROAD_TICK + 100, 28_000, 30_700]) {
      const half = World.create(defs, MAP, SCENARIO.seed);
      runScenario(half, SCENARIO, at);
      const restored = World.deserialize(defs, MAP, JSON.parse(JSON.stringify(half.serialize())) as WorldState);
      runScenario(restored, SCENARIO, TICKS);
      expect(stateHash(restored), `roundtrip v ticku ${String(at)}`).toBe(expected);
    }
  }, RUN_TIMEOUT_MS);
});

describe('scenár export_roundtrip: časovanie podľa režimu', () => {
  itR1Interim('režimy sa líšia stateHash a časovaním: pod hákom žeriav čaká na vozidlo a odovzdáva priamo, na aprone nie; rolled jednotka príde v oboch po otvorení cesty', () => {
    const hook = run(BUNDLED_DEFS);
    const apron = run(DEFS);
    expect(stateHash(hook.world)).not.toBe(stateHash(apron.world));
    const cranes = (world: World) => [...world.modules.values()].filter((module) => 'waitForVehicleTicks' in module) as unknown as { waitForVehicleTicks: number }[];
    expect(cranes(hook.world).some((crane) => crane.waitForVehicleTicks > 0)).toBe(true);
    expect(cranes(apron.world).every((crane) => crane.waitForVehicleTicks === 0)).toBe(true);
    // Rolled jednotka prišla v oboch behoch po otvorení zablokovanej cesty (30 600); pod hákom neskôr — kamión z vnútrozemia vojde až po uvoľnení
    // staging miesta na docku (T6D-01, ADR-035): všetkých 8 miest rezervoval v ticku 30 601 krok 5 pred krokom 8 (T6D-05b) a prvé sa uvoľní pod hákom
    // o ~240 ticků neskôr než na aprone.
    const rolledTicks = [hook, apron].map((entry) => of(entry.events, 'UnitRolled')[0].tick);
    for (const tick of rolledTicks) expect(tick).toBeGreaterThan(PLACE_ROAD_TICK);
    expect(rolledTicks[0]).toBeGreaterThan(rolledTicks[1]);
    expect(rolledTicks[0] - rolledTicks[1]).toBeLessThan(500);
    // Pod hákom (buffer 0) ide vykládka priamo vozidlu, na aprone cez apron; pomalšia vykládka posunie lashing neskôr než na aprone.
    const direct = (events: Entries): number => of(events, 'CargoMoved').filter((entry) => entry.event.from.kind === 'in_crane' && entry.event.to.kind === 'in_vehicle').length;
    // apron slúži len ako protideadlock (vozidlo s exportom čaká pod hákom, žeriav drží import): drvivá väčšina vykládky ide priamo
    expect(direct(hook.events)).toBeGreaterThanOrEqual(Math.floor(IMPORT_UNITS * 0.8));
    expect(direct(apron.events)).toBe(0);
    expect(of(hook.events, 'ShipLashingStarted')[0].tick).toBeGreaterThan(of(apron.events, 'ShipLashingStarted')[0].tick);
  }, RUN_TIMEOUT_MS);
});
