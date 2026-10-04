import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { SimEvent } from '@sim/events';
import { installDevHook, type DevHook } from '@app/dev-hook';
import { SimBridge } from '@app/sim-bridge';
import { TestAdjustCash, TestRejected, TestSetSpeed, createApp, createWorld } from './app-fixtures';
import { setCash } from '../sim/helpers/economy';

describe('SimBridge.snapshot', () => {
  it('obsahuje clock, hotovosť, grid a parcely sveta', () => {
    const world = createWorld();
    const bridge = new SimBridge(world);
    const snapshot = bridge.snapshot();
    expect(snapshot.tick).toBe(0);
    expect(snapshot.speed).toBe(world.clock.speed);
    expect(snapshot.cashCents).toBe(world.cashCents);
    expect(snapshot.day).toBe(0);
    expect(snapshot.hour).toBe(0);
    expect(snapshot.minute).toBe(0);
    expect(snapshot.grid).toBe(world.grid);
    expect(snapshot.parcels).toBe(world.parcels);
  });

  it('kalendár: 0-based deň, hodina dňa a minúta hodiny podľa ticku', () => {
    // ~100 000 tickov len kvôli kalendáru — invarianty kroku 12 by beh zbytočne naťahovali k limitu 5 s.
    const { world, bridge } = createApp({ checkInvariants: false });
    const { ticksPerDay, ticksPerHour, ticksPerMinute } = world.clock;
    // Deň 12 (0-based 11), 14:20 — príklad z formatGameTime.
    const target = 11 * ticksPerDay + 14 * ticksPerHour + 20 * ticksPerMinute;
    for (let i = 0; i < target; i++) world.tick();
    const snapshot = bridge.snapshot();
    expect(snapshot).toMatchObject({ tick: target, day: 11, hour: 14, minute: 20 });
  });

  it('referencia je stabilná, kým sa nezmení tick, rýchlosť alebo hotovosť', () => {
    const { world, bridge } = createApp();
    const first = bridge.snapshot();
    expect(bridge.snapshot()).toBe(first);

    world.tick();
    const afterTick = bridge.snapshot();
    expect(afterTick).not.toBe(first);
    expect(afterTick.tick).toBe(1);
    expect(bridge.snapshot()).toBe(afterTick);

    world.clock.setSpeed(4);
    const afterSpeed = bridge.snapshot();
    expect(afterSpeed).not.toBe(afterTick);
    expect(afterSpeed.speed).toBe(4);

    setCash(world, world.cashCents - 1);
    const afterCash = bridge.snapshot();
    expect(afterCash).not.toBe(afterSpeed);
    expect(afterCash.cashCents).toBe(world.cashCents);
    expect(bridge.snapshot()).toBe(afterCash);
  });

  it('starý snapshot ostáva nezmenený a je zmrazený (read-only view)', () => {
    const { world, bridge } = createApp();
    const old = bridge.snapshot();
    world.tick();
    bridge.snapshot();
    expect(old.tick).toBe(0);
    expect(Object.isFrozen(old)).toBe(true);
  });
});

describe('SimBridge.dispatch / validate', () => {
  it('dispatch zaradí príkaz do fronty sveta, aplikuje sa pri applyPending', () => {
    const { world, bridge } = createApp();
    const command = new TestAdjustCash(-1000);
    const cash = world.cashCents;
    bridge.dispatch(command);
    expect(world.pendingCommandCount).toBe(1);
    expect(command.applyCalls).toBe(0);
    world.applyPending();
    expect(command.applyCalls).toBe(1);
    expect(world.cashCents).toBe(cash - 1000);
  });

  it('validate volá command.validate nad živým svetom, nič nemení ani nezaraďuje', () => {
    const { world, bridge } = createApp();
    const ok = new TestAdjustCash(-1);
    const bad = new TestRejected();
    expect(bridge.validate(ok).ok).toBe(true);
    const result = bridge.validate(bad);
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(['insufficient_funds']);
    expect(ok.validateCalls).toBe(1);
    expect(bad.validateCalls).toBe(1);
    expect(ok.applyCalls).toBe(0);
    expect(world.pendingCommandCount).toBe(0);
  });

  it('odmietnutý príkaz sa cez loop prejaví ako CommandRejected v onEvents', () => {
    const { bridge, loop } = createApp();
    const seen: SimEvent[] = [];
    bridge.onEvents((events) => seen.push(...events));
    bridge.dispatch(new TestRejected());
    loop.frame(0);
    expect(seen).toEqual([{ type: 'CommandRejected', commandType: 'TestRejected', reasons: ['insufficient_funds'] }]);
  });
});

