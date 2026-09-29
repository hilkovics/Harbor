import { describe, expect, it } from 'vitest';
import { EventBus } from '@sim/core/event-bus';

type TestEvent = { type: 'Tick'; tick: number } | { type: 'Money'; amountCents: number };

describe('EventBus', () => {
  it('nový bus je prázdny', () => {
    const bus = new EventBus<TestEvent>();
    expect(bus.pending).toBe(0);
    expect(bus.flush()).toEqual([]);
  });

  it('emit zvyšuje pending a flush vráti udalosti v poradí emitovania', () => {
    const bus = new EventBus<TestEvent>();
    const a: TestEvent = { type: 'Tick', tick: 1 };
    const b: TestEvent = { type: 'Money', amountCents: -500 };
    const c: TestEvent = { type: 'Tick', tick: 2 };
    bus.emit(a);
    bus.emit(b);
    expect(bus.pending).toBe(2);
    bus.emit(c);
    expect(bus.pending).toBe(3);

    const events = bus.flush();
    expect(events).toEqual([a, b, c]);
    expect(events[0]).toBe(a); // rovnaké objekty, bez kopírovania
  });

  it('flush vyprázdni buffer', () => {
    const bus = new EventBus<TestEvent>();
    bus.emit({ type: 'Tick', tick: 1 });
    expect(bus.flush()).toHaveLength(1);
    expect(bus.pending).toBe(0);
    expect(bus.flush()).toEqual([]);
  });

  it('udalosti emitované po flush sa nedostanú do už vráteného poľa', () => {
    const bus = new EventBus<TestEvent>();
    bus.emit({ type: 'Tick', tick: 1 });
    const first = bus.flush();
    bus.emit({ type: 'Tick', tick: 2 });
    expect(first).toEqual([{ type: 'Tick', tick: 1 }]);
    expect(bus.pending).toBe(1);
    expect(bus.flush()).toEqual([{ type: 'Tick', tick: 2 }]);
  });

  it('tick po ticku: každý flush obsahuje len udalosti svojho ticku', () => {
    const bus = new EventBus<TestEvent>();
    const perTick: number[] = [];
    for (let tick = 1; tick <= 5; tick++) {
      for (let i = 0; i < tick; i++) bus.emit({ type: 'Tick', tick });
      perTick.push(bus.flush().length);
    }
    expect(perTick).toEqual([1, 2, 3, 4, 5]);
  });

  it('udalosti sú typovo readonly (kontroluje tsc, za behu sa nevolá)', () => {
    const bus = new EventBus<TestEvent>();
    const typeChecksOnly = (): void => {
      const [event] = bus.flush();
      if (event.type === 'Money') {
        // @ts-expect-error udalosti sú readonly DTO
        event.amountCents = 0;
      }
      // @ts-expect-error vrátené pole je readonly
      bus.flush().push({ type: 'Tick', tick: 0 });
    };
    expect(typeChecksOnly).toBeTypeOf('function');
    expect(bus.pending).toBe(0);
  });
});
