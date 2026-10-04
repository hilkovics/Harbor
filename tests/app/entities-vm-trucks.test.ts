// T04-08 B: TruckVM zo simu — mapovanie stavu a nákladu, poloha v strede stojiska (waiting) a docku (loading), kurz podľa
// rotácie modulu a prev pri skoku do/zo stojiska a docku. Kamióny vznikajú skutočným tickom celého reťazca
// (loď → dvory → rampa → kamión → export, `buildFullChain`), nie fiktívnymi id.
import { describe, expect, it } from 'vitest';
import type { TruckVM } from '@render/view-models';
import { dockCenter, dockHeading, stallCenter, type SlotHost } from '@render/module-slots';
import type { EntityId } from '@sim/core';
import { LoadingRamp, WaitingArea, type Module } from '@sim/modules';
import { Truck } from '@sim/trucks';
import { entitiesVM, truckPose, truckVMs, type TruckPoses } from '@app/entities-vm';
import { CHAIN_AREA_ID, CHAIN_RAMP_ID, buildFullChain, createApp, frameUntil, runCommands, type App } from './app-fixtures';

const UNITS = 6;

function chainApp(units = UNITS): App {
  const app = createApp();
  buildFullChain(app, { units });
  return app;
}

/** Hostiteľ stojísk / dokov z modulu (footprint po rotácii). */
function hostOf(module: Module): SlotHost {
  return { defId: module.def.id, x: module.origin.x, y: module.origin.y, w: module.size.w, h: module.size.h, rotation: module.rotation };
}

const areaOf = (app: App): WaitingArea => app.world.modules.get(CHAIN_AREA_ID) as WaitingArea;
const rampOf = (app: App): LoadingRamp => app.world.modules.get(CHAIN_RAMP_ID) as LoadingRamp;

function inside(module: Module, x: number, y: number): boolean {
  return x > module.origin.x && x < module.origin.x + module.size.w && y > module.origin.y && y < module.origin.y + module.size.h;
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
    truckInState(app, 'waiting');
    const entities = app.bridge.entities();
    expect(entities.trucks.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(entities))).toEqual(entities);
  });
});

describe('TruckVM: celý beh reťazca, každý frame', () => {
  it('stav, náklad a poloha zodpovedajú simu; v stojisku a v docku stojí v strede slotu; kurz podľa rotácie modulu', () => {
    const app = chainApp();
    const { world, bridge } = app;
    const seenStates = new Set<string>();
    const seenLoaded = new Set<boolean>();
    let parked = 0;
    let docked = 0;
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
          if (truck.state === 'waiting') {
            const area = areaOf(app);
            expect(truck.bay).not.toBeNull();
            const center = stallCenter(hostOf(area), truck.bay ?? -1);
            expect([vm.x, vm.y]).toEqual([center.x, center.y]);
            expect(vm.heading).toBe(area.rotation);
            expect(inside(area, vm.x, vm.y)).toBe(true);
            parked += 1;
          } else if (truck.state === 'loading') {
            const ramp = rampOf(app);
            const center = dockCenter(hostOf(ramp), truck.dock);
            expect([vm.x, vm.y]).toEqual([center.x, center.y]);
            // do docku kamión cúva: kabína smeruje von z rampy (proti smeru od vonkajšej bunky ku dokom)
            expect(vm.heading).toBe(((ramp.rotation + 180) % 360) as TruckVM['heading']);
            expect(vm.heading).toBe(dockHeading(truck, center));
            expect(inside(ramp, vm.x, vm.y)).toBe(true);
            // sim poloha (vonkajšia bunka konektora) je východisko cúvania
            expect(vm.approach).toEqual({ x: truck.x, y: truck.y, heading: truck.heading });
            expect(inside(ramp, truck.x, truck.y)).toBe(false);
            docked += 1;
          } else {
            expect([vm.x, vm.y, vm.heading]).toEqual([truck.x, truck.y, truck.heading]);
            expect(vm.approach).toBeUndefined(); // manéver pri rampe je len v stave `loading`
          }
        }
        return world.cargo.exportedCount === UNITS;
      },
      6000,
    );
    expect(parked).toBeGreaterThan(0);
    expect(docked).toBeGreaterThan(0);
    expect(seenLoaded).toEqual(new Set([true, false]));
    expect([...seenStates]).toEqual(expect.arrayContaining(['to_gate', 'gate_queue', 'to_bay', 'waiting', 'to_dock', 'loading', 'to_gate_out', 'gate_queue_out', 'to_portal']));
    expect(world.trucks.size).toBe(0);
    expect(bridge.snapshot().trucks).toEqual([]);
  });

  it('kamión pri stojisku a dokoch na skutočnej ceste (sim) stojí inde než VM: v slote sa nekreslí na bunke cesty', () => {
    const app = chainApp();
    const waiting = truckInState(app, 'waiting');
    const vm = app.bridge.snapshot().trucks.find((truck) => truck.id === waiting.id) as TruckVM;
    // sim vedie kamión na vstupnej bunke stojiska (stred bunky cesty mimo modulu), VM v strede stojiska vo footprinte
    expect(inside(areaOf(app), waiting.x, waiting.y)).toBe(false);
    expect(inside(areaOf(app), vm.x, vm.y)).toBe(true);
    const loading = truckInState(app, 'loading');
    const loadingVm = app.bridge.snapshot().trucks.find((truck) => truck.id === loading.id) as TruckVM;
    expect(inside(rampOf(app), loading.x, loading.y)).toBe(false);
    expect(inside(rampOf(app), loadingVm.x, loadingVm.y)).toBe(true);
  });
});

