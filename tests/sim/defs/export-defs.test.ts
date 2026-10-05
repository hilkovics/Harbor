// F6a / T6A-02 (ADR-032): defy exportu a bookingu — hodnoty v bundled defoch, fail-fast `DefRegistry` s JSON pointerom,
// vzťahy polí (cut-off, rezerva apronu, váhy tried, druh šablóny), zhoda schémy a registra (Ajv) a pool, ktorý import
// ponuky ťahá len zo šablón druhu `import` (import-only svet ostáva bitovo rovnaký).
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
import logisticsSchema from '@data/schemas/logistics.schema.json';
import modulesSchema from '@data/schemas/modules.schema.json';
import shipsSchema from '@data/schemas/ships.schema.json';
import { eligibleTemplates } from '@sim/contracts';
import { DefError, DefRegistry, berthParams, craneParams, loadBundledDefs } from '@sim/defs';

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
const templateOf = (raw: Record<string, Json>, id: string): Json => {
  const found = itemsOf(raw, 'contract_templates').find((item) => item['id'] === id);
  if (found === undefined) throw new Error(`šablóna ${id} chýba`);
  return found;
};

/** Chyba `DefError` s daným defom a cestou (a správou `<defName><path>: …`). */
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

describe('bundled defy exportu (hodnoty z ADR-032)', () => {
  const defs = loadBundledDefs();

  it('economy.json: booking ponuky, cut-off, splnenie bookingu a penalizácie', () => {
    const { economy } = defs;
    expect(economy.bookingOffersPerDay).toBe(2);
    expect(economy.exportArrivalDaysRange).toEqual([2, 3]);
    expect(economy.cutoffHours).toBe(12);
    expect(economy.cutoffWarningHours).toBe(6);
    expect(economy.bookingFulfilmentShare).toBe(0.9);
    expect(economy.lastMinuteExportRateOfReward).toBe(0.02);
    expect(economy.rolledExportRateOfReward).toBe(0.05);
    expect(economy.unfulfilledBookingRateOfReward).toBe(0.1);
    expect(Object.isFrozen(economy.exportArrivalDaysRange)).toBe(true);
  });

  it('logistics.json exportFlow: okno príchodov, VGM a rozdelenie hmotnostných tried', () => {
    const { exportFlow } = defs.logistics;
    expect(exportFlow).toEqual({ arrivalWindowDays: 2, vgmMissingChance: 0.05, vgmHoldHours: 6, weightClassShares: { light: 0.3, medium: 0.5, heavy: 0.2 } });
    expect(Object.isFrozen(exportFlow.weightClassShares)).toBe(true);
  });

  it('modules.json: rezerva apronu 2 z 8 slotov a dual cycle 1,5 ×', () => {
    expect(berthParams(defs.modules.get('berth_standard')).apronReserveSlots).toBe(2);
    expect(craneParams(defs.modules.get('crane_container_gantry')).dualCycleFactor).toBe(1.5);
  });

  it('ships.json: lashing 6 tickov na jednotku, papiere feeder 360 a handy 540', () => {
    expect(defs.ships.get('feeder')).toMatchObject({ lashingTicksPerUnit: 6, paperworkTicks: 360 });
    expect(defs.ships.get('handy')).toMatchObject({ lashingTicksPerUnit: 6, paperworkTicks: 540 });
  });

  it('cargo_types.json: exportPricePerUnitCents TEU 40 000 (import 45 000)', () => {
    expect(defs.cargoTypes.get('container_teu').exportPricePerUnitCents).toBe(40_000);
    expect(defs.cargoTypes.get('container_teu').basePricePerUnitCents).toBe(45_000);
  });

  it('contract_templates.json: roundtrip a export majú cieľové prístavy, roundtrip aj objem exportu v rámci lode', () => {
    const roundtrip = defs.contractTemplates.get('container_feeder_roundtrip');
    const exportOnly = defs.contractTemplates.get('container_feeder_export');
    expect(roundtrip.kind).toBe('roundtrip');
    expect(exportOnly.kind).toBe('export');
    expect(roundtrip.destinationPorts).toEqual(['Rotterdam', 'Hamburg', 'Gdańsk']);
    expect(exportOnly.exportVolumeUnitsRange).toBeUndefined();
    expect(roundtrip.exportVolumeUnitsRange?.[1]).toBeLessThanOrEqual(defs.ships.get('feeder').capacityUnits);
    expect(Object.isFrozen(roundtrip.destinationPorts)).toBe(true);
  });
});

