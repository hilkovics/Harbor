/**
 * Scenár `live_terminal` (F6c, T6C-03, míľnik M2 „živý terminál“, ADR-034): všetky štyri toky kontajnerov v jednom prístave F4 (depo prázdnych, dva dvory,
 * brány, 2× straddle carrier + empty handler) za 60 000 tickov; druhý dvor (T6D-04, vedľa cesty pri bráne) vznikol po T6D-01 (ADR-035): jeden dvor (64)
 * plný prekládky (36) nemal miesto pre export, takže 8 z 36 exportov čakalo vo vnútrozemí do po cut-off (rolled) —
 * - **import**: kontrakty #1 (48 TEU) a #4 (48 TEU; pred R2 96) linky blue_anchor sa vyložia a odvezú kamiónmi (`exported`); objem poolu rastie s kapacitou skladov (ADR-026),
 * - **prázdne**: 60 % odvezených jednotiek sa vráti ako prázdne (brána → TP depa → empty handler → depo), kontrola v depe poškodí časť (oprava 6 h),
 *   exportér (booking #11) dostane z depa prázdne svojej linky (`EmptyPickedUp`) a **repositioning** #12 naloží 24 TEU prázdnych (14 kontajnerov) na loď po plných jednotkách,
 * - **export**: booking #11 (36 TEU) prejde bránou pred cut-off (žiadny „rolled“), uloží sa, naloží na loď voyage a odpláva (`shipped`); vnútrozemie (ADR-035) ho
 *   vpustí len so zaručeným miestom v sklade — dva dvory (2 × 64) ho majú aj popri 36 jednotkách prekládky,
 * - **prekládka** #13 (36 TEU northern_star): loď A ich vyloží do skladu (zoskupene; pri zaplnení dvora pretečie zvyšok do druhého), o ~1 – 2 dni príde loď B a odvezie ich (`shipped`), nikdy cez bránu.
 * `lostUnits 0`, konzervácia v každom ticku, každá zmena stavu prázdneho má udalosť, `--roundtrip-at` uprostred prekládky aj nakládky prázdnych dá zhodný hash.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CargoUnit } from '@sim/cargo';
import type { SimEvent } from '@sim/events';
import { World, stateHash, type WorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { REPO_ROOT, loadScenarioFile, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS, PORT_MAP } from '../world/world-fixtures';

const SCENARIO = loadScenarioFile('live_terminal');
const TICKS = 60_000;
const IMPORT_A = 1;
const IMPORT_B = 4;
const EXPORT_ID = 11;
const REPOSITIONING_ID = 12;
const TRANSHIP_ID = 13;
/** Počty kontajnerov pri `sizeMix` 0,6 (ADR-039): booking 36 TEU = 22 kontajnerov. */
const EXPORT_UNITS = 22;
/**
 * Exporty, ktoré prešli bránou po cut-off (rolled): pred R2 žiadny (s druhým dvorom, T6D-04; pred ním 8 z 36); po R2 jeden z 22 kontajnerov — zmes veľkostí
 * posunula prúd `Rng` a s ním plán príchodov. Rolled jednotka sa naloží ako last minute (booking nakladá, kým loď nelashuje).
 */
const EXPORTS_ROLLED = 1; // R4 (ADR-041): nový prúd Rng a plán príchodov — jeden export prešiel po cut-off (pred R4 žiadny, R2: 2)
/** Objemy importov po T6D-04: pool kontraktov sa škáluje kapacitou skladov (2 × 64 namiesto 64), preto #1 a #4 majú iný objem než pred druhým dvorom (45 a 64). */
/** Po R2 sú objemy v TEU: #1 = 48 TEU = 31 kontajnerov, #4 = 48 TEU = 30 kontajnerov (pred R2 #4 = 96 — zmes veľkostí posunula prúd `Rng` poolu). */
const IMPORT_A_UNITS = 31;
const IMPORT_B_UNITS = 30;
/** Repositioning je v TEU (ADR-039): booking 24 TEU naložil 14 prázdnych rôznej veľkosti (pridelenie sa zastaví po naplnení TEU). */
const REPOSITIONED_TEU = 24;
const REPOSITIONED_TEU_LOADED = 25;
const REPOSITIONED = 15; // R4 (ADR-041): posun prúdu Rng (R2: 16, pôvodne 14)
const TRANSHIP_UNITS = 22; // 36 TEU
const RUN_TIMEOUT_MS = 600_000;
const INVARIANT_EVERY = 250;
const GOLDEN_PATH = `${REPO_ROOT}tests/sim/__golden__/live_terminal.json`;
const TICKS_PER_DAY = 3600 * 24 / BUNDLED_DEFS.time.tickGameSeconds;