describe('TruckVM: prev (interpolácia) v SimBridge', () => {
  it('prev je póza pred posledným tickom; pri zmene stavu z/do waiting a loading (skok do stojiska / z docku) je prev = curr', () => {
    const app = chainApp();
    const { world, bridge } = app;
    let before = new Map<number, TruckVM>();
    const jumps = { intoWaiting: 0, outOfWaiting: 0, intoLoading: 0, outOfLoading: 0 };
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
        const slotSwitch = last.state !== vm.state && ['waiting', 'loading'].some((state) => state === last.state || state === vm.state);
        if (slotSwitch) {
          expect([vm.prevX, vm.prevY, vm.prevHeading]).toEqual([vm.x, vm.y, vm.heading]);
          // skok naozaj existuje: zapamätaná póza (predchádzajúci snapshot) je inde než nová
          expect(Math.hypot(last.x - vm.x, last.y - vm.y)).toBeGreaterThan(0);
          if (vm.state === 'waiting') jumps.intoWaiting += 1;
          if (last.state === 'waiting') jumps.outOfWaiting += 1;
          if (vm.state === 'loading') jumps.intoLoading += 1;
          if (last.state === 'loading') jumps.outOfLoading += 1;
        } else {
          expect([vm.prevX, vm.prevY, vm.prevHeading]).toEqual([last.x, last.y, last.heading]);
          continued += 1;
        }
      }
      before = new Map(now.map((vm) => [vm.id, vm] as const));
    }
    expect(jumps.intoWaiting).toBeGreaterThan(0);
    expect(jumps.outOfWaiting).toBeGreaterThan(0);
    expect(jumps.intoLoading).toBeGreaterThan(0);
    expect(jumps.outOfLoading).toBeGreaterThan(0);
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
    const truck = truckInState(app, 'waiting');
    const [vm] = truckVMs(app.world).filter((candidate) => candidate.id === truck.id);
    expect([vm?.prevX, vm?.prevY, vm?.prevHeading]).toEqual([vm?.x, vm?.y, vm?.heading]);
  });

  it('zmena stavu to_bay → waiting: prev = curr (kamión sa neinterpoluje z cesty do stojiska)', () => {
    const app = chainApp();
    const truck = truckInState(app, 'waiting');
    const prev: TruckPoses = new Map([[truck.id, { ...far, state: 'to_bay' }]]);
    const vm = truckVMs(app.world, prev).find((candidate) => candidate.id === truck.id) as TruckVM;
    expect([vm.prevX, vm.prevY, vm.prevHeading]).toEqual([vm.x, vm.y, vm.heading]);
  });

  it('bez zmeny stavu (waiting → waiting) sa použije zapamätaná póza', () => {
    const app = chainApp();
    const truck = truckInState(app, 'waiting');
    const prev: TruckPoses = new Map([[truck.id, { ...far, state: 'waiting' }]]);
    const vm = truckVMs(app.world, prev).find((candidate) => candidate.id === truck.id) as TruckVM;
    expect([vm.prevX, vm.prevY, vm.prevHeading]).toEqual([far.x, far.y, far.heading]);
  });

  it('zmena stavu waiting → to_dock (odchod zo stojiska): prev = curr', () => {
    const app = chainApp();
    const truck = truckInState(app, 'to_dock');
    const prev: TruckPoses = new Map([[truck.id, { ...far, state: 'waiting' }]]);
    const vm = truckVMs(app.world, prev).find((candidate) => candidate.id === truck.id) as TruckVM;
    expect([vm.prevX, vm.prevY, vm.prevHeading]).toEqual([vm.x, vm.y, vm.heading]);
  });

  it('zmena stavu to_dock → loading a loading → to_gate_out: prev = curr; jazda medzi cestnými stavmi (to_gate → gate_queue) interpoluje', () => {
    const app = chainApp();
    const loading = truckInState(app, 'loading');
    const intoLoading: TruckPoses = new Map([[loading.id, { ...far, state: 'to_dock' }]]);
    const loadingVm = truckVMs(app.world, intoLoading).find((candidate) => candidate.id === loading.id) as TruckVM;
    expect([loadingVm.prevX, loadingVm.prevY]).toEqual([loadingVm.x, loadingVm.y]);
    const leaving = truckInState(app, 'to_gate_out');
    const outOfLoading: TruckPoses = new Map([[leaving.id, { ...far, state: 'loading' }]]);
    const leavingVm = truckVMs(app.world, outOfLoading).find((candidate) => candidate.id === leaving.id) as TruckVM;
    expect([leavingVm.prevX, leavingVm.prevY]).toEqual([leavingVm.x, leavingVm.y]);
    const queued = truckInState(app, 'gate_queue');
    const beforeQueue: TruckPoses = new Map([[queued.id, { ...far, state: 'to_gate' }]]);
    const queuedVm = truckVMs(app.world, beforeQueue).find((candidate) => candidate.id === queued.id) as TruckVM;
    expect([queuedVm.prevX, queuedVm.prevY, queuedVm.prevHeading]).toEqual([far.x, far.y, far.heading]);
  });

  it('F5b č. 11: `prevState` je stav z pamätanej pózy pred posledným tickom; nový kamión ho nemá', () => {
    const app = chainApp();
    const loading = truckInState(app, 'loading');
    const fresh = truckVMs(app.world).find((candidate) => candidate.id === loading.id) as TruckVM;
    expect(fresh.prevState).toBeUndefined();
    const arrived = truckVMs(app.world, new Map([[loading.id, { ...far, state: 'to_dock' }]])).find((candidate) => candidate.id === loading.id) as TruckVM;
    expect(arrived.prevState).toBe('to_dock'); // práve dokončený príjazd k rampe
    expect(arrived.state).toBe('loading');
    // bez zmeny stavu je prevState rovnaký ako state
    const same = truckVMs(app.world, new Map([[loading.id, { ...far, state: 'loading' }]])).find((candidate) => candidate.id === loading.id) as TruckVM;
    expect(same.prevState).toBe('loading');
  });

  it('F5b č. 11: `approach` má len kamión v `loading` — sim poloha na vonkajšej bunke a kurz príjazdu; x, y, heading sú cieľ v doku', () => {
    const app = chainApp();
    const loading = truckInState(app, 'loading');
    const vm = truckVMs(app.world).find((candidate) => candidate.id === loading.id) as TruckVM;
    expect(vm.approach).toEqual({ x: loading.x, y: loading.y, heading: loading.heading });
    expect(inside(rampOf(app), loading.x, loading.y)).toBe(false); // východisko cúvania je na ceste pred rampou
    expect(inside(rampOf(app), vm.x, vm.y)).toBe(true); // cieľ je v doku
    expect(vm.heading).toBe(dockHeading(loading, { x: vm.x, y: vm.y }));
    const driving = truckInState(app, 'to_gate_out');
    expect((truckVMs(app.world).find((candidate) => candidate.id === driving.id) as TruckVM).approach).toBeUndefined();
  });
});

