// F6c / T6C-01 (ADR-034): defy liniek, prázdnych kontajnerov, depa prázdnych, empty handlera, repositioningu a transhipu —
// hodnoty v bundled defoch, fail-fast `DefRegistry` s JSON pointerom, vzťahy polí (rola skladu, druh šablóny, cena podľa druhu),
// zhoda schémy a registra (Ajv) a pool, ktorý šablóny F6c zatiaľ neponúka (svet F6a ostáva bitovo rovnaký).
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import cargoTypesJson from '@data/defs/cargo_types.json';
import contractTemplatesJson from '@data/defs/contract_templates.json';
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import linesJson from '@data/defs/lines.json';
import containerTypesJson from '@data/defs/container_types.json';
import logisticsJson from '@data/defs/logistics.json';
import modulesJson from '@data/defs/modules.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import trucksJson from '@data/defs/trucks.json';
import vehiclesJson from '@data/defs/vehicles.json';
import cargoTypesSchema from '@data/schemas/cargo_types.schema.json';
import contractTemplatesSchema from '@data/schemas/contract_templates.schema.json';
import economySchema from '@data/schemas/economy.schema.json';
import linesSchema from '@data/schemas/lines.schema.json';
import logisticsSchema from '@data/schemas/logistics.schema.json';
import modulesSchema from '@data/schemas/modules.schema.json';
import vehiclesSchema from '@data/schemas/vehicles.schema.json';
import { TEMPLATE_GROUP_KINDS, eligibleTemplates } from '@sim/contracts';
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
  };
}

const itemsOf = (raw: Record<string, Json>, name: string): Json[] => raw[name]!['items'] as Json[];
const itemOf = (raw: Record<string, Json>, name: string, id: string): Json => {
  const found = itemsOf(raw, name).find((item) => item['id'] === id);
  if (found === undefined) throw new Error(`${name}/${id} chýba`);
  return found;
};
const indexOf = (raw: Record<string, Json>, name: string, id: string): number => itemsOf(raw, name).findIndex((item) => item['id'] === id);

function expectDefError(fn: () => unknown, defName: string, path: string): DefError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DefError);
  const error = caught as DefError;
  expect(error.defName).toBe(defName);
  expect(error.path).toBe(path);
  return error;
}

const accepts = (raw: Record<string, Json>): boolean => {
  try {
    DefRegistry.fromRaw(raw);
    return true;
  } catch (error) {
    if (error instanceof DefError) return false;
    throw error;
  }
};

