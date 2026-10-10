// TR2-05: bay view bloku v ModuleInspectore — bunky sú farebné podľa **linky** (`--line-*` cez `lineId`, ako v rendereri), prázdny kontajner je
// `--cargo-empty`, kontajner bez linky neutrálny; typ je len skratka (žiadna mapa typ → farba); voľné bunky sú prázdne.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { lineTokenOfId } from '@ui/line-color';
import { CONTAINER_TYPE_ABBR, ModuleInspector, type ModuleInspectorData, type YardStackData } from '@ui/module-inspector';
import { loadCss } from './css-guard';

const dry = (lineId: string | null, direction = 'import', sizeFt: 20 | 40 = 20, containerType = 'dry') => ({ sizeFt, containerType, lineId, direction });

const stacks: YardStackData[] = [
  { bay: 0, row: 0, height: 2, top: dry('northern_star'), tiers: [dry('blue_anchor'), dry('northern_star')] },
  { bay: 0, row: 1, height: 1, top: dry('golden_wave', 'empty'), tiers: [dry('golden_wave', 'empty')] },
  { bay: 1, row: 0, height: 1, top: dry(null), tiers: [dry(null, 'import', 40, 'reefer')] },
  { bay: 1, row: 1, height: 0, top: null },
];

const YARD: ModuleInspectorData = {
  id: 4,
  defId: 'container_yard_small',
  displayName: 'Kontajnerový dvor S',
  kind: 'storage',
  stateLabel: 'V prevádzke',
  ok: true,
  storage: { stored: 5, reserved: 0, capacity: 12, unitsIn: 5, unitsOut: 0, unitLabel: 'TEU', split: { import: 5, export: 0, tranship: 0, empty: 0 } },
  yardBlock: { geometry: { bays: 2, rows: 2, maxTier: 2 }, capacityTeu: 8, usedTeu: 5, stacks },
  refundCents: 0,
  removable: true,
};

const html = renderToStaticMarkup(createElement(ModuleInspector, { data: YARD, onRemove: vi.fn(), onClose: vi.fn() }));

/** Otvárací tag bunky `(bay, row, tier)` z HTML. */
function cell(bay: number, row: number, tier: number): string {
  const match = new RegExp(`<div[^>]*class="module-inspector__bay-cell"[^>]*data-bay="${String(bay)}" data-row="${String(row)}" data-tier="${String(tier)}"[^>]*>(?:[^<]*)</div>`).exec(html);
  if (match === null) throw new Error(`bunka ${String(bay)}/${String(row)}/${String(tier)} chýba`);
  return match[0];
}

describe('lineTokenOfId', () => {
  it('lineId z lines.json → token farby linky; chýbajúca linka → undefined; už zadaný token ostane', () => {
    expect(lineTokenOfId('blue_anchor')).toBe('line-blue');
    expect(lineTokenOfId('northern_star')).toBe('line-amber');
    expect(lineTokenOfId('golden_wave')).toBe('line-teal');
    expect(lineTokenOfId(null)).toBeUndefined();
    expect(lineTokenOfId('line-blue')).toBe('line-blue');
  });
});

describe('ModuleInspector: bay view bloku', () => {
  it('bunka má farbu linky svojho kontajnera (token `--line-*`, `data-line`), aj spodné poschodie podľa vlastnej linky', () => {
    expect(cell(0, 0, 1)).toContain('data-fill="line"');
    expect(cell(0, 0, 1)).toContain('data-line="line-amber"');
    expect(cell(0, 0, 1)).toContain('--line-color:var(--line-amber, var(--ui-text-2))');
    expect(cell(0, 0, 0)).toContain('data-line="line-blue"');
    expect(cell(0, 0, 0)).toContain('--line-color:var(--line-blue, var(--ui-text-2))');
  });

  it('prázdny kontajner je `--cargo-empty` (bez farby linky), kontajner bez linky neutrálny, voľná bunka prázdna', () => {
    expect(cell(0, 1, 0)).toContain('data-fill="empty"');
    expect(cell(0, 1, 0)).not.toContain('--line-color');
    expect(cell(0, 1, 0)).not.toContain('data-line');
    expect(cell(1, 0, 0)).toContain('data-fill="neutral"');
    expect(cell(1, 0, 0)).not.toContain('--line-color');
    expect(cell(1, 1, 0)).toContain('data-empty="true"');
    expect(cell(1, 1, 0)).not.toContain('data-fill');
    // poschodie nad vrchom stohu je voľné
    expect(cell(0, 1, 1)).toContain('data-empty="true"');
  });

  it('typ je len skratka v bunke (dry D, reefer R) a veľkosť v data-size; typ nemení farbu', () => {
    expect(CONTAINER_TYPE_ABBR).toMatchObject({ dry: 'D', reefer: 'R' });
    expect(cell(0, 0, 0)).toMatch(/>D<\/div>$/);
    expect(cell(1, 0, 0)).toMatch(/>R<\/div>$/);
    expect(cell(1, 0, 0)).toContain('data-size="40"');
    expect(cell(1, 0, 0)).toContain('data-container-type="reefer"');
  });

  it('bunky sú v mriežke po riadkoch a poschodia idú zhora nadol (najvyššie poschodie ako prvé)', () => {
    const order = [...html.matchAll(/data-bay="0" data-row="(\d)" data-tier="(\d)"/g)].map((match) => `${String(match[2])}${String(match[1])}`);
    expect(order).toEqual(['10', '11', '00', '01']);
  });

  it('CSS: farbu bunky nesie `--line-color` / `--cargo-empty`; žiadna mapa typ → farba (`data-container-type` sa v CSS nepoužíva)', () => {
    const { source } = loadCss('src/ui/module-inspector.css');
    expect(source).toMatch(/\.module-inspector__bay-cell\[data-fill='line'\][^}]*var\(--line-color/);
    expect(source).toMatch(/\.module-inspector__bay-cell\[data-fill='empty'\][^}]*var\(--cargo-empty\)/);
    expect(source).not.toContain('data-container-type');
  });
});
