import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { SimEvent } from '@sim/events';
import { GameLoop, startRafLoop, type FrameEventSink, type RafHost } from '@app/game-loop';
import { TestAdjustCash, TestSetSpeed, createApp, createWorld } from './app-fixtures';

/** Svet rozbehnutý na požadovanú rýchlosť (bez prechodu cez frame, aby akumulátor ostal čistý). */
function createLoop(speed: number): { world: ReturnType<typeof createWorld>; loop: GameLoop } {
  const world = createWorld();
  world.clock.setSpeed(speed);
  return { world, loop: new GameLoop(world) };
}

const countType = (events: readonly SimEvent[], type: SimEvent['type']): number => events.filter((e) => e.type === type).length;

describe('GameLoop: akumulátor', () => {
  it('konštanty z time defu: tickMs = 1000 / ticksPerRealSecond, limit maxTicksPerFrame', () => {
    const { world, loop } = createLoop(1);
    expect(loop.tickMs).toBe(1000 / world.defs.time.ticksPerRealSecond);
    expect(loop.maxTicksPerFrame).toBe(world.defs.time.maxTicksPerFrame);
  });

  it('1000 ms pri 1× → presne 10 tickov', () => {
    const { world, loop } = createLoop(1);
    loop.frame(1000);
    expect(world.clock.tick).toBe(10);
    expect(loop.lastFrameTicks).toBe(10);
    expect(loop.alpha).toBe(0);
  });

  it('1000 ms pri 4× → 40 tickov', () => {
    const { world, loop } = createLoop(4);
    loop.frame(1000);
    expect(world.clock.tick).toBe(40);
  });

  it('10 s pri 8× v jednom frame → max 64 tickov a prebytok sa zahodí (alpha ≤ 1)', () => {
    const { world, loop } = createLoop(8);
    const events = loop.frame(10_000);
    expect(world.clock.tick).toBe(world.defs.time.maxTicksPerFrame);
    expect(world.clock.tick).toBe(64);
    expect(countType(events, 'TickAdvanced')).toBe(64);
    expect(loop.alpha).toBeGreaterThanOrEqual(0);
    expect(loop.alpha).toBeLessThanOrEqual(1);

    // Backlog sa nedobieha: ďalší malý frame nespustí desiatky tickov navyše.
    loop.frame(0);
    expect(world.clock.tick).toBeLessThanOrEqual(65);
  });

  it('po zásahu limitu je akumulátor ≤ tickMs (tick 65 najviac jeden)', () => {
    const { world, loop } = createLoop(8);
    loop.frame(10_000);
    loop.frame(0);
    expect(world.clock.tick).toBe(65);
    loop.frame(0);
    expect(world.clock.tick).toBe(65);
  });

  it('zlomky ticku sa prenášajú medzi framami (16 ms × 25 = 400 ms → 4 ticky)', () => {
    const { world, loop } = createLoop(1);
    for (let i = 0; i < 25; i++) loop.frame(16);
    expect(world.clock.tick).toBe(4);
  });

  it('alpha = acc / tickMs', () => {
    const { world, loop } = createLoop(1);
    loop.frame(250); // 2 ticky + 50 ms
    expect(world.clock.tick).toBe(2);
    expect(loop.alpha).toBeCloseTo(0.5, 10);
    loop.frame(30); // 80 ms
    expect(world.clock.tick).toBe(2);
    expect(loop.alpha).toBeCloseTo(0.8, 10);
    loop.frame(20); // 100 ms → tick, zvyšok 0
    expect(world.clock.tick).toBe(3);
    expect(loop.alpha).toBeCloseTo(0, 10);
  });

  it('dt = 0 nevykoná tick a vráti prázdne udalosti', () => {
    const { world, loop } = createLoop(1);
    expect(loop.frame(0)).toHaveLength(0);
    expect(world.clock.tick).toBe(0);
  });

  it('neplatné dt (záporné, NaN, Infinity) → RangeError', () => {
    const { loop } = createLoop(1);
    expect(() => loop.frame(-1)).toThrow(RangeError);
    expect(() => loop.frame(Number.NaN)).toThrow(RangeError);
    expect(() => loop.frame(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('frame vráti udalosti všetkých tickov v poradí (TickAdvanced s rastúcim tickom)', () => {
    const { loop } = createLoop(1);
    const ticks = loop
      .frame(300)
      .filter((e): e is Extract<SimEvent, { type: 'TickAdvanced' }> => e.type === 'TickAdvanced')
      .map((e) => e.tick);
    expect(ticks).toEqual([1, 2, 3]);
  });
});

describe('GameLoop: pauza a príkazy', () => {
  it('speed 0 → 0 tickov, akumulátor sa nezvyšuje, pending príkaz sa aplikuje', () => {
    const { world, loop } = createLoop(0);
    const cash = world.cashCents;
    world.enqueue(new TestAdjustCash(-123));
    const events = loop.frame(5000);
    expect(world.clock.tick).toBe(0);
    expect(loop.lastFrameTicks).toBe(0);
    expect(world.cashCents).toBe(cash - 123);
    expect(world.pendingCommandCount).toBe(0);
    expect(countType(events, 'MoneyChanged')).toBe(1);
    expect(countType(events, 'TickAdvanced')).toBe(0);
    expect(loop.alpha).toBe(0);
  });

  it('pauza neakumuluje dt: po obnove 1× nedobieha zameškaný čas', () => {
    const { world, loop } = createLoop(0);
    loop.frame(10_000);
    world.clock.setSpeed(1);
    loop.frame(0);
    expect(world.clock.tick).toBe(0);
    loop.frame(100);
    expect(world.clock.tick).toBe(1);
  });

  it('pauza zachová rozpracovaný zlomok ticku (alpha sa pri pauze nemení)', () => {
    const { world, loop } = createLoop(1);
    loop.frame(150); // 1 tick + 50 ms
    const alpha = loop.alpha;
    world.clock.setSpeed(0);
    loop.frame(1000);
    expect(loop.alpha).toBe(alpha);
    expect(world.clock.tick).toBe(1);
  });

  it('príkaz SetGameSpeed(0) sa aplikuje pred tickmi frame — po ňom už nebeží žiadny tick', () => {
    const { world, loop } = createLoop(8);
    world.enqueue(new TestSetSpeed(0));
    const events = loop.frame(1000);
    expect(world.clock.speed).toBe(0);
    expect(world.clock.tick).toBe(0);
    expect(countType(events, 'GameSpeedChanged')).toBe(1);
  });

  it('príkaz z pauzy na 2× v tom istom frame rozbehne ticky s novou rýchlosťou', () => {
    const { world, loop } = createLoop(0);
    world.enqueue(new TestSetSpeed(2));
    loop.frame(1000);
    expect(world.clock.tick).toBe(20);
  });

  it('príkazy pri rýchlosti > 0 sa aplikujú a udalosti idú pred udalosťami ticku', () => {
    const { world, loop } = createLoop(1);
    world.enqueue(new TestAdjustCash(-500));
    const types = loop.frame(100).map((e) => e.type);
    // Prvý tick naplní pool kontraktov (krok 2, ADR-026) — tie udalosti idú za TickAdvanced.
    expect(types.filter((type) => type !== 'ContractOffered')).toEqual(['MoneyChanged', 'TickAdvanced']);
  });
});

describe('GameLoop: sink', () => {
  it('publish sa volá po každom frame s rovnakým poľom, aké frame vráti (aj prázdnym)', () => {
    const world = createWorld();
    const published: (readonly SimEvent[])[] = [];
    const sink: FrameEventSink = { publish: (events) => published.push(events) };
    const loop = new GameLoop(world, sink);
    const first = loop.frame(0);
    const second = loop.frame(100);
    expect(published).toHaveLength(2);
    expect(published[0]).toBe(first);
    expect(published[0]).toHaveLength(0);
    expect(published[1]).toBe(second);
    expect(countType(second, 'TickAdvanced')).toBe(1);
  });

  it('publikuje do SimBridge: odberatelia sa dozvedia o zmene snapshotu', () => {
    const { loop, bridge } = createApp();
    let notified = 0;
    bridge.subscribe(() => notified++);
    loop.frame(0);
    expect(notified).toBe(0);
    loop.frame(100);
    expect(notified).toBe(1);
  });

  describe('beforeTick (voliteľný hák sinku)', () => {
    /** Sink, ktorý si pri každom `beforeTick` zapíše tick sveta (ešte pred `world.tick()`). */
    function recordingSink(world: ReturnType<typeof createWorld>): { sink: FrameEventSink; ticksSeen: number[] } {
      const ticksSeen: number[] = [];
      return {
        ticksSeen,
        sink: { publish: () => undefined, beforeTick: () => ticksSeen.push(world.clock.tick) },
      };
    }

    it('volá sa tesne pred každým tickom: vidí tick sveta pred ním', () => {
      const world = createWorld();
      world.clock.setSpeed(1);
      const { sink, ticksSeen } = recordingSink(world);
      new GameLoop(world, sink).frame(300); // 3 ticky
      expect(ticksSeen).toEqual([0, 1, 2]);
      expect(world.clock.tick).toBe(3);
    });

    it('nevolá sa pri pauze ani pri frame bez dokončeného ticku', () => {
      const world = createWorld();
      const { sink, ticksSeen } = recordingSink(world);
      const loop = new GameLoop(world, sink);
      loop.frame(50); // 0,5 ticku
      expect(ticksSeen).toEqual([]);
      world.clock.setSpeed(0);
      loop.frame(1000);
      expect(ticksSeen).toEqual([]);
    });

    it('sink bez beforeTick funguje (hák je voliteľný)', () => {
      const world = createWorld();
      const loop = new GameLoop(world, { publish: () => undefined });
      expect(() => loop.frame(200)).not.toThrow();
      expect(world.clock.tick).toBe(2);
    });

    it('príkazy frame sa aplikujú pred prvým beforeTick (nová loď je pri ňom už vo svete)', () => {
      const world = createWorld();
      const shipsAtHook: number[] = [];
      const sink: FrameEventSink = { publish: () => undefined, beforeTick: () => shipsAtHook.push(world.ships.size) };
      world.enqueue(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }));
      new GameLoop(world, sink).frame(100);
      expect(shipsAtHook).toEqual([1]);
    });
  });
});

describe('GameLoop.advance (DEV/e2e: preskočenie čakania)', () => {
  it('posunie hru o presne `ticks` tickov (aj viac framov: strop maxTicksPerFrame) a vráti ich počet', () => {
    const { world, loop } = createLoop(1);
    expect(loop.advance(200)).toBe(200);
    expect(world.clock.tick).toBe(200);
    expect(loop.advance(1)).toBe(1);
    expect(world.clock.tick).toBe(201);
  });

  it('presnosť nezávisí od rýchlosti hry ani od zlomku ticku z predošlých framov', () => {
    for (const speed of [1, 2, 4, 8]) {
      const { world, loop } = createLoop(speed);
      loop.frame(250); // zlomok ticku v akumulátore
      const before = world.clock.tick;
      expect(loop.advance(130)).toBe(130);
      expect(world.clock.tick).toBe(before + 130);
      expect(loop.alpha).toBeGreaterThanOrEqual(0);
      expect(loop.alpha).toBeLessThanOrEqual(1);
    }
  });

  it('sink dostane udalosti každého framu a každý tick má `beforeTick`', () => {
    const world = createWorld();
    world.clock.setSpeed(8);
    let publishes = 0;
    let beforeTicks = 0;
    const loop = new GameLoop(world, { publish: () => (publishes += 1), beforeTick: () => (beforeTicks += 1) });
    loop.advance(150); // 64 + 64 + 22
    expect(publishes).toBe(3);
    expect(beforeTicks).toBe(150);
    expect(world.clock.tick).toBe(150);
  });

  it('pri pauze (rýchlosť 0) a pri neplatnom počte nič nevykoná', () => {
    const { world, loop } = createLoop(0);
    expect(loop.advance(50)).toBe(0);
    expect(world.clock.tick).toBe(0);
    const running = createLoop(1);
    for (const ticks of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(running.loop.advance(ticks)).toBe(0);
    expect(running.world.clock.tick).toBe(0);
  });

  it('zhodné s bežným behom: advance(N) dá rovnaký stav sveta ako N tickov cez frame()', () => {
    const a = createLoop(4);
    const b = createLoop(4);
    a.loop.advance(300);
    for (let i = 0; i < 300; i += 1) b.loop.frame(b.loop.tickMs / 4);
    expect(a.world.clock.tick).toBe(300);
    expect(b.world.clock.tick).toBe(300);
    expect(JSON.stringify(a.world.serialize())).toBe(JSON.stringify(b.world.serialize()));
  });
});

describe('GameLoop: determinizmus', () => {
  it('rovnaký súčet dt v rôznych rozdeleniach na framy → rovnaký počet tickov', () => {
    const a = createLoop(4);
    const b = createLoop(4);
    a.loop.frame(1000);
    for (let i = 0; i < 100; i++) b.loop.frame(10);
    expect(a.world.clock.tick).toBe(40);
    expect(b.world.clock.tick).toBe(40);
  });
});

describe('startRafLoop (rAF wrapper s fake hostom)', () => {
  function createFakeHost(): { host: RafHost; flush(timestampMs: number): void; pending(): number; cancelled: number[] } {
    let nextHandle = 1;
    const callbacks = new Map<number, (timestampMs: number) => void>();
    const cancelled: number[] = [];
    return {
      host: {
        request(callback) {
          const handle = nextHandle++;
          callbacks.set(handle, callback);
          return handle;
        },
        cancel(handle) {
          cancelled.push(handle);
          callbacks.delete(handle);
        },
      },
      flush(timestampMs) {
        const current = [...callbacks.entries()];
        callbacks.clear();
        for (const [, callback] of current) callback(timestampMs);
      },
      pending: () => callbacks.size,
      cancelled,
    };
  }

  it('prvý frame má dt = 0, ďalšie dt z rozdielu časových pečiatok; onFrame dostane alpha a udalosti', () => {
    const { world, loop } = createLoop(1);
    const fake = createFakeHost();
    const frames: { alpha: number; events: number }[] = [];
    startRafLoop(loop, (alpha, events) => frames.push({ alpha, events: events.length }), fake.host);

    fake.flush(5000); // prvý frame: dt = 0
    expect(world.clock.tick).toBe(0);
    fake.flush(5250); // dt = 250 → 2 ticky, alpha 0,5
    expect(world.clock.tick).toBe(2);
    expect(frames).toHaveLength(2);
    expect(frames[1]?.alpha).toBeCloseTo(0.5, 10);
    // 2× TickAdvanced + prvé naplnenie poolu kontraktov v prvom ticku (ADR-026)
    expect(frames[1]?.events).toBe(2 + world.defs.economy.offersPerDay);
    expect(fake.pending()).toBe(1);
  });

  it('onFrame dostane aj dt (reálny čas od minulého framu) — pre posun kamery klávesmi', () => {
    const { loop } = createLoop(1);
    const fake = createFakeHost();
    const dts: number[] = [];
    startRafLoop(loop, (_alpha, _events, dtMs) => dts.push(dtMs), fake.host);
    fake.flush(1000);
    fake.flush(1016);
    fake.flush(1050);
    expect(dts).toEqual([0, 16, 34]);
  });

  it('záporný rozdiel pečiatok sa orezá na 0', () => {
    const { world, loop } = createLoop(1);
    const fake = createFakeHost();
    startRafLoop(loop, undefined, fake.host);
    fake.flush(1000);
    fake.flush(900);
    expect(world.clock.tick).toBe(0);
  });

  it('stop() zruší naplánovaný frame a slučka sa už nevolá', () => {
    const { world, loop } = createLoop(1);
    const fake = createFakeHost();
    const stop = startRafLoop(loop, undefined, fake.host);
    fake.flush(0);
    stop();
    expect(fake.cancelled).toHaveLength(1);
    fake.flush(10_000);
    expect(world.clock.tick).toBe(0);
    expect(fake.pending()).toBe(0);
  });
});
