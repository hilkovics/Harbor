// T6C-06a: render VM a toasty F6c nad skutočným svetom scenára `empty_cycle` (import → návrat prázdnych → depo → kontrola a oprava → výdaj
// exportérovi). Svet beží cez `GameLoop` + `SimBridge` po jednom ticku a po každom ticku sa VM porovná s ledgerom: depo (`ModuleVM.depot` =
// `depotCargoSplit`), prázdne vo vozidle (`VehicleVM.carriesEmpty`) a v kamióne (`TruckVM.carriesEmpty`,
// vrátane kamióna misie `collect`), operácie skladov (`lastStorageOp.empty`), súčet nákladu lode, a toasty (`EmptyReturned`, `EmptyRepaired`,
// `EmptyPickupMissed`) nad skutočnými udalosťami. Repositioning a prekládku sim zatiaľ negeneruje (T6C-03), tie pokrýva `entities-vm-f6c.test.ts`.
import { beforeAll, describe, expect, it } from 'vitest';
import type { CargoDirection } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { EmptyDepot } from '@sim/modules';
import { depotCargoSplit } from '@sim/world';
import { EMPTY_PICKUP_MISSED_TOAST_TITLE, EMPTY_REPAIRED_TOAST_TITLE, EMPTY_RETURNED_TOAST_TITLE } from '@app/toast-center';
import { formatMoney } from '@ui/format';
import { createScenarioApp, type ScenarioApp } from './f6a-scenario';

const TICKS = 40_000;

/** Pozorovania z jedného behu scenára (po každom ticku). */
interface Observed {
  readonly app: ScenarioApp;
  /** Tick, v ktorom sa VM rozišlo s ledgerom, a popis (prázdne = všetko sedí). */
  readonly mismatches: string[];
  readonly depot: { id: number; repairBays: number; maxAvailable: number; sawDamaged: boolean; sawInRepair: boolean; stepsWithUnits: number };
  readonly vehicles: { handlerCarried: number; handlerLoaded: number; otherCarried: number };
  readonly trucks: {
    /** Kamión misie `collect`: stav pred naložením a po naložení (podľa id kamióna). */
    readonly collect: Map<number, { before: boolean; after: boolean }>;
    /** Kamión, ktorý dovezie prázdny: po vyložení (`loaded: false`) si pamätá `carriesEmpty`. */
    memoryAfterUnload: number;
    /** Krok, v ktorom exportný / importný kamión nesie neprázdny náklad a `carriesEmpty` nie je nastavené. */
    plainLoaded: number;
  };
  readonly storageOps: { emptyOps: number; depotOpsNotEmpty: number };
}

