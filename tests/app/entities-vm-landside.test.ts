// T04-08 (R4, TR4-02): snapshot modulov pozemnej časti — `gate` vo view-modeloch modulov, plnené len pre brány; VM brány sa pri každom snapshote porovnáva
// so živým modulom (môže sa zmeniť aj bez udalosti) a pole modulov je nové len pri zmene. Rampa a čakacia plocha zanikli (ADR-041).
import { describe, expect, it } from 'vitest';
import type { ModuleVM } from '@render/view-models';
import type { EntityId } from '@sim/core';
import { TruckGate } from '@sim/modules';
import { EntitiesVMBuilder, isLiveModule, moduleVMs } from '@app/entities-vm';
import { CHAIN_GATE_ID, CHAIN_GATE_OUT_ID, buildFullChain, createPortApp, runCommands, type App } from './app-fixtures';

const ROOT_BERTH_ID = 1 as EntityId;
const TRUCK_A = 901 as EntityId;
const TRUCK_B = 902 as EntityId;

function vmOf(world: App['world'], id: EntityId): ModuleVM {
  const vm = moduleVMs(world).find((candidate) => candidate.id === id);
  if (vm === undefined) throw new Error(`VM modulu #${String(id)} chýba`);
  return vm;
}

function landsideApp(): App {
  const app = createPortApp();
  buildFullChain(app, { units: 0, vehicles: 0 });
  return app;
}

const gateOf = (app: App, id: EntityId = CHAIN_GATE_ID): TruckGate => app.world.modules.get(id) as TruckGate;

describe('ModuleVM.gate', () => {
  it('prázdna pripojená brána: fronta 0, závora zatvorená, vstupný konektor podľa strany určenej svetom', () => {
    const app = landsideApp();
    const gate = gateOf(app);
    // Vstupný pruh (44, 30) rot 0 (1×4): vstup z juhu na (44, 33) = konektor 0, výstup na sever = 1.
    expect(gate.entrySide).toMatchObject({ x: 44, y: 33, side: 's' });
    expect(vmOf(app.world, CHAIN_GATE_ID).gate).toEqual({ queueLength: 0, open: false, entryConnector: 0 });
  });

  it('entryConnector je index konektora v defe, ktorý sedí s entrySide; pruh je jednosmerný, takže vstupom je vždy konektor 0', () => {
    const app = landsideApp();
    const gate = gateOf(app);
    expect(gate.connectors.indexOf(gate.entrySide as never)).toBe(0);
    expect(vmOf(app.world, CHAIN_GATE_ID).gate?.entryConnector).toBe(0);
  });

  it('brána, ktorej strany svet neurčil (bez ciest), má entryConnector 0', () => {
    const app = createPortApp();
    runCommands(app, [{ type: 'PlaceModule', defId: 'gate_in_lane', x: 52, y: 20, rotation: 0 }]);
    const gate = [...app.world.modules.values()].find((module): module is TruckGate => module instanceof TruckGate);
    expect(gate?.entrySide).toBeNull();
    expect(moduleVMs(app.world).find((vm) => vm.id === gate?.id)?.gate).toEqual({ queueLength: 0, open: false, entryConnector: 0 });
  });

  it('fronta a otvorená závora idú z modulu brány (queueLength, isOpen)', () => {
    const app = landsideApp();
    const gate = gateOf(app);
    gate.enqueue(TRUCK_A);
    gate.enqueue(TRUCK_B);
    expect(vmOf(app.world, CHAIN_GATE_ID).gate).toMatchObject({ queueLength: 2, open: false });
    gate.dequeue();
    gate.beginPass([{ id: 'ocr', ticks: gate.planTicks(gate.planFor('standard', false)) }]);
    expect(vmOf(app.world, CHAIN_GATE_ID).gate).toMatchObject({ queueLength: 1, open: true });
  });
});

