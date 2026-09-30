import { describe, expect, it } from 'vitest';
import { INITIAL_SPEED, Rng } from '@sim/core';
import { DefError } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { World } from '@sim/world';
import {
  DEFS,
  MAP,
  MAP_GRID,
  SEED,
  TestCommand,
  adjustCash,
  defsWithTime,
  findCell,
  hashState,
  rejected,
  runTicks,
  setRoad,
} from './world-fixtures';

const create = (seed = SEED): World => World.create(DEFS, MAP, seed);

/** Verejná bunka pevniny mimo parciel a bez cesty. */
const PUBLIC_LAND = findCell(MAP_GRID, (cell) => cell.terrain === 'land' && cell.parcelId === null && cell.road === 'none');

describe('World.create', () => {
  it('nová hra: tick 0, rýchlosť INITIAL_SPEED, štartovná hotovosť, prázdna fronta', () => {
    const world = create();
    expect(world.clock.tick).toBe(0);
    expect(world.clock.speed).toBe(INITIAL_SPEED);
    expect(world.cashCents).toBe(DEFS.economy.startingCashCents);
    expect(world.seed).toBe(SEED);
    expect(world.pendingCommandCount).toBe(0);
    expect(world.defs).toBe(DEFS);
    expect(world.map).toBe(MAP);
  });

  it('Rng je Rng(seed) a ID sa prideľujú od 1 (prvé dostanú starter moduly mapy)', () => {
    const world = create(42);
    const reference = new Rng(42);
    expect(world.rng.getState()).toEqual(reference.getState());
    expect(world.rng.nextU32()).toBe(reference.nextU32());
    expect([...world.modules.keys()]).toEqual(MAP.starter.modules.map((_, i) => i + 1));
    expect(world.ids.next()).toBe(MAP.starter.modules.length + 1);
  });

  it('mriežka je klon šablóny mapy (terén, hĺbka, parcely, starter cesty)', () => {
    const world = create();
    const template = MAP.createGrid();
    expect(world.grid).not.toBe(template);
    expect([world.grid.width, world.grid.height]).toEqual([MAP.width, MAP.height]);
    for (let i = 0; i < template.cellCount; i++) {
      expect(world.grid.atIndex(i)).not.toBe(template.atIndex(i));
      // moduleId zapísali starter moduly (T02-04); ostatné polia sú presná kópia šablóny.
      expect({ ...world.grid.atIndex(i), moduleId: null }).toEqual(template.atIndex(i));
    }
    expect(MAP.starter.roads.length).toBeGreaterThan(0);
    for (const { x, y } of MAP.starter.roads) expect(world.grid.at(x, y).road).toBe('road');
  });

  it('parcely sú kópie v poradí mapy s ownership zo startOwned', () => {
    const world = create();
    expect([...world.parcels.keys()]).toEqual(MAP.parcels.map((p) => p.id));
    for (const source of MAP.parcels) {
      const parcel = world.parcels.get(source.id);
      expect(parcel).toEqual(source);
      expect(parcel).not.toBe(source);
    }
    expect(world.parcels.get('starter')?.ownership).toBe('owned');
  });

  it('dva svety z jednej LoadedMap nezdieľajú mriežku ani parcely a šablónu nemenia', () => {
    const a = create();
    const b = create();
    const { x, y } = PUBLIC_LAND;
    a.grid.at(x, y).road = 'rail';
    a.grid.at(x, y).traffic = 7;
    const west = a.parcels.get('west_quay');
    if (west === undefined) throw new Error('mapa nemá west_quay');
    west.ownership = 'leased';

    expect(b.grid.at(x, y).road).toBe('none');
    expect(b.grid.at(x, y).traffic).toBe(0);
    expect(MAP.createGrid().at(x, y).road).toBe('none');
    expect(b.parcels.get('west_quay')?.ownership).toBe('none');
    expect(MAP.parcels.find((p) => p.id === 'west_quay')?.ownership).toBe('none');
    // Nový svet z tej istej mapy začína znova z čistej šablóny.
    expect(create().grid.at(x, y).road).toBe('none');
  });

  it.each([-1, 2 ** 32, 2 ** 32 + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('seed %s (nie uint32) → RangeError', (seed) => {
    expect(() => create(seed)).toThrow(RangeError);
  });

  it('hraničné uint32 seedy 0 a 2^32 − 1 sú platné', () => {
    expect(create(0).seed).toBe(0);
    expect(create(2 ** 32 - 1).seed).toBe(2 ** 32 - 1);
  });

  it('počiatočná rýchlosť musí byť v time.speeds → inak DefError na /speeds', () => {
    const defs = defsWithTime({ speeds: [0, 2, 4, 8] });
    let error: unknown;
    try {
      World.create(defs, MAP, SEED);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DefError);
    expect((error as DefError).defName).toBe('time');
    expect((error as DefError).path).toBe('/speeds');
  });
});

describe('World.tick — krok 1 a 13', () => {
  it('prvý tick: clock.tick 1 a jediná udalosť TickAdvanced', () => {
    const world = create();
    expect(world.tick()).toEqual([{ type: 'TickAdvanced', tick: 1 }]);
    expect(world.clock.tick).toBe(1);
  });

  it('za jeden deň: 8 640× TickAdvanced, 24× HourClosed, 1× DayClosed na správnych tickoch', () => {
    const world = create();
    const { ticksPerHour, ticksPerDay } = world.clock;
    const events: SimEvent[] = [];
    for (let i = 0; i < ticksPerDay; i++) events.push(...world.tick());
    const ticksOf = (type: SimEvent['type']): number[] =>
      events.filter((e) => e.type === type).map((e) => (e as { tick: number }).tick);
    expect(ticksOf('TickAdvanced')).toHaveLength(ticksPerDay);
    expect(ticksOf('HourClosed')).toEqual(Array.from({ length: 24 }, (_, h) => (h + 1) * ticksPerHour));
    expect(ticksOf('DayClosed')).toEqual([ticksPerDay]);
    expect(ticksOf('MonthClosed')).toEqual([]);
  });

  it('poradie udalostí na hranici dňa: TickAdvanced, HourClosed, DayClosed', () => {
    const world = create();
    runTicks(world, world.clock.ticksPerDay - 1);
    const tick = world.clock.ticksPerDay;
    expect(world.tick()).toEqual([
      { type: 'TickAdvanced', tick },
      { type: 'HourClosed', tick },
      { type: 'DayClosed', tick },
    ]);
  });

  it('hranica mesiaca: TickAdvanced, HourClosed, DayClosed, MonthClosed', () => {
    const base = create();
    const { ticksPerMonth } = base.clock;
    const state = base.serialize();
    const world = World.deserialize(DEFS, MAP, { ...state, clock: { ...state.clock, tick: ticksPerMonth - 1 } });
    expect(world.tick()).toEqual([
      { type: 'TickAdvanced', tick: ticksPerMonth },
      { type: 'HourClosed', tick: ticksPerMonth },
      { type: 'DayClosed', tick: ticksPerMonth },
      { type: 'MonthClosed', tick: ticksPerMonth },
    ]);
    expect(world.clock.gameMonth).toBe(1);
  });

  it('vrátené pole sa neskorším tickom nemení', () => {
    const world = create();
    const first = world.tick();
    const copy = [...first];
    world.tick();
    expect(first).toEqual(copy);
  });

  it('rýchlosť tick neovplyvňuje — počet tickov riadi GameLoop (aj pri pauze tick posunie čas)', () => {
    const world = create();
    world.clock.setSpeed(0);
    world.tick();
    expect(world.clock.tick).toBe(1);
  });
});

describe('World — fronta príkazov', () => {
  it('applyPending: poradie vloženia, bez posunu času, vráti udalosti príkazov', () => {
    const world = create();
    const order: string[] = [];
    world.enqueue(new TestCommand({ type: 'A', apply: () => order.push('A') }));
    world.enqueue(adjustCash(-500));
    world.enqueue(new TestCommand({ type: 'B', apply: () => order.push('B') }));
    expect(world.pendingCommandCount).toBe(3);

    const events = world.applyPending();
    expect(order).toEqual(['A', 'B']);
    expect(world.clock.tick).toBe(0);
    expect(world.pendingCommandCount).toBe(0);
    expect(events).toEqual([
      { type: 'MoneyChanged', cashCents: DEFS.economy.startingCashCents - 500, deltaCents: -500, reason: 'road_capex' },
    ]);
  });

  it('applyPending s prázdnou frontou nič nerobí', () => {
    const world = create();
    const before = hashState(world.serialize());
    expect(world.applyPending()).toEqual([]);
    expect(hashState(world.serialize())).toBe(before);
  });

  it('validate aj apply sa volajú práve raz', () => {
    const world = create();
    const command = new TestCommand();
    world.enqueue(command);
    world.applyPending();
    world.applyPending();
    expect([command.validateCalls, command.applyCalls]).toEqual([1, 1]);
  });

  it('neplatný príkaz → CommandRejected, apply sa nezavolá, stav sa nezmení; ďalšie príkazy pokračujú', () => {
    const world = create();
    const before = hashState(world.serialize());
    const bad = new TestCommand({
      type: 'TestBad',
      validate: () => rejected('terrain', 'parcel_not_owned'),
      apply: (w) => {
        w.cashCents = 0;
      },
    });
    world.enqueue(bad);
    expect(world.applyPending()).toEqual([{ type: 'CommandRejected', commandType: 'TestBad', reasons: ['terrain', 'parcel_not_owned'] }]);
    expect(bad.applyCalls).toBe(0);
    expect(hashState(world.serialize())).toBe(before);

    const good = new TestCommand();
    world.enqueue(bad);
    world.enqueue(good);
    world.applyPending();
    expect(good.applyCalls).toBe(1);
  });

  it('CommandRejected nesie kópiu dôvodov (neskoršia zmena poľa príkazu ju neovplyvní)', () => {
    const world = create();
    const reasons: ('terrain' | 'occupied')[] = ['terrain'];
    world.enqueue(new TestCommand({ validate: () => ({ ok: false, reasons, cells: [], costCents: 0 }) }));
    const [event] = world.applyPending();
    reasons.push('occupied');
    expect(event).toEqual({ type: 'CommandRejected', commandType: 'Test', reasons: ['terrain'] });
  });

  it('validácia pri aplikácii vidí účinok predchádzajúcich príkazov', () => {
    const world = create();
    const all = DEFS.economy.startingCashCents;
    world.enqueue(adjustCash(-all));
    world.enqueue(adjustCash(-1));
    const events = world.applyPending();
    expect(world.cashCents).toBe(0);
    expect(events.at(-1)).toEqual({ type: 'CommandRejected', commandType: 'TestAdjustCash', reasons: ['insufficient_funds'] });
  });

  it('tick aplikuje príkazy pred krokom 1: apply vidí starý tick, udalosti príkazu idú pred TickAdvanced', () => {
    const world = create();
    runTicks(world, 5);
    let seenTick = -1;
    world.enqueue(new TestCommand({ apply: (w) => (seenTick = w.clock.tick) }));
    world.enqueue(adjustCash(-100));
    const events = world.tick();
    expect(seenTick).toBe(5);
    expect(events.map((e) => e.type)).toEqual(['MoneyChanged', 'TickAdvanced']);
    expect(world.clock.tick).toBe(6);
  });

  it('replay ekvivalencia: applyPending() + tick() ≡ tick()', () => {
    const run = (withApplyPending: boolean): { hash: string; events: SimEvent[] } => {
      const world = create();
      const events: SimEvent[] = [];
      runTicks(world, 10);
      world.enqueue(adjustCash(-12345));
      world.enqueue(setRoad([PUBLIC_LAND], 'road'));
      if (withApplyPending) events.push(...world.applyPending());
      events.push(...world.tick());
      runTicks(world, 10);
      return { hash: hashState(world.serialize()), events };
    };
    expect(run(true)).toEqual(run(false));
  });

  it('príkaz zaradený počas apply čaká na ďalšie kolo', () => {
    const world = create();
    const later = new TestCommand({ type: 'Later' });
    world.enqueue(new TestCommand({ apply: (w) => w.enqueue(later) }));
    world.applyPending();
    expect(later.applyCalls).toBe(0);
    expect(world.pendingCommandCount).toBe(1);
    world.tick();
    expect(later.applyCalls).toBe(1);
  });

  it('výnimka v apply sa nepotlačí a zvyšné príkazy ostanú vo fronte', () => {
    const world = create();
    const after = new TestCommand();
    world.enqueue(
      new TestCommand({
        apply: () => {
          throw new Error('bug v príkaze');
        },
      }),
    );
    world.enqueue(after);
    expect(() => world.applyPending()).toThrow('bug v príkaze');
    expect(world.pendingCommandCount).toBe(1);
    expect(after.applyCalls).toBe(0);
  });
});