describe('DefRegistry — fail-fast polia exportu s JSON pointerom', () => {
  it.each([
    ['economy', '/bookingOffersPerDay', -1],
    ['economy', '/bookingOffersPerDay', 1.5],
    ['economy', '/cutoffHours', 0],
    ['economy', '/cutoffWarningHours', -1],
    ['economy', '/bookingFulfilmentShare', 1.1],
    ['economy', '/lastMinuteExportRateOfReward', -0.1],
    ['economy', '/rolledExportRateOfReward', 2],
    ['economy', '/unfulfilledBookingRateOfReward', 'veľa'],
    ['economy', '/exportArrivalDaysRange', [3, 2]],
    ['economy', '/exportArrivalDaysRange', [2]],
    ['logistics', '/exportFlow/arrivalWindowDays', 0],
    ['logistics', '/exportFlow/vgmMissingChance', 1.5],
    ['logistics', '/exportFlow/vgmHoldHours', 0],
    ['logistics', '/exportFlow/weightClassShares/heavy', -0.1],
    ['logistics', '/exportFlow/weightClassShares/medium', 'half'],
  ])('%s %s = %j → DefError', (defName, path, value) => {
    const raw = rawDefs();
    const segments = path.slice(1).split('/');
    const last = segments.pop() as string;
    let target = raw[defName]!;
    for (const segment of segments) target = target[segment] as Json;
    target[last] = value;
    expectDefError(() => DefRegistry.fromRaw(raw), defName, path);
  });

  it.each([
    ['economy', 'bookingOffersPerDay'],
    ['economy', 'cutoffHours'],
    ['economy', 'exportArrivalDaysRange'],
    ['logistics', 'exportFlow'],
  ])('chýbajúce povinné pole %s.%s → DefError', (defName, field) => {
    const raw = rawDefs();
    delete raw[defName]![field];
    expectDefError(() => DefRegistry.fromRaw(raw), defName, `/${field}`);
  });

  it('exportFlow: neznáma trieda váhy a chýbajúca trieda → DefError', () => {
    const raw = rawDefs();
    ((raw['logistics']!['exportFlow'] as Json)['weightClassShares'] as Json)['extra'] = 1;
    expectDefError(() => DefRegistry.fromRaw(raw), 'logistics', '/exportFlow/weightClassShares/extra');
    const missing = rawDefs();
    delete ((missing['logistics']!['exportFlow'] as Json)['weightClassShares'] as Json)['light'];
    expectDefError(() => DefRegistry.fromRaw(missing), 'logistics', '/exportFlow/weightClassShares/light');
  });

  it('vzťah: súčet váh hmotnostných tried musí byť > 0', () => {
    const raw = rawDefs();
    raw['logistics']!['exportFlow'] = { ...(raw['logistics']!['exportFlow'] as Json), weightClassShares: { light: 0, medium: 0, heavy: 0 } };
    expectDefError(() => DefRegistry.fromRaw(raw), 'logistics', '/exportFlow/weightClassShares');
    const one = rawDefs();
    one['logistics']!['exportFlow'] = { ...(one['logistics']!['exportFlow'] as Json), weightClassShares: { light: 0, medium: 0, heavy: 1 } };
    expect(accepts(one)).toBe(true);
  });

  it('vzťah: exportArrivalDaysRange[0] × 24 h musí presiahnuť cutoffHours (cut-off po prijatí)', () => {
    const raw = rawDefs();
    raw['economy']!['cutoffHours'] = 48;
    expectDefError(() => DefRegistry.fromRaw(raw), 'economy', '/exportArrivalDaysRange/0');
    raw['economy']!['cutoffHours'] = 47.9;
    expect(accepts(raw)).toBe(true);
  });

  it('vzťah: okno príchodov exportu (arrivalWindowDays × 24 h) musí presiahnuť cutoffHours — inak je okno pred cut-off prázdne', () => {
    const raw = rawDefs();
    (raw['logistics']!['exportFlow'] as Json)['arrivalWindowDays'] = 0.5;
    expectDefError(() => DefRegistry.fromRaw(raw), 'logistics', '/exportFlow/arrivalWindowDays');
    (raw['logistics']!['exportFlow'] as Json)['arrivalWindowDays'] = 0.51;
    expect(accepts(raw)).toBe(true);
  });

  it('modules: apronReserveSlots ≤ ⌊apronSlots / 2⌋ (2 z 8 platí, 4 platí, 5 nie)', () => {
    const raw = rawDefs();
    const berth = itemsOf(raw, 'modules').find((item) => item['kind'] === 'berth') as Json;
    const params = berth['params'] as Json;
    params['apronReserveSlots'] = 4;
    expect(accepts(raw)).toBe(true);
    params['apronReserveSlots'] = 5;
    expectDefError(() => DefRegistry.fromRaw(raw), 'modules', '/items/0/params/apronReserveSlots');
    params['apronReserveSlots'] = -1;
    expectDefError(() => DefRegistry.fromRaw(raw), 'modules', '/items/0/params/apronReserveSlots');
  });

  it('modules: handoverMode apron | under_hook, craneBufferSlots 0 … 1 a craneBufferSlots × maxCranes ≤ apronSlots (ADR-033)', () => {
    const raw = rawDefs();
    const berth = itemsOf(raw, 'modules').find((item) => item['kind'] === 'berth') as Json;
    const params = berth['params'] as Json;
    for (const mode of ['apron', 'under_hook']) {
      params['handoverMode'] = mode;
      expect(accepts(raw), mode).toBe(true);
    }
    params['handoverMode'] = 'hook';
    expectDefError(() => DefRegistry.fromRaw(raw), 'modules', '/items/0/params/handoverMode');
    params['handoverMode'] = 'under_hook';
    for (const bad of [-1, 2, 0.5]) {
      params['craneBufferSlots'] = bad;
      expectDefError(() => DefRegistry.fromRaw(raw), 'modules', '/items/0/params/craneBufferSlots');
    }
    for (const ok of [0, 1]) {
      params['craneBufferSlots'] = ok;
      expect(accepts(raw), String(ok)).toBe(true);
    }
    // 1 × maxCranes 2 = 2 ≤ apronSlots; pri apronSlots 1 (rezerva 0) sa už dva buffery nezmestia.
    params['apronSlots'] = 1;
    params['apronReserveSlots'] = 0;
    expectDefError(() => DefRegistry.fromRaw(raw), 'modules', '/items/0/params/craneBufferSlots');
    params['craneBufferSlots'] = 0;
    expect(accepts(raw)).toBe(true);
  });

  it('modules: dualCycleFactor v 1 … 2', () => {
    const raw = rawDefs();
    const crane = itemsOf(raw, 'modules').find((item) => item['kind'] === 'crane') as Json;
    const params = crane['params'] as Json;
    for (const ok of [1, 1.5, 2]) {
      params['dualCycleFactor'] = ok;
      expect(accepts(raw), String(ok)).toBe(true);
    }
    for (const bad of [0.99, 2.01]) {
      params['dualCycleFactor'] = bad;
      expectDefError(() => DefRegistry.fromRaw(raw), 'modules', '/items/1/params/dualCycleFactor');
    }
  });

  it('ships: lashingTicksPerUnit a paperworkTicks sú celé ≥ 0', () => {
    for (const field of ['lashingTicksPerUnit', 'paperworkTicks']) {
      const raw = rawDefs();
      const ship = itemsOf(raw, 'ships')[0] as Json;
      ship[field] = 0;
      expect(accepts(raw), `${field} = 0`).toBe(true);
      ship[field] = -1;
      expectDefError(() => DefRegistry.fromRaw(raw), 'ships', `/items/0/${field}`);
      ship[field] = 1.5;
      expectDefError(() => DefRegistry.fromRaw(raw), 'ships', `/items/0/${field}`);
    }
  });

  it('cargo_types: exportPricePerUnitCents je celé ≥ 0 a export šablóna ju vyžaduje > 0', () => {
    const raw = rawDefs();
    const cargo = itemsOf(raw, 'cargo_types')[0] as Json;
    cargo['exportPricePerUnitCents'] = -1;
    expectDefError(() => DefRegistry.fromRaw(raw), 'cargo_types', '/items/0/exportPricePerUnitCents');
    cargo['exportPricePerUnitCents'] = 0;
    const error = expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/3/cargoTypeId');
    expect(error.message).toContain('exportPricePerUnitCents > 0');
    // Bez export šablón môže byť cena 0 (import ju nepoužíva).
    raw['contract_templates']!['items'] = itemsOf(raw, 'contract_templates').filter((item) => item['kind'] === 'import');
    expect(accepts(raw)).toBe(true);
  });
});

