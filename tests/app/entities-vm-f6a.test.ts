// T6A-07b: napojenie render VM na simuláciu F6a — smer cyklu žeriavu, náklad na palube podľa smeru a lashing lode, odznaky
// VGM hold (sklad / berth cez `World.holdIndex`) a exportné kamióny (R4: obsluha na TP dvora). Syntetické prípady
// idú nad živým svetom s nákladom presunutým cez ledger; kamióny a hold nad skutočným scenárom `export_inbound`.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleVM } from '@render/view-models';
import type { EntityId } from '@sim/core';
import { commandFromJSON } from '@sim/commands';
import { CRANE_CYCLES, type CraneCycle } from '@sim/modules';
import type { Ship } from '@sim/ships';
import { EntitiesVMBuilder, craneVMs, entitiesVM, heldByModule, moduleVMs, shipVMs } from '@app/entities-vm';
import type { LashingTotals } from '@app/lashing';
import { CHAIN_GATE_ID, CHAIN_GATE_OUT_ID, YARD_ID, buildFullChain, createApp, createPortApp, type App } from './app-fixtures';
import { addRoundtripOffer, createExportUnit, moveChain, toShipChain, toStorageChain } from './f6a-fixtures';
import { createScenarioApp } from './f6a-scenario';

const ROOT_BERTH = 1 as EntityId;
const ROOT_CRANE = 2 as EntityId;

function tickUntil(app: App, done: () => boolean, limit = 4000): void {
  for (let i = 0; i < limit && !done(); i += 1) app.world.tick();
  expect(done(), 'podmienka sa do limitu tickov nesplnila').toBe(true);
}

/** Feeder (4 TEU importu), ktorý dopláva a zakotví pri Root kotvisku. */
function dockedFeeder(app: App): Ship {
  app.bridge.dispatch(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }));
  tickUntil(app, () => [...app.world.ships.values()].some((ship) => ship.state === 'docked'));
  const ship = [...app.world.ships.values()].find((candidate) => candidate.state === 'docked');
  if (ship === undefined) throw new Error('loď chýba');
  return ship;
}

describe('CraneVM.cycle', () => {
  it('nesie smer cyklu z `crane.cycle` (vykládka je predvolená, nakládka a dual cykly podľa simu)', () => {
    const { world } = createApp();
    const crane = world.modules.get(ROOT_CRANE);
    if (crane === undefined || !('cycle' in crane)) throw new Error('žeriav chýba');
    expect(craneVMs(world)[0]?.cycle).toBe('unload');
    for (const cycle of CRANE_CYCLES) {
      (crane as { cycle: CraneCycle }).cycle = cycle;
      expect(craneVMs(world)[0]?.cycle).toBe(cycle);
    }
  });
});

describe('ShipVM.cargoSplit a ShipVM.lashing', () => {
  it('cargoSplit = shipCargoSplit: import a naložený export na palube, súčet = unitsOnBoard; bez lashingu pole nie je', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    const [before] = shipVMs(app.world);
    expect(before).toMatchObject({ unitsOnBoard: 4, cargoSplit: { import: 4, export: 0 } });
    expect(before).not.toHaveProperty('lashing');

    const roundtrip = addRoundtripOffer(app.world);
    for (let i = 0; i < 3; i += 1) moveChain(app.world, createExportUnit(app.world, roundtrip.exportContract).id, toShipChain(ship.id));
    const [after] = shipVMs(app.world);
    expect(after).toMatchObject({ unitsOnBoard: 7, cargoSplit: { import: 4, export: 3 } });
    expect(app.bridge.snapshot().ships[0]?.cargoSplit).toEqual({ import: 4, export: 3 });
  });

  it('v stave lashing: ticksLeft zo simu, ticksTotal zo vzorca defu (lashingTicksPerUnit × export + paperworkTicks), kým udalosť nepríde', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    const roundtrip = addRoundtripOffer(app.world);
    for (let i = 0; i < 3; i += 1) moveChain(app.world, createExportUnit(app.world, roundtrip.exportContract).id, toShipChain(ship.id));
    ship.transition('lashing');
    ship.lashingTicksLeft = 300;
    const expectedTotal = ship.def.lashingTicksPerUnit * 3 + ship.def.paperworkTicks;
    expect(expectedTotal).toBeGreaterThan(300);
    expect(shipVMs(app.world)[0]?.lashing).toEqual({ ticksLeft: 300, ticksTotal: expectedTotal });
    expect(app.bridge.snapshot().ships[0]?.lashing).toEqual({ ticksLeft: 300, ticksTotal: expectedTotal });
  });

  it('ticksTotal si SimBridge pamätá zo ShipLashingStarted.ticks (syntetická udalosť), prežije ticky a zabudne sa po ShipUndocked', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    ship.transition('lashing');
    ship.lashingTicksLeft = 480;
    app.bridge.publish([{ type: 'ShipLashingStarted', shipId: ship.id, loadedUnits: 2, ticks: 600 }]);
    expect(app.bridge.snapshot().ships[0]?.lashing).toEqual({ ticksLeft: 480, ticksTotal: 600 });
    ship.lashingTicksLeft = 120; // sim odpočítava lashing každý tick; zapamätaná celková doba ostáva
    expect(shipVMs(app.world, undefined, app.bridge.lashingTotals)[0]?.lashing).toEqual({ ticksLeft: 120, ticksTotal: 600 });

    ship.transition('undocking');
    ship.lashingTicksLeft = 0;
    app.bridge.publish([{ type: 'ShipUndocked', shipId: ship.id }]);
    expect(app.bridge.snapshot().ships[0]).not.toHaveProperty('lashing');
    expect(app.bridge.lashingTotals.has(ship.id)).toBe(false);
  });

  it('shipVMs berie celkové doby z argumentu; ticksTotal nie je nikdy menší než ticksLeft (progres neklesne pod 0)', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    ship.transition('lashing');
    ship.lashingTicksLeft = 500;
    const totals: LashingTotals = new Map([[ship.id, 200]]);
    expect(shipVMs(app.world, undefined, totals)[0]?.lashing).toEqual({ ticksLeft: 500, ticksTotal: 500 });
    expect(entitiesVM(app.world, undefined, undefined, undefined, undefined, new Map([[ship.id, 900]])).ships[0]?.lashing).toEqual({ ticksLeft: 500, ticksTotal: 900 });
  });
});

