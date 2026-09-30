// T04-07: BuildBar Landside — komponent zvláda skutočné položky modulov kindu gate / waiting_area / ramp (dáta z defov
// poskladá app vrstva v T04-08): ikony z `moduleKindIcon(kind)`, cena cez formatMoney, rozmer, stavy a výber. Komponent
// sa nemení — test to len zaručuje (vrátane zmesi s cestnými položkami a zamknutými položkami ďalších ramp).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BuildBar, itemAction, itemDetail, itemPriceText, itemStatus, itemTooltip, resolveItemSelection, toIconName, type BuildBarItem, type BuildBarProps } from '@ui/build-bar';
import { moduleKindIcon } from '@ui/module-inspector';
import { findAll, propsOf } from './react-tree';

const GATE: BuildBarItem = {
  defId: 'truck_gate',
  displayName: 'Brána kamiónov',
  costCents: 8_000_000,
  icon: moduleKindIcon('gate'),
  footprint: { w: 2, h: 2 },
  locked: false,
  affordable: true,
};
const WAITING: BuildBarItem = { defId: 'truck_waiting_area', displayName: 'Čakacia plocha', costCents: 6_000_000, icon: moduleKindIcon('waiting_area'), footprint: { w: 4, h: 3 }, locked: false, affordable: true };
const RAMP: BuildBarItem = { defId: 'loading_ramp_container', displayName: 'Rampa · kontajnery', costCents: 10_000_000, icon: moduleKindIcon('ramp'), footprint: { w: 4, h: 2 }, locked: false, affordable: true };
const ROAD: BuildBarItem = { defId: 'road_two_lane', displayName: 'Cesta dvojpruhová', costCents: 200_000, priceText: '$2,000 / bunka', icon: 'ic_road', locked: false, affordable: true, action: 'road' };
const RAMP_BULK: BuildBarItem = {
  defId: 'loading_ramp_bulk',
  displayName: 'Rampa · sypký',
  costCents: 11_000_000,
  icon: 'ramp',
  footprint: { w: 4, h: 2 },
  locked: true,
  affordable: true,
  lockedReason: 'Vyžaduje technológiu Sypké terminály · 90 XP',
};

const LANDSIDE = { id: 'landside', label: 'Landside', icon: 'ic_gate', enabled: true, items: [ROAD, GATE, WAITING, RAMP, RAMP_BULK] } as const;

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

describe('BuildBar Landside: moduly gate / waiting_area / ramp', () => {
  it('ikony položiek z kindu modulu sú z ikonovej sady (ic_gate, ic_waiting, ic_ramp); krátky názov bez prefixu sa doplní', () => {
    expect([GATE, WAITING, RAMP].map((item) => item.icon)).toEqual(['ic_gate', 'ic_waiting', 'ic_ramp']);
    expect(toIconName('waiting')).toBe('ic_waiting');
    const html = render();
    for (const [defId, icon] of [['truck_gate', 'ic_gate'], ['truck_waiting_area', 'ic_waiting'], ['loading_ramp_container', 'ic_ramp'], ['loading_ramp_bulk', 'ic_ramp']] as const) {
      expect(itemHtml(html, defId)).toMatch(new RegExp(`build-bar__item-icon"[^>]*><use href="[^"]*#${icon}"`));
    }
  });

  it('cena cez formatMoney a rozmer z defu; akcia build; stav dostupná', () => {
    const html = render();
    expect(itemField(html, 'truck_gate', 'item-cost')).toBe('$80,000');
    expect(itemField(html, 'truck_gate', 'item-size')).toBe('· 2×2');
    expect(itemField(html, 'truck_waiting_area', 'item-cost')).toBe('$60,000');
    expect(itemField(html, 'truck_waiting_area', 'item-size')).toBe('· 4×3');
    expect(itemField(html, 'loading_ramp_container', 'item-cost')).toBe('$100,000');
    expect(itemField(html, 'loading_ramp_container', 'item-size')).toBe('· 4×2');
    expect(html).toMatch(/data-def-id="truck_gate" data-status="available" data-action="build"/);
    expect(itemPriceText(GATE)).toBe('$80,000');
    expect(itemAction(GATE)).toBe('build');
    expect(itemDetail(RAMP)).toBe('4×2');
    expect(itemStatus(RAMP)).toBe('available');
    expect(itemTooltip(RAMP)).toBeNull();
  });

  it('názvy vrátane dlhého „Rampa · kontajnery" sú v DOM celé (orezanie rieši CSS ellipsis)', () => {
    const html = render();
    for (const name of ['Brána kamiónov', 'Čakacia plocha', 'Rampa · kontajnery', 'Rampa · sypký']) expect(html).toContain(`>${name}<`);
  });

  it('cestná položka a moduly Landside vedľa seba: každá má vlastnú akciu, výber modulu neoznačí cestu', () => {
    const html = render({ selectedDefId: 'truck_waiting_area' });
    expect(html).toMatch(/data-def-id="road_two_lane" data-status="available" data-action="road"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-def-id="truck_waiting_area"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-def-id="truck_gate"/);
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
    click(makeProps({ onSelect, onSelectRoad }), 'truck_gate');
    expect(onSelect).toHaveBeenLastCalledWith('truck_gate');
    click(makeProps({ onSelect, onSelectRoad, selectedDefId: 'truck_gate' }), 'truck_gate');
    expect(onSelect).toHaveBeenLastCalledWith(null);
    click(makeProps({ onSelect, onSelectRoad }), 'road_two_lane');
    expect(onSelectRoad).toHaveBeenCalledExactlyOnceWith('road_two_lane');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('brána bez peňazí: červená cena, tooltip „Chýba $30,000", ale vybrať sa dá (ghost s ikonou $)', () => {
    const poor: BuildBarItem = { ...GATE, affordable: false, missingCents: 3_000_000 };
    expect(itemStatus(poor)).toBe('unaffordable');
    expect(itemTooltip(poor)).toMatchObject({ title: 'Nedostatok peňazí', text: 'Chýba $30,000', tone: 'poor' });
    expect(resolveItemSelection(poor, null)).toBe('truck_gate');
    const html = render({ categories: [{ ...LANDSIDE, items: [poor] }] });
    expect(html).toContain('build-bar__item--unaffordable');
    expect(html).toContain('Chýba $30,000');
  });

  it('zamknutá rampa pre iný náklad: zámok, dôvod v tooltipe, nevyberateľná', () => {
    expect(itemStatus(RAMP_BULK)).toBe('locked');
    expect(itemTooltip(RAMP_BULK)).toMatchObject({ title: 'Zamknuté', text: 'Vyžaduje technológiu Sypké terminály · 90 XP', tone: 'locked' });
    expect(resolveItemSelection(RAMP_BULK, null)).toBeUndefined();
    const html = render();
    expect(html).toMatch(/aria-disabled="true"[^>]*data-def-id="loading_ramp_bulk" data-status="locked"/);
    expect(itemHtml(html, 'loading_ramp_bulk')).toContain('build-bar__item-lock');
    expect(html).toContain('Vyžaduje technológiu Sypké terminály · 90 XP');
  });

  it('kategória Landside je povolená a aktívna (tab s ikonou ic_gate), Terminál je vedľa nej', () => {
    const html = render();
    expect(html).toMatch(/data-category="landside"/);
    expect(html).toContain('data-active-category="landside"');
    expect(html).toMatch(/aria-selected="true"[^>]*data-category="landside"/);
    expect(html).toMatch(/data-category="landside"[^>]*><svg[^>]*><use href="[^"]*#ic_gate"/);
  });
});
