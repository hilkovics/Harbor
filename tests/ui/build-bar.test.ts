import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  BuildBar,
  TOOLTIP_LOCKED_FALLBACK,
  TOOLTIP_POOR_FALLBACK,
  itemStatus,
  itemTooltip,
  resolveItemSelection,
  toIconName,
  type BuildBarCategory,
  type BuildBarItem,
  type BuildBarProps,
} from '@ui/build-bar';
import { findAll, propsOf } from './react-tree';

const BERTH: BuildBarItem = {
  defId: 'berth_standard',
  displayName: 'Kotvisko štandard',
  costCents: 40_000_000,
  icon: 'ic_berth',
  footprint: { w: 8, h: 3 },
  locked: false,
  affordable: true,
};

const CRANE: BuildBarItem = {
  defId: 'crane_container_gantry',
  displayName: 'Kontajnerový žeriav',
  costCents: 60_000_000,
  icon: 'crane',
  footprint: { w: 2, h: 3 },
  locked: false,
  affordable: false,
  missingCents: 15_000_000,
};

const LOCKED: BuildBarItem = {
  defId: 'arm_liquid',
  displayName: 'Rameno kvapalín',
  costCents: 9_500_000,
  icon: 'liquid',
  footprint: { w: 4, h: 2 },
  locked: true,
  affordable: true,
  lockedReason: 'Vyžaduje technológiu Kvapalné terminály · 120 XP',
};

function lockedCategory(id: string, label: string): BuildBarCategory {
  return { id, label, icon: 'ic_lock', enabled: false, items: [] };
}

const CATEGORIES: readonly BuildBarCategory[] = [
  { id: 'terminal', label: 'Terminál', icon: 'ic_berth', enabled: true, items: [BERTH, CRANE, LOCKED] },
  lockedCategory('storage', 'Sklady'),
  lockedCategory('logistics', 'Logistika'),
  lockedCategory('landside', 'Landside'),
  lockedCategory('rail', 'Železnica'),
  lockedCategory('pipes', 'Potrubia'),
];

