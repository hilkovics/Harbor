/**
 * Scenár `export_roundtrip` (F6a, T6A-03/T6A-05, ADR-032, ADR-033): vertikálny rez celého roundtripu — roundtrip booking
 * (import 54 TEU + export 36 TEU, jedna voyage; kontrakty #7 a #8) prijatý v ticku 8 641 (od R2, ADR-039: 31 + 24 kontajnerov so zmesou 20′/40′ `sizeMix` 0,6), 36 delivery kamiónov prinesie export pred
 * cut-off (4 z nich s VGM hold), posledný kamión zablokuje chýbajúca cesta pred portálom (RemoveRoad 24 350, PlaceRoad 30 600),
 * takže prejde bránou po cut-off aj po začiatku lashingu (rolled, nenaloží sa), loď vyloží 31 kontajnerov / 54 TEU (žeriav, vozidlá, brána von),
 * naloží 23 kontajnerov / 34 TEU exportu v poradí stowage plánu, lashuje a odíde (`shipped`); rolled jednotka sa vráti odosielateľovi po súši.
 *
 * Beh sa overuje v oboch režimoch odovzdávania: predvolený `under_hook` (`BUNDLED_DEFS`, ADR-033) a `apron` (`DEFS`, F2–F5).
 * Režim `apron` ostáva v správaní zhodný s F6a — golden `tests/sim/__golden__/export_roundtrip.json`. Predvolený `under_hook` (od T6D-02: vozidlo
 * stojí pod žeriavom, buffer 0 — žeriav čaká na vozidlo) má pomalšiu vykládku — vlastný golden `tests/sim/__golden__/export_roundtrip_under_hook.json`.
 * Posledný kamión (zablokovaná cesta do 30 600, splatný od 24 395) po otvorení cesty nevojde hneď: od T6D-01 (ADR-035) potrebuje zaručené staging miesto
 * na docku. Príčina (T6D-05b): v ticku 30 601, prvom s prevádzkovou rampou, krok 5 (dispatcher) vytvorí 8× `JobCreated` pre import čakajúci na odvoz
 * a rezervuje všetkých 8 staging miest dockov skôr, než krok 8 čakajúci kamión vpustí — miesto sa uvoľní až po kamiónoch na odvoz importu. Prisľúbenie
 * miesta kamiónu (`DockIntake`, „príjem a odvoz majú každý vlastnú kapacitu“) platí až pre už vpustené kamióny, nie pre čakajúci kamión vo vnútrozemí.
 * Kamión tak vojde po začiatku lashingu v oboch režimoch (pod hákom 30 943, na aprone 30 699 — rozdiel je len v tom, kedy sa uvoľní prvé miesto) —
 * jednotka je rolled a vráti sa odosielateľovi po súši (23 odplávaných kontajnerov); pred T6D-01 dorazila ešte počas nakládky a naložila sa ako last minute
 * (to pokrýva `export-loading.test.ts`). Časovanie a `stateHash` sa líšia podľa režimu.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { bookingUnitsPenaltyCents } from '@sim/contracts/contract-terms';
import { World, stateHash, type WorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { lostUnits } from '../helpers/f6a';
import { PORT_MAP } from '../world/world-fixtures';
import { assertCargoConservation } from '../helpers/invariants';
import { REPO_ROOT, loadScenarioFile, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS, DEFS } from '../world/world-fixtures';

const SCENARIO = loadScenarioFile('export_roundtrip');
const TICKS = 40_000;
const IMPORT_ID = 7;
const EXPORT_ID = 8;
/** Objem kontraktov v TEU a počet kontajnerov pri `sizeMix` 0,6 (ADR-039): 54 TEU = 31 kontajnerov, 36 TEU = 24 kontajnerov (import sa pred R2 losoval 57 TEU — zmes veľkostí posunula prúd `Rng`). */
const IMPORT_TEU = 54;
const BOOKED_TEU = 36;
const IMPORT_UNITS = 31;
const BOOKED = 24;
/** Posledný kontajner exportu (index 23 z 24 kontajnerov / 36 TEU) je 40′: rolled a vrátený, naloží sa 23 kontajnerov = 34 TEU. */
const SHIPPED = BOOKED - 1;
const SHIPPED_TEU = BOOKED_TEU - 2;
const REMOVE_ROAD_TICK = 24_350;
const PLACE_ROAD_TICK = 30_600;
/** Pod hákom: R4 (ADR-041) posunul prúd Rng — 5 jednotiek mimo poradia z 23 (pred R4 najviac 1). */
const OUT_OF_ORDER_HOOK_MAX = 5;
const RUN_TIMEOUT_MS = 300_000;
const GOLDEN_PATH = `${REPO_ROOT}tests/sim/__golden__/export_roundtrip.json`;
const GOLDEN_HOOK_PATH = `${REPO_ROOT}tests/sim/__golden__/export_roundtrip_under_hook.json`;

