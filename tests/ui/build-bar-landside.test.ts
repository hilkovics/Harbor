// T04-07: BuildBar Landside — komponent zvláda skutočné položky modulov kindu gate / pre_gate / holding (dáta z defov
// poskladá app vrstva v T04-08): ikony z `moduleKindIcon(kind)`, cena cez formatMoney, rozmer, stavy a výber. Komponent
// sa nemení — test to len zaručuje (vrátane zmesi s cestnými položkami a zamknutými položkami).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BuildBar, itemAction, itemDetail, itemPriceText, itemStatus, itemTooltip, resolveItemSelection, toIconName, type BuildBarItem, type BuildBarProps } from '@ui/build-bar';
import { moduleKindIcon } from '@ui/module-inspector';
import { findAll, propsOf } from './react-tree';

const GATE: BuildBarItem = {
  defId: 'gate_in_lane',
  displayName: 'Vstupný pruh brány',
  costCents: 2_500_000,
  icon: moduleKindIcon('gate'),
  footprint: { w: 1, h: 4 },
  locked: false,
  affordable: true,
};
const PRE_GATE: BuildBarItem = { defId: 'pre_gate_buffer', displayName: 'Predbránová plocha', costCents: 9_000_000, icon: moduleKindIcon('pre_gate'), footprint: { w: 8, h: 8 }, locked: false, affordable: true };
const HOLDING: BuildBarItem = { defId: 'truck_holding', displayName: 'Odstavná plocha kamiónov', costCents: 5_000_000, icon: moduleKindIcon('holding'), footprint: { w: 6, h: 5 }, locked: false, affordable: true };
const ROAD: BuildBarItem = { defId: 'road_two_lane', displayName: 'Cesta dvojpruhová', costCents: 200_000, priceText: '$2,000 / bunka', icon: 'ic_road', locked: false, affordable: true, action: 'road' };
const GATE_OUT_LOCKED: BuildBarItem = {
  defId: 'gate_out_lane',
  displayName: 'Výstupný pruh brány',
  costCents: 2_500_000,
  icon: moduleKindIcon('gate'),
  footprint: { w: 1, h: 4 },
  locked: true,
  affordable: true,
  lockedReason: 'Vyžaduje technológiu Automatizovaná brána · 90 XP',
};

const LANDSIDE = { id: 'landside', label: 'Landside', icon: 'ic_gate', enabled: true, items: [ROAD, GATE, PRE_GATE, HOLDING, GATE_OUT_LOCKED] } as const;

