import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  BUY_ITEM_LABEL,
  BuildBar,
  TOOLTIP_LOCKED_FALLBACK,
  TOOLTIP_POOR_FALLBACK,
  canBuyItem,
  itemAction,
  itemDetail,
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

// --- F3 (T03-09): kategórie Sklady / Logistika, položky s akciou `buy` -----------------------------------------------

/** Prototyp: BI.storage (Kontajnerový dvor S) — ceny tu sú z defov F3 ($150,000), nie z prototypu ($90,000). */
const YARD: BuildBarItem = {
  defId: 'container_yard_small',
  displayName: 'Kontajnerový dvor S',
  costCents: 15_000_000,
  icon: 'ic_yard',
  footprint: { w: 4, h: 4 },
  locked: false,
  affordable: true,
};

const DEPOT: BuildBarItem = {
  defId: 'vehicle_depot',
  displayName: 'Depo vozidiel',
  costCents: 9_000_000,
  icon: 'ic_depot',
  footprint: { w: 3, h: 3 },
  locked: false,
  affordable: true,
};

/** Prototyp: BI.logistics[0] — Straddle carrier $48,000; vozidlo nemá stopu, ide sa kúpiť. */
const CARRIER: BuildBarItem = {
  defId: 'straddle_carrier',
  displayName: 'Straddle carrier',
  costCents: 4_800_000,
  icon: 'ic_vehicle',
  locked: false,
  affordable: true,
  action: 'buy',
};

const F3_CATEGORIES: readonly BuildBarCategory[] = [
  { id: 'terminal', label: 'Terminál', icon: 'ic_berth', enabled: true, items: [BERTH] },
  { id: 'storage', label: 'Sklady', icon: 'ic_yard', enabled: true, items: [YARD] },
  { id: 'logistics', label: 'Logistika', icon: 'ic_vehicle', enabled: true, items: [CARRIER, DEPOT] },
];

function renderF3(activeCategoryId: string, overrides: Partial<BuildBarProps> = {}): string {
  return render({ categories: F3_CATEGORIES, activeCategoryId, ...overrides });
}