type Entries = readonly { readonly tick: number; readonly event: SimEvent }[];

interface Run {
  readonly world: World;
  readonly events: Entries;
}

function run(defs: DefRegistry): Run {
  const world = World.create(defs, PORT_MAP, SCENARIO.seed);
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

  it('prístav F4 (8 + 6 úsekov ciest, 7 modulov, 2 vozidlá), AcceptContract 7 v ticku 8 641 a zablokovanie cesty pred portálom', () => {
    const types = SCENARIO.commands.map((entry) => entry.command.type);
    expect(types).toEqual([...Array<string>(8).fill('PlaceRoad'), ...Array<string>(7).fill('PlaceModule'), 'BuyVehicle', 'BuyVehicle', ...Array<string>(6).fill('PlaceRoad'), 'RemoveRoad', 'AcceptContract', 'RemoveRoad', 'PlaceRoad']);
    const accept = SCENARIO.commands.find((entry) => entry.command.type === 'AcceptContract');
    expect(accept).toEqual({ atTick: 8641, command: { type: 'AcceptContract', contractId: IMPORT_ID } });
    expect(SCENARIO.commands.find((entry) => entry.command.type === 'RemoveRoad' && entry.atTick > 0)?.atTick).toBe(REMOVE_ROAD_TICK);
    expect(SCENARIO.commands.find((entry) => entry.command.type === 'PlaceRoad' && entry.atTick > 0)?.atTick).toBe(PLACE_ROAD_TICK);
  });
});

/**
 * Režimy odovzdávania: v oboch príde rolled jednotka po začiatku lashingu (od T6D-01 vjazd z vnútrozemia len so zaručeným miestom na docku, viď hlavičku),
 * nenaloží sa a vráti sa odosielateľovi po súši (23 odplávaných kontajnerov, 1 vrátený). Naloženie rolled jednotky ako last minute pokrýva `export-loading.test.ts`.
 */
const MODES = [
  // Pod hákom (31 796 lashing, 31 984 posledný kamión) príde posledný kontajner (40′) po začiatku lashingu: rolled a vrátený odosielateľovi.
  { name: 'under_hook (predvolený režim)', defs: BUNDLED_DEFS, goldenPath: GOLDEN_HOOK_PATH, lateUnit: 'rolled_returned', shippedUnits: SHIPPED, returnedUnits: 1, shippedTeu: SHIPPED_TEU },
  // Na aprone sa lashing začne až v 32 407, posledný kamión príde už v 31 173 (po cut-off, pred lashingom): rolled, ale naloží sa ako last minute (R2: menej
  // kontajnerov = skôr hotová vykládka a iné časovanie než pred R2, kedy ho režimy delili len o ~240 ticků — viď hlavičku).
  { name: 'apron', defs: DEFS, goldenPath: GOLDEN_PATH, lateUnit: 'last_minute', shippedUnits: BOOKED, returnedUnits: 0, shippedTeu: BOOKED_TEU },
] as const;

