import { describe, expect, it } from 'vitest';
import { INITIAL_SPEED, SimClock, type ClockBoundaries } from '@sim/core/sim-clock';

// Konfigurácia ako v data/defs/time.json (ARCHITECTURE §3): 1 tick = 10 herných sekúnd.
const CFG = { tickGameSeconds: 10 };

const TICKS_PER_MINUTE = 6;
const TICKS_PER_HOUR = 360;
const TICKS_PER_DAY = 8640;
const TICKS_PER_MONTH = 259_200;

function advanceN(clock: SimClock, n: number): void {
  for (let i = 0; i < n; i++) clock.advance();
}

describe('SimClock', () => {
  describe('odvodené konštanty', () => {
    it('tickGameSeconds 10 → 6 / 360 / 8 640 / 259 200', () => {
      const clock = new SimClock(CFG);
      expect(clock.ticksPerMinute).toBe(TICKS_PER_MINUTE);
      expect(clock.ticksPerHour).toBe(TICKS_PER_HOUR);
      expect(clock.ticksPerDay).toBe(TICKS_PER_DAY);
      expect(clock.ticksPerMonth).toBe(TICKS_PER_MONTH);
    });

    it('odvádzajú sa z konfigurácie (tickGameSeconds 5 → 12 / 720 / 17 280 / 518 400)', () => {
      const clock = new SimClock({ tickGameSeconds: 5 });
      expect(clock.ticksPerMinute).toBe(12);
      expect(clock.ticksPerHour).toBe(720);
      expect(clock.ticksPerDay).toBe(17_280);
      expect(clock.ticksPerMonth).toBe(518_400);
    });

    it('akceptuje konfiguráciu s ďalšími poľami (štrukturálna kompatibilita s TimeDef)', () => {
      const timeDefLike = { schemaVersion: 1, tickGameSeconds: 10, ticksPerRealSecond: 10, speeds: [0, 1, 2, 4, 8] };
      expect(new SimClock(timeDefLike).ticksPerHour).toBe(TICKS_PER_HOUR);
    });

    it.each([0, -10, 7, 0.5, 120, Number.NaN, Number.POSITIVE_INFINITY])(
      'odmietne tickGameSeconds = %s (musí byť celé číslo delivé 60)',
      (tickGameSeconds) => {
        expect(() => new SimClock({ tickGameSeconds })).toThrow(RangeError);
      },
    );
  });

  describe('počiatočný stav a gettery', () => {
    it('začína na ticku 0 pri rýchlosti 1× (INITIAL_SPEED)', () => {
      const clock = new SimClock(CFG);
      expect(INITIAL_SPEED).toBe(1);
      expect(clock.getState()).toEqual({ tick: 0, speed: INITIAL_SPEED });
      expect(clock.tick).toBe(0);
      expect(clock.speed).toBe(1);
      expect([clock.gameMinute, clock.gameHour, clock.gameDay, clock.gameMonth]).toEqual([0, 0, 0, 0]);
    });

    it('gameMinute/Hour/Day/Month sú uplynulé počty jednotiek', () => {
      const at = (tick: number): SimClock => new SimClock(CFG, { tick, speed: 1 });
      expect(at(TICKS_PER_MINUTE - 1).gameMinute).toBe(0);
      expect(at(TICKS_PER_MINUTE).gameMinute).toBe(1);
      expect(at(TICKS_PER_HOUR - 1).gameHour).toBe(0);
      expect(at(TICKS_PER_HOUR).gameHour).toBe(1);
      expect(at(TICKS_PER_DAY - 1).gameDay).toBe(0);
      expect(at(TICKS_PER_DAY).gameDay).toBe(1);
      expect(at(TICKS_PER_MONTH - 1).gameMonth).toBe(0);
      expect(at(TICKS_PER_MONTH).gameMonth).toBe(1);
      const late = at(2 * TICKS_PER_MONTH + 3 * TICKS_PER_DAY + 5 * TICKS_PER_HOUR + 7 * TICKS_PER_MINUTE + 1);
      expect(late.gameMonth).toBe(2);
      expect(late.gameDay).toBe(2 * 30 + 3);
      expect(late.gameHour).toBe((2 * 30 + 3) * 24 + 5);
      expect(late.gameMinute).toBe(((2 * 30 + 3) * 24 + 5) * 60 + 7);
    });
  });

  describe('kalendár — minuteOfHour, hourOfDay, dayOfMonth (0-based)', () => {
    const at = (tick: number): SimClock => new SimClock(CFG, { tick, speed: 1 });
    const calendar = (clock: SimClock): [number, number, number] => [clock.minuteOfHour, clock.hourOfDay, clock.dayOfMonth];

    it.each([
      ['začiatok hry', 0, [0, 0, 0]],
      ['posledný tick prvej minúty', TICKS_PER_MINUTE - 1, [0, 0, 0]],
      ['prvá minúta', TICKS_PER_MINUTE, [1, 0, 0]],
      ['posledná minúta hodiny', TICKS_PER_HOUR - 1, [59, 0, 0]],
      ['prvá hodina', TICKS_PER_HOUR, [0, 1, 0]],
      ['23:59 prvého dňa', TICKS_PER_DAY - 1, [59, 23, 0]],
      ['polnoc druhého dňa', TICKS_PER_DAY, [0, 0, 1]],
      ['posledná minúta mesiaca', TICKS_PER_MONTH - 1, [59, 23, 29]],
      ['prvý deň druhého mesiaca', TICKS_PER_MONTH, [0, 0, 0]],
      ['mesiac 2, deň 3, 05:07', 2 * TICKS_PER_MONTH + 3 * TICKS_PER_DAY + 5 * TICKS_PER_HOUR + 7 * TICKS_PER_MINUTE + 1, [7, 5, 3]],
    ] as const)('%s (tick %i) → [minúta, hodina, deň] = %j', (_name, tick, expected) => {
      expect(calendar(at(tick))).toEqual(expected);
    });

    it('gameDay ostáva celkový počet dní, dayOfMonth sa na hranici mesiaca vynuluje', () => {
      const clock = at(TICKS_PER_MONTH + TICKS_PER_DAY);
      expect(clock.gameDay).toBe(31);
      expect(clock.dayOfMonth).toBe(1);
      expect(clock.gameHour).toBe(31 * 24);
      expect(clock.hourOfDay).toBe(0);
    });

    it('počas celého mesiaca: rozsahy 0–59 / 0–23 / 0–29 a zložky skladajú celkové minúty', () => {
      const clock = new SimClock(CFG);
      const seen = { minutes: new Set<number>(), hours: new Set<number>(), days: new Set<number>() };
      for (let i = 0; i < TICKS_PER_MONTH; i++) {
        const [minute, hour, day] = calendar(clock);
        seen.minutes.add(minute);
        seen.hours.add(hour);
        seen.days.add(day);
        if (i % TICKS_PER_MINUTE === 0) expect((day * 24 + hour) * 60 + minute).toBe(clock.gameMinute);
        clock.advance();
      }
      expect([...seen.minutes].sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i));
      expect([...seen.hours].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i));
      expect([...seen.days].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
      expect(calendar(clock)).toEqual([0, 0, 0]);
    });

    it('odvodzuje sa z tickových konštánt (tickGameSeconds 5: 12 tickov/min)', () => {
      const clock = new SimClock({ tickGameSeconds: 5 }, { tick: 17_280 + 720 * 13 + 12 * 42 + 11, speed: 1 });
      expect(calendar(clock)).toEqual([42, 13, 1]);
    });
  });

  describe('advance()', () => {
    it('zvýši tick o 1', () => {
      const clock = new SimClock(CFG);
      clock.advance();
      clock.advance();
      expect(clock.tick).toBe(2);
    });

    it('hourClosed je true presne raz za 360 ticků (na 360.) a potom znova na 720.', () => {
      const clock = new SimClock(CFG);
      const closedAt: number[] = [];
      for (let i = 0; i < 2 * TICKS_PER_HOUR; i++) {
        if (clock.advance().hourClosed) closedAt.push(clock.tick);
      }
      expect(closedAt).toEqual([TICKS_PER_HOUR, 2 * TICKS_PER_HOUR]);
    });

    it('dayClosed sa uzavrie na 8 640. ticku (spolu s hodinou), nie skôr', () => {
      const clock = new SimClock(CFG);
      advanceN(clock, TICKS_PER_DAY - 1);
      expect(clock.gameDay).toBe(0);
      const last = clock.advance();
      expect(last).toEqual({ hourClosed: true, dayClosed: true, monthClosed: false });
      expect(clock.tick).toBe(TICKS_PER_DAY);
      expect(clock.gameDay).toBe(1);
    });

    it('celý mesiac: 720 hodín, 30 dní a 1 mesiac, každý na správnom ticku', () => {
      const clock = new SimClock(CFG);
      const hourTicks: number[] = [];
      const dayTicks: number[] = [];
      const monthTicks: number[] = [];
      for (let i = 0; i < TICKS_PER_MONTH; i++) {
        const b: ClockBoundaries = clock.advance();
        if (b.hourClosed) hourTicks.push(clock.tick);
        if (b.dayClosed) dayTicks.push(clock.tick);
        if (b.monthClosed) monthTicks.push(clock.tick);
        // Hierarchia: uzavretý mesiac ⊂ uzavretý deň ⊂ uzavretá hodina.
        if (b.monthClosed) expect(b.dayClosed).toBe(true);
        if (b.dayClosed) expect(b.hourClosed).toBe(true);
      }
      expect(hourTicks).toHaveLength(30 * 24);
      expect(hourTicks[0]).toBe(TICKS_PER_HOUR);
      expect(dayTicks).toHaveLength(30);
      expect(dayTicks[0]).toBe(TICKS_PER_DAY);
      expect(dayTicks[29]).toBe(TICKS_PER_MONTH);
      expect(monthTicks).toEqual([TICKS_PER_MONTH]);
      expect(clock.gameMonth).toBe(1);
    });

    it('rýchlosť nemení počet ticků — advance ju ignoruje (ticky riadi GameLoop)', () => {
      const clock = new SimClock(CFG);
      clock.setSpeed(0);
      clock.advance();
      expect(clock.tick).toBe(1);
    });
  });

  describe('setSpeed()', () => {
    it('nastaví rýchlosť vrátane 0 (pauza)', () => {
      const clock = new SimClock(CFG);
      clock.setSpeed(4);
      expect(clock.speed).toBe(4);
      clock.setSpeed(0);
      expect(clock.speed).toBe(0);
    });

    it('odmietne záporné, necelé a nefinitné hodnoty a rýchlosť nezmení', () => {
      const clock = new SimClock(CFG);
      clock.setSpeed(2);
      expect(() => clock.setSpeed(-1)).toThrow(RangeError);
      expect(() => clock.setSpeed(1.5)).toThrow(RangeError);
      expect(() => clock.setSpeed(Number.NaN)).toThrow(RangeError);
      expect(() => clock.setSpeed(Number.POSITIVE_INFINITY)).toThrow(RangeError);
      expect(clock.speed).toBe(2);
    });
  });

  describe('serializácia stavu', () => {
    it('getState → fromState (aj cez JSON) pokračuje identicky', () => {
      const original = new SimClock(CFG);
      original.setSpeed(4);
      advanceN(original, 1234);

      const saved = JSON.parse(JSON.stringify(original.getState())) as { tick: number; speed: number };
      const restored = SimClock.fromState(CFG, saved);
      expect(restored.getState()).toEqual({ tick: 1234, speed: 4 });

      for (let i = 0; i < TICKS_PER_DAY; i++) {
        expect(restored.advance()).toEqual(original.advance());
      }
      expect(restored.getState()).toEqual(original.getState());
    });

    it('getState vracia kópiu — neskoršie advance stav uloženého objektu nezmení', () => {
      const clock = new SimClock(CFG);
      const saved = clock.getState();
      clock.advance();
      expect(saved.tick).toBe(0);
    });

    it('fromState odmietne neplatný tick alebo rýchlosť', () => {
      expect(() => SimClock.fromState(CFG, { tick: -1, speed: 1 })).toThrow(RangeError);
      expect(() => SimClock.fromState(CFG, { tick: 1.5, speed: 1 })).toThrow(RangeError);
      expect(() => SimClock.fromState(CFG, { tick: Number.NaN, speed: 1 })).toThrow(RangeError);
      expect(() => SimClock.fromState(CFG, { tick: 0, speed: -2 })).toThrow(RangeError);
    });
  });
});
