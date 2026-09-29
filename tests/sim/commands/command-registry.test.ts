import { describe, expect, it } from 'vitest';
import {
  CommandError,
  CommandRegistry,
  VALIDATION_REASONS,
  commandFromJSON,
  type Command,
  type SerializedCommand,
} from '@sim/commands';

/** Minimálny príkaz pre register (World sa tu nepotrebuje). */
function fakeCommand(json: SerializedCommand): Command {
  return {
    type: json.type,
    validate: () => ({ ok: true, reasons: [], cells: [], costCents: 0 }),
    apply: () => undefined,
    toJSON: () => json,
  };
}

describe('CommandRegistry (kostra T01-03)', () => {
  it('fromJSON zavolá factory registrovaného typu s celým JSON a toJSON ho vráti', () => {
    const registry = new CommandRegistry();
    const received: SerializedCommand[] = [];
    registry.register('Fake', (json) => {
      received.push(json);
      return fakeCommand(json);
    });
    const json = { type: 'Fake', cells: [{ x: 1, y: 2 }] };
    const command = registry.fromJSON(json);
    expect(received).toEqual([json]);
    expect(command.type).toBe('Fake');
    expect(command.toJSON()).toEqual(json);
  });

  it('types v poradí registrácie, has', () => {
    const registry = new CommandRegistry();
    registry.register('B', fakeCommand);
    registry.register('A', fakeCommand);
    expect(registry.types).toEqual(['B', 'A']);
    expect(registry.has('A')).toBe(true);
    expect(registry.has('C')).toBe(false);
  });

  it('duplicitný alebo prázdny typ pri registrácii → CommandError', () => {
    const registry = new CommandRegistry();
    registry.register('Fake', fakeCommand);
    expect(() => registry.register('Fake', fakeCommand)).toThrow(CommandError);
    expect(() => registry.register('', fakeCommand)).toThrow(CommandError);
  });

  it('neznámy typ → CommandError so zoznamom registrovaných typov', () => {
    const registry = new CommandRegistry();
    registry.register('Fake', fakeCommand);
    expect(() => registry.fromJSON({ type: 'Nope' })).toThrow(/neznámy typ príkazu 'Nope' \(registrované: Fake\)/);
  });

  it.each([null, 42, 'PlaceRoad', [], {}, { type: '' }, { type: 7 }])('neplatný tvar %j → CommandError', (raw) => {
    const registry = new CommandRegistry();
    registry.register('Fake', fakeCommand);
    expect(() => registry.fromJSON(raw as unknown as SerializedCommand)).toThrow(CommandError);
  });

  it('commandFromJSON (predvolený register) odmietne neznámy typ', () => {
    expect(() => commandFromJSON({ type: 'DefinitelyNotACommand' })).toThrow(CommandError);
  });

  it('VALIDATION_REASONS zodpovedajú „Spoločným rozhraniam" F1', () => {
    expect([...VALIDATION_REASONS]).toEqual([
      'out_of_bounds',
      'terrain',
      'occupied',
      'parcel_not_owned',
      'insufficient_funds',
      'no_road',
      'invalid_speed',
      'empty',
    ]);
  });
});
