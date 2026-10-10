// T6A-07: ModuleInspector — sklad s rozdelením import / export, zakotvená loď s nákladom podľa smeru a lashing s progresom
// (ADR-032) nad fixture dátami.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ModuleInspector,
  cargoSplitShares,
  cargoSplitText,
  cargoSplitTotal,
  lashingProgressPct,
  lashingText,
  type LashingData,
  type ModuleInspectorData,
} from '@ui/module-inspector';
import { fieldText } from './react-tree';

const SCALE = { ticksPerHour: 360, ticksPerDay: 8640 };

const YARD: ModuleInspectorData = {
  id: 5,
  defId: 'container_yard_small',
  displayName: 'Kontajnerový dvor S',
  kind: 'storage',
  footprint: { w: 4, h: 4 },
  stateLabel: 'V prevádzke',
  ok: true,
  storage: { stored: 46, reserved: 3, capacity: 64, unitsIn: 1_240, unitsOut: 12, unitLabel: 'TEU', split: { import: 30, export: 16, tranship: 0, empty: 0 } },
  refundCents: 7_500_000,
  removable: true,
};

const BERTH: ModuleInspectorData = {
  id: 7,
  defId: 'berth_standard',
  displayName: 'Kotvisko štandard',
  kind: 'berth',
  footprint: { w: 8, h: 3 },
  stateLabel: 'Loď kotví',
  ok: true,
  apron: { used: 3, reserved: 0, capacity: 8 },
  dockedShip: { classLabel: 'Feeder', unitsOnBoard: 12, capacityUnits: 40, unitLabel: 'TEU', cargoSplit: { import: 4, export: 8, tranship: 0, empty: 0 } },
  refundCents: 20_000_000,
  removable: false,
  removeBlockedReason: 'Pri kotvisku kotví loď.',
};

const render = (data: ModuleInspectorData): string =>
  renderToStaticMarkup(createElement(ModuleInspector, { data, onRemove: vi.fn(), onClose: vi.fn() }));

describe('rozdelenie import / export: čisté funkcie', () => {
  it('cargoSplitShares: celé percentá so súčtom 100, bez jednotiek 0 / 0', () => {
    expect(cargoSplitShares({ import: 30, export: 16, tranship: 0, empty: 0 })).toEqual({ import: 65, export: 35, tranship: 0, empty: 0 });
    expect(cargoSplitShares({ import: 1, export: 2, tranship: 0, empty: 0 })).toEqual({ import: 33, export: 67, tranship: 0, empty: 0 });
    expect(cargoSplitShares({ import: 0, export: 0, tranship: 0, empty: 0 })).toEqual({ import: 0, export: 0, tranship: 0, empty: 0 });
    expect(cargoSplitShares({ import: 5, export: 0, tranship: 0, empty: 0 })).toEqual({ import: 100, export: 0, tranship: 0, empty: 0 });
  });

  it('cargoSplitTotal a cargoSplitText; neplatné počty sa berú ako 0', () => {
    expect(cargoSplitTotal({ import: 30, export: 16, tranship: 0, empty: 0 })).toBe(46);
    expect(cargoSplitTotal({ import: Number.NaN, export: -3, tranship: 0, empty: 0 })).toBe(0);
    expect(cargoSplitText({ import: 30, export: 16, tranship: 0, empty: 0 }, 'TEU')).toBe('Import 30 TEU, export 16 TEU');
    expect(cargoSplitText({ import: 1, export: 0, tranship: 0, empty: 0 })).toBe('Import 1, export 0');
  });

  it('lashingProgressPct: podiel odpracovaného času, bez celkovej doby null', () => {
    expect(lashingProgressPct({ ticksLeft: 750, totalTicks: 1000 })).toBe(25);
    expect(lashingProgressPct({ ticksLeft: 0, totalTicks: 1000 })).toBe(100);
    expect(lashingProgressPct({ ticksLeft: 1200, totalTicks: 1000 })).toBe(0);
    expect(lashingProgressPct({ ticksLeft: 10 })).toBeNull();
    expect(lashingProgressPct({ ticksLeft: 10, totalTicks: 0 })).toBeNull();
  });

  it('lashingText: zostávajúci čas v hodinách / dňoch, pod hodinu `< 1 h`', () => {
    expect(lashingText({ ticksLeft: 2 * 360 + 10, scale: SCALE })).toBe('Lashing a papiere · zostáva 2 h');
    expect(lashingText({ ticksLeft: 30, scale: SCALE })).toBe('Lashing a papiere · zostáva < 1 h');
    expect(lashingText({ ticksLeft: 8640 + 3 * 360, scale: SCALE })).toBe('Lashing a papiere · zostáva 1 d 3 h');
  });
});

