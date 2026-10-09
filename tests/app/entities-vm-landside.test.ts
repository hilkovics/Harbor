// T04-08 / TR4-05 (R4): snapshot pozemných modulov — `gateLane` (pruh brány: smer, režim, strecha, krok), `tpCells` blokov skladu a `holdingSlots` odstavnej plochy.
// Živé polia sa menia aj bez udalosti, preto sa VM týchto modulov pri každom snapshote porovnáva so živým modulom a pole modulov je nové len pri zmene hodnôt.
// Rampa, čakacia plocha a `gate` zanikli (ADR-041).
import { describe, expect, it } from 'vitest';
import type { ModuleVM } from '@render/view-models';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { TruckGate, YardBlock } from '@sim/modules';
import { tpCellsOf } from '@sim/trucks';
import { EntitiesVMBuilder, isLiveModule, moduleVMs } from '@app/entities-vm';
import { CHAIN_GATE_ID, CHAIN_GATE_OUT_ID, YARD_ID, buildFullChain, createPortApp, frameUntil, runCommands, type App } from './app-fixtures';

const ROOT_BERTH_ID = 1 as EntityId;

function vmOf(world: App['world'], id: EntityId): ModuleVM {
  const vm = moduleVMs(world).find((candidate) => candidate.id === id);
  if (vm === undefined) throw new Error(`VM modulu #${String(id)} chýba`);
  return vm;
}

function landsideApp(units = 0, vehicles = 0): App {
  const app = createPortApp();
  buildFullChain(app, { units, vehicles });
  return app;
}

const gateOf = (app: App, id: EntityId = CHAIN_GATE_ID): TruckGate => app.world.modules.get(id) as TruckGate;

describe('ModuleVM.gateLane', () => {
  it('voľný vstupný pruh: smer in, režim standard, samostatná strecha, bez kroku', () => {
    const app = landsideApp();
    expect(vmOf(app.world, CHAIN_GATE_ID).gateLane).toEqual({ kind: 'in', mode: 'standard', roofPart: 'single' });
    expect(vmOf(app.world, CHAIN_GATE_OUT_ID).gateLane?.kind).toBe('out');
  });

  it('pruh, ktorý spracúva kamión, nesie krok a jeho priebeh z `currentStep()`', () => {
    const app = landsideApp();
    const gate = gateOf(app);
    gate.enqueue(901 as EntityId);
    gate.beginPass([{ id: 'ocr', ticks: 4 }]);
    const step = gate.currentStep();
    expect(step?.id).toBe('ocr');
    expect(vmOf(app.world, CHAIN_GATE_ID).gateLane).toMatchObject({ step: 'ocr', progress: step?.progress });
  });

  it('režim pruhu ide z modulu (`setMode`)', () => {
    const app = landsideApp();
    gateOf(app).setMode('express');
    expect(vmOf(app.world, CHAIN_GATE_ID).gateLane?.mode).toBe('express');
  });

  it('susedné pruhy tvoria jednu strechu: left, mid, right', () => {
    const app = createPortApp();
    runCommands(app, [0, 1, 2].map((dx) => ({ type: 'PlaceModule', defId: 'gate_in_lane', x: 52 + dx, y: 20, rotation: 0 })));
    const lanes = moduleVMs(app.world).filter((vm) => vm.gateLane !== undefined);
    expect(lanes.map((vm) => vm.gateLane?.roofPart)).toEqual(['left', 'mid', 'right']);
  });
});

describe('ModuleVM.tpCells a holdingSlots', () => {
  it('blok skladu nesie TP z `tpCellsOf` v bunkách sveta, bez kamiónov nie sú obsadené', () => {
    const app = landsideApp();
    const yard = app.world.modules.get(YARD_ID) as YardBlock;
    const cells = tpCellsOf(app.world, yard);
    const vm = vmOf(app.world, YARD_ID);
    expect(cells.length).toBeGreaterThan(0);
    expect(vm.tpCells?.map((cell) => cell.y * app.world.grid.width + cell.x)).toEqual([...cells]);
    expect(vm.tpCells?.every((cell) => !cell.busy)).toBe(true);
  });

  it('TP je obsadené len vtedy, keď ho drží kamión na TP (`at_tp` / `at_edge_tp`)', () => {
    const app = landsideApp(6, 3);
    const { world } = app;
    let busySeen = 0;
    frameUntil(
      app,
      () => {
        const expected = new Set<number>();
        for (const truck of world.trucks.values()) if (truck.tpCell !== null && (truck.state === 'at_tp' || truck.state === 'at_edge_tp')) expected.add(truck.tpCell);
        for (const vm of app.bridge.snapshot().modules) {
          for (const cell of vm.tpCells ?? []) {
            if (!cell.busy) continue;
            busySeen += 1;
            expect(expected.has(cell.y * world.grid.width + cell.x)).toBe(true);
          }
        }
        return world.cargo.exportedCount === 6;
      },
      6000,
    );
    expect(busySeen).toBeGreaterThan(0);
  });

  it('odstavná plocha nesie šesť státí vo svete; prázdna nemá obsadené', () => {
    const app = createPortApp();
    // prvé miesto, kde mapa dovolí odstavnú plochu (6 × 5 na pevnine)
    const spots = Array.from({ length: 60 }, (_, i) => ({ x: 30 + (i % 10) * 7, y: 20 + Math.floor(i / 10) * 6 }));
    const spot = spots.find(({ x, y }) => app.bridge.validate(commandFromJSON({ type: 'PlaceModule', defId: 'truck_holding', x, y, rotation: 0 })).ok);
    if (spot === undefined) throw new Error('odstavná plocha sa nedá nikam postaviť');
    runCommands(app, [{ type: 'PlaceModule', defId: 'truck_holding', ...spot, rotation: 0 }]);
    const holding = moduleVMs(app.world).find((vm) => vm.holdingSlots !== undefined);
    expect(holding?.holdingSlots).toHaveLength(6);
    expect(holding?.holdingSlots?.every((slot) => !slot.occupied)).toBe(true);
  });
});

