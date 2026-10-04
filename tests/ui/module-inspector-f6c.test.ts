// T6C-05: ModuleInspector — rozdelenie podľa štyroch smerov (import, export, tranship, prázdne) v sklade a na lodi a depo prázdnych
// kontajnerov (dostupné / poškodené / v oprave podľa linky, opravárenské miesta) nad fixture dátami (ADR-034).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CARGO_SPLIT_DIRECTIONS,
  CARGO_SPLIT_LABELS,
  ModuleInspector,
  cargoSplitBarLabel,
  cargoSplitShares,
  cargoSplitText,
  cargoSplitTitle,
  cargoSplitTotal,
  emptyDepotStats,
  emptyDepotTotals,
  emptyLineText,
  emptyLineTotal,
  repairBayStates,
  repairWaitingText,
  visibleSplitDirections,
  type CargoSplitData,
  type EmptyDepotData,
  type ModuleInspectorData,
} from '@ui/module-inspector';
import { fieldText } from './react-tree';

const split = (patch: Partial<CargoSplitData> = {}): CargoSplitData => ({ import: 0, export: 0, tranship: 0, empty: 0, ...patch });

const DEPOT: EmptyDepotData = {
  repairBays: 2,
  lines: [
    { lineId: 'blue_anchor', label: 'Blue Anchor Lines', colorToken: 'line-blue', available: 18, damaged: 1, inRepair: 1 },
    { lineId: 'northern_star', label: 'Northern Star Shipping', colorToken: 'line-amber', available: 12, damaged: 0, inRepair: 1 },
    { lineId: 'golden_wave', label: 'Golden Wave Container', colorToken: 'line-teal', available: 7, damaged: 1, inRepair: 0 },
  ],
};

const DEPOT_DATA: ModuleInspectorData = {
  id: 9,
  defId: 'empty_depot',
  displayName: 'Depo prázdnych kontajnerov',
  kind: 'storage',
  footprint: { w: 4, h: 4 },
  stateLabel: 'V prevádzke',
  ok: true,
  storage: { stored: 41, reserved: 2, capacity: 96, unitsIn: 212, unitsOut: 171, unitLabel: 'TEU', split: split({ empty: 41 }) },
  emptyDepot: DEPOT,
  connected: true,
  refundCents: 11_000_000,
  removable: false,
  removeBlockedReason: 'Modul obsahuje náklad',
};

const YARD: ModuleInspectorData = {
  id: 4,
  defId: 'container_yard_small',
  displayName: 'Kontajnerový dvor S',
  kind: 'storage',
  stateLabel: 'V prevádzke',
  ok: true,
  storage: { stored: 42, reserved: 3, capacity: 64, unitsIn: 1_240, unitsOut: 12, unitLabel: 'TEU', split: split({ import: 22, export: 10, tranship: 6, empty: 4 }) },
  refundCents: 7_500_000,
  removable: true,
};

const BERTH: ModuleInspectorData = {
  id: 1,
  defId: 'berth_standard',
  displayName: 'Kotvisko',
  kind: 'berth',
  stateLabel: 'Loď kotví',
  ok: true,
  apron: { used: 3, reserved: 1, capacity: 8 },
  dockedShip: { classLabel: 'Feeder', unitsOnBoard: 22, capacityUnits: 40, unitLabel: 'TEU', cargoSplit: split({ export: 8, tranship: 6, empty: 8 }) },
  refundCents: 0,
  removable: false,
};

const render = (data: ModuleInspectorData): string => renderToStaticMarkup(createElement(ModuleInspector, { data, onRemove: vi.fn(), onClose: vi.fn() }));

