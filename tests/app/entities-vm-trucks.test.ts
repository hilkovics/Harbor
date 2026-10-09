// T04-08 B (R4, TR4-02): TruckVM zo simu — mapovanie stavu a nákladu, póza v strede brány (`gate_pass`, `gate_pass_out`) a prev pri skoku do/z brány. Kamióny vznikajú skutočným
// tickom celého reťazca (loď → dvory → kamión na TP dvora → brána → export, `buildFullChain`), nie fiktívnymi id; rampa a čakacia plocha zanikli (ADR-041).
import { describe, expect, it } from 'vitest';
import type { TruckVM } from '@render/view-models';
import type { EntityId } from '@sim/core';
import type { Module } from '@sim/modules';
import { Truck } from '@sim/trucks';
import { entitiesVM, truckPose, truckVMs, type TruckPoses } from '@app/entities-vm';
import { buildFullChain, createApp, createPortApp, frameUntil, type App } from './app-fixtures';

const UNITS = 6;

function chainApp(units = UNITS): App {
  const app = createPortApp();
  buildFullChain(app, { units });
  return app;
}

/** Prvý kamión vo svete v stave `state` (po posune hry po framoch). */
function truckInState(app: App, state: string): Truck {
  frameUntil(app, () => [...app.world.trucks.values()].some((truck) => truck.state === state), 3000);
  return [...app.world.trucks.values()].find((truck) => truck.state === state) as Truck;
}

describe('TruckVM: prázdny svet', () => {
  it('bez kamiónov je pole prázdne (snapshot, entities() aj čistá funkcia)', () => {
    const app = createApp();
    expect(app.bridge.snapshot().trucks).toEqual([]);
    expect(app.bridge.entities().trucks).toBe(app.bridge.snapshot().trucks);
    expect(truckVMs(app.world)).toEqual([]);
    expect(entitiesVM(app.world).trucks).toEqual([]);
  });
});

describe('TruckVM: nový kamión zo simu', () => {
  it('prvý kamión po spawne na portáli: to_gate, prázdny, prev = curr, def z trucks.json, polia zodpovedajú simu', () => {
    const app = chainApp();
    const first = truckInState(app, 'to_gate');
    const vm = app.bridge.snapshot().trucks.find((truck) => truck.id === first.id) as TruckVM;
    expect(vm).toEqual<TruckVM>({
      id: first.id,
      defId: 'truck_container',
      x: first.x,
      y: first.y,
      prevX: first.x,
      prevY: first.y,
      heading: first.heading,
      prevHeading: first.heading,
      loaded: false,
      state: 'to_gate',
      body: first.body.map((slot) => ({ x: ((slot >> 1) % app.world.grid.width) + 0.5, y: Math.floor((slot >> 1) / app.world.grid.width) + 0.5 })),
      lengthCells: 3,
      offRoad: false,
      blocked: false,
      jammed: false,
    });
    expect(app.world.defs.trucks.get(vm.defId).id).toBe('truck_container');
  });

  it('kamióny sú vzostupne podľa id (ako world.trucks) a snapshot ich nesie aj v entities()', () => {
    const app = chainApp(12);
    frameUntil(app, () => app.world.trucks.size >= 2, 3000);
    const ids = app.bridge.snapshot().trucks.map((truck) => truck.id);
    expect(ids).toEqual([...app.world.trucks.keys()]);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(app.bridge.entities().trucks).toBe(app.bridge.snapshot().trucks);
  });

  it('je serializovateľné (window.__sim.entities() z Playwrightu)', () => {
    const app = chainApp();
    truckInState(app, 'to_tp');
    const entities = app.bridge.entities();
    expect(entities.trucks.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(entities))).toEqual(entities);
  });
});