describe('polia VM len pre moduly daného druhu', () => {
  it('pruh brány nemá storage ani apron; storage a apron tu nie sú', () => {
    const app = landsideApp();
    const gate = vmOf(app.world, CHAIN_GATE_ID);
    expect([gate.storage, gate.apron, gate.tpCells]).toEqual([undefined, undefined, undefined]);
  });

  it('Root berth nesie apron a žiadne pozemné polia', () => {
    const app = landsideApp();
    const berth = vmOf(app.world, ROOT_BERTH_ID);
    expect(berth.apron).toBeDefined();
    expect([berth.gateLane, berth.tpCells, berth.holdingSlots]).toEqual([undefined, undefined, undefined]);
  });

  it('isLiveModule: pruhy brány a bloky skladu (menia sa bez udalosti), nie kotvisko', () => {
    const app = landsideApp();
    expect(isLiveModule(gateOf(app))).toBe(true);
    expect(isLiveModule(gateOf(app, CHAIN_GATE_OUT_ID))).toBe(true);
    expect(isLiveModule(app.world.modules.get(YARD_ID) as YardBlock)).toBe(true);
    expect(isLiveModule(app.world.modules.get(ROOT_BERTH_ID) as TruckGate)).toBe(false);
  });
});

describe('EntitiesVMBuilder: živé pozemné moduly', () => {
  it('bez zmeny hodnôt ostáva pole modulov pri rovnakej revision tá istá referencia', () => {
    const app = landsideApp();
    const builder = new EntitiesVMBuilder();
    const first = builder.build(app.world, 5).modules;
    expect(builder.build(app.world, 5).modules).toBe(first);
  });

  it('zmena hodnôt pruhu pri rovnakej revision nahradí pole modulov, ostatné VM ostávajú tie isté objekty', () => {
    const app = landsideApp();
    const builder = new EntitiesVMBuilder();
    const first = builder.build(app.world, 5).modules;
    gateOf(app).enqueue(901 as EntityId);
    gateOf(app).beginPass([{ id: 'ocr', ticks: 3 }]);
    const second = builder.build(app.world, 5).modules;
    expect(second).not.toBe(first);
    const byId = (modules: readonly ModuleVM[], id: EntityId): ModuleVM => modules.find((vm) => vm.id === id) as ModuleVM;
    expect(byId(first, CHAIN_GATE_ID).gateLane?.step).toBeUndefined();
    expect(byId(second, CHAIN_GATE_ID).gateLane?.step).toBe('ocr');
    expect(byId(second, ROOT_BERTH_ID)).toBe(byId(first, ROOT_BERTH_ID));
    expect(second.map((vm) => vm.id)).toEqual(first.map((vm) => vm.id));
    expect(builder.build(app.world, 5).modules).toBe(second); // a znova stabilné
  });

  it('obnova živého bloku zachová jeho stohy (mení sa len `tpCells`)', () => {
    const app = landsideApp();
    const builder = new EntitiesVMBuilder();
    const first = builder.build(app.world, 5).modules.find((vm) => vm.id === YARD_ID);
    expect(first?.stacks).toBeDefined();
    expect(builder.build(app.world, 5).modules.find((vm) => vm.id === YARD_ID)?.stacks).toBe(first?.stacks);
  });
});

describe('SimBridge: snapshot pozemných modulov', () => {
  it('entities() nesie rovnaké pozemné VM ako snapshot a dá sa serializovať', () => {
    const app = landsideApp();
    const { modules } = app.bridge.entities();
    expect(modules).toBe(app.bridge.snapshot().modules);
    const restored = JSON.parse(JSON.stringify(modules)) as ModuleVM[];
    expect(restored.find((vm) => vm.id === CHAIN_GATE_ID)?.gateLane).toEqual({ kind: 'in', mode: 'standard', roofPart: 'single' });
  });
});