type Entries = readonly { readonly tick: number; readonly event: SimEvent }[];

/** Pri prechode stavu prázdneho kontajnera sa v tom istom ticku musí objaviť zodpovedajúca udalosť (`setStatus` udalosť nemá). */
const STATUS_EVENT: Readonly<Record<string, SimEvent['type']>> = { 'available>damaged': 'EmptyDamaged', 'damaged>in_repair': 'EmptyRepairStarted', 'in_repair>available': 'EmptyRepaired' };

function run(): { readonly world: World; readonly events: Entries } {
  const world = World.create(BUNDLED_DEFS, PORT_MAP, SCENARIO.seed);
  const events: { tick: number; event: SimEvent }[] = [];
  const statuses = new Map<number, string>();
  runScenario(world, SCENARIO, TICKS, {
    afterTick: (w, tickEvents) => {
      assertCargoConservation(w);
      if (w.clock.tick % INVARIANT_EVERY === 0) expect(findWorldViolation(w)).toBeUndefined();
      for (const event of tickEvents) events.push({ tick: w.clock.tick, event });
      for (const unit of w.cargo.liveUnits()) {
        if (unit.direction !== 'empty') continue;
        const before = statuses.get(unit.id);
        statuses.set(unit.id, unit.status);
        if (before === undefined || before === unit.status) continue;
        const expected = STATUS_EVENT[`${before}>${unit.status}`];
        const seen = tickEvents.some((event) => event.type === expected && (event as { unitId?: number }).unitId === unit.id);
        if (!seen) throw new Error(`zmena stavu prázdneho #${String(unit.id)} ${before} → ${unit.status} v ticku ${String(w.clock.tick)} bez udalosti ${String(expected)}`);
      }
    },
  });
  return { world, events };
}

const of = <T extends SimEvent['type']>(events: Entries, type: T): { tick: number; event: Extract<SimEvent, { type: T }> }[] =>
  events.filter((entry): entry is { tick: number; event: Extract<SimEvent, { type: T }> } => entry.event.type === type);

/** Reťaz polôh každej jednotky z `CargoMoved` (`kind → kind → …`) a sklady, v ktorých jednotka ležala (`in_storage.moduleId`). */
function chains(events: Entries): { readonly kinds: Map<number, string[]>; readonly storages: Map<number, number[]> } {
  const kinds = new Map<number, string[]>();
  const storages = new Map<number, number[]>();
  for (const entry of of(events, 'CargoMoved')) {
    const { unitId, from, to } = entry.event;
    const chain = kinds.get(unitId) ?? [from.kind];
    chain.push(to.kind);
    kinds.set(unitId, chain);
    if (to.kind === 'in_storage') storages.set(unitId, [...(storages.get(unitId) ?? []), to.moduleId]);
  }
  return { kinds, storages };
}

