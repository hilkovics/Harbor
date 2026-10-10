// T04-07: ModuleInspector — brána. Čisté pomocné
// funkcie + vykreslenie do HTML (renderToStaticMarkup) + spätná kompatibilita (moduly bez nových polí sú nezmenené).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DISCONNECTED_TITLE,
  ModuleInspector,
  gateStats,
  gateThroughputText,
  hinterlandRows,
  hinterlandSplitText,
  inspectorBadge,
  moduleCode,
  moduleKindIcon,
  type HinterlandData,
  type ModuleInspectorData,
} from '@ui/module-inspector';
import { fieldText } from './react-tree';

const GATE: ModuleInspectorData = {
  id: 1,
  defId: 'gate_in_lane',
  displayName: 'Vstupný pruh brány',
  kind: 'gate',
  footprint: { w: 2, h: 2 },
  stateLabel: 'V prevádzke',
  ok: true,
  gate: { queueLength: 3, throughputPerHour: 20, processTicks: 18 },
  connected: true,
  refundCents: 8_000_000,
  removable: true,
};

const render = (data: ModuleInspectorData): string =>
  renderToStaticMarkup(createElement(ModuleInspector, { data, onRemove: vi.fn(), onClose: vi.fn() }));

const tileValues = (html: string, keys: readonly string[]) => keys.map((key) => fieldText(html, `stat-${key}`));

