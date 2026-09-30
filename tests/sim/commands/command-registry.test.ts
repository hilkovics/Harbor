import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_COMMANDS,
  CommandError,
  CommandRegistry,
  PlaceRoadCommand,
  RemoveRoadCommand,
  SetGameSpeedCommand,
  VALIDATION_REASONS,
  PlaceModuleCommand,
  RemoveModuleCommand,
  commandFromJSON,
  commandRegistry,
  orderReasons,
  registerBuiltinCommands,
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

  it('nová CommandRegistry je prázdna (vstavané príkazy má len predvolený register)', () => {
    expect(new CommandRegistry().types).toEqual([]);
  });

  it('VALIDATION_REASONS zodpovedajú „Spoločným rozhraniam" F1 + F2 + F3 (staršie ostávajú na začiatku v pôvodnom poradí)', () => {
    expect([...VALIDATION_REASONS]).toEqual([
      'out_of_bounds',
      'terrain',
      'occupied',
      'parcel_not_owned',
      'insufficient_funds',
      'no_road',
      'invalid_speed',
      'empty',
      'unknown_def',
      'no_water_side',
      'water_blocked',
      'no_berth',
      'rotation_mismatch',
      'max_cranes',
      'has_cranes',
      'has_cargo',
      'ship_docked',
      'busy',
      'unknown_module',
      'unknown_ship_class',
      'unknown_cargo',
      'cargo_incompatible',
      'invalid_units',
      'invalid_rotation',
      // F3 (docs/tasks/phase-03.md „Spoločné rozhrania", T03-02, ADR-017)
      'unknown_vehicle_def',
      'unknown_depot',
      'depot_full',
      'not_connected',
      'unknown_vehicle',
      'vehicle_busy',
      'has_vehicles',
      'connector_blocked',
    ]);
    expect(new Set(VALIDATION_REASONS).size).toBe(VALIDATION_REASONS.length);
  });

  it('orderReasons: kanonické poradie VALIDATION_REASONS, bez duplicít, zmrazené', () => {
    const ordered = orderReasons(new Set(['invalid_rotation', 'occupied', 'unknown_def', 'out_of_bounds'] as const));
    expect(ordered).toEqual(['out_of_bounds', 'occupied', 'unknown_def', 'invalid_rotation']);
    expect(Object.isFrozen(ordered)).toBe(true);
    expect(orderReasons(new Set())).toEqual([]);
  });
});

describe('vstavané príkazy (T01-04, T02-04, T02-05)', () => {
  it('predvolený register pozná PlaceRoad, RemoveRoad, SetGameSpeed, PlaceModule, RemoveModule, SpawnShipDebug v poradí BUILTIN_COMMANDS', () => {
    expect(commandRegistry.types).toEqual(['PlaceRoad', 'RemoveRoad', 'SetGameSpeed', 'PlaceModule', 'RemoveModule', 'SpawnShipDebug']);
    expect(BUILTIN_COMMANDS.map((command) => command.TYPE)).toEqual(commandRegistry.types);
  });

  it('TYPE triedy = type inštancie = toJSON().type', () => {
    const instances = [
      new PlaceRoadCommand([]),
      new RemoveRoadCommand([]),
      new SetGameSpeedCommand(1),
      new PlaceModuleCommand({ defId: 'berth_standard', x: 0, y: 0, rotation: 0 }),
      new RemoveModuleCommand(1),
    ];
    const types = ['PlaceRoad', 'RemoveRoad', 'SetGameSpeed', 'PlaceModule', 'RemoveModule'];
    expect(instances.map((command) => command.type)).toEqual(types);
    expect(instances.map((command) => command.toJSON().type)).toEqual(types);
    expect([PlaceRoadCommand.TYPE, RemoveRoadCommand.TYPE, SetGameSpeedCommand.TYPE, PlaceModuleCommand.TYPE, RemoveModuleCommand.TYPE]).toEqual(
      instances.map((c) => c.type),
    );
  });

  it('registerBuiltinCommands naplní nový register; opakovaná registrácia → CommandError', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    expect(registry.types).toEqual(commandRegistry.types);
    expect(registry.fromJSON({ type: 'SetGameSpeed', speed: 2 }).toJSON()).toEqual({ type: 'SetGameSpeed', speed: 2 });
    expect(() => registerBuiltinCommands(registry)).toThrow(CommandError);
    expect(() => registerBuiltinCommands(commandRegistry)).toThrow(CommandError);
  });

  it('commandFromJSON funguje aj pri importe priamo z command-registry (register sa plní pri jeho načítaní)', async () => {
    // Čerstvý graf modulov bez `commands/index.ts` — register nesmie závisieť od importu barrelu.
    vi.resetModules();
    const direct = await import('@sim/commands/command-registry');
    expect(direct.commandRegistry).not.toBe(commandRegistry);
    expect(direct.commandRegistry.types).toEqual(['PlaceRoad', 'RemoveRoad', 'SetGameSpeed', 'PlaceModule', 'RemoveModule', 'SpawnShipDebug']);
    expect(direct.commandFromJSON({ type: 'RemoveRoad', cells: [] }).type).toBe('RemoveRoad');
  });
});