describe('SimBridge.subscribe', () => {
  it('notifikuje po zmene snapshotu; bez zmeny nie', () => {
    const { bridge, loop } = createApp();
    let calls = 0;
    bridge.subscribe(() => calls++);
    loop.frame(0);
    loop.frame(50); // pod tickMs → bez ticku
    expect(calls).toBe(0);
    loop.frame(50); // 100 ms → tick
    expect(calls).toBe(1);
    loop.frame(0);
    expect(calls).toBe(1);
  });

  it('notifikuje aj pri zmene bez udalosti (publish porovnáva snapshot, nie udalosti)', () => {
    const { world, bridge } = createApp();
    let calls = 0;
    bridge.subscribe(() => calls++);
    world.clock.setSpeed(0);
    bridge.publish([]);
    expect(calls).toBe(1);
    bridge.publish([]);
    expect(calls).toBe(1);
  });

  it('počas pauzy notifikuje príkaz, ktorý zmení hotovosť', () => {
    const { world, bridge, loop } = createApp();
    world.clock.setSpeed(0);
    loop.frame(0);
    let calls = 0;
    bridge.subscribe(() => calls++);
    bridge.dispatch(new TestAdjustCash(-500));
    loop.frame(16);
    expect(calls).toBe(1);
    expect(bridge.snapshot().cashCents).toBe(world.cashCents);
  });

  it('unsubscribe zastaví notifikácie; dvojité volanie je neškodné', () => {
    const { bridge, loop } = createApp();
    let calls = 0;
    const unsubscribe = bridge.subscribe(() => calls++);
    loop.frame(100);
    expect(calls).toBe(1);
    unsubscribe();
    unsubscribe();
    loop.frame(100);
    expect(calls).toBe(1);
  });

  it('rovnaká funkcia zaregistrovaná dvakrát sa volá dvakrát; unsubscribe ruší len svoju registráciu', () => {
    const { bridge, loop } = createApp();
    let calls = 0;
    const listener = (): void => {
      calls++;
    };
    const unsubscribeA = bridge.subscribe(listener);
    bridge.subscribe(listener);
    loop.frame(100);
    expect(calls).toBe(2);
    unsubscribeA();
    loop.frame(100);
    expect(calls).toBe(3);
  });

  it('odhlásenie počas notifikácie neskracuje ani nezacyklí rozosielanie', () => {
    const { bridge, loop } = createApp();
    const calls: string[] = [];
    const unsubscribeSecond = { current: (): void => undefined };
    bridge.subscribe(() => {
      calls.push('first');
      unsubscribeSecond.current();
    });
    unsubscribeSecond.current = bridge.subscribe(() => calls.push('second'));
    bridge.subscribe(() => calls.push('third'));
    loop.frame(100);
    expect(calls).toEqual(['first', 'third']);
  });
});

describe('SimBridge.onEvents', () => {
  it('dostane udalosti za frame v poradí; prázdne frame ich nevolá', () => {
    const { bridge, loop } = createApp();
    const batches: (readonly SimEvent[])[] = [];
    bridge.onEvents((events) => batches.push(events));
    loop.frame(0);
    expect(batches).toHaveLength(0);
    bridge.dispatch(new TestAdjustCash(-200));
    const returned = loop.frame(200);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toBe(returned);
    // Prvý tick naplní pool kontraktov (krok 2, ADR-026) — tie udalosti idú za prvým TickAdvanced.
    expect(batches[0]?.map((e) => e.type).filter((type) => type !== 'ContractOffered')).toEqual(['MoneyChanged', 'TickAdvanced', 'TickAdvanced']);
  });

  it('unsubscribe zastaví doručovanie', () => {
    const { bridge, loop } = createApp();
    let batches = 0;
    const unsubscribe = bridge.onEvents(() => batches++);
    loop.frame(100);
    unsubscribe();
    loop.frame(100);
    expect(batches).toBe(1);
  });

  it('udalosti sa doručia pred notifikáciou odberateľov snapshotu', () => {
    const { bridge, loop } = createApp();
    const order: string[] = [];
    bridge.subscribe(() => order.push('snapshot'));
    bridge.onEvents(() => order.push('events'));
    loop.frame(100);
    expect(order).toEqual(['events', 'snapshot']);
  });

  it('SetGameSpeed cez bridge sa prejaví v snapshote aj udalostiach', () => {
    const { bridge, loop } = createApp();
    const seen: SimEvent[] = [];
    bridge.onEvents((events) => seen.push(...events));
    bridge.dispatch(new TestSetSpeed(0));
    loop.frame(1000);
    expect(bridge.snapshot().speed).toBe(0);
    expect(seen).toEqual([{ type: 'GameSpeedChanged', speed: 0 }]);
  });
});

