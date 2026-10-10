// R6 / TR6-01 (ADR-043): `rail.json`, `equipment.rmg`, modul `rmg_rail_block` (role rail_terminal, koľaje, buffer, pruh) a `railShare` šablón — hodnoty v bundled defoch a odmietnutie neplatných.
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import contractTemplatesJson from '@data/defs/contract_templates.json';
import cargoTypesJson from '@data/defs/cargo_types.json';
import containerTypesJson from '@data/defs/container_types.json';
import economyJson from '@data/defs/economy.json';
import equipmentJson from '@data/defs/equipment.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import linesJson from '@data/defs/lines.json';
import logisticsJson from '@data/defs/logistics.json';
import modulesJson from '@data/defs/modules.json';
import railJson from '@data/defs/rail.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import trucksJson from '@data/defs/trucks.json';
import vehiclesJson from '@data/defs/vehicles.json';
import railSchema from '@data/schemas/rail.schema.json';
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
    rail: structuredClone(railJson),
  };
}

function errorOf(raw: Record<string, Json>): DefError {
  try {
    DefRegistry.fromRaw(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(DefError);
    return error as DefError;
  }
  throw new Error('očakávaná DefError, def prešiel');
}

const itemOf = (raw: Record<string, Json>, name: string, id: string): Json => {
  const found = (raw[name]!['items'] as Json[]).find((item) => item['id'] === id);
  if (found === undefined) throw new Error(`${name}/${id} chýba`);
  return found;
};

describe('bundled defy R6', () => {
  const defs = loadBundledDefs();

  it('rail.json: vlak 1 lokomotíva + 4 vagóny po 3 TEU, interval 6 h, pobyt 90 min; zmrazený', () => {
    expect(defs.rail).toMatchObject({
      timetable: { intervalHours: 6, firstArrivalHour: 2, wagonsPerTrain: 4, dwellMinutes: 90 },
      train: { speedMilliCellsPerTick: 400, locoLengthCells: 3, wagonLengthCells: 3, wagonTeu: 3 },
    });
    expect(Object.isFrozen(defs.rail.timetable)).toBe(true);
    expect(new Ajv2020({ strict: false }).validate(railSchema, railJson)).toBe(true);
  });

  it('equipment.rmg: časy a priority vlak < ťahač < housekeeping', () => {
    expect(defs.equipment.rmg).toEqual({ wagePerDayCents: 24_000, gantryCellsPerTick: 2, hoistTicksPerTier: 1, trolleyTicksPerRow: 1, lockTicks: 1, prefetchCells: 6, handoverGiveUpTicks: 600, priorities: { train: 0, ship: 1, truck: 2, housekeeping: 3 } });
  });

  it('rmg_rail_block: 6 × 16, 2 koľaje, buffer 4 rady × 4 vrstvy po 16 bays, pruh pre ťahače a 4 konektory', () => {
    const def = defs.modules.get('rmg_rail_block');
    expect(def.footprint).toEqual({ w: 6, h: 16 });
    expect(storageParams(def)).toMatchObject({ role: 'rail_terminal', bays: 16, rows: 4, maxTier: 4, laneCol: 5, trackCol: 0, tracks: 2 });
    expect(def.connectors.filter((connector) => connector.type === 'rail')).toHaveLength(2);
    expect(def.connectors.filter((connector) => connector.type === 'road')).toHaveLength(2);
  });

  it('šablóny import / export / roundtrip nesú `railShare`, ostatné nie', () => {
    const withShare = defs.contractTemplates.items.filter((template) => template.railShare !== undefined).map((template) => template.kind ?? 'import');
    expect([...new Set(withShare)].sort()).toEqual(['export', 'import', 'roundtrip']);
  });
});

describe('neplatné defy R6', () => {
  it.each([
    ['wagonTeu 0', (raw: Record<string, Json>) => ((raw['rail']!['train'] as Json)['wagonTeu'] = 0), 'rail'],
    ['wagonsPerTrain 0', (raw: Record<string, Json>) => ((raw['rail']!['timetable'] as Json)['wagonsPerTrain'] = 0), 'rail'],
    ['neznámy kľúč', (raw: Record<string, Json>) => ((raw['rail']!['train'] as Json)['colour'] = 'red'), 'rail'],
    ['priority RMG nerastú', (raw: Record<string, Json>) => (((raw['equipment']!['rmg'] as Json)['priorities'] as Json)['ship'] = 0), 'equipment'],
  ])('%s sa odmietne', (_name, mutate, defName) => {
    const raw = rawDefs();
    mutate(raw);
    expect(errorOf(raw).defName).toBe(defName);
  });

  it('railShare: mimo 0 … 1, min > max, na tranship šablóne sa odmietne', () => {
    const outside = rawDefs();
    itemOf(outside, 'contract_templates', 'container_feeder_standard')['railShare'] = [0.2, 1.5];
    expect(errorOf(outside).defName).toBe('contract_templates');
    const inverted = rawDefs();
    itemOf(inverted, 'contract_templates', 'container_feeder_standard')['railShare'] = [0.6, 0.3];
    expect(errorOf(inverted).defName).toBe('contract_templates');
    const tranship = rawDefs();
    itemOf(tranship, 'contract_templates', 'container_feeder_tranship')['railShare'] = [0.1, 0.2];
    expect(errorOf(tranship).path).toContain('railShare');
  });

  it('rail_terminal bez trackCol, s koľajou mimo footprintu alebo pruhom na koľaji sa odmietne', () => {
    const missing = rawDefs();
    delete (itemOf(missing, 'modules', 'rmg_rail_block')['params'] as Json)['trackCol'];
    expect(errorOf(missing).path).toContain('trackCol');
    const outside = rawDefs();
    (itemOf(outside, 'modules', 'rmg_rail_block')['params'] as Json)['tracks'] = 7;
    expect(errorOf(outside).path).toContain('tracks');
    const onTrack = rawDefs();
    (itemOf(onTrack, 'modules', 'rmg_rail_block')['params'] as Json)['laneCol'] = 1;
    expect(errorOf(onTrack).path).toContain('laneCol');
  });

  it('trackCol na inom module než rail_terminal sa odmietne', () => {
    const raw = rawDefs();
    (itemOf(raw, 'modules', 'rtg_block')['params'] as Json)['trackCol'] = 0;
    expect(errorOf(raw).path).toContain('trackCol');
  });

  it('chýbajúci rail def sa nahradí zabaleným (ručne skladané sady z čias pred R6)', () => {
    const raw = rawDefs();
    delete raw['rail'];
    expect(DefRegistry.fromRaw(raw).rail.train.wagonTeu).toBe(3);
  });
});