function observe(): Observed {
  const app = createScenarioApp('empty_cycle');
  const { world, bridge } = app;
  app.advanceTo(1); // príkazy z ticku 0 (cesty, moduly, depo prázdnych) sa aplikujú pri prvom ticku
  const depotModule = [...world.modules.values()].find((module): module is EmptyDepot => module instanceof EmptyDepot);
  if (depotModule === undefined) throw new Error('scenár empty_cycle nemá depo prázdnych');
  const observed: Observed = {
    app,
    mismatches: [],
    depot: { id: depotModule.id, repairBays: depotModule.repairBays, maxAvailable: 0, sawDamaged: false, sawInRepair: false, stepsWithUnits: 0 },
    vehicles: { handlerCarried: 0, handlerLoaded: 0, otherCarried: 0 },
    trucks: { collect: new Map(), memoryAfterUnload: 0, plainLoaded: 0 },
    storageOps: { emptyOps: 0, depotOpsNotEmpty: 0 },
  };
  const bad = (what: string): void => {
    if (observed.mismatches.length < 20) observed.mismatches.push(`tick ${String(world.clock.tick)}: ${what}`);
  };

  app.advanceTo(TICKS, 1, () => {
    const snapshot = bridge.snapshot();
    for (const vm of snapshot.modules) {
      const module = world.modules.get(vm.id as EntityId);
      if (module instanceof EmptyDepot) {
        const lines = depotCargoSplit(world, module.id).lines;
        const sum = (key: 'available' | 'damaged' | 'in_repair'): number => lines.reduce((total, line) => total + line[key], 0);
        const expected = { available: sum('available'), damaged: sum('damaged'), inRepair: sum('in_repair'), repairBays: module.repairBays };
        if (JSON.stringify(vm.depot) !== JSON.stringify(expected)) bad(`depo ${JSON.stringify(vm.depot)} ≠ ${JSON.stringify(expected)}`);
        if (expected.damaged + expected.inRepair + expected.available > 0) observed.depot.stepsWithUnits += 1;
        observed.depot.maxAvailable = Math.max(observed.depot.maxAvailable, expected.available);
        observed.depot.sawDamaged ||= expected.damaged > 0;
        observed.depot.sawInRepair ||= expected.inRepair > 0;
        if (vm.lastStorageOp !== undefined) {
          if (vm.lastStorageOp.empty === true) observed.storageOps.emptyOps += 1;
          else observed.storageOps.depotOpsNotEmpty += 1;
        }
      } else if (vm.depot !== undefined) {
        bad(`modul #${String(vm.id)} nie je depo, ale nesie depot`);
      }
    }

    for (const vm of snapshot.vehicles) {
      const unitId = world.cargo.firstUnitAt('in_vehicle', vm.id as EntityId);
      const direction: CargoDirection | undefined = unitId === undefined ? undefined : world.cargo.get(unitId)?.direction;
      if (vm.loaded !== (unitId !== undefined)) bad(`vozidlo #${String(vm.id)}: loaded ${String(vm.loaded)}`);
      if ((vm.carriesEmpty === true) !== (direction === 'empty')) bad(`vozidlo #${String(vm.id)} (${vm.defId}): carriesEmpty ${String(vm.carriesEmpty)}, smer ${String(direction)}`);
      if (vm.defId === 'empty_handler' && vm.loaded) {
        observed.vehicles.handlerLoaded += 1;
        if (vm.carriesEmpty === true) observed.vehicles.handlerCarried += 1;
      } else if (vm.carriesEmpty === true) {
        observed.vehicles.otherCarried += 1;
      }
    }

    for (const vm of snapshot.trucks) {
      const truck = world.trucks.get(vm.id as EntityId);
      const unitId = world.cargo.firstUnitAt('in_truck', vm.id as EntityId);
      const direction: CargoDirection | undefined = unitId === undefined ? undefined : world.cargo.get(unitId)?.direction;
      if (vm.loaded !== (unitId !== undefined)) bad(`kamión #${String(vm.id)}: loaded ${String(vm.loaded)}`);
      if (unitId !== undefined && (vm.carriesEmpty === true) !== (direction === 'empty')) bad(`kamión #${String(vm.id)}: carriesEmpty ${String(vm.carriesEmpty)}, smer ${String(direction)}`);
      if (unitId !== undefined && direction !== 'empty') observed.trucks.plainLoaded += 1;
      if (unitId === undefined && vm.carriesEmpty === true) observed.trucks.memoryAfterUnload += 1;
      if (truck?.mission === 'collect') {
        const seen = observed.trucks.collect.get(vm.id) ?? { before: false, after: false };
        if (!vm.loaded && vm.carriesEmpty !== true && !seen.after) seen.before = true;
        if (vm.loaded && vm.carriesEmpty === true) seen.after = true;
        if (vm.loaded && vm.carriesEmpty !== true) bad(`kamión collect #${String(vm.id)} nesie neprázdny náklad`);
        if (!vm.loaded && seen.after) bad(`kamión collect #${String(vm.id)} stratil náklad pred odchodom`);
        observed.trucks.collect.set(vm.id, seen);
      }
    }

    for (const vm of snapshot.ships) {
      const onBoard = world.cargo.countAt('on_ship', vm.id as EntityId);
      const split = vm.cargoSplit;
      if (split === undefined) bad(`loď #${String(vm.id)} nemá cargoSplit`);
      else if (vm.unitsOnBoard !== onBoard || split.import + split.export + (split.empty ?? 0) !== vm.unitsOnBoard) {
        bad(`loď #${String(vm.id)}: unitsOnBoard ${String(vm.unitsOnBoard)}, ledger ${String(onBoard)}, split ${JSON.stringify(split)}`);
      }
    }
  });
  return observed;
}