describe('TruckVM: celý beh reťazca, každý frame', () => {
  it('stav, náklad a poloha zodpovedajú simu; v prechode bránou stojí v strede brány; inak sim póza', () => {
    const app = chainApp();
    const { world, bridge } = app;
    const seenStates = new Set<string>();
    const seenLoaded = new Set<boolean>();
    frameUntil(
      app,
      () => {
        for (const vm of bridge.snapshot().trucks) {
          const truck = world.trucks.get(vm.id as EntityId) as Truck;
          seenStates.add(vm.state);
          seenLoaded.add(vm.loaded);
          expect(vm.state).toBe(truck.state);
          expect(vm.defId).toBe(truck.defId);
          expect(vm.loaded).toBe(world.cargo.countAt('in_truck', truck.id) > 0);
          if (truck.state === 'gate_pass' || truck.state === 'gate_pass_out') {
            const gate = world.modules.get(truck.state === 'gate_pass' ? truck.gateId : (truck.gateOutId as EntityId)) as Module;
            expect([vm.x, vm.y, vm.heading]).toEqual([gate.origin.x + gate.size.w / 2, gate.origin.y + gate.size.h / 2, gate.rotation]);
          } else {
            expect([vm.x, vm.y, vm.heading]).toEqual([truck.x, truck.y, truck.heading]);
          }
        }
        return world.cargo.exportedCount === UNITS;
      },
      6000,
    );
    expect(seenLoaded).toEqual(new Set([true, false]));
    expect([...seenStates]).toEqual(expect.arrayContaining(['to_gate', 'gate_pass', 'to_tp', 'at_edge_tp', 'to_gate_out', 'gate_pass_out', 'to_portal']));
    expect(world.trucks.size).toBe(0);
    expect(bridge.snapshot().trucks).toEqual([]);
  });
});

describe('TruckVM: prev (interpolácia) v SimBridge', () => {
  it('prev je póza pred posledným tickom; pri zmene stavu z/do prechodu bránou (skok do stredu brány) je prev = curr', () => {
    const app = chainApp();
    const { world, bridge } = app;
    let before = new Map<number, TruckVM>();
    const jumps = { intoGate: 0, outOfGate: 0 };
    let continued = 0;
    for (let i = 0; i < 6000 && world.cargo.exportedCount < UNITS; i += 1) {
      app.loop.frame(app.loop.tickMs);
      const now = bridge.snapshot().trucks;
      for (const vm of now) {
        const last = before.get(vm.id);
        if (last === undefined) {
          expect([vm.prevX, vm.prevY, vm.prevHeading]).toEqual([vm.x, vm.y, vm.heading]); // nový kamión
          continue;
        }
        const slotSwitch = last.state !== vm.state && ['gate_pass', 'gate_pass_out', 'pre_gate', 'holding'].some((state) => state === last.state || state === vm.state);
        if (slotSwitch) {
          expect([vm.prevX, vm.prevY, vm.prevHeading]).toEqual([vm.x, vm.y, vm.heading]);
          if (vm.state === 'gate_pass' || vm.state === 'gate_pass_out') jumps.intoGate += 1;
          if (last.state === 'gate_pass' || last.state === 'gate_pass_out') jumps.outOfGate += 1;
        } else {
          expect([vm.prevX, vm.prevY, vm.prevHeading]).toEqual([last.x, last.y, last.heading]);
          continued += 1;
        }
      }
      before = new Map(now.map((vm) => [vm.id, vm] as const));
    }
    expect(jumps.intoGate).toBeGreaterThan(0);
    expect(jumps.outOfGate).toBeGreaterThan(0);
    expect(continued).toBeGreaterThan(100);
  });

  it('pauza: kamión tesne po spawne nemá predchodcu (prev = curr); po obnove sa rozbehne z miesta spawnu', () => {
    const app = chainApp();
    const truck = truckInState(app, 'to_gate');
    const spawn = { x: truck.x, y: truck.y };
    app.world.clock.setSpeed(0);
    app.loop.frame(1000);
    app.loop.frame(1000);
    for (const vm of app.bridge.snapshot().trucks) {
      expect([vm.prevX, vm.prevY, vm.prevHeading]).toEqual([vm.x, vm.y, vm.heading]);
    }
    app.world.clock.setSpeed(1);
    app.loop.frame(app.loop.tickMs);
    const running = app.bridge.snapshot().trucks.find((vm) => vm.id === truck.id) as TruckVM;
    expect([running.prevX, running.prevY]).toEqual([spawn.x, spawn.y]);
    expect(Math.hypot(running.x - spawn.x, running.y - spawn.y)).toBeCloseTo(app.world.defs.trucks.get('truck_container').speedCellsPerTick, 5);
  });
});