describe('bundled defy F6c (hodnoty z ADR-034)', () => {
  const defs = loadBundledDefs();

  it('lines.json: tri linky v poradí defu, každá s farebným tokenom', () => {
    expect(defs.lines.items.map((line) => line.id)).toEqual(['blue_anchor', 'northern_star', 'golden_wave']);
    expect(defs.lines.get('blue_anchor')).toEqual({ id: 'blue_anchor', displayName: 'Blue Anchor Lines', colorToken: 'line-blue' });
    expect(Object.isFrozen(defs.lines.items)).toBe(true);
  });

  it('economy.json: ponuky, cena opravy, rozstup lodí a penalizácia transhipu', () => {
    const { economy } = defs;
    expect(economy.repositioningOffersPerDay).toBe(1);
    expect(economy.transhipOffersPerDay).toBe(1);
    expect(economy.repairCostCents).toBe(12_000);
    expect(economy.transhipGapDaysRange).toEqual([1, 2]);
    expect(economy.transhipRescueDays).toBe(3);
    expect(economy.transhipMissedRateOfReward).toBe(0.25);
    expect(Object.isFrozen(economy.transhipGapDaysRange)).toBe(true);
  });

  it('logistics.json emptyFlow: návrat, kontrola, oprava a výdaj prázdneho exportérovi', () => {
    expect(defs.logistics.emptyFlow).toEqual({
      hinterlandDaysRange: [1, 3],
      emptyReturnRate: 0.6,
      damageChance: 0.08,
      repairHours: 6,
      emptyPickupRate: 0.4,
      emptyPickupLeadHoursRange: [4, 12],
      emptyPickupMaxWaitHours: 6,
    });
    expect(Object.isFrozen(defs.logistics.emptyFlow.hinterlandDaysRange)).toBe(true);
  });

  it('cargo_types.json: cena repositioningu a prekládky TEU (pod exportom aj importom)', () => {
    const teu = defs.cargoTypes.get('container_teu');
    expect(teu.repositioningPricePerUnitCents).toBe(12_000);
    expect(teu.transhipPricePerUnitCents).toBe(28_000);
    expect(teu.repositioningPricePerUnitCents).toBeLessThan(teu.exportPricePerUnitCents);
  });

  it('modules.json: empty_depot je sklad kontajnerov s rolou, vyššou kapacitou na plochu ako dvor a bez technológie', () => {
    const depot = defs.modules.get('empty_depot');
    const yard = defs.modules.get('container_yard_small');
    expect(depot.kind).toBe('storage');
    expect(storageParams(depot)).toEqual({ capacityUnits: 96, category: 'container', role: 'empty_depot', repairBays: 2, bays: 4, rows: 3, maxTier: 8 });
    expect(depot.footprint).toEqual(yard.footprint);
    expect(storageParams(depot).capacityUnits).toBeGreaterThan(storageParams(yard).capacityUnits);
    expect(depot.techRequired).toBeUndefined();
    expect(storageParams(yard).role).toBeUndefined();
  });

  it('vehicles.json: empty_handler vezie len prázdne, je rýchlejší ako straddle carrier a nie je prvý (UI kupuje prvé vozidlo)', () => {
    const handler = defs.vehicles.get('empty_handler');
    const straddle = defs.vehicles.get('straddle_carrier');
    expect(handler.cargoDirections).toEqual(['empty']);
    expect(straddle.cargoDirections).toBeUndefined();
    expect(handler.speedCellsPerTick).toBeGreaterThan(straddle.speedCellsPerTick);
    expect(handler.loadTicks).toBeLessThan(straddle.loadTicks);
    expect(defs.vehicles.items[0]?.id).toBe('straddle_carrier');
  });

  it('contract_templates.json: šablóny repositioningu (vlastná voyage / so skupinou exportu) a prekládky', () => {
    const own = defs.contractTemplates.get('container_feeder_repositioning');
    const bundle = defs.contractTemplates.get('container_feeder_export_repositioning');
    const tranship = defs.contractTemplates.get('container_feeder_tranship');
    expect([own.kind, bundle.kind, tranship.kind]).toEqual(['empty_repositioning', 'empty_repositioning', 'tranship']);
    expect(own.exportVolumeUnitsRange).toBeUndefined();
    expect(bundle.exportVolumeUnitsRange).toEqual([12, 36]);
    expect(tranship.exportVolumeUnitsRange).toBeUndefined();
    for (const template of [own, bundle, tranship]) {
      expect(template.destinationPorts?.length).toBeGreaterThan(0);
      // SLA nepresiahne najväčšie SLA bundled šablón, takže `maxSlaDays` (urgency existujúcich ponúk) sa nemení.
      expect(template.slaDaysRange[1]).toBeLessThanOrEqual(8);
    }
  });

  it('pool šablóny F6c neponúka: import ani booking skupina ich nezahŕňa (svet F6a ostáva bitovo rovnaký)', () => {
    const listed = [...TEMPLATE_GROUP_KINDS.import, ...TEMPLATE_GROUP_KINDS.booking] as string[];
    expect(listed).not.toContain('empty_repositioning');
    expect(listed).not.toContain('tranship');
    for (const group of ['import', 'booking'] as const) {
      const ids = eligibleTemplates(defs.contractTemplates.items, 9, group).map((item) => item.id);
      expect(ids.filter((id) => /repositioning|tranship/.test(id))).toEqual([]);
    }
  });
});