describe.each(MODES)('scenár export_roundtrip: režim $name', ({ defs, goldenPath, lateUnit, shippedUnits, returnedUnits, shippedTeu }) => {
  const result = run(defs);
  const { world, events } = result;
  const exportContract = world.contracts.get(EXPORT_ID as never)!;
  const importContract = world.contracts.get(IMPORT_ID as never)!;

  it('roundtrip: import 54 TEU a export 36 TEU jednej voyage, oba prijaté v ticku 8 641 a dokončené', () => {
    expect([importContract.kind, exportContract.kind]).toEqual(['import', 'export']);
    expect(importContract.voyageId).toBe(exportContract.voyageId);
    expect([importContract.volumeTeu, exportContract.volumeTeu]).toEqual([IMPORT_TEU, BOOKED_TEU]);
    expect(importContract.volumeUnits).toBe(IMPORT_UNITS);
    expect(exportContract.volumeUnits).toBe(BOOKED);
    expect([importContract.acceptedTick, exportContract.acceptedTick]).toEqual([8641, 8641]);
    expect([importContract.state, exportContract.state]).toEqual(['completed', 'completed']);
    expect(of(events, 'ContractCompleted').map((entry) => entry.event.contractId).sort((a, b) => a - b)).toEqual([IMPORT_ID, EXPORT_ID]);
    expect(world.clock.tick).toBe(TICKS);
  });

  it('24 kamiónov s exportom (36 TEU) prešlo bránou, posledný prišiel po cut-off ako rolled (VGM hold u časti jednotiek), pod hákom až počas lashingu', () => {
    const cutoff = of(events, 'CutoffPassed');
    expect(cutoff).toHaveLength(1);
    expect(cutoff[0].event).toMatchObject({ contractId: EXPORT_ID, arrivedUnits: BOOKED - 1, bookedUnits: BOOKED });
    const arrivals = of(events, 'ExportArrived');
    expect(arrivals).toHaveLength(BOOKED);
    expect(arrivals.filter((entry) => entry.tick <= cutoff[0].tick)).toHaveLength(BOOKED - 1);
    const rolled = of(events, 'UnitRolled');
    expect(rolled).toHaveLength(1);
    expect(rolled[0].tick).toBeGreaterThan(PLACE_ROAD_TICK);
    const lashingTick = of(events, 'ShipLashingStarted')[0].tick;
    if (lateUnit === 'rolled_returned') expect(rolled[0].tick).toBeGreaterThan(lashingTick);
    else expect(rolled[0].tick).toBeLessThan(lashingTick);
    // VGM hold je losovaný z Rng: po R4 (ADR-041, brána losuje problémy) má hold jedna jednotka (pred R4 dve); každý hold sa uvoľní.
    expect(of(events, 'VgmHoldStarted').length).toBeGreaterThan(0);
    expect(of(events, 'VgmHoldReleased')).toHaveLength(of(events, 'VgmHoldStarted').length);
    expect(of(events, 'TruckUnloaded')).toHaveLength(BOOKED);
  });

  it('loď vyloží 31 kontajnerov (54 TEU) importu a naloží exportu v poradí stowage plánu (žiadna jednotka mimo poradia)', () => {
    expect(of(events, 'CraneCycleDone')).toHaveLength(IMPORT_UNITS);
    const loaded = of(events, 'UnitLoaded');
    expect(loaded).toHaveLength(shippedUnits);
    expect(loaded.filter((entry) => entry.event.lastMinute)).toHaveLength(lateUnit === 'last_minute' ? 1 : 0);
    // Na aprone príde posledný (medium) kontajner ešte pred lashingom a čaká v sklade, kým sa nakladajú ľahšie jednotky → tie sú mimo poradia (last minute).
    // Pod hákom vozidlo, ktoré musí najprv preložiť kontajner nad cieľom (rehandling, R2 ADR-039), príde po inom vozidle — najviac 1 jednotka mimo poradia tried.
    const outOfOrder = loaded.filter((entry) => entry.event.outOfOrder).length;
    if (lateUnit === 'last_minute') expect(outOfOrder).toBeGreaterThan(0);
    else expect(outOfOrder).toBeLessThanOrEqual(OUT_OF_ORDER_HOOK_MAX);
    expect(of(events, 'DualCycle').length).toBeGreaterThan(0);
  });

  it('lashing po poslednej naloženej jednotke: lashingTicksPerUnit × počet naložených + paperworkTicks, potom odchod lode s ExportShipped', () => {
    const { lashingTicksPerUnit, paperworkTicks } = defs.ships.get('feeder');
    const lashing = of(events, 'ShipLashingStarted');
    expect(lashing).toHaveLength(1);
    expect(lashing[0].event.loadedUnits).toBe(shippedUnits);
    expect(exportContract.booking?.loadedTeu).toBe(shippedTeu);
    expect(lashing[0].event.ticks).toBe(lashingTicksPerUnit * shippedUnits + paperworkTicks);
    const departed = of(events, 'ShipDeparted');
    expect(departed).toHaveLength(1);
    expect(of(events, 'ShipUndocked')[0].tick - lashing[0].tick).toBe(lashing[0].event.ticks);
    expect(of(events, 'ExportShipped').map((entry) => entry.event.units)).toEqual([shippedUnits]);
    expect(of(events, 'ExportShipped')[0].tick).toBe(departed[0].tick);
  });

  it('každá naložená jednotka prešla legálnu cestu on_ship ← in_crane ← vozidlo ← sklad … → shipped (nič sa neteleportuje)', () => {
    const shipped = of(events, 'CargoMoved').filter((entry) => entry.event.to.kind === 'shipped');
    expect(shipped).toHaveLength(shippedUnits);
    const all = chains(events);
    const expected =
      defs.modules.get('berth_standard').params['handoverMode'] === 'under_hook'
        ? ['in_truck', 'at_ramp', 'in_vehicle', 'in_storage', 'in_vehicle', 'in_crane', 'on_ship', 'shipped']
        : ['in_truck', 'at_ramp', 'in_vehicle', 'in_storage', 'in_vehicle', 'on_apron', 'in_crane', 'on_ship', 'shipped'];
    for (const entry of shipped) expect(all.get(entry.event.unitId), `jednotka ${String(entry.event.unitId)}`).toEqual(expected);
  });

  it('rolled jednotka: pod hákom prišla po začiatku lashingu, nenaložená, vráti sa odosielateľovi po súši; booking s penalizáciou rolled (na aprone sa naloží ako last minute)', () => {
    const [rolled] = of(events, 'UnitRolled');
    const id = rolled.event.unitId;
    const loadedEntry = of(events, 'UnitLoaded').find((entry) => entry.event.unitId === id);
    const chain = chains(events).get(id) as string[];
    const penalties = of(events, 'BookingPenaltyApplied').map((entry) => entry.event);
    if (lateUnit === 'last_minute') {
      expect(loadedEntry?.event.lastMinute).toBe(true);
      expect(chain.at(-1)).toBe('shipped');
      expect(penalties).toHaveLength(1);
      // Posledný kontajner je 40′ (2 z 36 TEU): penalizácia last minute je pomerná k TEU.
      expect(penalties[0]).toMatchObject({ contractId: EXPORT_ID, kind: 'last_minute', units: 1 });
      expect(penalties[0].amountCents).toBe(bookingUnitsPenaltyCents(exportContract.rewardCents, BOOKED_TEU, 2, defs.economy.lastMinuteExportRateOfReward));
      return;
    }
    expect(loadedEntry).toBeUndefined();
    expect(chain.at(-1)).toBe('exported');
    expect(chain.includes('on_ship')).toBe(false);
    expect(penalties).toHaveLength(1);
    // Jednotka sa nenaložila (penalizácia rolled, nie last_minute).
    expect(penalties[0]).toMatchObject({ contractId: EXPORT_ID, kind: 'rolled', units: 1 });
    // Penalizácia je pomerná k TEU rolled jednotky (40′ = 2 z 36 TEU), nie k počtu kontajnerov.
    expect(penalties[0].amountCents).toBe(bookingUnitsPenaltyCents(exportContract.rewardCents, BOOKED_TEU, 2, defs.economy.rolledExportRateOfReward));
    expect(penalties[0].amountCents).toBeGreaterThan(0);
    expect(exportContract.booking?.rolledUnitIds).toEqual([id]);
  });

  it('žiadna jednotka sa nestratila: vytvorených 55 = 31 exportovaných importov + vrátený export (pod hákom 1, na aprone 0) + odoslané lodou (pod hákom 23, na aprone 24); invarianty bez porušenia', () => {
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
      const half = World.create(defs, PORT_MAP, SCENARIO.seed);
      runScenario(half, SCENARIO, at);
      const restored = World.deserialize(defs, PORT_MAP, JSON.parse(JSON.stringify(half.serialize())) as WorldState);
      runScenario(restored, SCENARIO, TICKS);
      expect(stateHash(restored), `roundtrip v ticku ${String(at)}`).toBe(expected);
    }
  }, RUN_TIMEOUT_MS);
});

