// T03-20: BuildBar — položky s akciou `road` (typy ciest v Landside): text ceny `priceText`, výber cez vlastný stav
// (`selectedRoadDefId` / `onSelectRoad`), opakovaný klik ruší, zamknuté zástupné položky sú nevyberateľné.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BuildBar, itemAction, itemDetail, itemPriceText, itemStatus, itemTooltip, resolveItemSelection, type BuildBarItem, type BuildBarProps } from '@ui/build-bar';
import { findAll, propsOf } from './react-tree';

const TWO_LANE: BuildBarItem = {
  defId: 'road_two_lane',
  displayName: 'Cesta dvojpruhová',
  costCents: 200_000,
  priceText: '$2,000 / bunka',
  icon: 'ic_road',
  locked: false,
  affordable: true,
  action: 'road',
};
const ONE_LANE: BuildBarItem = { ...TWO_LANE, defId: 'road_one_lane', displayName: 'Cesta jednopruhová', costCents: 120_000, priceText: '$1,200 / bunka' };
const ONE_WAY: BuildBarItem = { ...TWO_LANE, defId: 'road_one_way', displayName: 'Jednosmerná cesta', costCents: 150_000, priceText: '$1,500 / bunka' };
const GATE: BuildBarItem = {
  defId: 'gate',
  displayName: 'Vrátnica',
  costCents: 0,
  priceText: 'čoskoro (F4)',
  icon: 'ic_gate',
  locked: true,
  affordable: true,
  lockedReason: 'čoskoro (F4)',
};
const BERTH: BuildBarItem = { defId: 'berth_standard', displayName: 'Kotvisko', costCents: 40_000_000, icon: 'ic_berth', footprint: { w: 8, h: 3 }, locked: false, affordable: true };

const LANDSIDE = { id: 'landside', label: 'Landside', icon: 'ic_gate', enabled: true, items: [TWO_LANE, ONE_LANE, ONE_WAY, GATE] } as const;

