// T04-08: snapshot modulov F4 — `gate`, `waitingArea` a `ramp` vo view-modeloch modulov (tvary z T04-06), plnené len pre
// moduly daného druhu; prevádzkovosť rampy sa premietne cez `RampOperationalChanged` (revision), stav brány a stojiska
// sa skladá pri každom snapshote (mení sa aj bez udalosti).
import { describe, expect, it } from 'vitest';
import type { ModuleVM } from '@render/view-models';
import type { EntityId } from '@sim/core';
import { LoadingRamp, TruckGate, WaitingArea } from '@sim/modules';
import { EntitiesVMBuilder, isLiveModule, moduleVMs } from '@app/entities-vm';
import { AREA_ID, GATE_ID, RAMP_ID, buildLandside, createApp, runCommands, type App } from './app-fixtures';

const ROOT_BERTH_ID = 1 as EntityId;
const TRUCK_A = 901 as EntityId;
const TRUCK_B = 902 as EntityId;

function vmOf(world: App['world'], id: EntityId): ModuleVM {
  const vm = moduleVMs(world).find((candidate) => candidate.id === id);
  if (vm === undefined) throw new Error(`VM modulu #${String(id)} chýba`);
  return vm;
}

function landsideApp(): App {
  const app = createApp();
  buildLandside(app);
  return app;
}

const gateOf = (app: App): TruckGate => app.world.modules.get(GATE_ID) as TruckGate;
const areaOf = (app: App): WaitingArea => app.world.modules.get(AREA_ID) as WaitingArea;
const rampOf = (app: App): LoadingRamp => app.world.modules.get(RAMP_ID) as LoadingRamp;

/** Jednotka priamo na docku rampy (ledger: reťaz prechodov §7.1 s fiktívnymi držiteľmi; svet sa netikuje). */
function stage(app: App, dock: number): void {
  const { world } = app;
  const ramp = rampOf(app);
  const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as EntityId }).id;
  world.cargo.move(unit, { kind: 'in_crane', craneId: 901 as EntityId });
  world.cargo.move(unit, { kind: 'on_apron', berthId: ROOT_BERTH_ID, slot: 0 });
  world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
  ramp.reserve(dock);
  world.cargo.move(unit, { kind: 'at_ramp', rampId: ramp.id, dock });
  ramp.commit(dock, unit);
}

describe('ModuleVM.gate', () => {
  it('prázdna pripojená brána: fronta 0, závora zatvorená, vstupný konektor podľa strany určenej svetom', () => {
    const app = landsideApp();
    const gate = gateOf(app);
    // Brána (45, 32) rot 270: vstup zo západu na (45, 33) = konektor 0 v defe (sever pri rot 0), výstup na východ = 1.
    expect(gate.entrySide).toMatchObject({ x: 45, y: 33, side: 'w' });
    expect(vmOf(app.world, GATE_ID).gate).toEqual({ queueLength: 0, open: false, entryConnector: 0 });
  });

  it('entryConnector je index konektora v defe, ktorý sedí s entrySide (nie vždy 0)', () => {
    const app = createApp();
    // Brána (44, 32) rot 0: južný konektor (index 1) sa napája na verejnú cestu x = 44 od portálu → je vstupný.
    runCommands(app, [{ type: 'PlaceModule', defId: 'truck_gate', x: 44, y: 32, rotation: 0 }]);
    const gate = app.world.modules.get(GATE_ID) as TruckGate;
    expect(gate.entrySide).toMatchObject({ x: 44, y: 33, side: 's' });
    expect(vmOf(app.world, GATE_ID).gate?.entryConnector).toBe(1);
  });

  it('brána, ktorej strany svet neurčil (bez ciest), má entryConnector 0', () => {
    const app = createApp();
    buildLandside(app, { roads: false, parts: ['gate'] });
    expect(gateOf(app).entrySide).toBeNull();
    expect(vmOf(app.world, GATE_ID).gate).toEqual({ queueLength: 0, open: false, entryConnector: 0 });
  });

  it('fronta a otvorená závora idú z modulu brány (queueLength, isOpen)', () => {
    const app = landsideApp();
    const gate = gateOf(app);
    gate.enqueue(TRUCK_A);
    gate.enqueue(TRUCK_B);
    expect(vmOf(app.world, GATE_ID).gate).toMatchObject({ queueLength: 2, open: false });
    gate.dequeue();
    gate.beginPass(gate.params.processTicks);
    expect(vmOf(app.world, GATE_ID).gate).toMatchObject({ queueLength: 1, open: true });
  });
});