describe('sklad: import / export', () => {
  it('sekcia s počtom, dvojsegmentovým pruhom a legendou; čísla zodpovedajú rozdeleniu', () => {
    const html = render(YARD);
    expect(html).toContain('data-section="storage-split"');
    expect(fieldText(html, 'storage-split-count')).toBe('46 TEU');
    expect(fieldText(html, 'storage-split-import')).toBe('30 TEU');
    expect(fieldText(html, 'storage-split-export')).toBe('16 TEU');
    expect(html).toMatch(/module-inspector__bar-fill--import" style="width:65%"/);
    expect(html).toMatch(/module-inspector__bar-fill--export" style="width:35%"/);
    expect(html).toContain('aria-label="Import 30 TEU, export 16 TEU"');
    expect(html).toMatch(/aria-label="Obsah skladu: import a export"/);
  });

  it('prázdny sklad: „Prázdny“ a bez výplne pruhu; sklad bez `split` sekciu nemá', () => {
    const empty = render({ ...YARD, storage: { ...YARD.storage!, stored: 0, split: { import: 0, export: 0, tranship: 0, empty: 0 } } });
    expect(fieldText(empty, 'storage-split-count')).toBe('Prázdny');
    expect(empty).toMatch(/module-inspector__bar-fill--import" style="width:0%"/);
    expect(render({ ...YARD, storage: { ...YARD.storage!, split: undefined } })).not.toContain('storage-split');
  });

  it('bez jednotky počtu sa použije „jedn.“', () => {
    const html = render({ ...YARD, storage: { ...YARD.storage!, unitLabel: undefined } });
    expect(fieldText(html, 'storage-split-count')).toBe('46 jedn.');
  });
});

describe('zakotvená loď: náklad na palube podľa smeru', () => {
  it('pruh má segmenty import a export z kapacity lode a legenda ukazuje počty', () => {
    const html = render(BERTH);
    expect(fieldText(html, 'ship-units')).toBe('12 / 40 TEU');
    expect(fieldText(html, 'ship-split-import')).toBe('4 TEU');
    expect(fieldText(html, 'ship-split-export')).toBe('8 TEU');
    expect(html).toMatch(/module-inspector__bar-fill--import" style="width:10%"/);
    expect(html).toMatch(/module-inspector__bar-fill--export" style="width:20%"/);
    expect(html).not.toContain('data-section="lashing"');
    expect(html).toContain('data-lashing="false"');
  });

  it('loď bez rozdelenia ostáva s jedným segmentom (spätná kompatibilita)', () => {
    const html = render({ ...BERTH, dockedShip: { classLabel: 'Feeder', unitsOnBoard: 12, capacityUnits: 40, unitLabel: 'TEU' } });
    expect(html).toMatch(/module-inspector__bar-fill--used" style="width:30%"/);
    expect(html).not.toContain('ship-split');
  });

  it('lashing: text so zostávajúcim časom, percento a pruh progresu', () => {
    const lashing: LashingData = { ticksLeft: 600, totalTicks: 800, scale: SCALE };
    const html = render({ ...BERTH, dockedShip: { ...BERTH.dockedShip!, cargoSplit: { import: 0, export: 12, tranship: 0, empty: 0 }, lashing } });
    expect(html).toContain('data-lashing="true"');
    expect(fieldText(html, 'lashing-text')).toBe('Lashing a papiere · zostáva 1 h');
    expect(fieldText(html, 'lashing-progress')).toBe('25 %');
    expect(html).toMatch(/aria-label="Priebeh lashingu"[^>]*aria-valuenow="25"/);
  });

  it('lashing bez celkovej doby: len text, bez percenta a pruhu', () => {
    const html = render({ ...BERTH, dockedShip: { ...BERTH.dockedShip!, lashing: { ticksLeft: 600, scale: SCALE } } });
    expect(fieldText(html, 'lashing-text')).toBe('Lashing a papiere · zostáva 1 h');
    expect(html).not.toContain('data-field="lashing-progress"');
    expect(html).not.toContain('aria-label="Priebeh lashingu"');
  });

  it('bez lode: prázdny stav ako doteraz', () => {
    const html = render({ ...BERTH, dockedShip: null });
    expect(fieldText(html, 'ship-class')).toBe('Žiadna loď pri kotvisku');
    expect(html).not.toContain('ship-split');
  });
});
