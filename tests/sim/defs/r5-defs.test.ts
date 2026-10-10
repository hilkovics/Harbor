// Defy fázy R5 (TR5-01, ADR-042): typy kontajnerov, `typeMix` šablón, parametre reeferov a OOG, ceny reklamácie a elektriny, blok `reefer_block_8`.
import { describe, expect, it } from 'vitest';
import { DefError, DefRegistry } from '@sim/defs';
import { RAW_DEFS, DEFS } from '../world/world-fixtures';

function expectDefError(fn: () => unknown, defName: string, path: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DefError);
  expect((caught as DefError).defName).toBe(defName);
  expect((caught as DefError).path).toBe(path);
}

function withTemplate(fields: Record<string, unknown>): () => DefRegistry {
  const [first, ...rest] = RAW_DEFS.contract_templates.items;
  return () => DefRegistry.fromRaw({ ...RAW_DEFS, contract_templates: { ...RAW_DEFS.contract_templates, items: [{ ...first, ...fields }, ...rest] } });
}

describe('container_types.json (R5)', () => {
  it('päť typov podľa docs/TERMINAL_2.md §3.1: dry, reefer, open_top, flat_rack, tank', () => {
    const types = DEFS.containerTypes;
    expect(types.items.map((item) => item.id)).toEqual(['dry', 'reefer', 'open_top', 'flat_rack', 'tank']);
    expect(types.get('reefer')).toMatchObject({ stacking: 'normal', needsPower: true, oogChance: 0, rateMultiplier: 1.6 });
    expect(types.get('flat_rack')).toMatchObject({ stacking: 'top_only', needsPower: false, oogChance: 0.8 });
    expect(types.get('tank').sizes).toEqual([20]);
    expect(types.get('open_top').oogChance).toBe(0.5);
  });
});

describe('parametre reeferov a OOG (R5)', () => {
  it('logistics.reefer a logistics.oog, economy.reeferClaimCents a reeferPowerCentsPerHour', () => {
    expect(DEFS.logistics.reefer).toEqual({ plugTicks: 30, unplugTicks: 30, maxUnpluggedHours: 3, alarmChancePerDay: 0.05, alarmResponseHours: 2, technicians: 1, alarmFixTicks: 60 });
    expect(DEFS.logistics.oog).toEqual({ extraCycleTicks: 60, lashTicks: 120 });
    expect(DEFS.economy.reeferClaimCents).toBe(150_000);
    expect(DEFS.economy.reeferPowerCentsPerHour).toBe(800);
  });

  it('neplatné hodnoty sa odmietnu s cestou k poľu', () => {
    const logistics = (reefer: Record<string, unknown>) => () => DefRegistry.fromRaw({ ...RAW_DEFS, logistics: { ...RAW_DEFS.logistics, reefer: { ...RAW_DEFS.logistics.reefer, ...reefer } } });
    expectDefError(logistics({ plugTicks: 0 }), 'logistics', '/reefer/plugTicks');
    expectDefError(logistics({ alarmChancePerDay: 1.5 }), 'logistics', '/reefer/alarmChancePerDay');
    expectDefError(logistics({ technicians: 0 }), 'logistics', '/reefer/technicians');
    expectDefError(() => DefRegistry.fromRaw({ ...RAW_DEFS, economy: { ...RAW_DEFS.economy, reeferClaimCents: -1 } }), 'economy', '/reeferClaimCents');
  });
});

describe('typeMix šablón kontraktu (R5)', () => {
  it('platná zmes prejde, jej podiely sa čítajú z defu', () => {
    const defs = withTemplate({ typeMix: [{ type: 'reefer', share: 0.2 }, { type: 'tank', share: 0.1 }] })();
    expect(defs.contractTemplates.items[0].typeMix).toEqual([{ type: 'reefer', share: 0.2 }, { type: 'tank', share: 0.1 }]);
  });

  it('neznámy typ, dry, opakovaný typ, súčet nad 1 a nepovolený druh šablóny sa odmietnu', () => {
    expectDefError(withTemplate({ typeMix: [{ type: 'nope', share: 0.1 }] }), 'contract_templates', '/items/0/typeMix/0/type');
    expectDefError(withTemplate({ typeMix: [{ type: 'dry', share: 0.1 }] }), 'contract_templates', '/items/0/typeMix/0/type');
    expectDefError(withTemplate({ typeMix: [{ type: 'reefer', share: 0.1 }, { type: 'reefer', share: 0.1 }] }), 'contract_templates', '/items/0/typeMix/1/type');
    expectDefError(withTemplate({ typeMix: [{ type: 'reefer', share: 0.7 }, { type: 'tank', share: 0.5 }] }), 'contract_templates', '/items/0/typeMix');
    expectDefError(withTemplate({ kind: 'empty_repositioning', destinationPorts: ['Hamburg'], typeMix: [{ type: 'reefer', share: 0.1 }] }), 'contract_templates', '/items/0/typeMix');
    // TR5-02: export a roundtrip zmes typov majú (kamióny privezú open top / flat rack, OOG)
    expect(withTemplate({ kind: 'export', destinationPorts: ['Hamburg'], typeMix: [{ type: 'flat_rack', share: 0.1 }] })().contractTemplates.items[0].typeMix).toHaveLength(1);
  });
});

