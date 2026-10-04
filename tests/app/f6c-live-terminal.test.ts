// T6C-06b: app a VM nad skutočným svetom míľnika M2 — scenár `live_terminal` (seed 5014): import, export + repositioning prázdnych
// na jednej lodi, prekládka loď A → sklad → loď B a návrat prázdnych v jednom prístave. Svet beží cez `GameLoop` + `SimBridge` ako v hre
// a po každom kroku sa porovná s ledgerom a so svetom (nie so syntetickými udalosťami):
//  - `ShipVM.cargoSplit`: pravidlo A / B pre prekládku (import na lodi A, export na lodi B) proti nezávislému orákulu z kontraktov
//    (`contract.shipId` = loď A, `contract.tranship.outShipId` = loď B), prázdne na lodi s exportom;
//  - karty: `snapshot.contracts` (skladané len pri zmene revízie) = čerstvé `contractCards(world)` — dôkaz, že `REVISION_EVENTS` stačia —,
//    repositioning (`arrivedUnits` = pridelené prázdne, `loadedUnits` = naložené) a prekládka (`outArrivalTick`, `outShipId`, bez
//    `rescueDeadlineTick`, `arrivedUnits` = `unitsUnloaded`);
//  - inšpektor depa (`depotCargoSplit`) a dvora (prekládka čakajúca na loď B), toasty a udalosti (`ExportShipped.units`, `UnitLoaded`).
// Zmeškanú, zachránenú a predanú prekládku live_terminal neprodukuje (loď B prišla včas), tie pokrýva `f6c-tranship-rescue.test.ts`.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Contract } from '@sim/contracts';
import type { EntityId } from '@sim/core';
import { EmptyDepot } from '@sim/modules';
import { depotCargoSplit } from '@sim/world';
import { contractCards } from '@app/contract-cards';
import { inspectorData } from '@app/inspector-data';
import { EXPORT_SHIPPED_TOAST_TITLE } from '@app/toast-center';
import { assertCargoConservation } from '../sim/helpers/invariants';
import { createScenarioApp, type ScenarioApp } from './f6a-scenario';
import { oracleDeckSplit, type DeckCounts } from './f6c-fixtures';

const TICKS = 60_000;
const STEP = 20;

interface Run {
  readonly app: ScenarioApp;
  readonly mismatches: string[];
  readonly depotId: EntityId;
  /** Najväčšie pozorované rozdelenie nákladu lode podľa lode (id) a druhu. */
  readonly peak: Map<number, DeckCounts>;
  /** Kroky, v ktorých loď A (resp. B) prekládky niesla jej jednotky podľa VM. */
  readonly seen: { aWithTranship: number; bWithTranship: number; mixedExportEmpty: number; depotUnits: number; yardTranship: number };
  readonly contracts: { repo: Contract; tranship: Contract; exportContract: Contract };
  /** Prvý tick, v ktorom mala karta kontraktu dané počítadlo (`kontrakt:pole` → tick). */
  readonly cardTicks: Map<string, number>;
}