describe('scenár live_terminal: súbor', () => {
  it('má tvar { id, seed, map, commands }, seed 5014, mapu harbor_01', () => {
    expect(Object.keys(SCENARIO).sort()).toEqual(['commands', 'id', 'map', 'seed']);
    expect([SCENARIO.id, SCENARIO.seed, SCENARIO.map]).toEqual(['live_terminal', 5014, 'data/maps/harbor_01.json']);
  });

  it('prístav s depom prázdnych, dvoma dvormi, tri vozidlá (2× straddle, empty handler) a štyri AcceptContract (1 @2, 4 @8 641, 11 a 13 @17 281)', () => {
    const modules = SCENARIO.commands.filter((entry) => entry.command.type === 'PlaceModule').map((entry) => (entry.command as unknown as { defId: string }).defId);
    expect(modules).toEqual(['vehicle_depot', 'container_yard_small', 'empty_depot', 'container_yard_small', 'gate_in_lane', 'gate_out_lane']);
    const vehicles = SCENARIO.commands.filter((entry) => entry.command.type === 'BuyVehicle').map((entry) => (entry.command as unknown as { vehicleDefId: string }).vehicleDefId);
    expect(vehicles).toEqual(['straddle_carrier', 'straddle_carrier', 'empty_handler']);
    const accepts = SCENARIO.commands.filter((entry) => entry.command.type === 'AcceptContract').map((entry) => [entry.atTick, (entry.command as unknown as { contractId: number }).contractId]);
    expect(accepts).toEqual([[2, IMPORT_A], [8_641, IMPORT_B], [17_281, EXPORT_ID], [17_281, TRANSHIP_ID]]);
  });
});