function makeProps(overrides: Partial<BuildBarProps> = {}): BuildBarProps {
  return {
    categories: [{ id: 'terminal', label: 'Terminál', icon: 'ic_berth', enabled: true, items: [] }, LANDSIDE],
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

const itemHtml = (html: string, defId: string): string => new RegExp(`<button[^>]*data-def-id="${defId}"[^>]*>[\\s\\S]*?</button>`).exec(html)?.[0] ?? '';

describe('BuildBar Landside: moduly gate / pre_gate / holding', () => {
  it('ikony položiek z kindu modulu sú z ikonovej sady (ic_gate, ic_one_way, ic_waiting); krátky názov bez prefixu sa doplní', () => {
    expect([GATE, PRE_GATE, HOLDING].map((item) => item.icon)).toEqual(['ic_gate', 'ic_one_way', 'ic_waiting']);
    expect(toIconName('waiting')).toBe('ic_waiting');
    const html = render();
    for (const [defId, icon] of [['gate_in_lane', 'ic_gate'], ['pre_gate_buffer', 'ic_one_way'], ['truck_holding', 'ic_waiting'], ['gate_out_lane', 'ic_gate']] as const) {
      expect(itemHtml(html, defId)).toMatch(new RegExp(`build-bar__item-icon"[^>]*><use href="[^"]*#${icon}"`));
    }
  });

  it('cena cez formatMoney a rozmer z defu; akcia build; stav dostupná', () => {
    const html = render();
    expect(itemField(html, 'gate_in_lane', 'item-cost')).toBe('$25,000');
    expect(itemField(html, 'gate_in_lane', 'item-size')).toBe('· 1×4');
    expect(itemField(html, 'pre_gate_buffer', 'item-cost')).toBe('$90,000');
    expect(itemField(html, 'pre_gate_buffer', 'item-size')).toBe('· 8×8');
    expect(itemField(html, 'truck_holding', 'item-cost')).toBe('$50,000');
    expect(itemField(html, 'truck_holding', 'item-size')).toBe('· 6×5');
    expect(html).toMatch(/data-def-id="gate_in_lane" data-status="available" data-action="build"/);
    expect(itemPriceText(GATE)).toBe('$25,000');
    expect(itemAction(GATE)).toBe('build');
    expect(itemDetail(HOLDING)).toBe('6×5');
    expect(itemStatus(HOLDING)).toBe('available');
    expect(itemTooltip(HOLDING)).toBeNull();
  });

  it('názvy vrátane dlhého „Odstavná plocha kamiónov" sú v DOM celé (orezanie rieši CSS ellipsis)', () => {
    const html = render();
    for (const name of ['Vstupný pruh brány', 'Predbránová plocha', 'Odstavná plocha kamiónov', 'Výstupný pruh brány']) expect(html).toContain(`>${name}<`);
  });

  it('cestná položka a moduly Landside vedľa seba: každá má vlastnú akciu, výber modulu neoznačí cestu', () => {
    const html = render({ selectedDefId: 'pre_gate_buffer' });
    expect(html).toMatch(/data-def-id="road_two_lane" data-status="available" data-action="road"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-def-id="pre_gate_buffer"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-def-id="gate_in_lane"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-def-id="road_two_lane"/);
    expect(html.match(/build-bar__item--selected/g)).toHaveLength(1);
  });

  it('výber brány volá onSelect(defId), opakovaný klik ruší; cesta ide cez onSelectRoad', () => {
    const onSelect = vi.fn();
    const onSelectRoad = vi.fn();
    const click = (props: BuildBarProps, defId: string): void => {
      const [element] = findAll(BuildBar(props), (candidate) => propsOf(candidate)['data-def-id'] === defId);
      (propsOf(element!)['onClick'] as () => void)();
    };
    click(makeProps({ onSelect, onSelectRoad }), 'gate_in_lane');
    expect(onSelect).toHaveBeenLastCalledWith('gate_in_lane');
    click(makeProps({ onSelect, onSelectRoad, selectedDefId: 'gate_in_lane' }), 'gate_in_lane');
    expect(onSelect).toHaveBeenLastCalledWith(null);
    click(makeProps({ onSelect, onSelectRoad }), 'road_two_lane');
    expect(onSelectRoad).toHaveBeenCalledExactlyOnceWith('road_two_lane');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('brána bez peňazí: červená cena, tooltip „Chýba $30,000", ale vybrať sa dá (ghost s ikonou $)', () => {
    const poor: BuildBarItem = { ...GATE, affordable: false, missingCents: 3_000_000 };
    expect(itemStatus(poor)).toBe('unaffordable');
    expect(itemTooltip(poor)).toMatchObject({ title: 'Nedostatok peňazí', text: 'Chýba $30,000', tone: 'poor' });
    expect(resolveItemSelection(poor, null)).toBe('gate_in_lane');
    const html = render({ categories: [{ ...LANDSIDE, items: [poor] }] });
    expect(html).toContain('build-bar__item--unaffordable');
    expect(html).toContain('Chýba $30,000');
  });

  it('zamknutý pruh brány: zámok, dôvod v tooltipe, nevyberateľná', () => {
    expect(itemStatus(GATE_OUT_LOCKED)).toBe('locked');
    expect(itemTooltip(GATE_OUT_LOCKED)).toMatchObject({ title: 'Zamknuté', text: 'Vyžaduje technológiu Automatizovaná brána · 90 XP', tone: 'locked' });
    expect(resolveItemSelection(GATE_OUT_LOCKED, null)).toBeUndefined();
    const html = render();
    expect(html).toMatch(/aria-disabled="true"[^>]*data-def-id="gate_out_lane" data-status="locked"/);
    expect(itemHtml(html, 'gate_out_lane')).toContain('build-bar__item-lock');
    expect(html).toContain('Vyžaduje technológiu Automatizovaná brána · 90 XP');
  });

  it('kategória Landside je povolená a aktívna (tab s ikonou ic_gate), Terminál je vedľa nej', () => {
    const html = render();
    expect(html).toMatch(/data-category="landside"/);
    expect(html).toContain('data-active-category="landside"');
    expect(html).toMatch(/aria-selected="true"[^>]*data-category="landside"/);
    expect(html).toMatch(/data-category="landside"[^>]*><svg[^>]*><use href="[^"]*#ic_gate"/);
  });
});