function observe(): Run {
  const app = createScenarioApp('live_terminal');
  const { world, bridge } = app;
  app.advanceTo(1);
  const depot = [...world.modules.values()].find((module): module is EmptyDepot => module instanceof EmptyDepot);
  if (depot === undefined) throw new Error('live_terminal nemá depo prázdnych');
  const yard = [...world.modules.values()].find((module) => module.def.id === 'container_yard_small');
  if (yard === undefined) throw new Error('live_terminal nemá dvor');
  const run: Run = {
    app,
    mismatches: [],
    depotId: depot.id,
    peak: new Map(),
    seen: { aWithTranship: 0, bWithTranship: 0, mixedExportEmpty: 0, depotUnits: 0, yardTranship: 0 },
    contracts: undefined as never,
    cardTicks: new Map(),
  };
  const bad = (what: string): void => {
    if (run.mismatches.length < 25) run.mismatches.push(`tick ${String(world.clock.tick)}: ${what}`);
  };
  const repoMaxArrived = new Map<number, number>();

  app.advanceTo(TICKS, STEP, () => {
    const snapshot = bridge.snapshot();
    const fresh = contractCards(world);
    if (JSON.stringify(snapshot.contracts) !== JSON.stringify(fresh)) {
      const index = snapshot.contracts.findIndex((card, i) => JSON.stringify(card) !== JSON.stringify(fresh[i]));
      bad(`karty snapshotu sa rozišli s čerstvými (karta #${String(snapshot.contracts[index]?.id)}): ${JSON.stringify(snapshot.contracts[index])} ≠ ${JSON.stringify(fresh[index])}`);
    }

    for (const vm of snapshot.ships) {
      const expected = oracleDeckSplit(world, vm.id as EntityId);
      const split = vm.cargoSplit;
      if (split === undefined) {
        bad(`loď #${String(vm.id)} bez cargoSplit`);
        continue;
      }
      const actual: DeckCounts = { import: split.import, export: split.export, empty: split.empty ?? 0 };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) bad(`loď #${String(vm.id)}: cargoSplit ${JSON.stringify(actual)} ≠ orákulum ${JSON.stringify(expected)}`);
      const peak: DeckCounts = run.peak.get(vm.id) ?? { import: 0, export: 0, empty: 0 };
      run.peak.set(vm.id, { import: Math.max(peak.import, actual.import), export: Math.max(peak.export, actual.export), empty: Math.max(peak.empty, actual.empty) });
      for (const contract of world.contracts.values()) {
        if (contract.tranship === null) continue;
        if (contract.shipId === vm.id && actual.import > 0 && actual.export === 0) run.seen.aWithTranship += 1;
        if (contract.tranship.outShipId === vm.id && actual.export > 0 && actual.import === 0) run.seen.bWithTranship += 1;
      }
      if (actual.export > 0 && actual.empty > 0) run.seen.mixedExportEmpty += 1;
    }

    for (const contract of world.contracts.values()) {
      const { booking } = contract;
      if (booking === null) continue;
      if (contract.kind === 'empty_repositioning' && contract.state !== 'offered' && contract.state !== 'expired') {
        if (booking.loadedUnits > booking.arrivedUnits || booking.arrivedUnits > booking.bookedUnits) bad(`repositioning #${String(contract.id)}: naložené ${String(booking.loadedUnits)}, pridelené ${String(booking.arrivedUnits)}, bookované ${String(booking.bookedUnits)}`);
        const maxArrived = repoMaxArrived.get(contract.id) ?? 0;
        if (booking.arrivedUnits < maxArrived) bad(`repositioning #${String(contract.id)}: pridelené prázdne klesli ${String(maxArrived)} → ${String(booking.arrivedUnits)}`);
        repoMaxArrived.set(contract.id, Math.max(maxArrived, booking.arrivedUnits));
        // naložené = prázdne linky na lodi voyage (po odchode lode `shipped` a loadedUnits ostane)
        const shipVm = snapshot.ships.find((ship) => ship.id === contract.shipId);
        if (shipVm !== undefined && contract.state === 'exporting' && (shipVm.cargoSplit?.empty ?? 0) !== booking.loadedUnits) bad(`repositioning: na lodi ${String(shipVm.cargoSplit?.empty)} prázdnych, loadedUnits ${String(booking.loadedUnits)}`);
      }
      if (contract.kind === 'tranship') {
        if (booking.arrivedUnits !== contract.unitsUnloaded) bad(`prekládka #${String(contract.id)}: arrivedUnits ${String(booking.arrivedUnits)} ≠ unitsUnloaded ${String(contract.unitsUnloaded)}`);
        if (contract.tranship?.rescueDeadlineTick !== undefined) bad(`prekládka #${String(contract.id)}: lehota záchrany bez zmeškania`);
        if (booking.loadedUnits > booking.arrivedUnits) bad(`prekládka: naložené ${String(booking.loadedUnits)} > vyložené ${String(booking.arrivedUnits)}`);
      }
      for (const [field, value] of Object.entries({ arrived: booking.arrivedUnits, loaded: booking.loadedUnits })) {
        const key = `${String(contract.id)}:${field}`;
        if (value > 0 && !run.cardTicks.has(key)) run.cardTicks.set(key, world.clock.tick);
      }
    }

    // inšpektor depa a dvora nad skutočným svetom
    const depotData = inspectorData(bridge, depot.id);
    const lines = depotCargoSplit(world, depot.id).lines;
    const sum = (key: 'available' | 'damaged' | 'in_repair'): number => lines.reduce((total, line) => total + line[key], 0);
    const shown = depotData?.emptyDepot?.lines.reduce((total, line) => ({ available: total.available + line.available, damaged: total.damaged + line.damaged, inRepair: total.inRepair + line.inRepair }), { available: 0, damaged: 0, inRepair: 0 });
    if (JSON.stringify(shown) !== JSON.stringify({ available: sum('available'), damaged: sum('damaged'), inRepair: sum('in_repair') })) bad(`inšpektor depa ${JSON.stringify(shown)} ≠ ledger`);
    if (shown !== undefined && shown.available + shown.damaged + shown.inRepair > 0) run.seen.depotUnits += 1;
    const yardData = inspectorData(bridge, yard.id);
    let tranships = 0;
    const stored = world.cargo.countAt('in_storage', yard.id);
    for (let i = 0; i < stored; i++) {
      const unitId = world.cargo.unitAtIndex('in_storage', yard.id, i);
      if (unitId !== undefined && world.cargo.get(unitId)?.direction === 'tranship') tranships += 1;
    }
    if ((yardData?.storage?.split?.tranship ?? 0) !== tranships) bad(`inšpektor dvora: prekládka ${String(yardData?.storage?.split?.tranship)} ≠ ledger ${String(tranships)}`);
    if (tranships > 0) run.seen.yardTranship += 1;
  });

  const all = [...world.contracts.values()];
  const find = (kind: Contract['kind']): Contract => {
    const found = all.find((contract) => contract.kind === kind && contract.state !== 'offered' && contract.state !== 'expired');
    if (found === undefined) throw new Error(`scenár nemá prijatý kontrakt druhu ${kind}`);
    return found;
  };
  (run as { contracts: Run['contracts'] }).contracts = { repo: find('empty_repositioning'), tranship: find('tranship'), exportContract: find('export') };
  return run;
}

