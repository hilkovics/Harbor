// Koniec hry centrálne (T05-04, ADR-027; ADR-025 bod 5): po `GameOver` vráti `validate` každého príkazu odmietnutie
// s jediným dôvodom `game_over` (základ `SimCommand`), bunky a cena ostávajú pre ghost; `RoadLayerCommand.quote` tiež.
// `World.applyQueuedCommands` odmietne po `GameOver` aj príkaz, ktorý `SimCommand` nededí. Svet po bankrote sa tu
// pripraví zo save s `economy.gameOver = true` (bankrot sám testuje tests/sim/economy/economy-bankruptcy.test.ts).
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_COMMANDS,
  PlaceRoadCommand,
  SimCommand,
  commandFromJSON,
  withGameOver,
  type Command,
  type SerializedCommand,
  type ValidationResult,
} from '@sim/commands';
import { World, type WorldState } from '@sim/world';
import { DEFS, MAP } from '../world/world-fixtures';

const SEED = 5501;

/** Po jednej vzorke každého vstavaného príkazu (platnej aj neplatnej — po GameOver na tom nezáleží). */
const SAMPLES: readonly SerializedCommand[] = [
  { type: 'PlaceRoad', cells: [{ x: 41, y: 17 }, { x: 41, y: 18 }] },
  { type: 'RemoveRoad', cells: [{ x: 44, y: 34 }] },
  { type: 'SetGameSpeed', speed: 2 },
  { type: 'PlaceModule', defId: 'container_yard_small', x: 42, y: 18, rotation: 0 },
  { type: 'RemoveModule', moduleId: 2 },
  { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 12 },
  { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: 1 },
  { type: 'SellVehicle', vehicleId: 99 },
  { type: 'AcceptContract', contractId: 1 },
  { type: 'DeclineContract', contractId: 1 },
];

/** Svet po prvom ticku (pool ponúk existuje) a jeho kópia zo save s `gameOver = true`. */
function worlds(): { readonly alive: World; readonly over: World } {
  const alive = World.create(DEFS, MAP, SEED);
  alive.tick();
  const state = JSON.parse(JSON.stringify(alive.serialize())) as WorldState;
  const over = World.deserialize(DEFS, MAP, { ...state, economy: { ...state.economy, gameOver: true } });
  return { alive, over };
}

const plain = (result: ValidationResult) => ({ ok: result.ok, reasons: [...result.reasons], cells: result.cells, costCents: result.costCents });

describe('game_over pre všetky príkazy (SimCommand.validate)', () => {
  it('vzorky pokrývajú všetky vstavané príkazy a každý z nich dedí SimCommand', () => {
    expect(SAMPLES.map((sample) => sample.type).sort()).toEqual(BUILTIN_COMMANDS.map((command) => command.TYPE).sort());
    for (const sample of SAMPLES) expect(commandFromJSON(sample), sample.type).toBeInstanceOf(SimCommand);
  });

  it('pred GameOver sa výsledok nemení; po ňom je jediný dôvod game_over a bunky aj cena zostanú', () => {
    const { alive, over } = worlds();
    expect([alive.gameOver, over.gameOver]).toEqual([false, true]);
    expect(commandFromJSON(SAMPLES[0]).validate(alive).ok).toBe(true);
    expect(commandFromJSON({ type: 'AcceptContract', contractId: 1 }).validate(alive).ok).toBe(true);
    for (const sample of SAMPLES) {
      const before = commandFromJSON(sample).validate(alive);
      expect(before.reasons, sample.type).not.toContain('game_over');
      const after = commandFromJSON(sample).validate(over);
      expect(plain(after), sample.type).toEqual({ ok: false, reasons: ['game_over'], cells: before.cells, costCents: before.costCents });
      expect(Object.isFrozen(after), sample.type).toBe(true);
    }
  });

  it('RoadLayerCommand.quote po GameOver: game_over so zachovaným rozpadom ceny; apply vyhodí a svet nezmení', () => {
    const { alive, over } = worlds();
    const command = new PlaceRoadCommand([{ x: 41, y: 17 }]);
    const before = command.quote(alive);
    const after = command.quote(over);
    expect(after).toEqual({ ...before, ok: false, reasons: ['game_over'] });
    const cash = over.cashCents;
    expect(() => command.apply(over)).toThrow(/game_over/);
    expect(over.cashCents).toBe(cash);
    expect(over.grid.at(41, 17).road).toBe('none');
  });

  it('World po GameOver odmietne každý príkaz vo fronte s CommandRejected(game_over) a nič nezmení', () => {
    const { over } = worlds();
    const hash = JSON.stringify(over.serialize());
    for (const sample of SAMPLES) over.enqueue(commandFromJSON(sample));
    const events = over.applyPending();
    expect(events.map((event) => (event.type === 'CommandRejected' ? [event.commandType, [...event.reasons]] : event.type))).toEqual(
      SAMPLES.map((sample) => [sample.type, ['game_over']]),
    );
    expect(JSON.stringify(over.serialize())).toBe(hash);
  });

  it('príkaz mimo základu SimCommand: World ho po GameOver odmietne (withGameOver pri dispatchi), inak aplikuje', () => {
    const applied: string[] = [];
    const custom: Command = {
      type: 'CustomProbe',
      validate: () => Object.freeze({ ok: true, reasons: Object.freeze([]), cells: Object.freeze([]), costCents: 0 }),
      apply: () => {
        applied.push('apply');
      },
      toJSON: () => ({ type: 'CustomProbe' }),
    };
    const { alive, over } = worlds();
    alive.enqueue(custom);
    expect(alive.applyPending()).toEqual([]);
    expect(applied).toEqual(['apply']);
    over.enqueue(custom);
    expect(over.applyPending()).toEqual([{ type: 'CommandRejected', commandType: 'CustomProbe', reasons: ['game_over'] }]);
    expect(applied).toEqual(['apply']);
  });

  it('withGameOver je idempotentné a pred GameOver vráti ten istý objekt', () => {
    const { alive, over } = worlds();
    const result = commandFromJSON(SAMPLES[0]).validate(alive);
    expect(withGameOver(alive, result)).toBe(result);
    const once = withGameOver(over, result);
    expect(withGameOver(over, once)).toEqual(once);
  });
});