describe('brána — čisté pomocné funkcie', () => {
  it('gateThroughputText: celé kamióny za hodinu s „/ h"; zaokrúhli, tisíce s čiarkou, neplatná hodnota → —', () => {
    expect(gateThroughputText(20)).toBe('20 / h');
    expect(gateThroughputText(0)).toBe('0 / h');
    expect(gateThroughputText(33.3)).toBe('33 / h');
    expect(gateThroughputText(1_200)).toBe('1,200 / h');
    expect(gateThroughputText(Number.NaN)).toBe('—');
    expect(gateThroughputText(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('gateStats: fronta / priepustnosť / ticky na kamión, bez farebných značiek', () => {
    const stats = gateStats({ queueLength: 3, throughputPerHour: 20, processTicks: 18 });
    expect(stats.map((stat) => [stat.key, stat.value, stat.tone])).toEqual([
      ['queue', '3', 'normal'],
      ['throughput', '20 / h', 'normal'],
      ['process', '18', 'normal'],
    ]);
    expect(stats.every((stat) => stat.swatch === undefined)).toBe(true);
  });
});

describe('ikony, kódy druhov a badge', () => {
  it('ikony a kódy druhov: gate → ic_gate GTE', () => {
    expect(moduleKindIcon('gate')).toBe('ic_gate');
    expect(moduleCode('gate', 1)).toBe('GTE-01');
  });

  it('inspectorBadge: „Nepripojené" má prednosť pred stavom modulu', () => {
    const base = { stateLabel: 'V prevádzke', ok: true } as const;
    expect(inspectorBadge({ ...base, connected: false })).toEqual({ label: 'Nepripojené', title: DISCONNECTED_TITLE, ok: false });
    expect(inspectorBadge(base)).toEqual({ label: 'V prevádzke', title: 'V prevádzke', ok: true });
  });
});

describe('ModuleInspector — brána', () => {
  it('hlavička: ikona brány, GTE-01 · 2×2, zelený badge; dlaždice fronta 3, 20 / h, 18 tickov', () => {
    const html = render(GATE);
    expect(fieldText(html, 'title')).toBe('Vstupný pruh brány');
    expect(fieldText(html, 'sub')).toBe('GTE-01 · 2×2');
    expect(html).toContain('#ic_gate');
    expect(html).toContain('data-kind="gate"');
    expect(html).toContain('module-inspector__badge--ok');
    expect(tileValues(html, ['queue', 'throughput', 'process'])).toEqual(['3', '20 / h', '18']);
    expect(html).not.toContain('module-inspector__swatch');
    expect(html).not.toContain('data-section="disconnected"');
  });

  it('nepripojená brána (vzor insp_gate): badge „Nepripojené", banner a 0 / h; fronta 0', () => {
    const html = render({ ...GATE, connected: false, gate: { queueLength: 0, throughputPerHour: 0, processTicks: 18 } });
    expect(html).toContain('module-inspector__badge--warn');
    expect(html).toContain('data-section="disconnected"');
    expect(tileValues(html, ['queue', 'throughput'])).toEqual(['0', '0 / h']);
  });

  it('brána nemá sekciu stojísk ani dockov; vrátenie cez formatMoney', () => {
    const html = render(GATE);
    expect(fieldText(html, 'refund')).toBe('$80,000');
  });
});

describe('spätná kompatibilita — moduly bez polí F4', () => {
  it('kotvisko, sklad a depo bez gate nevykreslia žiadnu sekciu F4', () => {
    const plain: ModuleInspectorData = {
      id: 3,
      defId: 'container_yard_small',
      displayName: 'Kontajnerový dvor S',
      kind: 'storage',
      stateLabel: 'V prevádzke',
      ok: true,
      storage: { stored: 46, reserved: 3, capacity: 64, unitsIn: 0, unitsOut: 0 },
      refundCents: 0,
      removable: true,
    };
    const html = render(plain);
    for (const marker of ['stat-queue', 'stat-throughput']) {
      expect(html).not.toContain(marker);
    }
    expect(html).toContain('module-inspector__badge--ok');
  });
});

// F6d (T6D-04, ADR-035): kamióny čakajúce vo vnútrozemí v inšpektore brány — riadok „Vo vnútrozemí čaká“, rozpis podľa misie a najdlhšie čakanie.
const SCALE = { ticksPerHour: 360, ticksPerDay: 8640 };
const WAITING_NONE: HinterlandData = { pickup: 0, delivery: 0, collect: 0, total: 0, oldestWaitTicks: 0, scale: SCALE };
const WAITING_SOME: HinterlandData = { pickup: 2, delivery: 3, collect: 1, total: 6, oldestWaitTicks: 360 + 90, scale: SCALE };
const gateWith = (hinterland: HinterlandData | undefined): ModuleInspectorData => ({
  ...GATE,
  gate: { queueLength: 3, throughputPerHour: 20, processTicks: 18, ...(hinterland === undefined ? {} : { hinterland }) },
});

describe('vnútrozemie brány (F6d)', () => {
  it('hinterlandSplitText: len nenulové misie v poradí odvoz → dovoz → výdaj prázdnych', () => {
    expect(hinterlandSplitText(WAITING_SOME)).toBe('odvoz 2 \u00B7 dovoz 3 \u00B7 výdaj prázdnych 1');
    expect(hinterlandSplitText({ pickup: 0, delivery: 4, collect: 0 })).toBe('dovoz 4');
    expect(hinterlandSplitText({ pickup: 0, delivery: 0, collect: 0 })).toBe('');
  });

  it('hinterlandRows: nikto nečaká → jediný riadok s nulou (bez rozpisu a čakania)', () => {
    expect(hinterlandRows(WAITING_NONE).map((row) => [row.key, row.label, row.value])).toEqual([['total', 'Vo vnútrozemí čaká', '0']]);
  });

  it('hinterlandRows: čakajúci kamióny → počet, rozpis a najdlhšie čakanie v hodinách a minútach herného času', () => {
    expect(hinterlandRows(WAITING_SOME).map((row) => [row.key, row.label, row.value])).toEqual([
      ['total', 'Vo vnútrozemí čaká', '6'],
      ['split', 'Podľa misie', 'odvoz 2 \u00B7 dovoz 3 \u00B7 výdaj prázdnych 1'],
      ['oldest', 'Najdlhšie čaká', '1 h 15 min'],
    ]);
  });

  it('hinterlandRows: čaká len dopyt po odvoze (oldestWaitTicks 0) → počet a rozpis bez riadku najdlhšieho čakania', () => {
    const rows = hinterlandRows({ ...WAITING_NONE, pickup: 2, total: 2 });
    expect(rows.map((row) => row.key)).toEqual(['total', 'split']);
    expect(rows[1]?.value).toBe('odvoz 2');
  });

  it('hinterlandRows: neplatné počty sa berú ako 0 (UI sa nerozbije na NaN)', () => {
    const rows = hinterlandRows({ ...WAITING_NONE, total: Number.NaN, oldestWaitTicks: Number.NaN });
    expect(rows.map((row) => row.value)).toEqual(['0']);
  });

  it('vykreslenie: sekcia hinterland s tromi riadkami a hodnotami v data-field', () => {
    const html = renderToStaticMarkup(createElement(ModuleInspector, { data: gateWith(WAITING_SOME), onRemove: vi.fn(), onClose: vi.fn() }));
    expect(html).toContain('data-section="hinterland"');
    expect(html).toContain('Vo vnútrozemí čaká');
    expect(fieldText(html, 'hinterland-total')).toBe('6');
    expect(fieldText(html, 'hinterland-split')).toBe('odvoz 2 \u00B7 dovoz 3 \u00B7 výdaj prázdnych 1');
    expect(fieldText(html, 'hinterland-oldest')).toBe('1 h 15 min');
    // pôvodné dlaždice brány ostávajú
    expect(fieldText(html, 'stat-queue')).toBe('3');
  });

  it('vykreslenie: nikto nečaká → riadok s nulou, bez rozpisu a čakania', () => {
    const html = renderToStaticMarkup(createElement(ModuleInspector, { data: gateWith(WAITING_NONE), onRemove: vi.fn(), onClose: vi.fn() }));
    expect(fieldText(html, 'hinterland-total')).toBe('0');
    expect(fieldText(html, 'hinterland-split')).toBeNull();
    expect(fieldText(html, 'hinterland-oldest')).toBeNull();
  });

  it('spätná kompatibilita: brána bez `hinterland` nemá sekciu', () => {
    const html = renderToStaticMarkup(createElement(ModuleInspector, { data: gateWith(undefined), onRemove: vi.fn(), onClose: vi.fn() }));
    expect(html).not.toContain('data-section="hinterland"');
    expect(html).not.toContain('Vo vnútrozemí čaká');
  });
});