describe('rozdelenie podľa smeru: štyri kľúče', () => {
  it('CARGO_SPLIT_DIRECTIONS a názvy pre hráča', () => {
    expect(CARGO_SPLIT_DIRECTIONS).toEqual(['import', 'export', 'tranship', 'empty']);
    expect(CARGO_SPLIT_LABELS).toEqual({ import: 'Import', export: 'Export', tranship: 'Tranship', empty: 'Prázdne' });
  });

  it('visibleSplitDirections: import a export vždy, tranship a prázdne len nenulové (neplatný počet = 0)', () => {
    expect(visibleSplitDirections(split())).toEqual(['import', 'export']);
    expect(visibleSplitDirections(split({ tranship: 2 }))).toEqual(['import', 'export', 'tranship']);
    expect(visibleSplitDirections(split({ empty: 1 }))).toEqual(['import', 'export', 'empty']);
    expect(visibleSplitDirections(split({ tranship: 1, empty: 1 }))).toEqual(['import', 'export', 'tranship', 'empty']);
    expect(visibleSplitDirections(split({ tranship: Number.NaN, empty: -4 }))).toEqual(['import', 'export']);
  });

  it('cargoSplitShares: celé percentá so súčtom presne 100 (najväčší zvyšok, pri zhode skorší smer)', () => {
    expect(cargoSplitShares(split({ import: 22, export: 10, tranship: 6, empty: 4 }))).toEqual({ import: 52, export: 24, tranship: 14, empty: 10 });
    expect(cargoSplitShares(split({ import: 1, export: 1, tranship: 1 }))).toEqual({ import: 34, export: 33, tranship: 33, empty: 0 });
    expect(cargoSplitShares(split({ import: 1, export: 1, tranship: 1, empty: 1 }))).toEqual({ import: 25, export: 25, tranship: 25, empty: 25 });
    expect(cargoSplitShares(split())).toEqual(split());
    expect(cargoSplitShares(split({ empty: 5 }))).toEqual(split({ empty: 100 }));
    for (const counts of [[7, 11, 13, 17], [1, 2, 0, 0], [3, 3, 3, 3], [97, 1, 1, 1], [5, 0, 0, 1]]) {
      const [imported = 0, exported = 0, transhipped = 0, empties = 0] = counts;
      const shares = cargoSplitShares(split({ import: imported, export: exported, tranship: transhipped, empty: empties }));
      expect(shares.import + shares.export + shares.tranship + shares.empty, counts.join(',')).toBe(100);
    }
  });

  it('cargoSplitTotal súčet všetkých smerov; cargoSplitText, nadpis a popis pruhu podľa zobrazených smerov', () => {
    expect(cargoSplitTotal(split({ import: 22, export: 10, tranship: 6, empty: 4 }))).toBe(42);
    expect(cargoSplitTotal(split({ import: Number.NaN, empty: 3 }))).toBe(3);
    expect(cargoSplitText(split({ import: 30, export: 16 }), 'TEU')).toBe('Import 30 TEU, export 16 TEU');
    expect(cargoSplitText(split({ import: 22, export: 10, tranship: 6, empty: 4 }), 'TEU')).toBe('Import 22 TEU, export 10 TEU, tranship 6 TEU, prázdne 4 TEU');
    expect(cargoSplitTitle(split())).toBe('Import / export');
    expect(cargoSplitTitle(split({ empty: 4 }))).toBe('Import / export / prázdne');
    expect(cargoSplitBarLabel(split())).toBe('Obsah skladu: import a export');
    expect(cargoSplitBarLabel(split({ tranship: 1 }))).toBe('Obsah skladu: import, export a tranship');
    expect(cargoSplitBarLabel(split({ tranship: 1, empty: 1 }))).toBe('Obsah skladu: import, export, tranship a prázdne');
  });
});