describe('truckVMs: predchádzajúce pózy ako vstup', () => {
  const far = { x: 3, y: 4, heading: 90 } as const;

  it('bez záznamu (nový kamión) je prev = curr', () => {
    const app = chainApp();
    const truck = truckInState(app, 'to_tp');
    const [vm] = truckVMs(app.world).filter((candidate) => candidate.id === truck.id);
    expect([vm?.prevX, vm?.prevY, vm?.prevHeading]).toEqual([vm?.x, vm?.y, vm?.heading]);
  });

  it('zmena stavu to_gate → gate_pass: prev = curr (kamión sa neinterpoluje z cesty do stredu brány)', () => {
    const app = chainApp();
    const truck = truckInState(app, 'gate_pass');
    const prev: TruckPoses = new Map([[truck.id, { ...far, state: 'gate_queue' }]]);
    const vm = truckVMs(app.world, prev).find((candidate) => candidate.id === truck.id) as TruckVM;
    expect([vm.prevX, vm.prevY, vm.prevHeading]).toEqual([vm.x, vm.y, vm.heading]);
  });

  it('bez zmeny stavu (gate_pass → gate_pass) sa použije zapamätaná póza', () => {
    const app = chainApp();
    const truck = truckInState(app, 'gate_pass');
    const prev: TruckPoses = new Map([[truck.id, { ...far, state: 'gate_pass' }]]);
    const vm = truckVMs(app.world, prev).find((candidate) => candidate.id === truck.id) as TruckVM;
    expect([vm.prevX, vm.prevY, vm.prevHeading]).toEqual([far.x, far.y, far.heading]);
  });

  it('zmena stavu gate_pass → to_tp (odchod z brány): prev = curr; jazda medzi cestnými stavmi (to_gate → gate_queue) interpoluje', () => {
    const app = chainApp();
    const leaving = truckInState(app, 'to_tp');
    const outOfGate: TruckPoses = new Map([[leaving.id, { ...far, state: 'gate_pass' }]]);
    const leavingVm = truckVMs(app.world, outOfGate).find((candidate) => candidate.id === leaving.id) as TruckVM;
    expect([leavingVm.prevX, leavingVm.prevY]).toEqual([leavingVm.x, leavingVm.y]);
    const driving = truckInState(app, 'to_gate_out');
    const beforeDriving: TruckPoses = new Map([[driving.id, { ...far, state: 'at_edge_tp' }]]);
    const drivingVm = truckVMs(app.world, beforeDriving).find((candidate) => candidate.id === driving.id) as TruckVM;
    expect([drivingVm.prevX, drivingVm.prevY, drivingVm.prevHeading]).toEqual([far.x, far.y, far.heading]);
  });

  it('`prevState` je stav z pamätanej pózy pred posledným tickom; nový kamión ho nemá', () => {
    const app = chainApp();
    const truck = truckInState(app, 'to_tp');
    const fresh = truckVMs(app.world).find((candidate) => candidate.id === truck.id) as TruckVM;
    expect(fresh.prevState).toBeUndefined();
    const arrived = truckVMs(app.world, new Map([[truck.id, { ...far, state: 'gate_pass' }]])).find((candidate) => candidate.id === truck.id) as TruckVM;
    expect(arrived.prevState).toBe('gate_pass');
    expect(arrived.state).toBe('to_tp');
    // bez zmeny stavu je prevState rovnaký ako state
    const same = truckVMs(app.world, new Map([[truck.id, { ...far, state: 'to_tp' }]])).find((candidate) => candidate.id === truck.id) as TruckVM;
    expect(same.prevState).toBe('to_tp');
  });
});

describe('truckPose: póza podľa stavu', () => {
  it('stav mimo brány: poloha a kurz zo simu; v `gate_pass` stred brány s rotáciou modulu', () => {
    const app = chainApp();
    const driving = truckInState(app, 'to_tp');
    expect(truckPose(app.world, driving)).toEqual({ x: driving.x, y: driving.y, heading: driving.heading, state: 'to_tp' });
    const passing = truckInState(app, 'gate_pass');
    const gate = app.world.modules.get(passing.gateId) as Module;
    const pose = truckPose(app.world, passing);
    expect([pose.x, pose.y, pose.heading, pose.state]).toEqual([gate.origin.x + gate.size.w / 2, gate.origin.y + gate.size.h / 2, gate.rotation, 'gate_pass']);
  });
});