describe('ModuleVM.waitingArea', () => {
  it('prázdne stojisko: 6 stojísk, nikde obsadené', () => {
    const app = landsideApp();
    expect(vmOf(app.world, AREA_ID).waitingArea).toEqual({ bays: 6, occupied: [false, false, false, false, false, false] });
  });

  it('rezervovaný aj obsadený bay je „obsadený“; uvoľnený je voľný; poradie polí = poradie stojísk', () => {
    const app = landsideApp();
    const area = areaOf(app);
    area.reserveBay(TRUCK_A); // bay 0 rezervovaný
    area.reserveBay(TRUCK_B); // bay 1
    area.occupyBay(TRUCK_B); // bay 1 obsadený
    expect(vmOf(app.world, AREA_ID).waitingArea?.occupied).toEqual([true, true, false, false, false, false]);
    area.releaseBay(TRUCK_A);
    expect(vmOf(app.world, AREA_ID).waitingArea?.occupied).toEqual([false, true, false, false, false, false]);
  });
});

describe('ModuleVM.ramp', () => {
  it('prázdna prevádzková rampa: 2 docky bez jednotiek, operational true', () => {
    const app = landsideApp();
    expect(vmOf(app.world, RAMP_ID).ramp).toEqual({ docks: 2, staged: [0, 0], operational: true });
  });

  it('staged[i] = jednotky na docku i podľa ledgera', () => {
    const app = landsideApp();
    stage(app, 1);
    stage(app, 1);
    stage(app, 0);
    expect(vmOf(app.world, RAMP_ID).ramp).toEqual({ docks: 2, staged: [1, 2], operational: true });
  });

  it('rampa bez brány a stojiska je neprevádzková', () => {
    const app = createApp();
    buildLandside(app, { parts: ['ramp'] });
    const ramp = moduleVMs(app.world).find((vm) => vm.defId === 'loading_ramp_container');
    expect(ramp?.ramp).toEqual({ docks: 2, staged: [0, 0], operational: false });
  });
});