describe('položky s akciou (build / buy)', () => {
  it('bez `action` je položka `build`; `buy` sa nevyberá a nikdy nenesie stav vybranej', () => {
    expect(itemAction(BERTH)).toBe('build');
    expect(itemAction(CARRIER)).toBe('buy');
    expect(resolveItemSelection(CARRIER, null)).toBeUndefined();
    expect(resolveItemSelection(CARRIER, 'straddle_carrier')).toBeUndefined();
  });

  it('canBuyItem: len dostupná `buy` položka (zamknutá, drahá aj `build` nie)', () => {
    expect(canBuyItem(CARRIER)).toBe(true);
    expect(canBuyItem({ ...CARRIER, affordable: false })).toBe(false);
    expect(canBuyItem({ ...CARRIER, locked: true })).toBe(false);
    expect(canBuyItem(DEPOT)).toBe(false);
  });

  it('itemDetail: pri nákupe „kúpiť", pri stavbe rozmer, bez rozmeru nič', () => {
    expect(itemDetail(CARRIER)).toBe(BUY_ITEM_LABEL);
    expect(BUY_ITEM_LABEL).toBe('kúpiť');
    expect(itemDetail(DEPOT)).toBe('3×3');
    expect(itemDetail({ footprint: undefined })).toBeNull();
  });

  it('Sklady: dvor s cenou z formatMoney a rozmerom 4×4', () => {
    const html = renderF3('storage');
    expect(itemField(html, 'container_yard_small', 'item-cost')).toBe('$150,000');
    expect(itemField(html, 'container_yard_small', 'item-size')).toBe('· 4×4');
    expect(html).toMatch(/data-def-id="container_yard_small" data-status="available" data-action="build"/);
  });

  it('Logistika: straddle carrier $48,000 · kúpiť (bez aria-pressed), depo $90,000 · 3×3 ako stavba', () => {
    const html = renderF3('logistics');
    expect(itemField(html, 'straddle_carrier', 'item-cost')).toBe('$48,000');
    expect(itemField(html, 'straddle_carrier', 'item-size')).toBe('· kúpiť');
    expect(itemField(html, 'vehicle_depot', 'item-cost')).toBe('$90,000');
    expect(itemField(html, 'vehicle_depot', 'item-size')).toBe('· 3×3');
    expect(html).toMatch(/data-def-id="straddle_carrier" data-status="available" data-action="buy"/);
    expect(html).toContain('build-bar__item--buy');
    // `buy` je akcia, nie prepínač: len depo (stavba) má aria-pressed
    expect(html.match(/aria-pressed=/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-def-id="vehicle_depot"/);
  });

  it('`buy` položka sa nezvýrazní ani vtedy, keď jej defId sedí s výberom (výber patrí stavbám)', () => {
    const html = renderF3('logistics', { selectedDefId: 'straddle_carrier' });
    expect(html).not.toContain('build-bar__item--selected');
  });

  it('položka bez rozmeru nevykreslí `item-size`', () => {
    const noSize: BuildBarItem = { ...DEPOT, footprint: undefined };
    const html = render({ categories: [{ id: 'logistics', label: 'Logistika', icon: 'ic_vehicle', enabled: true, items: [noSize] }], activeCategoryId: 'logistics' });
    expect(itemField(html, 'vehicle_depot', 'item-cost')).toBe('$90,000');
    expect(html).not.toContain('data-field="item-size"');
  });

  it('zamknutý nákup („Postav depo vozidiel") a nákup bez peňazí majú tooltip a nekupujú', () => {
    const locked: BuildBarItem = { ...CARRIER, locked: true, lockedReason: 'Postav depo vozidiel' };
    const poor: BuildBarItem = { ...CARRIER, affordable: false, missingCents: 4_800_000 - 1_000_000 };
    expect(itemTooltip(locked)).toEqual({ title: 'Zamknuté', text: 'Postav depo vozidiel', icon: 'ic_lock', tone: 'locked' });
    expect(itemTooltip(poor)).toEqual({ title: 'Nedostatok peňazí', text: 'Chýba $38,000', icon: 'ic_cash', tone: 'poor' });

    const lockedHtml = render({ categories: [{ ...F3_CATEGORIES[2]!, items: [locked] }], activeCategoryId: 'logistics' });
    expect(lockedHtml).toContain('Postav depo vozidiel');
    expect(lockedHtml).toMatch(/aria-disabled="true"[^>]*data-def-id="straddle_carrier"[^>]*data-status="locked"[^>]*data-action="buy"/);
    expect(lockedHtml).toContain('build-bar__item-lock');
  });

  it('klik na dostupnú `buy` položku volá onBuy(defId), nie onSelect; drahá, zamknutá a `build` ho nevolajú', () => {
    const onBuy = vi.fn();
    const onSelect = vi.fn();
    const clickIn = (items: readonly BuildBarItem[], defId: string) => {
      const tree = BuildBar(
        makeProps({ categories: [{ id: 'logistics', label: 'Logistika', icon: 'ic_vehicle', enabled: true, items }], activeCategoryId: 'logistics', onBuy, onSelect }),
      );
      const [element] = findAll(tree, (candidate) => propsOf(candidate)['data-def-id'] === defId);
      (propsOf(element!)['onClick'] as () => void)();
    };

    clickIn([CARRIER, DEPOT], 'straddle_carrier');
    expect(onBuy).toHaveBeenCalledExactlyOnceWith('straddle_carrier');
    expect(onSelect).not.toHaveBeenCalled();

    clickIn([{ ...CARRIER, affordable: false }], 'straddle_carrier');
    clickIn([{ ...CARRIER, locked: true }], 'straddle_carrier');
    expect(onBuy).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    clickIn([CARRIER, DEPOT], 'vehicle_depot'); // stavba ide cez onSelect
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('vehicle_depot');
    expect(onBuy).toHaveBeenCalledTimes(1);
  });

  it('bez onBuy klik na `buy` položku nič nerobí (spätná kompatibilita s F2 rodičom)', () => {
    const onSelect = vi.fn();
    const tree = BuildBar(makeProps({ categories: F3_CATEGORIES, activeCategoryId: 'logistics', onSelect }));
    const [element] = findAll(tree, (candidate) => propsOf(candidate)['data-def-id'] === 'straddle_carrier');
    expect(() => {
      (propsOf(element!)['onClick'] as () => void)();
    }).not.toThrow();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