describe('DefRegistry — fail-fast polia F6c s JSON pointerom', () => {
  it.each([
    ['economy', '/repositioningOffersPerDay', -1],
    ['economy', '/transhipOffersPerDay', 1.5],
    ['economy', '/repairCostCents', -1],
    ['economy', '/repairCostCents', 'drahé'],
    ['economy', '/transhipGapDaysRange', [2, 1]],
    ['economy', '/transhipGapDaysRange/0', [0, 2]],
    ['economy', '/transhipGapDaysRange', [1]],
    ['economy', '/transhipRescueDays', -1],
    ['economy', '/transhipMissedRateOfReward', 1.1],
    ['logistics', '/emptyFlow/hinterlandDaysRange', [3, 1]],
    ['logistics', '/emptyFlow/hinterlandDaysRange/0', [-1, 2]],
    ['logistics', '/emptyFlow/emptyReturnRate', 1.5],
    ['logistics', '/emptyFlow/damageChance', -0.1],
    ['logistics', '/emptyFlow/repairHours', 0],
    ['logistics', '/emptyFlow/emptyPickupRate', 2],
    ['logistics', '/emptyFlow/emptyPickupLeadHoursRange/0', [0, 12]],
    ['logistics', '/emptyFlow/emptyPickupLeadHoursRange', [12, 4]],
    ['logistics', '/emptyFlow/emptyPickupMaxWaitHours', 0],
  ])('%s %s = %j → DefError', (defName, errorPath, value) => {
    // `errorPath` smeruje na zlú položku rozsahu (`…/0`); hodnota sa zapisuje do celého rozsahu.
    const path = errorPath.replace(/\/[01]$/, '');
    const raw = rawDefs();
    const segments = path.slice(1).split('/');
    const last = segments.pop() as string;
    let target = raw[defName]!;
    for (const segment of segments) target = target[segment] as Json;
    target[last] = value;
    expectDefError(() => DefRegistry.fromRaw(raw), defName, errorPath);
  });

  it.each([
    ['economy', 'repairCostCents'],
    ['economy', 'transhipGapDaysRange'],
    ['logistics', 'emptyFlow'],
  ])('chýbajúce povinné pole %s.%s → DefError', (defName, field) => {
    const raw = rawDefs();
    delete raw[defName]![field];
    expectDefError(() => DefRegistry.fromRaw(raw), defName, `/${field}`);
  });

  it('lines: chýbajúci def, prázdny katalóg, duplicitné id, zlé id a token → DefError', () => {
    const missing = rawDefs();
    delete missing['lines'];
    expectDefError(() => DefRegistry.fromRaw(missing), 'lines', '');
    const empty = rawDefs();
    empty['lines'] = { schemaVersion: 1, items: [] };
    expectDefError(() => DefRegistry.fromRaw(empty), 'lines', '/items');
    const duplicate = rawDefs();
    duplicate['lines'] = { schemaVersion: 1, items: [itemsOf(duplicate, 'lines')[0], itemsOf(duplicate, 'lines')[0]] };
    expectDefError(() => DefRegistry.fromRaw(duplicate), 'lines', '/items/1/id');
    for (const [field, value] of [['id', 'Blue Anchor'], ['colorToken', '--line-blue'], ['displayName', 3]] as const) {
      const raw = rawDefs();
      itemsOf(raw, 'lines')[0]![field] = value;
      expectDefError(() => DefRegistry.fromRaw(raw), 'lines', `/items/0/${field}`);
    }
  });

  it('cargo_types: ceny repositioningu a prekládky sú celé ≥ 0; šablóna druhu ich vyžaduje > 0', () => {
    for (const [field, templateId] of [['repositioningPricePerUnitCents', 'container_feeder_repositioning'], ['transhipPricePerUnitCents', 'container_feeder_tranship']] as const) {
      const raw = rawDefs();
      const cargo = itemsOf(raw, 'cargo_types')[0]!;
      cargo[field] = -1;
      expectDefError(() => DefRegistry.fromRaw(raw), 'cargo_types', `/items/0/${field}`);
      cargo[field] = 0;
      const error = expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', `/items/${String(indexOf(raw, 'contract_templates', templateId))}/cargoTypeId`);
      expect(error.message).toContain(`${field} > 0`);
    }
  });
});