/** Jeden beh scenára pre oba bloky testov (trvá niekoľko sekúnd). */
let cachedRun: Observed | undefined;
function run(): Observed {
  cachedRun ??= observe();
  return cachedRun;
}

describe('empty_cycle: render VM nad skutočným svetom', () => {
  let observed: Observed;
  beforeAll(() => {
    observed = run();
  }, 120_000);

  it('scenár dobehol bez straty nákladu a VM sa v žiadnom ticku nerozišlo s ledgerom', () => {
    expect(observed.app.world.clock.tick).toBe(TICKS);
    expect(observed.mismatches).toEqual([]);
  });

  it('depo prázdnych: dostupné, poškodené a v oprave zo `depotCargoSplit`, `repairBays` z modulu (revízia ho prepočíta pri každej zmene stavu)', () => {
    const { depot } = observed;
    expect(depot.repairBays).toBeGreaterThan(0);
    expect(depot.stepsWithUnits).toBeGreaterThan(100);
    expect(depot.maxAvailable).toBeGreaterThan(0);
    expect(depot.sawDamaged).toBe(true);
    expect(depot.sawInRepair).toBe(true);
    const vm = observed.app.bridge.snapshot().modules.find((module) => module.id === depot.id);
    expect(vm?.depot?.repairBays).toBe(depot.repairBays);
    expect(vm?.depot?.inRepair).toBeLessThanOrEqual(depot.repairBays);
  });

  it('prázdne vo vozidle: empty handler nesie prázdny vždy (`carriesEmpty`), záložné vozidlo len keď ho vezie', () => {
    expect(observed.vehicles.handlerLoaded).toBeGreaterThan(0);
    expect(observed.vehicles.handlerCarried).toBe(observed.vehicles.handlerLoaded);
  });

  it('prázdne v kamióne: návrat nesie `carriesEmpty` aj po vyložení (kontajner z príchodu), neprázdny náklad ho nenesie', () => {
    expect(observed.trucks.memoryAfterUnload).toBeGreaterThan(0);
    expect(observed.trucks.plainLoaded).toBeGreaterThan(0);
  });

  it('kamión misie `collect` (výdaj exportérovi): pred naložením prázdny bez `carriesEmpty`, po naložení `carriesEmpty`', () => {
    const { collect } = observed.trucks;
    const pickedUp = observed.app.events.filter((entry) => entry.event.type === 'EmptyPickedUp').length;
    expect(pickedUp).toBeGreaterThan(0);
    const completed = [...collect.values()].filter((seen) => seen.after);
    expect(completed.length).toBe(pickedUp);
    expect(completed.every((seen) => seen.before)).toBe(true);
    // kamióny bez dostupného prázdneho do prístavu nevošli (ADR-035): `EmptyPickupMissed` nesie `truckId: null` a kamión `collect` nikdy nevznikol
    const missed = observed.app.events.filter((entry) => entry.event.type === 'EmptyPickupMissed');
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((entry) => entry.event.type === 'EmptyPickupMissed' && entry.event.truckId === null)).toBe(true);
    expect(collect.size).toBe(pickedUp);
  });

  it('operácie skladov: depo drží len prázdne, preto každá jeho `lastStorageOp` nesie `empty`', () => {
    expect(observed.storageOps.emptyOps).toBeGreaterThan(0);
    expect(observed.storageOps.depotOpsNotEmpty).toBe(0);
  });
});