describe('DefRegistry — šablóny podľa druhu (kind)', () => {
  it('chýbajúci kind = import (F5 šablóna bez poľa je platná)', () => {
    const raw = rawDefs();
    for (const item of itemsOf(raw, 'contract_templates')) if (item['kind'] === 'import') delete item['kind'];
    const defs = DefRegistry.fromRaw(raw);
    expect(defs.contractTemplates.get('container_feeder_express').kind).toBeUndefined();
    expect(eligibleTemplates(defs.contractTemplates.items, 0).map((item) => item.id)).toEqual(['container_feeder_express', 'container_feeder_standard']);
  });

  it('neznámy kind → DefError', () => {
    const raw = rawDefs();
    templateOf(raw, 'container_feeder_express')['kind'] = 'nope';
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/0/kind');
  });

  it('import nemá destinationPorts ani exportVolumeUnitsRange', () => {
    for (const [field, value] of [['destinationPorts', ['Rotterdam']], ['exportVolumeUnitsRange', [12, 24]]] as const) {
      const raw = rawDefs();
      templateOf(raw, 'container_feeder_express')[field] = value;
      expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', `/items/0/${field}`);
    }
  });

  it('export vyžaduje destinationPorts a nemá exportVolumeUnitsRange', () => {
    const raw = rawDefs();
    delete templateOf(raw, 'container_feeder_export')['destinationPorts'];
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/4/destinationPorts');
    const extra = rawDefs();
    templateOf(extra, 'container_feeder_export')['exportVolumeUnitsRange'] = [12, 24];
    expectDefError(() => DefRegistry.fromRaw(extra), 'contract_templates', '/items/4/exportVolumeUnitsRange');
  });

  it('roundtrip vyžaduje destinationPorts aj exportVolumeUnitsRange', () => {
    for (const field of ['destinationPorts', 'exportVolumeUnitsRange']) {
      const raw = rawDefs();
      delete templateOf(raw, 'container_feeder_roundtrip')[field];
      expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', `/items/3/${field}`);
    }
  });

  it('destinationPorts: neprázdne pole neprázdnych jedinečných reťazcov', () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [[], '/items/4/destinationPorts'],
      [[''], '/items/4/destinationPorts/0'],
      [['Hamburg', 'Hamburg'], '/items/4/destinationPorts'],
      [[1], '/items/4/destinationPorts/0'],
      ['Hamburg', '/items/4/destinationPorts'],
    ];
    for (const [bad, path] of cases) {
      const raw = rawDefs();
      templateOf(raw, 'container_feeder_export')['destinationPorts'] = bad;
      expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', path);
    }
  });

  it('exportVolumeUnitsRange: min ≤ max, celé ≥ 1 a max sa zmestí do najmenšej lode', () => {
    const raw = rawDefs();
    const roundtrip = templateOf(raw, 'container_feeder_roundtrip');
    roundtrip['exportVolumeUnitsRange'] = [36, 12];
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/3/exportVolumeUnitsRange');
    roundtrip['exportVolumeUnitsRange'] = [0, 12];
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/3/exportVolumeUnitsRange/0');
    roundtrip['exportVolumeUnitsRange'] = [12, 121];
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/3/exportVolumeUnitsRange/1');
    roundtrip['exportVolumeUnitsRange'] = [12, 120];
    expect(accepts(raw)).toBe(true);
  });

  it('volumeUnitsRange export šablóny sa tiež zmestí do najmenšej lode', () => {
    const raw = rawDefs();
    templateOf(raw, 'container_feeder_export')['volumeUnitsRange'] = [12, 121];
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/4/volumeUnitsRange/1');
  });
});