describe('polia VM len pre moduly daného druhu', () => {
  it('brána nemá storage ani apron; storage a apron tu nie sú', () => {
    const app = landsideApp();
    const gate = vmOf(app.world, CHAIN_GATE_ID);
    expect([gate.storage, gate.apron]).toEqual([undefined, undefined]);
  });

  it('Root berth nesie apron a žiadne pozemné polia', () => {
    const app = landsideApp();
    const berth = vmOf(app.world, ROOT_BERTH_ID);
    expect(berth.apron).toBeDefined();
    expect(berth.gate).toBeUndefined();
  });

  it('isLiveModule: len brána (mení sa bez udalosti), nie kotvisko', () => {
    const app = landsideApp();
    expect(isLiveModule(gateOf(app))).toBe(true);
    expect(isLiveModule(gateOf(app, CHAIN_GATE_OUT_ID))).toBe(true);
    expect(isLiveModule(app.world.modules.get(ROOT_BERTH_ID) as TruckGate)).toBe(false);
  });
});

describe('EntitiesVMBuilder: živé pozemné moduly', () => {
  it('bez brány je pole modulov pri rovnakej revision tá istá referencia (cache podľa revision)', () => {
    const app = createPortApp();
    const builder = new EntitiesVMBuilder();
    expect(builder.build(app.world, 0).modules).toBe(builder.build(app.world, 0).modules);
  });

  it('bez zmeny hodnôt ostáva pole modulov s bránou pri rovnakej revision tá istá referencia (aj VM brány)', () => {
    const app = landsideApp();
    const builder = new EntitiesVMBuilder();
    const first = builder.build(app.world, 5).modules;
    expect(builder.build(app.world, 5).modules).toBe(first);
    gateOf(app).enqueue(TRUCK_A); // zmena hodnoty → nové pole
    const second = builder.build(app.world, 5).modules;
    expect(second).not.toBe(first);
    expect(builder.build(app.world, 5).modules).toBe(second); // a znova stabilné
    expect(second.find((vm) => vm.id === CHAIN_GATE_ID)?.gate?.queueLength).toBe(1);
    expect(second.find((vm) => vm.id === ROOT_BERTH_ID)).toBe(first.find((vm) => vm.id === ROOT_BERTH_ID)); // ostatné VM sa nezmenili
  });

  it('zmena hodnôt brány pri rovnakej revision nahradí pole modulov, ostatné VM ostávajú tie isté objekty', () => {
    const app = landsideApp();
    const builder = new EntitiesVMBuilder();
    const first = builder.build(app.world, 5).modules;
    gateOf(app).enqueue(TRUCK_A);
    gateOf(app).beginPass([{ id: 'ocr', ticks: 3 }]);
    const second = builder.build(app.world, 5).modules;
    expect(second).not.toBe(first);
    const byId = (modules: readonly ModuleVM[], id: EntityId): ModuleVM => modules.find((vm) => vm.id === id) as ModuleVM;
    expect(byId(first, CHAIN_GATE_ID).gate).toEqual({ queueLength: 0, open: false, entryConnector: 0 }); // stav pred zmenou
    expect(byId(second, CHAIN_GATE_ID).gate).toEqual({ queueLength: 1, open: true, entryConnector: 0 });
    expect(byId(second, ROOT_BERTH_ID)).toBe(byId(first, ROOT_BERTH_ID));
    expect(second.map((vm) => vm.id)).toEqual(first.map((vm) => vm.id));
  });
});

describe('SimBridge: snapshot pozemných modulov', () => {
  it('entities() nesie rovnaké pozemné VM ako snapshot a dá sa serializovať', () => {
    const app = landsideApp();
    const { modules } = app.bridge.entities();
    expect(modules).toBe(app.bridge.snapshot().modules);
    const restored = JSON.parse(JSON.stringify(modules)) as ModuleVM[];
    expect(restored.find((vm) => vm.id === CHAIN_GATE_ID)?.gate).toEqual({ queueLength: 0, open: false, entryConnector: 0 });
  });
});
