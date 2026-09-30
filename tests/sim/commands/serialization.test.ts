import { describe, expect, it } from 'vitest';
import {
  CommandError,
  PlaceModuleCommand,
  PlaceRoadCommand,
  RemoveModuleCommand,
  RemoveRoadCommand,
  SetGameSpeedCommand,
  commandFromJSON,
  type SerializedCommand,
} from '@sim/commands';

/** Tvary zo „Spoločných rozhraní" F1 — vrátane duplicít, poradia „naopak" a buniek mimo mapy. */
const ROUNDTRIP_CASES: readonly [string, SerializedCommand][] = [
  ['PlaceRoad', { type: 'PlaceRoad', cells: [{ x: 30, y: 30 }] }],
  ['PlaceRoad bez normalizácie poradia a s duplicitami', { type: 'PlaceRoad', cells: [{ x: 5, y: 2 }, { x: 1, y: 9 }, { x: 5, y: 2 }] }],
  ['PlaceRoad s prázdnym zoznamom', { type: 'PlaceRoad', cells: [] }],
  ['PlaceRoad mimo mapy (záporné súradnice)', { type: 'PlaceRoad', cells: [{ x: -3, y: 1000 }] }],
  ['RemoveRoad', { type: 'RemoveRoad', cells: [{ x: 44, y: 14 }, { x: 44, y: 15 }] }],
  ['SetGameSpeed 4', { type: 'SetGameSpeed', speed: 4 }],
  ['SetGameSpeed 0', { type: 'SetGameSpeed', speed: 0 }],
  ['SetGameSpeed mimo time.speeds (overí až validate)', { type: 'SetGameSpeed', speed: 3 }],
  // F2 (T02-04): tvary zo „Spoločných rozhraní" F2 — hodnoty mimo sveta overí až validate (unknown_def, invalid_rotation…).
  ['PlaceModule', { type: 'PlaceModule', defId: 'berth_standard', x: 48, y: 14, rotation: 0 }],
  ['PlaceModule žeriav otočený', { type: 'PlaceModule', defId: 'crane_container_gantry', x: 43, y: 14, rotation: 270 }],
  ['PlaceModule s neznámym defom, rotáciou 45 a mimo mapy', { type: 'PlaceModule', defId: 'nope', x: -5, y: 900, rotation: 45 }],
  ['RemoveModule', { type: 'RemoveModule', moduleId: 7 }],
  ['RemoveModule s id, ktoré neexistuje', { type: 'RemoveModule', moduleId: 0 }],
];

describe('commandFromJSON ↔ toJSON', () => {
  it.each(ROUNDTRIP_CASES)('%s: commandFromJSON(json).toJSON() toEqual json', (_name, json) => {
    const command = commandFromJSON(json);
    expect(command.type).toBe(json.type);
    expect(command.toJSON()).toEqual(json);
  });

  it.each(ROUNDTRIP_CASES)('%s: prežije aj JSON.stringify/parse (replay zo súboru)', (_name, json) => {
    const text = JSON.stringify(commandFromJSON(json).toJSON());
    expect(commandFromJSON(JSON.parse(text) as SerializedCommand).toJSON()).toEqual(json);
  });

  it('vráti inštanciu správnej triedy', () => {
    expect(commandFromJSON({ type: 'PlaceRoad', cells: [] })).toBeInstanceOf(PlaceRoadCommand);
    expect(commandFromJSON({ type: 'RemoveRoad', cells: [] })).toBeInstanceOf(RemoveRoadCommand);
    expect(commandFromJSON({ type: 'SetGameSpeed', speed: 1 })).toBeInstanceOf(SetGameSpeedCommand);
    expect(commandFromJSON({ type: 'PlaceModule', defId: 'berth_standard', x: 1, y: 2, rotation: 90 })).toBeInstanceOf(PlaceModuleCommand);
    expect(commandFromJSON({ type: 'RemoveModule', moduleId: 3 })).toBeInstanceOf(RemoveModuleCommand);
  });

  it('príkaz vytvorený v kóde má rovnaký tvar ako zo JSON', () => {
    expect(new PlaceRoadCommand([{ x: 1, y: 2 }]).toJSON()).toEqual({ type: 'PlaceRoad', cells: [{ x: 1, y: 2 }] });
    expect(new RemoveRoadCommand([{ x: 1, y: 2 }]).toJSON()).toEqual({ type: 'RemoveRoad', cells: [{ x: 1, y: 2 }] });
    expect(new SetGameSpeedCommand(2).toJSON()).toEqual({ type: 'SetGameSpeed', speed: 2 });
    expect(new PlaceModuleCommand({ defId: 'berth_standard', x: 48, y: 14, rotation: 0 }).toJSON()).toEqual({
      type: 'PlaceModule',
      defId: 'berth_standard',
      x: 48,
      y: 14,
      rotation: 0,
    });
    expect(new RemoveModuleCommand(7).toJSON()).toEqual({ type: 'RemoveModule', moduleId: 7 });
  });

  it('príkaz nezdieľa stav so vstupom ani s výstupom toJSON', () => {
    const input = [{ x: 1, y: 2 }];
    const json = { type: 'PlaceRoad', cells: input };
    const command = commandFromJSON(json);
    input[0].x = 99;
    input.push({ x: 7, y: 7 });
    const out = command.toJSON();
    expect(out).toEqual({ type: 'PlaceRoad', cells: [{ x: 1, y: 2 }] });
    (out.cells as { x: number }[])[0].x = 42;
    expect(command.toJSON()).toEqual({ type: 'PlaceRoad', cells: [{ x: 1, y: 2 }] });

    const cells = [{ x: 3, y: 4 }];
    const built = new RemoveRoadCommand(cells);
    cells[0].y = 0;
    expect(built.cells).toEqual([{ x: 3, y: 4 }]);
    expect(Object.isFrozen(built.cells)).toBe(true);
  });
});

