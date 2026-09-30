// SpawnShipDebug (T02-05, ADR-016; docs/tasks/phase-02.md rozhodnutie 8): JSON tvar a roundtrip, validácia
// (unknown_ship_class, unknown_cargo, cargo_incompatible, invalid_units — všetky naraz, cena 0, bez buniek), apply
// (loď na seaLane[0], jednotky on_ship s id po lodi, ShipSpawned, hotovosť bez zmeny) a registrácia v registri.
import { describe, expect, it } from 'vitest';
import { CommandError, SpawnShipDebugCommand, commandFromJSON, commandRegistry, type SerializedCommand } from '@sim/commands';
import { BULKER, GRAIN, SHIP_DEFS, TEU, newWorld } from '../ships/ship-fixtures';

const JSON_SPAWN: SerializedCommand = { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 };
const spawnCommand = (shipClassId: string, cargoTypeId: string, units: number): SpawnShipDebugCommand =>
  new SpawnShipDebugCommand({ shipClassId, cargoTypeId, units });

describe('SpawnShipDebug — JSON', () => {
  it('je registrovaný vždy a commandFromJSON(json).toJSON() vráti rovnaký tvar', () => {
    expect(commandRegistry.types).toContain('SpawnShipDebug');
    const command = commandFromJSON(JSON_SPAWN);
    expect(command).toBeInstanceOf(SpawnShipDebugCommand);
    expect(command.toJSON()).toEqual(JSON_SPAWN);
    expect(Object.keys(command.toJSON())).toEqual(['type', 'shipClassId', 'cargoTypeId', 'units']);
  });

  it('necelé units prejdú parserom (odmietne ich až validate ako invalid_units) a zachovajú sa v toJSON', () => {
    expect(commandFromJSON({ ...JSON_SPAWN, units: 1.5 }).toJSON()).toEqual({ ...JSON_SPAWN, units: 1.5 });
  });

  it.each<[string, SerializedCommand, RegExp]>([
    ['chýba units', { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: TEU }, /SpawnShipDebug\/units: chýba povinný kľúč/],
    ['neznámy kľúč', { ...JSON_SPAWN, x: 1 }, /SpawnShipDebug\/x: neznámy kľúč/],
    ['shipClassId číslo', { ...JSON_SPAWN, shipClassId: 7 }, /SpawnShipDebug\/shipClassId: musí byť reťazec/],
    ['cargoTypeId null', { ...JSON_SPAWN, cargoTypeId: null }, /SpawnShipDebug\/cargoTypeId: musí byť reťazec/],
    ['units reťazec', { ...JSON_SPAWN, units: '4' }, /SpawnShipDebug\/units: musí byť konečné číslo/],
  ])('%s → CommandError', (_name, json, message) => {
    expect(() => commandFromJSON(json)).toThrow(CommandError);
    expect(() => commandFromJSON(json)).toThrow(message);
  });

  it('konštruktor odmietne ne-objekt a nekonečné units', () => {
    expect(() => new SpawnShipDebugCommand(null as never)).toThrow(CommandError);
    expect(() => spawnCommand('feeder', TEU, Number.POSITIVE_INFINITY)).toThrow(CommandError);
  });
});

describe('SpawnShipDebug — validate', () => {
  const world = newWorld();

  it('platný príkaz: ok, bez buniek, cena 0', () => {
    expect(spawnCommand('feeder', TEU, 4).validate(world)).toEqual({ ok: true, reasons: [], cells: [], costCents: 0 });
    expect(spawnCommand('handy', TEU, SHIP_DEFS.ships.get('handy').capacityUnits).validate(world).ok).toBe(true);
  });

  it.each<[string, SpawnShipDebugCommand, readonly string[]]>([
    ['neznáma trieda', spawnCommand('panamax_x', TEU, 4), ['unknown_ship_class']],
    ['neznámy náklad', spawnCommand('feeder', 'bananas', 4), ['unknown_cargo']],
    ['náklad mimo kategórií triedy', spawnCommand(BULKER, TEU, 4), ['cargo_incompatible']],
    ['kompatibilný sypký náklad', spawnCommand(BULKER, GRAIN, 4), []],
    ['units 0', spawnCommand('feeder', TEU, 0), ['invalid_units']],
    ['units záporné', spawnCommand('feeder', TEU, -3), ['invalid_units']],
    ['units necelé', spawnCommand('feeder', TEU, 2.5), ['invalid_units']],
    ['units nad capacityUnits', spawnCommand('feeder', TEU, SHIP_DEFS.ships.get('feeder').capacityUnits + 1), ['invalid_units']],
    ['neznáma trieda aj náklad aj units 0', spawnCommand('x', 'y', 0), ['unknown_ship_class', 'unknown_cargo', 'invalid_units']],
    ['neznáma trieda — kapacita sa neoveruje, len celé ≥ 1', spawnCommand('x', TEU, 100000), ['unknown_ship_class']],
  ])('%s → %o', (_name, command, reasons) => {
    const result = command.validate(world);
    expect(result.reasons).toEqual(reasons);
    expect(result.ok).toBe(reasons.length === 0);
    expect(result.cells).toEqual([]);
    expect(result.costCents).toBe(0);
  });
});

describe('SpawnShipDebug — apply', () => {
  it('loď inbound v strede seaLane[0] s kurzom prvého úseku, jednotky on_ship s id po lodi, ShipSpawned, hotovosť bez zmeny', () => {
    const world = newWorld();
    const cash = world.cashCents;
    const firstId = world.ids.getState().nextId;
    world.enqueue(spawnCommand('feeder', TEU, 3));
    const events = world.applyPending();

    expect(events).toEqual([{ type: 'ShipSpawned', shipId: firstId, classId: 'feeder', cargoTypeId: TEU, units: 3 }]);
    const ship = world.ships.get(firstId as never);
    expect(ship).toMatchObject({ state: 'inbound', x: 48.5, y: 0.5, heading: 180, berthIds: [], anchorageIndex: null, waypointIndex: 0 });
    expect(world.cargo.unitsOnShip(firstId as never)).toEqual([firstId + 1, firstId + 2, firstId + 3]);
    expect(world.cargo.createdCount).toBe(3);
    expect(world.cashCents).toBe(cash);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('neplatný príkaz vo fronte → CommandRejected, nič nevznikne; apply bez validate vyhodí Error', () => {
    const world = newWorld();
    world.enqueue(spawnCommand('feeder', TEU, 0));
    expect(world.applyPending()).toEqual([{ type: 'CommandRejected', commandType: 'SpawnShipDebug', reasons: ['invalid_units'] }]);
    expect(world.ships.size).toBe(0);
    expect(() => spawnCommand('nope', TEU, 1).apply(world)).toThrow(/nie je platný \(unknown_ship_class\)/);
    expect(world.cargo.createdCount).toBe(0);
  });
});