describe('truckPose: rotácia modulu určuje kurz a polohu slotu', () => {
  it.each([0, 90, 180, 270] as const)('čakacia plocha a rampa otočené o %i°: kamión v slote stojí v strede footprintu (v stojisku smeruje ako modul, v doku kabínou von)', (rotation) => {
    const app = createApp();
    // moduly bez ciest (poloha kamióna sa berie zo slotu manifestu, nie z cesty); dostatočne ďaleko od seba
    runCommands(app, [
      { type: 'PlaceModule', defId: 'truck_waiting_area', x: 49, y: 28, rotation },
      { type: 'PlaceModule', defId: 'loading_ramp_container', x: 53, y: 24, rotation },
    ]);
    const area = app.world.modules.get(3 as EntityId) as WaitingArea;
    const ramp = app.world.modules.get(4 as EntityId) as LoadingRamp;
    const def = app.world.defs.trucks.get('truck_container');
    const width = app.world.grid.width;
    // samostatný kamión (mimo sveta): pózu určuje stav, bay/dock a moduly sveta
    const make = (state: 'waiting' | 'loading', bay: number | null, dock: number): Truck =>
      new Truck({
        id: 40 as EntityId,
        def,
        state,
        x: 44.5,
        y: 40.5,
        heading: 180,
        route: [40 * width + 44],
        rampId: ramp.id,
        dock,
        gateId: 99 as EntityId,
        waitingAreaId: area.id,
        bay,
      });
    for (let bay = 0; bay < area.bays; bay += 1) {
      const pose = truckPose(app.world, make('waiting', bay, 1));
      const center = stallCenter(hostOf(area), bay);
      expect([pose.x, pose.y, pose.heading, pose.state]).toEqual([center.x, center.y, rotation, 'waiting']);
      expect(inside(area, pose.x, pose.y)).toBe(true);
    }
    for (let dock = 0; dock < ramp.docks; dock += 1) {
      const pose = truckPose(app.world, make('loading', null, dock));
      const center = dockCenter(hostOf(ramp), dock);
      // kurz: kabína von z docku = opak smeru od vonkajšej bunky (tu fiktívna poloha kamióna 44,5; 40,5) ku dokom
      expect([pose.x, pose.y, pose.heading, pose.state]).toEqual([center.x, center.y, dockHeading({ x: 44.5, y: 40.5 }, center), 'loading']);
      expect(inside(ramp, pose.x, pose.y)).toBe(true);
    }
    // ostatné stavy: poloha a kurz zo simu
    const driving = truckPose(app.world, new Truck({ id: 41 as EntityId, def, state: 'to_gate', x: 44.5, y: 40.5, heading: 270, route: [40 * width + 44], rampId: ramp.id, dock: 0, gateId: 99 as EntityId, waitingAreaId: area.id, bay: 0 }));
    expect([driving.x, driving.y, driving.heading, driving.state]).toEqual([44.5, 40.5, 270, 'to_gate']);
  });
});