describe('installDevHook', () => {
  it('zapíše { world, bridge } do cieľa, vráti háčik', () => {
    const { world, bridge } = createApp();
    const target: { __sim?: DevHook } = {};
    const hook = installDevHook(bridge, { enabled: true, target });
    expect(hook).not.toBeNull();
    expect(target.__sim).toBe(hook);
    expect(target.__sim?.world).toBe(world);
    expect(target.__sim?.bridge).toBe(bridge);
    expect(target.__sim?.cellToScreen).toBeUndefined();
  });

  it('entities() vráti aktuálne view-modely (moduly, žeriavy, lode) — presne to, čo dostáva renderer', () => {
    const { bridge, loop } = createApp();
    const target: { __sim?: DevHook } = {};
    const hook = installDevHook(bridge, { enabled: true, target });
    expect(hook?.entities()).toBe(bridge.entities());
    expect(hook?.entities().modules.map((module) => module.defId)).toEqual(['berth_standard']);
    expect(hook?.entities().cranes.map((crane) => crane.defId)).toEqual(['crane_container_gantry']);
    expect(hook?.entities().ships).toEqual([]);
    bridge.dispatch(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }));
    loop.frame(loop.tickMs);
    expect(hook?.entities().ships).toHaveLength(1); // vždy aktuálne, nie snímka z inštalácie
  });

  it('rendered() (počty views a stav ghostu v rendereri) sa prenesie z bootstrapu; bez neho chýba', () => {
    const { bridge } = createApp();
    const counts = { modules: 1, cranes: 1, ships: 0, vehicles: 2, trucks: 3, truckStates: { waiting: 2, loading: 1 }, ghostCells: 24, ghostConnectors: 2, ghostArrows: 0, selectionRing: false };
    const target: { __sim?: DevHook } = {};
    expect(installDevHook(bridge, { enabled: true, target, rendered: () => counts })?.rendered?.()).toEqual(counts);
    expect(installDevHook(bridge, { enabled: true, target: {} })?.rendered).toBeUndefined();
  });

  it('moduleGhost() a centerOn() sa prenesú z bootstrapu; bez neho chýbajú', () => {
    const { bridge } = createApp();
    const centered: [number, number, number | undefined][] = [];
    const target: { __sim?: DevHook } = {};
    const hook = installDevHook(bridge, {
      enabled: true,
      target,
      moduleGhost: () => null,
      centerOn: (x, y, zoom) => centered.push([x, y, zoom]),
    });
    expect(hook?.moduleGhost?.()).toBeNull();
    hook?.centerOn?.(44, 15);
    hook?.centerOn?.(44, 15, 1);
    expect(centered).toEqual([
      [44, 15, undefined],
      [44, 15, 1],
    ]);
    const bare = installDevHook(bridge, { enabled: true, target: {} });
    expect(bare?.moduleGhost).toBeUndefined();
    expect(bare?.centerOn).toBeUndefined();
  });

  it('cellToScreen sa prenesie; bootstrap ho môže doplniť aj neskôr', () => {
    const { bridge } = createApp();
    const target: { __sim?: DevHook } = {};
    const cellToScreen = (x: number, y: number): { x: number; y: number } => ({ x: x * 2, y: y * 2 });
    const hook = installDevHook(bridge, { enabled: true, target, cellToScreen });
    expect(hook?.cellToScreen?.(3, 4)).toEqual({ x: 6, y: 8 });
  });

  it('vypnutý (produkčný build) → nič nezapíše a vráti null', () => {
    const { bridge } = createApp();
    const target: { __sim?: DevHook } = {};
    expect(installDevHook(bridge, { enabled: false, target })).toBeNull();
    expect(target.__sim).toBeUndefined();
  });

  it('bez cieľa a bez window (Node) → null, nevyhodí', () => {
    const { bridge } = createApp();
    expect(installDevHook(bridge, { enabled: true })).toBeNull();
  });

  it('predvolene je zapnutý podľa import.meta.env.DEV (vo vitest = dev)', () => {
    const { bridge } = createApp();
    const target: { __sim?: DevHook } = {};
    expect(installDevHook(bridge, { target })).not.toBeNull();
  });
});