describe('empty_cycle: toasty nad skutočnými udalosťami', () => {
  let observed: Observed;
  beforeAll(() => {
    observed = run();
  }, 120_000);

  const eventsOf = <T extends string>(type: T) => observed.app.events.filter((entry) => entry.event.type === type);
  const toastsOf = (prefix: string) => observed.app.toasts.filter((entry) => entry.spec.key.startsWith(prefix));

  it('EmptyReturned: jeden nenápadný toast za linku a dávku, s názvom linky z lines.json', () => {
    const { world } = observed.app;
    const returns = eventsOf('EmptyReturned');
    expect(returns.length).toBeGreaterThan(0);
    const toasts = toastsOf('empty_returned:');
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts.length).toBeLessThanOrEqual(returns.length);
    for (const { tick, event } of returns) {
      if (event.type !== 'EmptyReturned') continue;
      const toast = toasts.find((entry) => entry.tick === tick && entry.spec.key === `empty_returned:${event.lineId}`);
      expect(toast, `toast pre návrat linky ${event.lineId} v ticku ${String(tick)}`).toBeDefined();
      expect(toast?.spec.title).toBe(EMPTY_RETURNED_TOAST_TITLE);
      expect(toast?.spec.tone).toBe('info');
      expect(toast?.spec.text).toContain(world.defs.lines.get(event.lineId).displayName);
    }
  });

  it('EmptyRepaired: „Oprava hotová“ zlúčená podľa depa a linky, s počtom a cenou opráv z udalostí a akciou „Ukázať“ na depo', () => {
    const { world } = observed.app;
    const repairs = eventsOf('EmptyRepaired');
    expect(repairs.length).toBeGreaterThan(0);
    for (const { tick, event } of repairs) {
      if (event.type !== 'EmptyRepaired') continue;
      const sameBatch = repairs.filter((entry) => entry.tick === tick && entry.event.type === 'EmptyRepaired' && entry.event.moduleId === event.moduleId && entry.event.lineId === event.lineId);
      const costCents = sameBatch.reduce((sum, entry) => sum + (entry.event.type === 'EmptyRepaired' ? entry.event.costCents : 0), 0);
      const toast = observed.app.toasts.find((entry) => entry.tick === tick && entry.spec.key === `empty_repaired:${String(event.moduleId)}:${event.lineId}`);
      expect(toast, `toast opravy v ticku ${String(tick)}`).toBeDefined();
      expect(toast?.spec.title).toBe(EMPTY_REPAIRED_TOAST_TITLE);
      expect(toast?.spec.tone).toBe('success');
      expect(toast?.spec.text).toContain(`opravené: ${String(sameBatch.length)}`);
      expect(toast?.spec.text).toContain(formatMoney(-costCents));
      expect(toast?.spec.text).toContain(world.defs.lines.get(event.lineId).displayName);
      const module = world.modules.get(event.moduleId);
      expect(toast?.spec.focus).toEqual({ x: (module?.origin.x ?? 0) + (module?.size.w ?? 0) / 2, y: (module?.origin.y ?? 0) + (module?.size.h ?? 0) / 2 });
    }
  });

  it('EmptyPickupMissed: varovanie „Výdaj prázdneho zlyhal“ s popisom kontraktu a linky, akcia otvorí kontrakty; ostatné udalosti výdaja toast nemajú', () => {
    const { world } = observed.app;
    const misses = eventsOf('EmptyPickupMissed');
    expect(misses.length).toBeGreaterThan(0);
    for (const { tick, event } of misses) {
      if (event.type !== 'EmptyPickupMissed') continue;
      const toast = observed.app.toasts.find((entry) => entry.tick === tick && entry.spec.key === `empty_pickup_missed:${String(event.contractId)}`);
      expect(toast, `toast zlyhaného výdaja kontraktu #${String(event.contractId)} v ticku ${String(tick)}`).toBeDefined();
      expect(toast?.spec.title).toBe(EMPTY_PICKUP_MISSED_TOAST_TITLE);
      expect(toast?.spec.tone).toBe('warning');
      expect(toast?.spec.panel).toBe('contracts');
      expect(toast?.spec.text).toContain(`#${String(event.contractId)}`);
      expect(toast?.spec.text).toContain(world.defs.lines.get(event.lineId).displayName);
      // od ADR-035 sa kamión bez dostupného prázdneho vzdá vo vnútrozemí (truckId null) a do prístavu nevojde
      if (event.truckId === null) expect(toast?.spec.text).toContain('do prístavu nevošiel');
      else expect(toast?.spec.text).toContain('odišiel prázdny');
    }
    expect(eventsOf('EmptyPickedUp').length).toBeGreaterThan(0);
    expect(toastsOf('empty_picked_up').length).toBe(0);
    expect(toastsOf('empty_stored').length + toastsOf('empty_damaged').length + toastsOf('empty_repair_started').length).toBe(0);
  });
});