let cached: Run | undefined;
const run = (): Run => (cached ??= observe());

describe('live_terminal: app a VM nad skutočným svetom (M2)', () => {
  let observed: Run;
  beforeAll(() => {
    observed = run();
  }, 180_000);

  const eventsOf = <T extends string>(type: T) => observed.app.events.filter((entry) => entry.event.type === type);

  it('scenár dobehol, nič sa nestratilo a VM / karty / inšpektor sa v žiadnom kroku nerozišli so svetom ani ledgerom', () => {
    const { world } = observed.app;
    expect(world.clock.tick).toBe(TICKS);
    expect(observed.mismatches).toEqual([]);
    assertCargoConservation(world);
    const { cargo } = world;
    expect(cargo.createdCount - cargo.liveCount - cargo.exportedCount - cargo.shippedCount).toBe(0);
    expect(cargo.shippedCount).toBe(36 + 24 + 36); // export + repositioning + prekládka
  });

  it('pravidlo A / B: loď A nesie prekládku ako import (export 0), loď B ako export (import 0); orákulum z kontraktov sedí v každom kroku', () => {
    const { tranship } = observed.contracts;
    const a = tranship.shipId as EntityId;
    const b = tranship.tranship?.outShipId as EntityId;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(b).not.toBe(a);
    expect(observed.peak.get(a)).toEqual({ import: 36, export: 0, empty: 0 });
    expect(observed.peak.get(b)).toEqual({ import: 0, export: 36, empty: 0 });
    expect(observed.seen.aWithTranship).toBeGreaterThan(20);
    expect(observed.seen.bWithTranship).toBeGreaterThan(20);
    // iné jednotky na týchto lodiach neboli: A vyložila len prekládku, B naložila len prekládku
    expect(observed.contracts.tranship.unitsUnloaded).toBe(36);
    expect(observed.contracts.tranship.booking?.loadedUnits).toBe(36);
  });

  it('export + repositioning na jednej lodi: paluba nesie export aj prázdne (`cargoSplit.empty`), prázdne sa nakladajú po plných', () => {
    const { exportContract, repo } = observed.contracts;
    expect(repo.shipId).toBe(exportContract.shipId);
    expect(observed.peak.get(exportContract.shipId as EntityId)).toEqual({ import: 0, export: 36, empty: 24 });
    expect(observed.seen.mixedExportEmpty).toBeGreaterThan(5);
    const loads = eventsOf('UnitLoaded').map((entry) => (entry.event.type === 'UnitLoaded' ? entry.event : undefined));
    // nakládka prázdneho nesie `contractId` bookingu repositioningu, plnej jednotky export kontraktu (a prekládky na lodi B)
    const byContract = new Map<number, number>();
    for (const load of loads) if (load !== undefined && load.contractId !== null) byContract.set(load.contractId, (byContract.get(load.contractId) ?? 0) + 1);
    expect(Object.fromEntries(byContract)).toEqual({ [exportContract.id]: 36, [repo.id]: 24, [observed.contracts.tranship.id]: 36 });
    expect(loads.every((load) => load !== undefined && !load.outOfOrder)).toBe(true); // stowage: žiadna neskorá plná jednotka po prázdnych
  });

  it('karta repositioningu: pridelené prázdne rastú k bookovaným, naložené ich dobiehajú; po odchode lode 24 / 24 a kontrakt splnený', () => {
    const { repo } = observed.contracts;
    const { booking } = repo;
    expect(repo.state).toBe('completed');
    expect(booking).toMatchObject({ bookedUnits: 24, arrivedUnits: 24, loadedUnits: 24 });
    const arrivedAt = observed.cardTicks.get(`${String(repo.id)}:arrived`) ?? 0;
    const loadedAt = observed.cardTicks.get(`${String(repo.id)}:loaded`) ?? 0;
    expect(arrivedAt).toBeGreaterThan(0);
    expect(loadedAt).toBeGreaterThanOrEqual(arrivedAt);
    const card = contractCards(observed.app.world).find((entry) => entry.id === repo.id);
    expect(card).toMatchObject({ kind: 'empty_repositioning', state: 'completed', line: { id: 'blue_anchor' }, booking: { arrivedUnits: 24, loadedUnits: 24 } });
    expect(card).not.toHaveProperty('availableEmpties'); // zatvorený repositioning už dostupné prázdne neukazuje
  });

  it('karta prekládky: loď B má plán príchodu od prijatia, `outShipId` sa po jej vzniku zhoduje s loďou na mape, zmeškanie nenastalo', () => {
    const { tranship } = observed.contracts;
    const card = contractCards(observed.app.world).find((entry) => entry.id === tranship.id);
    expect(card).toMatchObject({ kind: 'tranship', state: 'completed', line: { id: 'northern_star' }, unitsUnloaded: 36 });
    expect(card?.tranship).toMatchObject({ outVoyageId: tranship.tranship?.outVoyageId, outArrivalTick: tranship.tranship?.outArrivalTick });
    expect(card?.tranship).not.toHaveProperty('rescueDeadlineTick');
    expect(card?.tranship).not.toHaveProperty('outGapTicks');
    expect(card?.booking).toMatchObject({ bookedUnits: 36, arrivedUnits: 36, loadedUnits: 36, returnedUnits: 0 });
    // loď B príde v plánovanom ticku (`transhipGapDaysRange` po lodi A) — plán z karty je spoľahlivý odpočet
    const spawn = eventsOf('ShipSpawned').find((entry) => entry.event.type === 'ShipSpawned' && entry.event.shipId === tranship.tranship?.outShipId);
    expect(spawn).toBeDefined();
    expect(Math.abs((spawn?.tick ?? 0) - (tranship.tranship?.outArrivalTick ?? 0))).toBeLessThanOrEqual(STEP + 1);
    expect(eventsOf('TranshipMissed')).toEqual([]);
  });

  it('ExportShipped.units = export + prázdne + prekládka; toast lode B prekládky ukáže triedu, počet a cieľ z kontraktu prekládky (nie len číslo lode)', () => {
    const { exportContract, repo, tranship } = observed.contracts;
    const shipped = eventsOf('ExportShipped').map((entry) => (entry.event.type === 'ExportShipped' ? entry.event : undefined));
    expect(shipped.map((event) => [event?.shipId, event?.units])).toEqual([
      [tranship.tranship?.outShipId, 36],
      [exportContract.shipId, 36 + 24],
    ]);
    const toasts = observed.app.toasts.filter((entry) => entry.spec.title === EXPORT_SHIPPED_TOAST_TITLE).map((entry) => entry.spec.text);
    const destination = repo.booking?.destinationPort ?? '';
    expect(toasts).toEqual([`Feeder · 36 TEU → ${tranship.booking?.destinationPort ?? ''}`, `Feeder · 60 TEU → ${destination}`]);
  });

  it('toasty: prijatie skupiny export + prázdne a prekládky, splnenie repositioningu a prekládky; zmeškaná prekládka ani jej penalizácia toast nemajú', () => {
    const { exportContract, repo, tranship } = observed.contracts;
    const toasts = observed.app.toasts.map((entry) => entry.spec);
    const accepted = toasts.filter((spec) => spec.key.startsWith('contract_accepted:'));
    expect(accepted.map((spec) => spec.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`#${String(exportContract.id)} · Export 36 TEU → Gdańsk + #${String(repo.id)} · Prázdne 24 TEU → Gdańsk`),
        expect.stringContaining(`#${String(tranship.id)} · Tranship 36 TEU → Gdańsk`),
      ]),
    );
    const completed = toasts.filter((spec) => spec.key.startsWith('contract_completed:'));
    expect(completed.map((spec) => spec.key)).toEqual(expect.arrayContaining([`contract_completed:${String(repo.id)}`, `contract_completed:${String(tranship.id)}`]));
    expect(toasts.some((spec) => spec.key.startsWith('tranship_'))).toBe(false);
    expect(toasts.some((spec) => spec.key.startsWith('booking_penalty:'))).toBe(false);
  });

  it('inšpektor: depo ukázalo prázdne podľa linky počas toku (ledger = inšpektor v každom kroku) a dvor prekládku čakajúcu na loď B', () => {
    expect(observed.seen.depotUnits).toBeGreaterThan(500);
    expect(observed.seen.yardTranship).toBeGreaterThan(50);
    const data = inspectorData(observed.app.bridge, observed.depotId);
    expect(data?.emptyDepot?.lines.map((line) => line.lineId)).toEqual(['blue_anchor', 'northern_star', 'golden_wave']);
    expect(data?.emptyDepot?.repairBays).toBe(2);
  });
});