describe('sklad a loď: tranship a prázdne', () => {
  it('dvor so štyrmi smermi: nadpis, počet, štyri segmenty s podielmi a legenda s počtami', () => {
    const html = render(YARD);
    expect(html).toContain('Import / export / tranship / prázdne');
    expect(fieldText(html, 'storage-split-count')).toBe('42 TEU');
    for (const [direction, percent] of [['import', 52], ['export', 24], ['tranship', 14], ['empty', 10]] as const) {
      expect(html).toContain(`module-inspector__bar-fill--${direction}" style="width:${String(percent)}%"`);
    }
    expect(fieldText(html, 'storage-split-import')).toBe('22 TEU');
    expect(fieldText(html, 'storage-split-export')).toBe('10 TEU');
    expect(fieldText(html, 'storage-split-tranship')).toBe('6 TEU');
    expect(fieldText(html, 'storage-split-empty')).toBe('4 TEU');
    expect(html).toContain('aria-label="Import 22 TEU, export 10 TEU, tranship 6 TEU, prázdne 4 TEU"');
    expect(html).toContain('aria-label="Obsah skladu: import, export, tranship a prázdne"');
  });

  it('dvor bez prekládky a prázdnych ostáva v pôvodnom tvare (len import a export)', () => {
    const html = render({ ...YARD, storage: { ...YARD.storage!, split: split({ import: 30, export: 16 }) } });
    expect(html).not.toContain('storage-split-tranship');
    expect(html).not.toContain('storage-split-empty');
    expect(html).not.toContain('bar-fill--tranship');
    expect(html).toContain('aria-label="Obsah skladu: import a export"');
  });

  it('loď: segmenty z kapacity lode pre export, tranship a prázdne; import s nulou ostane v legende', () => {
    const html = render(BERTH);
    expect(fieldText(html, 'ship-units')).toBe('22 / 40 TEU');
    expect(html).toContain('module-inspector__bar-fill--export" style="width:20%"');
    expect(html).toContain('module-inspector__bar-fill--tranship" style="width:15%"');
    expect(html).toContain('module-inspector__bar-fill--empty" style="width:20%"');
    expect(fieldText(html, 'ship-split-import')).toBe('0 TEU');
    expect(fieldText(html, 'ship-split-tranship')).toBe('6 TEU');
    expect(fieldText(html, 'ship-split-empty')).toBe('8 TEU');
    expect(html).toMatch(/module-inspector__swatch module-inspector__swatch--empty"/);
  });
});

describe('depo prázdnych: pomocné funkcie', () => {
  it('emptyDepotTotals a emptyLineTotal: súčty cez linky, obsadené a voľné miesta opravy', () => {
    expect(emptyLineTotal(DEPOT.lines[0]!)).toBe(20);
    expect(emptyDepotTotals(DEPOT)).toEqual({ available: 37, damaged: 2, inRepair: 2, total: 41, repairBusy: 2, repairFree: 0 });
    expect(emptyDepotTotals({ repairBays: 4, lines: DEPOT.lines })).toMatchObject({ repairBusy: 2, repairFree: 2 });
    expect(emptyDepotTotals({ repairBays: 1, lines: DEPOT.lines })).toMatchObject({ inRepair: 2, repairBusy: 1, repairFree: 0 });
    expect(emptyDepotTotals({ repairBays: 2, lines: [] })).toEqual({ available: 0, damaged: 0, inRepair: 0, total: 0, repairBusy: 0, repairFree: 2 });
  });

  it('emptyDepotStats: dostupné / poškodené (varovanie len ak sú) / v oprave', () => {
    expect(emptyDepotStats(DEPOT)).toEqual([
      { key: 'available', label: 'Dostupné', value: '37', tone: 'normal', swatch: 'empty' },
      { key: 'damaged', label: 'Poškodené', value: '2', tone: 'warn', swatch: 'damaged' },
      { key: 'repair', label: 'V oprave', value: '2', tone: 'normal', swatch: 'repair' },
    ]);
    expect(emptyDepotStats({ repairBays: 2, lines: [{ ...DEPOT.lines[0]!, damaged: 0 }] })[1]).toMatchObject({ value: '0', tone: 'normal' });
  });

  it('repairBayStates: obsadené (beží oprava) → voľné, dĺžka = repairBays; repairWaitingText len keď poškodené čakajú a miesta nie sú voľné', () => {
    expect(repairBayStates(DEPOT)).toEqual(['occupied', 'occupied']);
    expect(repairBayStates({ repairBays: 3, lines: DEPOT.lines })).toEqual(['occupied', 'occupied', 'free']);
    expect(repairBayStates({ repairBays: 0, lines: DEPOT.lines })).toEqual([]);
    expect(repairWaitingText(DEPOT)).toBe('Čakajú na voľné miesto opravy: 2');
    expect(repairWaitingText({ repairBays: 3, lines: DEPOT.lines })).toBeNull();
    expect(repairWaitingText({ repairBays: 2, lines: [{ ...DEPOT.lines[0]!, damaged: 0 }] })).toBeNull();
  });

  it('emptyLineText: popis riadku linky pre čítačku', () => {
    expect(emptyLineText(DEPOT.lines[0]!)).toBe('Blue Anchor Lines: dostupné 18, poškodené 1, v oprave 1');
  });
});

describe('depo prázdnych: inšpektor', () => {
  it('dlaždice dostupné / poškodené / v oprave namiesto dlaždíc skladu, s farebnými značkami a tónom varovania', () => {
    const html = render(DEPOT_DATA);
    expect(fieldText(html, 'stat-available')).toBe('37');
    expect(fieldText(html, 'stat-damaged')).toBe('2');
    expect(fieldText(html, 'stat-repair')).toBe('2');
    expect(html).toContain('module-inspector__stat-value module-inspector__stat-value--warn" data-field="stat-damaged"');
    expect(html).toContain('module-inspector__swatch module-inspector__swatch--empty');
    expect(html).toContain('module-inspector__swatch module-inspector__swatch--damaged');
    expect(html).toContain('module-inspector__swatch module-inspector__swatch--repair');
    expect(html).not.toContain('data-stat="reserved"');
    expect(html).not.toContain('data-stat="fill"');
  });

  it('zoznam liniek: riadok na linku s názvom, súčtom a tromi počtami; nenulové poškodené a opravované sú zvýraznené', () => {
    const html = render(DEPOT_DATA);
    expect(html).toContain('data-section="empty-lines"');
    expect(html).toContain('aria-label="Prázdne kontajnery podľa linky a stavu"');
    expect(html.match(/data-line="/g)).toHaveLength(3);
    const blue = /<li class="module-inspector__line" data-line="blue_anchor"[^>]*>([\s\S]*?)<\/li>/.exec(html)?.[1] ?? '';
    expect(blue).toContain('Blue Anchor Lines');
    expect(blue).toContain('style="--line-color:var(--line-blue, var(--ui-text-2))"');
    expect(fieldText(blue, 'line-total')).toBe('20');
    expect(fieldText(blue, 'line-available')).toBe('18');
    expect(fieldText(blue, 'line-damaged')).toBe('1');
    expect(fieldText(blue, 'line-repair')).toBe('1');
    expect(blue).toContain('module-inspector__line-value--warn" data-field="line-damaged"');
    expect(blue).toContain('module-inspector__line-value--busy" data-field="line-repair"');
    const amber = /<li class="module-inspector__line" data-line="northern_star"[^>]*>([\s\S]*?)<\/li>/.exec(html)?.[1] ?? '';
    expect(amber).toContain('module-inspector__line-value--normal" data-field="line-damaged"');
    expect(amber).toContain('style="--line-color:var(--line-amber, var(--ui-text-2))"');
  });

  it('opravárenské miesta: obsadené s ikonou opravy, počet, upozornenie na čakajúce poškodené; voľné miesta bez upozornenia', () => {
    const busy = render(DEPOT_DATA);
    expect(busy).toContain('data-section="repair-bays"');
    expect(fieldText(busy, 'repair-count')).toBe('2 / 2 miest');
    expect(busy.match(/module-inspector__bay--occupied/g)).toHaveLength(2);
    expect(busy).toContain('aria-label="Miesto opravy 1 · oprava beží"');
    expect(fieldText(busy, 'repair-waiting')).toBe('Čakajú na voľné miesto opravy: 2');
    const quiet = render({ ...DEPOT_DATA, emptyDepot: { repairBays: 2, lines: DEPOT.lines.map((line) => ({ ...line, damaged: 0, inRepair: 0 })) } });
    expect(fieldText(quiet, 'repair-count')).toBe('0 / 2 miest');
    expect(quiet).toContain('aria-label="Miesto opravy 2 · voľné"');
    expect(quiet).not.toContain('data-field="repair-waiting"');
    expect(quiet.match(/module-inspector__bay--free/g)).toHaveLength(2);
  });

  it('depo nemá sekciu import / export (je len pre prázdne) a ponecháva kapacitu a súčty prijaté / vydané', () => {
    const html = render(DEPOT_DATA);
    expect(html).not.toContain('data-section="storage-split"');
    expect(html).toContain('data-section="storage"');
    expect(fieldText(html, 'storage-count')).toBe('41 / 96 TEU');
    expect(fieldText(html, 'units-in')).toBe('212 TEU');
    expect(fieldText(html, 'units-out')).toBe('171 TEU');
  });

  it('bežný sklad bez `emptyDepot` nemá sekcie depa a ukáže dlaždice skladu', () => {
    const html = render(YARD);
    expect(html).not.toContain('data-section="empty-lines"');
    expect(html).not.toContain('data-section="repair-bays"');
    expect(html).toContain('data-stat="fill"');
  });
});