describe('reefer_block_8 (R5)', () => {
  const def = DEFS.modules.get('reefer_block_8');

  it('RTG blok 8 × 4 so zásuvkami v každom rade (4 rady × 4 vrstvy = 128 TEU)', () => {
    expect(def.params).toMatchObject({ role: 'rtg_block', bays: 8, rows: 4, maxTier: 4, plugRows: 4, capacityUnits: 128, laneCol: 3 });
    expect(def.footprint).toEqual({ w: 4, h: 8 });
  });

  it('plugRows mimo rtg_block alebo nad počet radov sa odmietne', () => {
    const modules = (patch: (params: Record<string, unknown>) => Record<string, unknown>, id: string) => () =>
      DefRegistry.fromRaw({ ...RAW_DEFS, modules: { ...RAW_DEFS.modules, items: RAW_DEFS.modules.items.map((item) => (item.id === id ? { ...item, params: patch({ ...item.params }) } : item)) } });
    expectDefError(modules((params) => ({ ...params, plugRows: 5 }), 'reefer_block_8'), 'modules', '/items/' + String(RAW_DEFS.modules.items.findIndex((item) => item.id === 'reefer_block_8')) + '/params/plugRows');
    expectDefError(modules((params) => ({ ...params, plugRows: 1 }), 'container_yard_small'), 'modules', '/items/' + String(RAW_DEFS.modules.items.findIndex((item) => item.id === 'container_yard_small')) + '/params/plugRows');
  });
});

describe('oog_area a reach stacker (R5, TR5-02)', () => {
  const index = (id: string): string => String(RAW_DEFS.modules.items.findIndex((item) => item.id === id));
  const modules = (patch: (params: Record<string, unknown>) => Record<string, unknown>, id: string) => () =>
    DefRegistry.fromRaw({ ...RAW_DEFS, modules: { ...RAW_DEFS.modules, items: RAW_DEFS.modules.items.map((item) => (item.id === id ? { ...item, params: patch({ ...item.params }) } : item)) } });

  it('oog_area: RTG blok 6 × 3, jeden rad vrstiev (len na zem), acceptsOog, bez zásuviek', () => {
    const def = DEFS.modules.get('oog_area');
    expect(def.params).toMatchObject({ role: 'rtg_block', bays: 6, rows: 3, maxTier: 1, acceptsOog: true, capacityUnits: 18, laneCol: 3 });
    expect(def.footprint).toEqual({ w: 4, h: 6 });
  });

  it('acceptsOog len pri maxTier 1, bez zásuviek a len pri rtg_block', () => {
    expectDefError(modules((params) => ({ ...params, maxTier: 2, capacityUnits: 36 }), 'oog_area'), 'modules', '/items/' + index('oog_area') + '/params/maxTier');
    expectDefError(modules((params) => ({ ...params, plugRows: 1 }), 'oog_area'), 'modules', '/items/' + index('oog_area') + '/params/plugRows');
    expectDefError(modules((params) => ({ ...params, acceptsOog: true }), 'container_yard_small'), 'modules', '/items/' + index('container_yard_small') + '/params/acceptsOog');
  });

  it('equipment.reachStacker má časy a priority ako RTG (rovnaká tabuľka polí), priorita musí rásť', () => {
    expect(DEFS.equipment.reachStacker.prefetchCells).toBe(0);
    expect(DEFS.equipment.reachStacker.priorities).toEqual({ ship: 0, truck: 1, housekeeping: 2 });
    const bad = () => DefRegistry.fromRaw({ ...RAW_DEFS, equipment: { ...RAW_DEFS.equipment, reachStacker: { ...RAW_DEFS.equipment.reachStacker, priorities: { ship: 1, truck: 1, housekeeping: 2 } } } });
    expectDefError(bad, 'equipment', '/reachStacker/priorities/truck');
  });
});