describe('commandFromJSON — neplatný vstup → CommandError', () => {
  it('neznámy typ', () => {
    expect(() => commandFromJSON({ type: 'BuyParcel', parcelId: 'x' })).toThrow(CommandError);
    expect(() => commandFromJSON({ type: 'BuyParcel', parcelId: 'x' })).toThrow(/neznámy typ príkazu 'BuyParcel'/);
    expect(() => commandFromJSON({ type: 'placeRoad', cells: [] })).toThrow(/neznámy typ príkazu 'placeRoad'/);
  });

  const BAD: readonly [string, unknown, RegExp][] = [
    ['PlaceRoad bez cells', { type: 'PlaceRoad' }, /PlaceRoad\/cells: chýba povinný kľúč/],
    ['PlaceRoad s neznámym kľúčom', { type: 'PlaceRoad', cells: [], rotation: 90 }, /PlaceRoad\/rotation: neznámy kľúč/],
    ['cells nie je pole', { type: 'PlaceRoad', cells: { x: 1, y: 2 } }, /PlaceRoad\/cells: musí byť pole/],
    ['bunka nie je objekt', { type: 'PlaceRoad', cells: [[1, 2]] }, /PlaceRoad\/cells\/0: musí byť objekt/],
    ['bunka null', { type: 'RemoveRoad', cells: [null] }, /RemoveRoad\/cells\/0: musí byť objekt/],
    ['bunke chýba y', { type: 'PlaceRoad', cells: [{ x: 1, y: 2 }, { x: 1 }] }, /PlaceRoad\/cells\/1\/y: chýba povinný kľúč/],
    ['bunka má navyše kľúč', { type: 'RemoveRoad', cells: [{ x: 1, y: 2, layer: 'road' }] }, /RemoveRoad\/cells\/0\/layer: neznámy kľúč/],
    ['necelá súradnica', { type: 'PlaceRoad', cells: [{ x: 1.5, y: 2 }] }, /PlaceRoad\/cells\/0\/x: súradnica musí byť celé číslo/],
    ['súradnica ako reťazec', { type: 'PlaceRoad', cells: [{ x: 1, y: '2' }] }, /PlaceRoad\/cells\/0\/y: súradnica musí byť celé číslo/],
    ['SetGameSpeed bez speed', { type: 'SetGameSpeed' }, /SetGameSpeed\/speed: chýba povinný kľúč/],
    ['speed ako reťazec', { type: 'SetGameSpeed', speed: '4' }, /SetGameSpeed\/speed: musí byť konečné číslo/],
    ['speed null', { type: 'SetGameSpeed', speed: null }, /SetGameSpeed\/speed: musí byť konečné číslo/],
    ['SetGameSpeed s neznámym kľúčom', { type: 'SetGameSpeed', speed: 4, pause: true }, /SetGameSpeed\/pause: neznámy kľúč/],
    ['PlaceModule bez rotation', { type: 'PlaceModule', defId: 'berth_standard', x: 1, y: 2 }, /PlaceModule\/rotation: chýba povinný kľúč/],
    ['PlaceModule s neznámym kľúčom', { type: 'PlaceModule', defId: 'berth_standard', x: 1, y: 2, rotation: 0, cost: 1 }, /PlaceModule\/cost: neznámy kľúč/],
    ['PlaceModule: rotácia ako reťazec (štrukturálne)', { type: 'PlaceModule', defId: 'berth_standard', x: 1, y: 2, rotation: '90' }, /PlaceModule\/rotation: musí byť konečné číslo/],
    ['PlaceModule: rotácia null', { type: 'PlaceModule', defId: 'berth_standard', x: 1, y: 2, rotation: null }, /PlaceModule\/rotation: musí byť konečné číslo/],
    ['PlaceModule: defId nie je reťazec', { type: 'PlaceModule', defId: 7, x: 1, y: 2, rotation: 0 }, /PlaceModule\/defId: musí byť reťazec/],
    ['PlaceModule: necelé x', { type: 'PlaceModule', defId: 'berth_standard', x: 1.5, y: 2, rotation: 0 }, /PlaceModule\/x: súradnica musí byť celé číslo/],
    ['PlaceModule: y ako reťazec', { type: 'PlaceModule', defId: 'berth_standard', x: 1, y: '2', rotation: 0 }, /PlaceModule\/y: súradnica musí byť celé číslo/],
    ['RemoveModule bez moduleId', { type: 'RemoveModule' }, /RemoveModule\/moduleId: chýba povinný kľúč/],
    ['RemoveModule: necelé moduleId', { type: 'RemoveModule', moduleId: 1.5 }, /RemoveModule\/moduleId: musí byť celé číslo/],
    ['RemoveModule: moduleId ako reťazec', { type: 'RemoveModule', moduleId: '7' }, /RemoveModule\/moduleId: musí byť celé číslo/],
    ['RemoveModule s neznámym kľúčom', { type: 'RemoveModule', moduleId: 7, refund: 0 }, /RemoveModule\/refund: neznámy kľúč/],
  ];

  it.each(BAD)('%s', (_name, json, message) => {
    expect(() => commandFromJSON(json as SerializedCommand)).toThrow(CommandError);
    expect(() => commandFromJSON(json as SerializedCommand)).toThrow(message);
  });

  it('statické fromJSON odmietne iný typ príkazu', () => {
    expect(() => PlaceRoadCommand.fromJSON({ type: 'RemoveRoad', cells: [] })).toThrow(/PlaceRoad\/type: očakávaný typ 'PlaceRoad'/);
    expect(() => RemoveRoadCommand.fromJSON({ type: 'PlaceRoad', cells: [] })).toThrow(CommandError);
    expect(() => SetGameSpeedCommand.fromJSON({ type: 'PlaceRoad', speed: 1 })).toThrow(CommandError);
    expect(() => PlaceModuleCommand.fromJSON({ type: 'RemoveModule', defId: 'x', x: 0, y: 0, rotation: 0 })).toThrow(/PlaceModule\/type/);
    expect(() => RemoveModuleCommand.fromJSON({ type: 'PlaceModule', moduleId: 1 })).toThrow(/RemoveModule\/type/);
  });

  it('konštruktor odmietne necelé súradnice (príkaz vždy prežije toJSON → commandFromJSON)', () => {
    expect(() => new PlaceRoadCommand([{ x: 0.5, y: 0 }])).toThrow(/PlaceRoad\/cells\/0\/x/);
    expect(() => new RemoveRoadCommand([{ x: 0, y: Number.NaN }])).toThrow(CommandError);
    expect(() => new PlaceRoadCommand([{ x: Number.MAX_SAFE_INTEGER + 1, y: 0 }])).toThrow(CommandError);
    expect(() => new PlaceModuleCommand({ defId: 'berth_standard', x: 0.5, y: 0, rotation: 0 })).toThrow(/PlaceModule\/x/);
    expect(() => new PlaceModuleCommand({ defId: 'berth_standard', x: 0, y: 0, rotation: Number.NaN })).toThrow(/PlaceModule\/rotation/);
    expect(() => new RemoveModuleCommand(Number.POSITIVE_INFINITY)).toThrow(/RemoveModule\/moduleId/);
  });
});
