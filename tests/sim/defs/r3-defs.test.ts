// R3 / TR3-01 (ADR-040): `equipment.json` (RTG), `terminal_tractor` (`canLift: false`), modul `rtg_block` (role, geometria, pruh, TP) — hodnoty v bundled defoch,
// fail-fast `DefRegistry` s JSON pointerom a zhoda schém s registrom (Ajv).
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import cargoTypesJson from '@data/defs/cargo_types.json';
import containerTypesJson from '@data/defs/container_types.json';
import contractTemplatesJson from '@data/defs/contract_templates.json';
import economyJson from '@data/defs/economy.json';
import equipmentJson from '@data/defs/equipment.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import linesJson from '@data/defs/lines.json';
import logisticsJson from '@data/defs/logistics.json';
import modulesJson from '@data/defs/modules.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import trucksJson from '@data/defs/trucks.json';
import vehiclesJson from '@data/defs/vehicles.json';
import equipmentSchema from '@data/schemas/equipment.schema.json';
import modulesSchema from '@data/schemas/modules.schema.json';
import vehiclesSchema from '@data/schemas/vehicles.schema.json';
import { DefError, DefRegistry, loadBundledDefs, storageParams } from '@sim/defs';

type Json = Record<string, unknown>;

function rawDefs(): Record<string, Json> {
  return {
    time: structuredClone(timeJson),
    economy: structuredClone(economyJson),
    infrastructure: structuredClone(infrastructureJson),
    cargo_types: structuredClone(cargoTypesJson),
    modules: structuredClone(modulesJson),
    ships: structuredClone(shipsJson),
    vehicles: structuredClone(vehiclesJson),
    trucks: structuredClone(trucksJson),
    logistics: structuredClone(logisticsJson),
    contract_templates: structuredClone(contractTemplatesJson),
    lines: structuredClone(linesJson),
    container_types: structuredClone(containerTypesJson),
    equipment: structuredClone(equipmentJson),
  };
}

const itemOf = (raw: Record<string, Json>, name: string, id: string): Json => {
  const found = (raw[name]!['items'] as Json[]).find((item) => item['id'] === id);
  if (found === undefined) throw new Error(`${name}/${id} chýba`);
  return found;
};
const rtgParams = (raw: Record<string, Json>): Json => itemOf(raw, 'modules', 'rtg_block')['params'] as Json;
const rtgIndex = (raw: Record<string, Json>): number => (raw['modules']!['items'] as Json[]).findIndex((item) => item['id'] === 'rtg_block');