describe('polia VM len pre moduly daného druhu', () => {
  it('brána nemá waitingArea ani ramp, stojisko nemá gate ani ramp, rampa nemá gate ani waitingArea; storage a apron tu nie sú', () => {
    const app = landsideApp();
    const gate = vmOf(app.world, GATE_ID);
    const area = vmOf(app.world, AREA_ID);
    const ramp = vmOf(app.world, RAMP_ID);
    expect([gate.waitingArea, gate.ramp, gate.storage, gate.apron]).toEqual([undefined, undefined, undefined, undefined]);
    expect([area.gate, area.ramp, area.storage, area.apron]).toEqual([undefined, undefined, undefined, undefined]);
    expect([ramp.gate, ramp.waitingArea, ramp.storage, ramp.apron]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('Root berth nesie apron a žiadne pozemné polia', () => {
    const app = landsideApp();
    const berth = vmOf(app.world, ROOT_BERTH_ID);
    expect(berth.apron).toBeDefined();
    expect([berth.gate, berth.waitingArea, berth.ramp]).toEqual([undefined, undefined, undefined]);
  });

  it('isLiveModule: len brána a stojisko (menia sa bez udalosti), nie rampa ani kotvisko', () => {
    const app = landsideApp();
    const { modules } = app.world;
    expect(isLiveModule(gateOf(app))).toBe(true);
    expect(isLiveModule(areaOf(app))).toBe(true);
    expect(isLiveModule(rampOf(app))).toBe(false);
    expect(isLiveModule(modules.get(ROOT_BERTH_ID) as TruckGate)).toBe(false);
  });
});

describe('EntitiesVMBuilder: živé pozemné moduly', () => {
  it('bez brány a stojiska je pole modulov pri rovnakej revision tá istá referencia (cache podľa revision)', () => {
    const app = createApp();
    const builder = new EntitiesVMBuilder();
    expect(builder.build(app.world, 0).modules).toBe(builder.build(app.world, 0).modules);
    buildLandside(app, { parts: ['ramp'] });
    expect(builder.build(app.world, 1).modules).toBe(builder.build(app.world, 1).modules);
  });

  it('s bránou sa VM brány a stojiska skladajú znova aj pri rovnakej revision, ostatné VM ostávajú tie isté objekty', () => {
    const app = landsideApp();
    const builder = new EntitiesVMBuilder();
    const first = builder.build(app.world, 5).modules;
    gateOf(app).enqueue(TRUCK_A);
    gateOf(app).beginPass(3);
    areaOf(app).reserveBay(TRUCK_B);
    const second = builder.build(app.world, 5).modules;
    expect(second).not.toBe(first);
    const byId = (modules: readonly ModuleVM[], id: EntityId): ModuleVM => modules.find((vm) => vm.id === id) as ModuleVM;
    expect(byId(first, GATE_ID).gate).toEqual({ queueLength: 0, open: false, entryConnector: 0 }); // stav pred zmenou
    expect(byId(second, GATE_ID).gate).toEqual({ queueLength: 1, open: true, entryConnector: 0 });
    expect(byId(second, AREA_ID).waitingArea?.occupied[0]).toBe(true);
    expect(byId(second, RAMP_ID)).toBe(byId(first, RAMP_ID));
    expect(byId(second, ROOT_BERTH_ID)).toBe(byId(first, ROOT_BERTH_ID));
    expect(second.map((vm) => vm.id)).toEqual(first.map((vm) => vm.id));
  });

  it('zmena revision prepočíta aj cachované VM (rampa: staged)', () => {
    const app = landsideApp();
    const builder = new EntitiesVMBuilder();
    const before = builder.build(app.world, 1).modules.find((vm) => vm.id === RAMP_ID);
    stage(app, 0);
    expect(builder.build(app.world, 1).modules.find((vm) => vm.id === RAMP_ID)).toBe(before); // rovnaká revision → cache
    expect(builder.build(app.world, 2).modules.find((vm) => vm.id === RAMP_ID)?.ramp?.staged).toEqual([1, 0]);
  });
});

describe('SimBridge: snapshot pozemných modulov', () => {
  it('rampa postavená pred bránou a stojiskom je neprevádzková; po ich dostavaní sa v snapshote prepne (RampOperationalChanged)', () => {
    const app = createApp();
    buildLandside(app, { parts: ['ramp'] });
    const rampVm = (): ModuleVM => app.bridge.snapshot().modules.find((vm) => vm.defId === 'loading_ramp_container') as ModuleVM;
    expect(rampVm().ramp?.operational).toBe(false);
    const revisionBefore = app.bridge.snapshot().revision;
    buildLandside(app, { roads: false, parts: ['gate', 'waiting_area'] });
    expect(app.bridge.snapshot().revision).toBeGreaterThan(revisionBefore);
    expect(rampVm().ramp).toEqual({ docks: 2, staged: [0, 0], operational: true });
  });

  it('entities() nesie rovnaké pozemné VM ako snapshot a dá sa serializovať', () => {
    const app = landsideApp();
    const { modules } = app.bridge.entities();
    expect(modules).toBe(app.bridge.snapshot().modules);
    const restored = JSON.parse(JSON.stringify(modules)) as ModuleVM[];
    expect(restored.find((vm) => vm.id === GATE_ID)?.gate).toEqual({ queueLength: 0, open: false, entryConnector: 0 });
    expect(restored.find((vm) => vm.id === AREA_ID)?.waitingArea?.bays).toBe(6);
  });
});