describe('ModuleVM.held (VGM hold)', () => {
  function logisticsApp(): App {
    const app = createPortApp();
    buildFullChain(app, { units: 0, vehicles: 0 });
    return app;
  }

  /** Jednotka exportu presunutá cez ledger na `chain`, zadržaná do `untilTick` (ledger aj index ako brána). */
  function holdUnit(app: App, chain: ReturnType<typeof toStorageChain>, untilTick = 5000) {
    const unit = createExportUnit(app.world, addRoundtripOffer(app.world).exportContract);
    moveChain(app.world, unit.id, chain);
    app.world.cargo.setHold(unit.id, { reason: 'vgm', untilTick });
    app.world.holdIndex.add(untilTick, unit.id);
    return unit;
  }

  it('bez zadržaných jednotiek nemá žiadny modul `held` a index je prázdny', () => {
    const app = logisticsApp();
    expect(app.world.holdIndex.size).toBe(0);
    expect(heldByModule(app.world).size).toBe(0);
    for (const vm of moduleVMs(app.world)) expect(vm).not.toHaveProperty('held');
  });

  it('sklad: počet zadržaných jednotiek (nezadržané sa nepočítajú); berth: sloty apronu vzostupne', () => {
    const app = logisticsApp();
    holdUnit(app, toStorageChain(YARD_ID, 0));
    const free = createExportUnit(app.world, addRoundtripOffer(app.world).exportContract);
    moveChain(app.world, free.id, toStorageChain(YARD_ID, 1)); // v sklade, ale bez hold
    holdUnit(app, [
      { kind: 'in_vehicle', vehicleId: 9003 as EntityId },
      { kind: 'on_apron', berthId: ROOT_BERTH, slot: 3 },
    ]);
    holdUnit(app, [
      { kind: 'in_vehicle', vehicleId: 9003 as EntityId },
      { kind: 'on_apron', berthId: ROOT_BERTH, slot: 1 },
    ]);
    holdUnit(app, []); // ostáva v kamióne (miesto vzniku exportu): žiadny modul ho nenesie
    expect(app.world.holdIndex.size).toBe(4);

    const byId = new Map<number, ModuleVM>(moduleVMs(app.world).map((vm) => [vm.id, vm]));
    expect(byId.get(YARD_ID)?.held).toEqual({ count: 1 });
    expect(byId.get(ROOT_BERTH)?.held).toEqual({ count: 2, slots: [1, 3] });
    expect(byId.get(CHAIN_GATE_ID)).not.toHaveProperty('held');
    expect(byId.get(CHAIN_GATE_OUT_ID)).not.toHaveProperty('held');
  });

  it('VM modulov sa prepočíta len pri zmene revízie: VgmHoldStarted / VgmHoldReleased ju zvyšujú, stav pole `held` v snapshote', () => {
    const app = logisticsApp();
    app.bridge.publish([]);
    const yard = () => app.bridge.snapshot().modules.find((vm) => vm.id === YARD_ID);
    expect(yard()).not.toHaveProperty('held');

    const unit = holdUnit(app, toStorageChain(YARD_ID, 0), 700);
    const stale = app.bridge.snapshot().modules;
    expect(stale.find((vm) => vm.id === YARD_ID)).not.toHaveProperty('held'); // bez udalosti ostáva cache
    app.bridge.publish([{ type: 'VgmHoldStarted', contractId: unit.contractId as never, unitId: unit.id, untilTick: 700 }]);
    expect(app.bridge.snapshot().modules).not.toBe(stale);
    expect(yard()?.held).toEqual({ count: 1 });

    app.world.cargo.setHold(unit.id, null);
    app.world.holdIndex.remove(unit.id);
    app.bridge.publish([{ type: 'VgmHoldReleased', contractId: unit.contractId as never, unitId: unit.id }]);
    expect(yard()).not.toHaveProperty('held');
  });

  it('EntitiesVMBuilder: bez zmeny revízie vráti tú istú referenciu modulov aj pri zadržaných jednotkách', () => {
    const app = logisticsApp();
    holdUnit(app, toStorageChain(YARD_ID, 0));
    const builder = new EntitiesVMBuilder();
    const first = builder.build(app.world, 1);
    expect(first.modules.find((vm) => vm.id === YARD_ID)?.held).toEqual({ count: 1 });
    expect(builder.build(app.world, 1).modules).toBe(first.modules);
  });
});