describe('scenár live_terminal: beh', () => {
  const { world, events } = run();
  const { kinds, storages } = chains(events);
  const returned = of(events, 'EmptyReturned').map((entry) => entry.event);
  const returnedIds = new Set(returned.map((event) => event.unitId as number));
  const loaded = of(events, 'UnitLoaded');

  it('import: kontrakty #1 (48 TEU) a #4 (96 TEU) sa vyložia, odvezú kamiónmi (exported) a dokončia', () => {
    for (const [id, units] of [[IMPORT_A, IMPORT_A_UNITS], [IMPORT_B, IMPORT_B_UNITS]] as const) {
      expect(world.contracts.get(id as never), `import #${String(id)}`).toMatchObject({ kind: 'import', lineId: 'blue_anchor', volumeUnits: units, state: 'completed', unitsExported: units });
    }
    expect(of(events, 'TruckExited').reduce((sum, entry) => sum + entry.event.units, 0)).toBe(world.cargo.exportedCount);
    // exported = 144 importov + prázdne odvezené exportérom
    expect(world.cargo.exportedCount).toBe(IMPORT_A_UNITS + IMPORT_B_UNITS + of(events, 'EmptyPickedUp').length);
  });

  it('prázdne: návrat z vnútrozemia (len linka importov) do depa, kontrola a oprava, výdaj exportérovi #11 z depa', () => {
    expect(returned.length).toBeGreaterThan(REPOSITIONED);
    expect(returned.every((event) => event.lineId === 'blue_anchor')).toBe(true);
    for (const event of returned) expect(kinds.get(event.unitId)?.slice(0, 3), `jednotka ${String(event.unitId)}`).toEqual(['in_truck', 'in_vehicle', 'in_storage']);
    expect(of(events, 'EmptyStored').every((entry) => !entry.event.fallback)).toBe(true);
    const damaged = of(events, 'EmptyDamaged');
    expect(damaged.length).toBeGreaterThan(0);
    expect(of(events, 'EmptyRepaired')).toHaveLength(damaged.length);
    expect(world.economy.entries.filter((entry) => entry.category === 'maintenance_repair')).toHaveLength(damaged.length);
    const picked = of(events, 'EmptyPickedUp').map((entry) => entry.event);
    expect(picked.length).toBeGreaterThan(0);
    for (const event of picked) {
      expect(event.contractId).toBe(EXPORT_ID);
      expect(returnedIds.has(event.unitId)).toBe(true);
      expect(kinds.get(event.unitId)?.slice(-4)).toEqual(['in_storage', 'in_vehicle', 'in_truck', 'exported']);
    }
    // výdaj len v čase, keď sa jednotka už vrátila: nikdy poškodená ani opravovaná (po EmptyRepaired)
    for (const event of picked) {
      const repaired = of(events, 'EmptyRepaired').find((entry) => entry.event.unitId === event.unitId);
      const damage = damaged.find((entry) => entry.event.unitId === event.unitId);
      if (damage !== undefined) expect(of(events, 'EmptyPickedUp').find((entry) => entry.event.unitId === event.unitId)!.tick).toBeGreaterThan(repaired?.tick ?? Infinity);
    }
  });

  it('export: booking #11 — 36 TEU prešlo bránou, uložilo sa, naložilo a odplávalo (in_truck → … → in_crane → on_ship → shipped)', () => {
    const booking = world.contracts.get(EXPORT_ID as never);
    expect(booking).toMatchObject({ kind: 'export', lineId: 'blue_anchor', state: 'completed', volumeUnits: EXPORT_UNITS });
    // vnútrozemie (ADR-035): export vojde len so zaručeným miestom v sklade; dva dvory (T6D-04) ho majú, takže nezostáva čakať vo vnútrozemí celé skupiny (rolled len jednotky s neskorým plánovaným príchodom)
    expect(booking?.booking).toMatchObject({ arrivedUnits: EXPORT_UNITS, loadedUnits: EXPORT_UNITS });
    expect(booking?.booking?.rolledUnits).toBe(EXPORTS_ROLLED);
    expect(of(events, 'UnitRolled').filter((entry) => entry.event.contractId === EXPORT_ID)).toHaveLength(EXPORTS_ROLLED);
    // Po R2 (menej kontajnerov) kamióny s exportom už nečakajú pred vjazdom stovky tickov (pred R2 > 500); čakanie pokrýva landside_pressure.
    expect(world.hinterland.waitTicksMax('delivery')).toBeGreaterThanOrEqual(0);
    expect(of(events, 'ExportArrived').filter((entry) => entry.event.contractId === EXPORT_ID)).toHaveLength(EXPORT_UNITS);
    const exportLoads = loaded.filter((entry) => entry.event.contractId === EXPORT_ID);
    expect(exportLoads).toHaveLength(EXPORT_UNITS);
    for (const entry of exportLoads) {
      expect(kinds.get(entry.event.unitId)).toEqual(['in_truck', 'in_vehicle', 'in_storage', 'in_vehicle', 'in_crane', 'on_ship', 'shipped']);
    }
  });

  it('repositioning: booking #12 naložil 24 prázdnych (vrátených z vnútrozemia) na tú istú loď po plných jednotkách exportu; odmena za naložené', () => {
    const booking = world.contracts.get(REPOSITIONING_ID as never);
    expect(booking).toMatchObject({ kind: 'empty_repositioning', lineId: 'blue_anchor', state: 'completed', volumeUnits: REPOSITIONED_TEU, volumeTeu: REPOSITIONED_TEU });
    expect(booking?.booking).toMatchObject({ arrivedUnits: REPOSITIONED, loadedUnits: REPOSITIONED });
    // Pridelené TEU dosiahli bookované (posledný prázdny smie presiahnuť najviac o 1 TEU).
    // R4 (ADR-041): repositioning naložil 15 kontajnerov = 25 TEU (posledný prázdny presiahol bookovaných 24 TEU o 1).
    expect(booking?.booking?.loadedTeu).toBe(REPOSITIONED_TEU_LOADED);
    expect(booking?.booking?.loadedTeu).toBeLessThanOrEqual(REPOSITIONED_TEU + 1);
    const empties = loaded.filter((entry) => entry.event.contractId === REPOSITIONING_ID);
    expect(empties).toHaveLength(REPOSITIONED);
    for (const entry of empties) {
      expect(returnedIds.has(entry.event.unitId)).toBe(true);
      expect(kinds.get(entry.event.unitId)?.slice(-5)).toEqual(['in_storage', 'in_vehicle', 'in_crane', 'on_ship', 'shipped']);
    }
    // stowage: všetky plné jednotky exportu predchádzajú prázdnym; mimo poradia len výnimočne
    const exportTicks = loaded.filter((entry) => entry.event.contractId === EXPORT_ID).map((entry) => entry.tick);
    const emptyTicks = empties.map((entry) => entry.tick);
    expect(Math.max(...exportTicks)).toBeLessThan(Math.min(...emptyTicks));
    // Pod hákom (od T6D-02) vozia jednotky nakládky viaceré vozidlá a žeriav berie to, ktoré už čaká pod ním — výnimočne (menej než 2 % nakládok,
    // metrika `stowageOrderViolations`) sa tak naloží jednotka pred skoršou jednotkou plánu, ktorá je ešte vo vozidle na ceste. Od R1 (ADR-037)
    // sa vozidlá nepredbiehajú (rýchlejší `empty_handler` uviazne za pomalším straddle carrierom), preto je hranica 6 % (live_terminal: 5 zo 96 nakládok).
    expect(loaded.filter((entry) => entry.event.outOfOrder).length).toBeLessThan(loaded.length * 0.06);
    expect(of(events, 'ContractCompleted').find((entry) => entry.event.contractId === REPOSITIONING_ID)?.event).toMatchObject({ rewardCents: 396_000, penaltiesCents: 0 }); // R4: naložených 25 TEU (≥ 24 bookovaných) — plná odmena bez penále
    // jedna loď odviezla export aj prázdne
    expect(new Set([...exportTicks, ...emptyTicks].map((tick) => loaded.find((entry) => entry.tick === tick)?.event.shipId)).size).toBe(1);
  });

  it('prekládka: #13 — loď A vyloží 36 TEU do skladu (zoskupene, najviac dva dvory), loď B o 1 – 2 dni odvezie; jednotky nikdy neprešli bránou', () => {
    const leg = world.contracts.get(TRANSHIP_ID as never);
    expect(leg).toMatchObject({ kind: 'tranship', lineId: 'northern_star', state: 'completed', volumeUnits: TRANSHIP_UNITS });
    expect(leg?.booking).toMatchObject({ arrivedUnits: TRANSHIP_UNITS, loadedUnits: TRANSHIP_UNITS, returnedUnits: 0 });
    const gap = ((leg?.tranship?.outArrivalTick ?? 0) - (leg?.shipArrivalTick ?? 0)) / TICKS_PER_DAY;
    expect(gap).toBeGreaterThanOrEqual(1);
    expect(gap).toBeLessThanOrEqual(2);
    const legLoads = loaded.filter((entry) => entry.event.contractId === TRANSHIP_ID);
    expect(legLoads).toHaveLength(TRANSHIP_UNITS);
    const spawned = of(events, 'ShipSpawned');
    // loď A (36 jednotiek) a loď B (0 jednotiek, vznikla v outArrivalTick) sú rôzne lode
    expect(spawned.some((entry) => entry.event.units === TRANSHIP_UNITS && entry.tick === leg?.shipArrivalTick)).toBe(true);
    expect(spawned.some((entry) => entry.event.units === 0 && entry.tick === leg?.tranship?.outArrivalTick)).toBe(true);
    expect(legLoads.every((entry) => entry.event.shipId === leg?.tranship?.outShipId)).toBe(true);
    const unitIds = legLoads.map((entry) => entry.event.unitId);
    for (const unitId of unitIds) {
      // pod hákom môže žeriav jednotku vyloženú z lode A odložiť na buffer apronu (`in_crane → on_apron → in_vehicle`), keď pod hákom nečaká vozidlo
      const chain = (kinds.get(unitId) as string[]).filter((kind) => kind !== 'on_apron');
      expect(chain, `jednotka ${String(unitId)}`).toEqual(['on_ship', 'in_crane', 'in_vehicle', 'in_storage', 'in_vehicle', 'in_crane', 'on_ship', 'shipped']);
      expect(storages.get(unitId)).toHaveLength(1);
    }
    // zoskupenie (ADR-032): jednotky prekládky idú do jedného dvora, kým má miesto; s dvoma dvormi (T6D-04) zvyšok pri zaplnení pretečie do druhého (nie striedavo)
    const perStorage = new Map<number | undefined, number>();
    for (const unitId of unitIds) perStorage.set(storages.get(unitId)?.[0], (perStorage.get(storages.get(unitId)?.[0]) ?? 0) + 1);
    expect(perStorage.size).toBeLessThanOrEqual(2);
    expect(Math.max(...perStorage.values())).toBeGreaterThanOrEqual(TRANSHIP_UNITS / 2);
    expect(of(events, 'TranshipMissed')).toEqual([]);
    expect(of(events, 'TranshipSold')).toEqual([]);
    expect(of(events, 'ContractCompleted').find((entry) => entry.event.contractId === TRANSHIP_ID)?.event).toMatchObject({ rewardCents: 1_386_000, penaltiesCents: 0 });
  });

  it('nič sa nestratilo: vytvorené = živé + exported + shipped, lostUnits 0, invarianty sveta bez porušenia', () => {
    expect(lostUnits(world)).toBe(0);
    expect(world.cargo.createdCount).toBe(world.cargo.liveCount + world.cargo.exportedCount + world.cargo.shippedCount);
    expect(world.cargo.shippedCount).toBe(EXPORT_UNITS + REPOSITIONED + TRANSHIP_UNITS);
    expect(findWorldViolation(world)).toBeUndefined();
    const live = [...world.cargo.liveUnits()] as CargoUnit[];
    expect(live.every((unit) => unit.location.kind === 'in_storage')).toBe(true);
    expect(live.every((unit) => unit.direction === 'empty')).toBe(true);
    expect(world.storedCargo.emptySize).toBe(live.length);
  });

  it('golden report tests/sim/__golden__/live_terminal.json sa zhoduje s behom (všetky štyri toky nenulové)', () => {
    expect(existsSync(GOLDEN_PATH), 'chýba golden: pnpm simrun data/scenarios/live_terminal.json --ticks 60000 --report').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, number>;
    const metrics = {
      cashEnd: world.cashCents,
      exportedUnits: world.cargo.exportedCount,
      shippedUnits: world.cargo.shippedCount,
      contractsCompleted: of(events, 'ContractCompleted').length,
      xp: world.xp,
      emptyReturns: returned.length,
      emptyFallbackStored: of(events, 'EmptyStored').filter((entry) => entry.event.fallback).length,
      emptyDamaged: of(events, 'EmptyDamaged').length,
      emptyRepaired: of(events, 'EmptyRepaired').length,
      repairCostCents: of(events, 'EmptyRepaired').reduce((sum, entry) => sum + entry.event.costCents, 0),
      emptyPickedUp: of(events, 'EmptyPickedUp').length,
      emptyPickupMisses: of(events, 'EmptyPickupMissed').length,
      repositionedUnits: loaded.filter((entry) => entry.event.contractId === REPOSITIONING_ID).length,
      transhipLoaded: loaded.filter((entry) => entry.event.contractId === TRANSHIP_ID).length,
      transhipMissed: of(events, 'TranshipMissed').reduce((sum, entry) => sum + entry.event.units, 0),
      transhipRescued: of(events, 'TranshipRescued').reduce((sum, entry) => sum + entry.event.units, 0),
      transhipSold: of(events, 'TranshipSold').reduce((sum, entry) => sum + entry.event.units, 0),
    };
    expect(metrics).toEqual(golden);
    expect([metrics.exportedUnits, metrics.shippedUnits, metrics.emptyPickedUp, metrics.repositionedUnits, metrics.transhipLoaded].every((value) => value > 0)).toBe(true);
  });

  it('deterministický: rovnaký beh dá rovnaký stateHash; obnova uprostred prekládky (jednotky v sklade, nakládka na B) a nakládky prázdnych dá zhodný stateHash', () => {
    const expected = stateHash(world);
    expect(stateHash(run().world)).toBe(expected);
    const leg = world.contracts.get(TRANSHIP_ID as never);
    const legLoads = loaded.filter((entry) => entry.event.contractId === TRANSHIP_ID);
    const emptyLoads = loaded.filter((entry) => entry.event.contractId === REPOSITIONING_ID);
    const ticks = [(leg?.shipArrivalTick ?? 0) + 4_000, legLoads[10].tick + 1, emptyLoads[5].tick + 1, TICKS - 1_000];
    for (const at of ticks) {
      const half = World.create(BUNDLED_DEFS, PORT_MAP, SCENARIO.seed);
      runScenario(half, SCENARIO, at);
      const restored = World.deserialize(BUNDLED_DEFS, PORT_MAP, JSON.parse(JSON.stringify(half.serialize())) as WorldState);
      runScenario(restored, SCENARIO, TICKS);
      expect(stateHash(restored), `roundtrip v ticku ${String(at)}`).toBe(expected);
    }
  }, RUN_TIMEOUT_MS);
});