describe('scenár export_roundtrip: časovanie podľa režimu', () => {
  it('režimy sa líšia stateHash a časovaním: pod hákom žeriav čaká na vozidlo a odovzdáva priamo, na aprone nie; rolled jednotka príde v oboch po otvorení cesty', () => {
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
    expect(rolledTicks[0] - rolledTicks[1]).toBeLessThan(1000);
    // Pod hákom (buffer 0) ide vykládka priamo vozidlu, na aprone cez apron; pomalšia vykládka posunie lashing neskôr než na aprone.
    const direct = (events: Entries): number => of(events, 'CargoMoved').filter((entry) => entry.event.from.kind === 'in_crane' && entry.event.to.kind === 'in_vehicle').length;
    // apron slúži len ako protideadlock (vozidlo s exportom čaká pod hákom, žeriav drží import): väčšina vykládky ide priamo (R4, ADR-041: posun prúdu Rng — 23 z 31 namiesto 25+)
    expect(direct(hook.events)).toBeGreaterThanOrEqual(Math.floor(IMPORT_UNITS * 0.7));
    expect(direct(apron.events)).toBe(0);
    // Časovanie lashingu sa v režimoch líši (pred R2 bol pod hákom neskôr; s menším počtom kontajnerov R2 je poradie závislé od priebehu vykládky).
    expect(of(hook.events, 'ShipLashingStarted')[0].tick).not.toBe(of(apron.events, 'ShipLashingStarted')[0].tick);
  }, RUN_TIMEOUT_MS);
});