describe('scenár export_inbound: kamióny s exportom a VGM hold v skutočnom sime', () => {
  const app = createScenarioApp();
  const problems: string[] = [];
  const seen = { atTp: 0, deliveryLoaded: 0, deliveryEmpty: 0, heldSamples: 0, heldStorage: 0, maxHeld: 0 };

  const check = (condition: boolean, message: string): void => {
    if (!condition) problems.push(`tick ${String(app.world.clock.tick)}: ${message}`);
  };
  const ARRIVING = ['to_gate', 'gate_queue', 'gate_pass', 'to_holding', 'holding', 'to_tp'];
  const LEAVING = ['to_gate_out', 'gate_queue_out', 'gate_pass_out', 'to_portal'];

  function sampleTrucks(): void {
    for (const vm of app.bridge.snapshot().trucks) {
      const truck = app.world.trucks.get(vm.id as EntityId);
      if (truck === undefined) {
        check(false, 'kamión chýba');
        continue;
      }
      if (vm.state === 'at_tp' || vm.state === 'at_edge_tp') seen.atTp += 1;
      if (truck.mission === 'delivery' && ARRIVING.includes(vm.state)) {
        check(vm.loaded, `delivery kamión #${String(vm.id)} v stave ${vm.state} má byť naložený`);
        seen.deliveryLoaded += 1;
      } else if (truck.mission === 'delivery' && LEAVING.includes(vm.state)) {
        check(!vm.loaded, `delivery kamión #${String(vm.id)} v stave ${vm.state} má byť prázdny`);
        seen.deliveryEmpty += 1;
      }
    }
  }

  function sampleHold(): void {
    const held = app.bridge.snapshot().modules.filter((vm) => vm.held !== undefined);
    const total = held.reduce((sum, vm) => sum + (vm.held?.count ?? 0), 0);
    if (app.world.holdIndex.size === 0) check(held.length === 0, 'bez zadržaných jednotiek nemá žiadny modul held');
    check(total <= app.world.holdIndex.size, 'súčet held.count presahuje index zadržaných jednotiek');
    seen.maxHeld = Math.max(seen.maxHeld, app.world.holdIndex.size);
    if (held.length > 0) seen.heldSamples += 1;
    for (const vm of held) if (vm.storage !== undefined) seen.heldStorage += 1;
  }

  beforeAll(() => {
    // Krok 10 tickov; do konca VGM hold.
    app.advanceTo(
      30_000,
      () => 10,
      () => {
        sampleTrucks();
        sampleHold();
      },
    );
  }, 120_000);

  it('exportný kamión: na TP dvora vykladá, delivery kamión je naložený na ceste k TP a prázdny po vyložení (loaded zo simu)', () => {
    expect(problems).toEqual([]);
    expect(seen.atTp).toBeGreaterThan(0);
    expect(seen.deliveryLoaded).toBeGreaterThan(0);
    expect(seen.deliveryEmpty).toBeGreaterThan(0);
  });

  it('VGM hold: jednotka zadržaná v sklade nesie odznak `held`, po uvoľnení odznak zmizne', () => {
    expect(seen.heldSamples).toBeGreaterThan(0);
    expect(seen.heldStorage).toBeGreaterThan(0);
    // dve jednotky bookingu #10 s chýbajúcim VGM (Rng); naraz zadržané najviac dve
    expect(seen.maxHeld).toBeGreaterThanOrEqual(1);
    expect(seen.maxHeld).toBeLessThanOrEqual(2);
    expect(app.world.holdIndex.size).toBe(0);
    expect(app.bridge.snapshot().modules.filter((vm) => vm.held !== undefined)).toEqual([]);
  });
});