describe('eligibleTemplates — import a booking skupina', () => {
  const { contractTemplates } = loadBundledDefs();

  it('predvolená (import) skupina vynecháva booking šablóny — import-only svet je bitovo rovnaký', () => {
    expect(eligibleTemplates(contractTemplates.items, 0).map((item) => item.id)).toEqual(['container_feeder_express', 'container_feeder_standard']);
    expect(eligibleTemplates(contractTemplates.items, 1).map((item) => item.id)).toEqual(['container_feeder_express', 'container_feeder_standard', 'container_handy_run']);
  });

  it('booking skupina: roundtrip a export v poradí defu, filter minTier a váhy', () => {
    expect(eligibleTemplates(contractTemplates.items, 0, 'booking').map((item) => item.id)).toEqual(['container_feeder_roundtrip', 'container_feeder_export']);
    expect(eligibleTemplates([{ ...contractTemplates.get('container_feeder_export'), weight: 0 }], 9, 'booking')).toEqual([]);
    expect(eligibleTemplates([{ ...contractTemplates.get('container_feeder_export'), minTier: 2 }], 1, 'booking')).toEqual([]);
  });
});

describe('schéma ⇔ DefRegistry (Ajv) pre polia exportu', () => {
  const ajv = (schema: object) => new Ajv2020({ allErrors: true }).compile(schema);
  const validateEconomy = ajv(economySchema);
  const validateLogistics = ajv(logisticsSchema);
  const validateShips = ajv(shipsSchema);
  const validateCargo = ajv(cargoTypesSchema);
  const validateModules = ajv(modulesSchema);
  const validateTemplates = ajv(contractTemplatesSchema);

  it('bundled defy prejdú schémami', () => {
    expect(validateEconomy(economyJson)).toBe(true);
    expect(validateLogistics(logisticsJson)).toBe(true);
    expect(validateShips(shipsJson)).toBe(true);
    expect(validateCargo(cargoTypesJson)).toBe(true);
    expect(validateModules(modulesJson)).toBe(true);
    expect(validateTemplates(contractTemplatesJson)).toBe(true);
  });

  it.each([
    ['bookingOffersPerDay', -1],
    ['cutoffHours', 0],
    ['cutoffWarningHours', -0.5],
    ['bookingFulfilmentShare', 1.5],
    ['lastMinuteExportRateOfReward', -1],
    ['rolledExportRateOfReward', 1.5],
    ['unfulfilledBookingRateOfReward', -1],
  ])('economy.%s = %j: schéma aj register odmietnu', (field, value) => {
    const raw = rawDefs();
    raw['economy']![field] = value;
    expect(validateEconomy(raw['economy'])).toBe(false);
    expect(accepts(raw)).toBe(false);
  });

  it('economy: chýbajúce nové pole odmietne schéma aj register', () => {
    const raw = rawDefs();
    delete raw['economy']!['cutoffHours'];
    expect(validateEconomy(raw['economy'])).toBe(false);
    expect(accepts(raw)).toBe(false);
  });

  it.each([
    ['arrivalWindowDays', 0],
    ['vgmMissingChance', -0.1],
    ['vgmHoldHours', -1],
  ])('logistics.exportFlow.%s = %j: schéma aj register odmietnu', (field, value) => {
    const raw = rawDefs();
    (raw['logistics']!['exportFlow'] as Json)[field] = value;
    expect(validateLogistics(raw['logistics'])).toBe(false);
    expect(accepts(raw)).toBe(false);
  });

  it('schéma šablón: export bez destinationPorts, roundtrip bez exportVolumeUnitsRange a import s prístavmi sa odmietnu', () => {
    const noPorts = rawDefs();
    delete templateOf(noPorts, 'container_feeder_export')['destinationPorts'];
    expect(validateTemplates(noPorts['contract_templates'])).toBe(false);
    const noRange = rawDefs();
    delete templateOf(noRange, 'container_feeder_roundtrip')['exportVolumeUnitsRange'];
    expect(validateTemplates(noRange['contract_templates'])).toBe(false);
    const importPorts = rawDefs();
    templateOf(importPorts, 'container_feeder_express')['destinationPorts'] = ['Hamburg'];
    expect(validateTemplates(importPorts['contract_templates'])).toBe(false);
    const noKind = rawDefs();
    delete templateOf(noKind, 'container_feeder_express')['kind'];
    expect(validateTemplates(noKind['contract_templates'])).toBe(true);
  });
});