function errorOf(raw: Record<string, Json>): DefError {
  try {
    DefRegistry.fromRaw(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(DefError);
    return error as DefError;
  }
  throw new Error('očakávaná DefError, def prešiel');
}

describe('bundled defy R3', () => {
  const defs = loadBundledDefs();

  it('equipment.json: časy RTG a priority loď < kamión < housekeeping', () => {
    expect(defs.equipment.rtg).toEqual({ wagePerDayCents: 22_000, gantryCellsPerTick: 2, hoistTicksPerTier: 1, trolleyTicksPerRow: 1, lockTicks: 1, prefetchCells: 6, handoverGiveUpTicks: 600, priorities: { ship: 0, truck: 1, housekeeping: 2 } });
    expect(Object.isFrozen(defs.equipment.rtg)).toBe(true);
  });

  it('terminal_tractor: 1 kontajner (20′ aj 40′), dĺžka 3, canLift false; straddle a empty handler majú canLift true', () => {
    const tractor = defs.vehicles.get('terminal_tractor');
    expect(tractor).toMatchObject({ capacityUnits: 1, lengthCells: 3, canLift: false, cargoCategories: ['container'] });
    expect(defs.vehicles.get('straddle_carrier').canLift).toBe(true);
    expect(defs.vehicles.get('empty_handler').canLift).toBe(true);
  });

  it('rtg_block: footprint 5 × 12, 6 radov × 5 vrstiev, pruh v stĺpci 4 s vjazdom na severe a výjazdom na juhu, TP pri každom bayi', () => {
    const block = defs.modules.get('rtg_block');
    expect(block.kind).toBe('storage');
    expect(block.footprint).toEqual({ w: 5, h: 12 });
    expect(block.connectors).toEqual([
      { x: 4, y: 0, side: 'n', type: 'road', access: 'in' },
      { x: 4, y: 11, side: 's', type: 'road', access: 'out' },
    ]);
    expect(storageParams(block)).toEqual({ capacityUnits: 360, category: 'container', role: 'rtg_block', bays: 12, rows: 6, maxTier: 5, laneCol: 4, tpSpacingBays: 1 });
  });
});

describe('DefRegistry — equipment, canLift a rtg_block', () => {
  it('priorita musí ostro rásť v poradí ship, truck, housekeeping (/rtg/priorities/<druh>)', () => {
    const raw = rawDefs();
    ((raw['equipment']!['rtg'] as Json)['priorities'] as Json)['truck'] = 0;
    expect(errorOf(raw).path).toBe('/rtg/priorities/truck');
    expect(errorOf(raw).defName).toBe('equipment');
  });

  it.each([
    ['gantryCellsPerTick', 0],
    ['hoistTicksPerTier', 0],
    ['trolleyTicksPerRow', 1.5],
    ['lockTicks', 0],
  ])('rtg.%s = %s sa odmietne', (field, value) => {
    const raw = rawDefs();
    (raw['equipment']!['rtg'] as Json)[field] = value;
    expect(errorOf(raw).path).toBe(`/rtg/${field}`);
  });

  it('equipment.json bez rtg alebo s neznámym kľúčom sa odmietne', () => {
    const missing = rawDefs();
    delete missing['equipment']!['rtg'];
    expect(errorOf(missing).defName).toBe('equipment');
    const extra = rawDefs();
    (extra['equipment'] as Json)['agv'] = {};
    expect(errorOf(extra).path).toBe('/agv');
  });

  it('canLift musí byť boolean', () => {
    const raw = rawDefs();
    itemOf(raw, 'vehicles', 'terminal_tractor')['canLift'] = 'nie';
    expect(errorOf(raw).path).toBe(`/items/${String((raw['vehicles']!['items'] as Json[]).findIndex((item) => item['id'] === 'terminal_tractor'))}/canLift`);
  });

  it.each([
    ['laneCol', 5, 'laneCol'],
    ['bays', 13, 'bays'],
  ])('rtg_block: %s = %s leží mimo footprintu 5 × 12', (field, value, key) => {
    const raw = rawDefs();
    rtgParams(raw)[field] = value;
    expect(errorOf(raw).path).toBe(`/items/${String(rtgIndex(raw))}/params/${key}`);
  });

  it.each(['laneCol', 'tpSpacingBays', 'bays'])('rtg_block bez %s sa odmietne', (field) => {
    const raw = rawDefs();
    delete rtgParams(raw)[field];
    expect(errorOf(raw).path).toContain(`/items/${String(rtgIndex(raw))}/params/`);
  });

  it('laneCol a tpSpacingBays majú zmysel len pri role rtg_block', () => {
    const raw = rawDefs();
    (itemOf(raw, 'modules', 'container_yard_small')['params'] as Json)['laneCol'] = 1;
    expect(errorOf(raw).path).toMatch(/\/params\/laneCol$/);
  });
});

describe('schémy ⇔ DefRegistry (Ajv)', () => {
  const ajv = new Ajv2020({ allErrors: true });
  const equipment = ajv.compile(equipmentSchema);
  const modules = ajv.compile(modulesSchema);
  const vehicles = ajv.compile(vehiclesSchema);

  it('bundled súbory prejdú schémami', () => {
    expect(equipment(equipmentJson)).toBe(true);
    expect(modules(modulesJson)).toBe(true);
    expect(vehicles(vehiclesJson)).toBe(true);
  });

  it('schéma odmietne nulový časový parameter RTG, chýbajúcu prioritu aj canLift mimo boolean; register rovnako', () => {
    const zero = structuredClone(equipmentJson) as unknown as Json;
    (zero['rtg'] as Json)['lockTicks'] = 0;
    expect(equipment(zero)).toBe(false);
    const missing = structuredClone(equipmentJson) as unknown as Json;
    delete ((missing['rtg'] as Json)['priorities'] as Json)['housekeeping'];
    expect(equipment(missing)).toBe(false);
    const raw = rawDefs();
    itemOf(raw, 'vehicles', 'terminal_tractor')['canLift'] = 1;
    expect(vehicles(raw['vehicles'])).toBe(false);
    expect(() => DefRegistry.fromRaw(raw)).toThrow(DefError);
  });

  it('schéma modulov pozná rolu rtg_block a polia laneCol, tpSpacingBays', () => {
    const raw = rawDefs();
    rtgParams(raw)['laneCol'] = -1;
    expect(modules(raw['modules'])).toBe(false);
  });
});