function makeProps(overrides: Partial<BuildBarProps> = {}): BuildBarProps {
  return {
    categories: [LANDSIDE, { id: 'terminal', label: 'Terminál', icon: 'ic_berth', enabled: true, items: [BERTH] }],
    activeCategoryId: 'landside',
    selectedDefId: null,
    onSelectCategory: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
}

const render = (overrides: Partial<BuildBarProps> = {}): string => renderToStaticMarkup(createElement(BuildBar, makeProps(overrides)));

function itemField(html: string, defId: string, field: string): string | null {
  const item = new RegExp(`<button[^>]*data-def-id="${defId}"[^>]*>([\\s\\S]*?)</button>`).exec(html);
  if (item === null) return null;
  const match = new RegExp(`data-field="${field}"[^>]*>([^<]*)<`).exec(item[1] ?? '');
  return match === null ? null : (match[1] ?? null);
}

const click = (props: BuildBarProps, defId: string): void => {
  const [element] = findAll(BuildBar(props), (candidate) => propsOf(candidate)['data-def-id'] === defId);
  (propsOf(element!)['onClick'] as () => void)();
};

describe('BuildBar: položky ciest (action: road)', () => {
  it('cena za bunku z priceText, bez rozmeru; akcia road, stav dostupná', () => {
    const html = render();
    expect(itemField(html, 'road_two_lane', 'item-cost')).toBe('$2,000 / bunka');
    expect(itemField(html, 'road_one_lane', 'item-cost')).toBe('$1,200 / bunka');
    expect(itemField(html, 'road_one_way', 'item-cost')).toBe('$1,500 / bunka');
    expect(html).not.toContain('data-field="item-size"');
    expect(html).toMatch(/data-def-id="road_two_lane" data-status="available" data-action="road"/);
    expect(html).toContain('build-bar__item--road');
    expect(html).toContain('Cesta dvojpruhová');
    expect(html).toContain('Jednosmerná cesta');
  });

  it('priceText nahrádza formátovanú cenu, bez neho sa cena formátuje z costCents; itemDetail pre road nemá rozmer', () => {
    expect(itemPriceText(TWO_LANE)).toBe('$2,000 / bunka');
    expect(itemPriceText({ ...TWO_LANE, priceText: undefined })).toBe('$2,000');
    expect(itemAction(TWO_LANE)).toBe('road');
    expect(itemDetail(TWO_LANE)).toBeNull();
  });

  it('vybraná je len položka zhodná s selectedRoadDefId (aria-pressed), selectedDefId modulu ju neovplyvní', () => {
    const html = render({ selectedRoadDefId: 'road_one_way' });
    expect(html).toMatch(/aria-pressed="true"[^>]*data-def-id="road_one_way"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-def-id="road_two_lane"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-def-id="road_one_lane"/);
    expect(html.match(/build-bar__item--selected/g)).toHaveLength(1);

    const clash = render({ selectedDefId: 'road_two_lane' }); // výber modulu s rovnakým id nezvýrazní cestu
    expect(clash).not.toContain('build-bar__item--selected');
    expect(render()).not.toMatch(/aria-pressed="true"/);
  });

  it('klik volá onSelectRoad(defId), nie onSelect; opakovaný klik na vybranú volá onSelectRoad(null)', () => {
    const onSelect = vi.fn();
    const onSelectRoad = vi.fn();
    click(makeProps({ onSelect, onSelectRoad }), 'road_one_lane');
    expect(onSelectRoad).toHaveBeenLastCalledWith('road_one_lane');
    click(makeProps({ onSelect, onSelectRoad, selectedRoadDefId: 'road_one_lane' }), 'road_one_lane');
    expect(onSelectRoad).toHaveBeenLastCalledWith(null);
    click(makeProps({ onSelect, onSelectRoad, selectedRoadDefId: 'road_one_lane' }), 'road_one_way'); // iný typ = prepnutie
    expect(onSelectRoad).toHaveBeenLastCalledWith('road_one_way');
    expect(onSelectRoad).toHaveBeenCalledTimes(3);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('bez onSelectRoad klik na cestu nič nerobí a nehádže (spätná kompatibilita)', () => {
    const onSelect = vi.fn();
    expect(() => {
      click(makeProps({ onSelect }), 'road_two_lane');
    }).not.toThrow();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('drahá cesta (bez peňazí na bunku) sa vybrať dá, stav je unaffordable s tooltipom „Chýba …“', () => {
    const poor: BuildBarItem = { ...TWO_LANE, affordable: false, missingCents: 50_000 };
    expect(itemStatus(poor)).toBe('unaffordable');
    expect(itemTooltip(poor)?.text).toBe('Chýba $500');
    expect(resolveItemSelection(poor, null)).toBe('road_two_lane');
    expect(resolveItemSelection(poor, 'road_two_lane')).toBeNull();
  });

  it('zástupná položka: zamknutá, text „čoskoro (F4)“ v cene aj tooltipe, klik ju nevyberie', () => {
    const html = render();
    expect(itemField(html, 'gate', 'item-cost')).toBe('čoskoro (F4)');
    expect(html).toMatch(/aria-disabled="true"[^>]*data-def-id="gate"[^>]*data-status="locked"/);
    expect(itemTooltip(GATE)).toEqual({ title: 'Zamknuté', text: 'čoskoro (F4)', icon: 'ic_lock', tone: 'locked' });

    const onSelect = vi.fn();
    const onSelectRoad = vi.fn();
    click(makeProps({ onSelect, onSelectRoad }), 'gate');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSelectRoad).not.toHaveBeenCalled();
  });

  it('modulová položka v inej kategórii sa správa ako doteraz (onSelect)', () => {
    const onSelect = vi.fn();
    const onSelectRoad = vi.fn();
    click(makeProps({ onSelect, onSelectRoad, activeCategoryId: 'terminal' }), 'berth_standard');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('berth_standard');
    expect(onSelectRoad).not.toHaveBeenCalled();
  });
});