describe('DefRegistry — rola skladu a smery vozidla', () => {
  const depotIndex = (raw: Record<string, Json>): number => indexOf(raw, 'modules', 'empty_depot');
  const depotParams = (raw: Record<string, Json>): Json => itemOf(raw, 'modules', 'empty_depot')['params'] as Json;

  it('role empty_depot vyžaduje repairBays a kategóriu container', () => {
    const raw = rawDefs();
    delete depotParams(raw)['repairBays'];
    expectDefError(() => DefRegistry.fromRaw(raw), 'modules', `/items/${String(depotIndex(raw))}/params/repairBays`);
    const bulk = rawDefs();
    depotParams(bulk)['category'] = 'bulk';
    expectDefError(() => DefRegistry.fromRaw(bulk), 'modules', `/items/${String(depotIndex(bulk))}/params/category`);
  });

  it('repairBays bez roly nemá zmysel; rola mimo enumu a repairBays < 1 sa odmietnu', () => {
    const noRole = rawDefs();
    delete depotParams(noRole)['role'];
    expectDefError(() => DefRegistry.fromRaw(noRole), 'modules', `/items/${String(depotIndex(noRole))}/params/repairBays`);
    const badRole = rawDefs();
    depotParams(badRole)['role'] = 'rtg_block';
    expectDefError(() => DefRegistry.fromRaw(badRole), 'modules', `/items/${String(depotIndex(badRole))}/params/role`);
    for (const bad of [0, 1.5, '2']) {
      const raw = rawDefs();
      depotParams(raw)['repairBays'] = bad;
      expectDefError(() => DefRegistry.fromRaw(raw), 'modules', `/items/${String(depotIndex(raw))}/params/repairBays`);
    }
    const ok = rawDefs();
    depotParams(ok)['repairBays'] = 1;
    expect(accepts(ok)).toBe(true);
  });

  it('vehicles.cargoDirections: neprázdne pole jedinečných smerov nákladu', () => {
    const index = indexOf(rawDefs(), 'vehicles', 'empty_handler');
    for (const [bad, path] of [[[], `/items/${String(index)}/cargoDirections`], [['sideways'], `/items/${String(index)}/cargoDirections/0`], [['empty', 'empty'], `/items/${String(index)}/cargoDirections`]] as const) {
      const raw = rawDefs();
      itemOf(raw, 'vehicles', 'empty_handler')['cargoDirections'] = bad;
      expectDefError(() => DefRegistry.fromRaw(raw), 'vehicles', path);
    }
    const all = rawDefs();
    itemOf(all, 'vehicles', 'empty_handler')['cargoDirections'] = ['import', 'export', 'tranship', 'empty'];
    expect(accepts(all)).toBe(true);
  });
});

describe('DefRegistry — šablóny F6c podľa druhu', () => {
  it('empty_repositioning vyžaduje destinationPorts, exportVolumeUnitsRange je voliteľné (a musí sa zmestiť do lode)', () => {
    const raw = rawDefs();
    const index = indexOf(raw, 'contract_templates', 'container_feeder_repositioning');
    delete itemOf(raw, 'contract_templates', 'container_feeder_repositioning')['destinationPorts'];
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', `/items/${String(index)}/destinationPorts`);
    const withExport = rawDefs();
    itemOf(withExport, 'contract_templates', 'container_feeder_repositioning')['exportVolumeUnitsRange'] = [12, 36];
    expect(accepts(withExport)).toBe(true);
    itemOf(withExport, 'contract_templates', 'container_feeder_repositioning')['exportVolumeUnitsRange'] = [12, 121];
    expectDefError(() => DefRegistry.fromRaw(withExport), 'contract_templates', `/items/${String(index)}/exportVolumeUnitsRange/1`);
  });

  it('tranship vyžaduje destinationPorts a nemá exportVolumeUnitsRange', () => {
    const raw = rawDefs();
    const index = indexOf(raw, 'contract_templates', 'container_feeder_tranship');
    delete itemOf(raw, 'contract_templates', 'container_feeder_tranship')['destinationPorts'];
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', `/items/${String(index)}/destinationPorts`);
    const extra = rawDefs();
    itemOf(extra, 'contract_templates', 'container_feeder_tranship')['exportVolumeUnitsRange'] = [12, 24];
    expectDefError(() => DefRegistry.fromRaw(extra), 'contract_templates', `/items/${String(index)}/exportVolumeUnitsRange`);
  });

  it('objem prekládky sa zmestí do najmenšej lode šablóny', () => {
    const raw = rawDefs();
    itemOf(raw, 'contract_templates', 'container_feeder_tranship')['volumeUnitsRange'] = [12, 121];
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', `/items/${String(indexOf(raw, 'contract_templates', 'container_feeder_tranship'))}/volumeUnitsRange/1`);
  });
});