function makeProps(overrides: Partial<BuildBarProps> = {}): BuildBarProps {
  return {
    categories: CATEGORIES,
    activeCategoryId: 'terminal',
    selectedDefId: null,
    onSelectCategory: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
}

function render(overrides: Partial<BuildBarProps> = {}): string {
  return renderToStaticMarkup(createElement(BuildBar, makeProps(overrides)));
}

/** Text elementu s `data-field` vnútri prvku s `data-def-id` (jednoduchý výber z HTML reťazca). */
function itemField(html: string, defId: string, field: string): string | null {
  const item = new RegExp(`<button[^>]*data-def-id="${defId}"[^>]*>([\\s\\S]*?)</button>`).exec(html);
  if (item === null) return null;
  const match = new RegExp(`data-field="${field}"[^>]*>([^<]*)<`).exec(item[1] ?? '');
  return match === null ? null : (match[1] ?? null);
}

describe('itemStatus / itemTooltip', () => {
  it('zámok má prednosť pred nedostatkom peňazí; inak dostupná / bez peňazí', () => {
    expect(itemStatus({ locked: false, affordable: true })).toBe('available');
    expect(itemStatus({ locked: false, affordable: false })).toBe('unaffordable');
    expect(itemStatus({ locked: true, affordable: true })).toBe('locked');
    expect(itemStatus({ locked: true, affordable: false })).toBe('locked');
  });

  it('dostupná položka nemá tooltip', () => {
    expect(itemTooltip(BERTH)).toBeNull();
  });

  it('bez peňazí: „Chýba <suma cez formatMoney>", bez údaja o sume všeobecný text', () => {
    expect(itemTooltip(CRANE)).toEqual({ title: 'Nedostatok peňazí', text: 'Chýba $150,000', icon: 'ic_cash', tone: 'poor' });
    expect(itemTooltip({ ...CRANE, missingCents: undefined })?.text).toBe(TOOLTIP_POOR_FALLBACK);
    expect(itemTooltip({ ...CRANE, missingCents: 0 })?.text).toBe(TOOLTIP_POOR_FALLBACK);
  });

  it('zamknutá: dôvod z položky, inak všeobecný text', () => {
    expect(itemTooltip(LOCKED)).toEqual({
      title: 'Zamknuté',
      text: 'Vyžaduje technológiu Kvapalné terminály · 120 XP',
      icon: 'ic_lock',
      tone: 'locked',
    });
    expect(itemTooltip({ ...LOCKED, lockedReason: undefined })?.text).toBe(TOOLTIP_LOCKED_FALLBACK);
  });
});

describe('resolveItemSelection', () => {
  it('dostupná položka sa vyberie; klik na už vybranú výber zruší (null)', () => {
    expect(resolveItemSelection(BERTH, null)).toBe('berth_standard');
    expect(resolveItemSelection(BERTH, 'crane_container_gantry')).toBe('berth_standard');
    expect(resolveItemSelection(BERTH, 'berth_standard')).toBeNull();
  });

  it('drahá (affordable: false), ale nezamknutá položka sa vybrať dá; opätovný klik výber zruší', () => {
    expect(resolveItemSelection(CRANE, null)).toBe('crane_container_gantry');
    expect(resolveItemSelection(CRANE, 'berth_standard')).toBe('crane_container_gantry');
    expect(resolveItemSelection(CRANE, 'crane_container_gantry')).toBeNull();
  });

  it('zamknutá technológiou sa ignoruje (undefined), aj keď je práve vybraná a hráč má peniaze', () => {
    expect(resolveItemSelection(LOCKED, null)).toBeUndefined();
    expect(resolveItemSelection(LOCKED, 'arm_liquid')).toBeUndefined();
    expect(resolveItemSelection({ ...LOCKED, affordable: false }, null)).toBeUndefined();
  });
});

describe('toIconName', () => {
  it('názov ikony s prefixom `ic_` aj bez neho', () => {
    expect(toIconName('ic_berth')).toBe('ic_berth');
    expect(toIconName('berth')).toBe('ic_berth');
  });
});

describe('BuildBar — kategórie', () => {
  it('šesť tabov v poradí, aktívny je Terminál; ostatné sú zamknuté (disabled) so zámkom', () => {
    const html = render();
    const labels = [...html.matchAll(/data-category="([a-z]+)"/g)].map((match) => match[1]);
    expect(labels).toEqual(['terminal', 'storage', 'logistics', 'landside', 'rail', 'pipes']);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-selected="true"[^>]*data-category="terminal"/);
    expect(html.match(/build-bar__tab--locked/g)).toHaveLength(5);
    expect(html.match(/ disabled=""/g)).toHaveLength(5);
    expect(html.match(/build-bar__tab-lock/g)).toHaveLength(5);
    expect(html).toContain('title="Sklady · čoskoro"');
  });

  it('taby nemajú číselné nápovedy (klávesy 1–4 sú rýchlosti hry); vpravo ostáva nápoveda R / Esc', () => {
    const html = render();
    expect(html).not.toMatch(/build-bar__key">\d</);
    expect(html.match(/<kbd /g)).toHaveLength(2);
    expect(html).toMatch(/build-bar__key">R<\/kbd><span>otočiť<\/span>/);
    expect(html).toMatch(/build-bar__key build-bar__key--gap">Esc<\/kbd><span>zrušiť<\/span>/);
  });

  it('povolená kategória je aktívna, zamknutá sa neaktivuje', () => {
    const onSelectCategory = vi.fn();
    const tree = BuildBar(makeProps({ onSelectCategory }));
    const tab = (id: string) => findAll(tree, (element) => propsOf(element)['data-category'] === id)[0];
    (propsOf(tab('terminal')!)['onClick'] as () => void)();
    expect(onSelectCategory).toHaveBeenCalledExactlyOnceWith('terminal');
    (propsOf(tab('storage')!)['onClick'] as () => void)();
    expect(onSelectCategory).toHaveBeenCalledTimes(1);
  });
});

describe('BuildBar — položky', () => {
  it('zobrazí len položky aktívnej kategórie; cena cez formatMoney, rozmer s × (U+00D7)', () => {
    const html = render();
    expect(html.match(/data-def-id="/g)).toHaveLength(3);
    expect(itemField(html, 'berth_standard', 'item-cost')).toBe('$400,000');
    expect(itemField(html, 'berth_standard', 'item-size')).toBe('· 8×3');
    expect(itemField(html, 'crane_container_gantry', 'item-cost')).toBe('$600,000');
    expect(itemField(html, 'crane_container_gantry', 'item-size')).toBe('· 2×3');
    expect(itemField(html, 'arm_liquid', 'item-cost')).toBe('$95,000');
    expect(html).toContain('Kotvisko štandard');
  });

  it('stav položky: data-status, trieda a aria-disabled (len zamknutá je nedostupná, drahá sa dá vybrať)', () => {
    const html = render();
    expect(html).toMatch(/aria-disabled="false"[^>]*data-def-id="berth_standard"[^>]*data-status="available"/);
    expect(html).toMatch(/aria-disabled="false"[^>]*data-def-id="crane_container_gantry"[^>]*data-status="unaffordable"/);
    expect(html).toMatch(/aria-disabled="true"[^>]*data-def-id="arm_liquid"[^>]*data-status="locked"/);
    expect(html).toContain('build-bar__item--unaffordable');
    expect(html).toContain('build-bar__item--locked');
  });

  it('tooltip „Chýba $150,000" pri žeriave a dôvod zámku pri zamknutej položke; aria-describedby ukazuje naň', () => {
    const html = render();
    expect(html).toContain('Chýba $150,000');
    expect(html).toContain('Vyžaduje technológiu Kvapalné terminály · 120 XP');
    expect(html).toMatch(/aria-describedby="build-bar-tip-crane_container_gantry"/);
    expect(html).toMatch(/id="build-bar-tip-crane_container_gantry"/);
    expect(html).not.toContain('build-bar-tip-berth_standard');
    expect(html.match(/role="tooltip"/g)).toHaveLength(2);
  });

  it('zámok len pri zamknutej položke', () => {
    expect(render().match(/build-bar__item-lock/g)).toHaveLength(1);
  });

  it('idPrefix robí id tooltipov unikátne medzi viacerými pásmi', () => {
    expect(render({ idPrefix: 'second' })).toContain('id="second-tip-crane_container_gantry"');
  });

  it('vybraná položka: aria-pressed a trieda', () => {
    const html = render({ selectedDefId: 'berth_standard' });
    expect(html).toMatch(/aria-pressed="true"[^>]*data-def-id="berth_standard"/);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/build-bar__item--selected/g)).toHaveLength(1);
  });

  it('prázdna alebo neznáma kategória ukáže zástupný text', () => {
    expect(render({ activeCategoryId: 'storage' })).toContain('build-bar__empty');
    expect(render({ activeCategoryId: 'neexistuje' })).toContain('build-bar__empty');
    expect(render()).not.toContain('build-bar__empty');
  });

  it('klik: dostupná aj drahá položka volá onSelect(defId), vybraná onSelect(null), zamknutá nič', () => {
    const onSelect = vi.fn();
    const item = (tree: ReturnType<typeof BuildBar>, defId: string) =>
      findAll(tree, (element) => propsOf(element)['data-def-id'] === defId)[0]!;
    const click = (tree: ReturnType<typeof BuildBar>, defId: string) => {
      (propsOf(item(tree, defId))['onClick'] as () => void)();
    };

    const fresh = BuildBar(makeProps({ onSelect }));
    click(fresh, 'berth_standard');
    expect(onSelect).toHaveBeenLastCalledWith('berth_standard');

    click(BuildBar(makeProps({ onSelect, selectedDefId: 'berth_standard' })), 'berth_standard');
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(onSelect).toHaveBeenCalledTimes(2);

    click(fresh, 'crane_container_gantry'); // bez peňazí, ale nezamknutá: ghost s ikonou $ (ARCHITECTURE §8 bod 6)
    expect(onSelect).toHaveBeenLastCalledWith('crane_container_gantry');
    expect(onSelect).toHaveBeenCalledTimes(3);

    click(fresh, 'arm_liquid'); // zamknutá technológiou
    expect(onSelect).toHaveBeenCalledTimes(3);
  });
});
