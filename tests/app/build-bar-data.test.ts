import { describe, expect, it } from 'vitest';
import type { ModuleDef } from '@sim/defs';
import { loadBundledDefs } from '@sim/defs';
import { BUILD_CATEGORIES, DEFAULT_BUILD_CATEGORY_ID, buildBarCategories, buildBarItem } from '@app/build-bar-data';
import { itemStatus } from '@ui/build-bar';

const defs = loadBundledDefs();
const BERTH_COST = defs.modules.get('berth_standard').costCents;
const CRANE_COST = defs.modules.get('crane_container_gantry').costCents;

function terminalItems(cashCents: number) {
  const terminal = buildBarCategories(defs, cashCents).find((category) => category.id === 'terminal');
  if (terminal === undefined) throw new Error('kategória Terminál chýba');
  return terminal.items;
}

describe('buildBarCategories: kategórie', () => {
  it('poradie a názvy z prototypu; vo F3 sú povolené Terminál, Sklady, Logistika a Landside (cesty), ostatné sú zamknuté a bez položiek', () => {
    const categories = buildBarCategories(defs, 0);
    expect(categories.map((category) => [category.id, category.label, category.enabled])).toEqual([
      ['terminal', 'Terminál', true],
      ['storage', 'Sklady', true],
      ['logistics', 'Logistika', true],
      ['landside', 'Landside', true],
      ['rail', 'Železnica', false],
      ['pipes', 'Potrubia', false],
    ]);
    for (const category of categories.filter((c) => !c.enabled)) expect(category.items).toEqual([]);
  });

  it('predvolená kategória je povolená a existuje', () => {
    expect(BUILD_CATEGORIES.find((category) => category.id === DEFAULT_BUILD_CATEGORY_ID)?.enabled).toBe(true);
  });

  it('Terminál: berth_standard a crane_container_gantry v poradí defu', () => {
    expect(terminalItems(0).map((item) => item.defId)).toEqual(['berth_standard', 'crane_container_gantry']);
  });

  it('každý def modulu patrí najviac do jednej kategórie (žiadne duplikáty položiek)', () => {
    const all = buildBarCategories(defs, 0).flatMap((category) => category.items.map((item) => item.defId));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('buildBarCategories: položky z defs.modules', () => {
  it('názov, cena a rozmer footprintu pri rotácii 0 idú z defu; ikony podľa druhu modulu', () => {
    const [berth, crane] = terminalItems(0);
    expect(berth).toMatchObject({ defId: 'berth_standard', displayName: 'Kotvisko', costCents: BERTH_COST, footprint: { w: 8, h: 4 }, icon: 'ic_berth', locked: false });
    expect(crane).toMatchObject({ defId: 'crane_container_gantry', displayName: 'Kontajnerový žeriav', costCents: CRANE_COST, footprint: { w: 2, h: 3 }, icon: 'ic_crane', locked: false });
  });

  it('štartovná hotovosť (1 200 000 USD) stačí na oboje: affordable, bez missingCents', () => {
    for (const item of terminalItems(defs.economy.startingCashCents)) {
      expect(item.affordable).toBe(true);
      expect(item.missingCents).toBeUndefined();
      expect(itemStatus(item)).toBe('available');
    }
  });

  it('hotovosť medzi cenami: kotvisko áno, žeriav nie — chýba rozdiel', () => {
    const cash = BERTH_COST + 5_000_000; // 450 000 USD pri cenách F2
    expect(cash).toBeLessThan(CRANE_COST);
    const [berth, crane] = terminalItems(cash);
    expect(berth?.affordable).toBe(true);
    expect(crane?.affordable).toBe(false);
    expect(crane?.missingCents).toBe(CRANE_COST - cash);
    expect(crane === undefined ? null : itemStatus(crane)).toBe('unaffordable');
  });

  it('hranica: hotovosť presne rovná cene stačí, o cent menej nie', () => {
    expect(terminalItems(BERTH_COST)[0]?.affordable).toBe(true);
    const short = terminalItems(BERTH_COST - 1)[0];
    expect(short?.affordable).toBe(false);
    expect(short?.missingCents).toBe(1);
  });

  it('záporná hotovosť (dlh): nič nie je dostupné a chýba cena + dlh', () => {
    const [berth] = terminalItems(-1_000);
    expect(berth?.affordable).toBe(false);
    expect(berth?.missingCents).toBe(BERTH_COST + 1_000);
  });

  it('def s techRequired je zamknutý s dôvodom (strom technológií príde vo F8)', () => {
    const base = defs.modules.get('berth_standard');
    const locked: ModuleDef = { ...base, id: 'berth_deep', techRequired: 'deep_water' };
    const item = buildBarItem(locked, 10 * BERTH_COST);
    expect(item.locked).toBe(true);
    expect(item.lockedReason).toBe('Vyžaduje technológiu deep_water');
    expect(itemStatus(item)).toBe('locked');
    expect('lockedReason' in buildBarItem(base, 0)).toBe(false);
  });

  it('položka nezdieľa objekt footprintu s defom (def je zmrazený)', () => {
    const def = defs.modules.get('berth_standard');
    expect(buildBarItem(def, 0).footprint).not.toBe(def.footprint);
  });
});