describe('schéma ⇔ DefRegistry (Ajv) pre polia F6c', () => {
  const ajv = (schema: object) => new Ajv2020({ allErrors: true }).compile(schema);
  const validators = {
    economy: ajv(economySchema),
    logistics: ajv(logisticsSchema),
    cargo: ajv(cargoTypesSchema),
    modules: ajv(modulesSchema),
    vehicles: ajv(vehiclesSchema),
    templates: ajv(contractTemplatesSchema),
    lines: ajv(linesSchema),
  };

  it('bundled defy prejdú schémami', () => {
    expect(validators.economy(economyJson)).toBe(true);
    expect(validators.logistics(logisticsJson)).toBe(true);
    expect(validators.cargo(cargoTypesJson)).toBe(true);
    expect(validators.modules(modulesJson)).toBe(true);
    expect(validators.vehicles(vehiclesJson)).toBe(true);
    expect(validators.templates(contractTemplatesJson)).toBe(true);
    expect(validators.lines(linesJson)).toBe(true);
  });

  it.each([
    ['repositioningOffersPerDay', -1],
    ['transhipOffersPerDay', 0.5],
    ['repairCostCents', -1],
    ['transhipGapDaysRange', [0, 2]],
    ['transhipRescueDays', -1],
    ['transhipMissedRateOfReward', 2],
  ])('economy.%s = %j: schéma aj register odmietnu', (field, value) => {
    const raw = rawDefs();
    raw['economy']![field] = value;
    expect(validators.economy(raw['economy'])).toBe(false);
    expect(accepts(raw)).toBe(false);
  });

  it.each([
    ['emptyReturnRate', 1.2],
    ['damageChance', -1],
    ['repairHours', 0],
    ['emptyPickupMaxWaitHours', -3],
    ['hinterlandDaysRange', [-1, 1]],
    ['emptyPickupLeadHoursRange', [0, 3]],
  ])('logistics.emptyFlow.%s = %j: schéma aj register odmietnu', (field, value) => {
    const raw = rawDefs();
    (raw['logistics']!['emptyFlow'] as Json)[field] = value;
    expect(validators.logistics(raw['logistics'])).toBe(false);
    expect(accepts(raw)).toBe(false);
  });

  it('schéma odmietne sklad s role bez zmyslu a vozidlo s neznámym smerom; register rovnako', () => {
    const raw = rawDefs();
    depotParamsOf(raw)['role'] = 'rtg_block';
    expect(validators.modules(raw['modules'])).toBe(false);
    expect(accepts(raw)).toBe(false);
    const vehicle = rawDefs();
    itemOf(vehicle, 'vehicles', 'empty_handler')['cargoDirections'] = ['sideways'];
    expect(validators.vehicles(vehicle['vehicles'])).toBe(false);
    expect(accepts(vehicle)).toBe(false);
  });

  it('schéma šablón: tranship s exportVolumeUnitsRange a empty_repositioning bez prístavov sa odmietnu', () => {
    const tranship = rawDefs();
    itemOf(tranship, 'contract_templates', 'container_feeder_tranship')['exportVolumeUnitsRange'] = [12, 24];
    expect(validators.templates(tranship['contract_templates'])).toBe(false);
    const noPorts = rawDefs();
    delete itemOf(noPorts, 'contract_templates', 'container_feeder_repositioning')['destinationPorts'];
    expect(validators.templates(noPorts['contract_templates'])).toBe(false);
  });

  it('schéma liniek: prázdny katalóg, zlé id a token sa odmietnu', () => {
    expect(validators.lines({ schemaVersion: 1, items: [] })).toBe(false);
    expect(validators.lines({ schemaVersion: 1, items: [{ id: 'Bad Id', displayName: 'X', colorToken: 'line-blue' }] })).toBe(false);
    expect(validators.lines({ schemaVersion: 1, items: [{ id: 'ok', displayName: 'X', colorToken: '--line-blue' }] })).toBe(false);
    expect(validators.lines({ schemaVersion: 1, items: [{ id: 'ok', displayName: 'X', colorToken: 'line-blue', extra: 1 }] })).toBe(false);
  });
});

function depotParamsOf(raw: Record<string, Json>): Json {
  return itemOf(raw, 'modules', 'empty_depot')['params'] as Json;
}
