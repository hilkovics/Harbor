import { describe, expect, it } from 'vitest';
import { CommandError, SetGameSpeedCommand } from '@sim/commands';
import { INITIAL_SPEED } from '@sim/core';
import { DEFS, hashState, newWorld } from './command-fixtures';

describe('SetGameSpeed.validate', () => {
  it.each(DEFS.time.speeds)('rýchlosť %i z time.speeds je platná (vrátane 0 = pauza)', (speed) => {
    expect(new SetGameSpeedCommand(speed).validate(newWorld())).toEqual({ ok: true, reasons: [], cells: [], costCents: 0 });
  });

  it('time.speeds obsahuje 0 a 4 (akceptácia F1)', () => {
    expect(DEFS.time.speeds).toContain(0);
    expect(DEFS.time.speeds).toContain(4);
  });

  it.each([3, -1, 1.5, 16, 5])('rýchlosť %d mimo time.speeds → invalid_speed', (speed) => {
    expect(DEFS.time.speeds).not.toContain(speed);
    expect(new SetGameSpeedCommand(speed).validate(newWorld())).toEqual({
      ok: false,
      reasons: ['invalid_speed'],
      cells: [],
      costCents: 0,
    });
  });

  it('validate nemení svet', () => {
    const world = newWorld();
    const before = hashState(world.serialize());
    new SetGameSpeedCommand(4).validate(world);
    new SetGameSpeedCommand(3).validate(world);
    expect(hashState(world.serialize())).toBe(before);
    expect(world.clock.speed).toBe(INITIAL_SPEED);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('konštruktor s %d → CommandError', (speed) => {
    expect(() => new SetGameSpeedCommand(speed)).toThrow(CommandError);
  });
});

describe('SetGameSpeed.apply', () => {
  it('SetGameSpeed(4): clock.speed = 4 a práve jeden GameSpeedChanged', () => {
    const world = newWorld();
    new SetGameSpeedCommand(4).apply(world);
    expect(world.clock.speed).toBe(4);
    expect(world.events.flush()).toEqual([{ type: 'GameSpeedChanged', speed: 4 }]);
  });

  it('SetGameSpeed(0) = pauza; nemení hotovosť ani tick', () => {
    const world = newWorld();
    const { cashCents } = world;
    new SetGameSpeedCommand(0).apply(world);
    expect(world.clock.speed).toBe(0);
    expect(world.clock.tick).toBe(0);
    expect(world.cashCents).toBe(cashCents);
  });

  it('rovnaká rýchlosť ako aktuálna: udalosť sa aj tak emituje práve raz', () => {
    const world = newWorld();
    new SetGameSpeedCommand(INITIAL_SPEED).apply(world);
    expect(world.events.flush()).toEqual([{ type: 'GameSpeedChanged', speed: INITIAL_SPEED }]);
  });

  it('rýchlosť sa uloží do serialize (clock.speed)', () => {
    const world = newWorld();
    new SetGameSpeedCommand(8).apply(world);
    expect(world.serialize().clock.speed).toBe(8);
  });

  it('apply s rýchlosťou mimo time.speeds vyhodí Error a svet nezmení', () => {
    const world = newWorld();
    expect(() => new SetGameSpeedCommand(3).apply(world)).toThrow(/SetGameSpeed\.apply/);
    expect(world.clock.speed).toBe(INITIAL_SPEED);
    expect(world.events.pending).toBe(0);
  });
});
