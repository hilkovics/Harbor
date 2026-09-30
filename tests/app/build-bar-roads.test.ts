// T03-20: BuildBar kategória Landside — typy ciest z defov (cena za bunku), zamknuté zástupné položky (čoskoro F4)
// a napojenie ConnectedBuildBar na RoadSelection (klik na položku → výber typu, zvýraznenie, opakovaný klik ruší).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROAD_KINDS } from '@sim/grid';
import { loadBundledDefs } from '@sim/defs';
import { COMING_SOON_F4, ROAD_PRICE_UNIT, buildBarCategories, placeholderItem, roadKindItem } from '@app/build-bar-data';
import { BuildSelection } from '@app/build-selection';
import { ConnectedBuildBar } from '@app/connected-build-bar';
import { roadItemId } from '@app/road-build';
import { RoadSelection } from '@app/road-selection';
import { SimBridgeProvider } from '@app/use-sim-snapshot';
import { itemStatus, type BuildBarProps } from '@ui/build-bar';
import { createApp } from './app-fixtures';

// Prezentačný BuildBar nahradíme atrapou, ktorá zachytí props — overujeme napojenie na výber, nie vzhľad (tests/ui).
const captured = vi.hoisted(() => ({ bar: null as BuildBarProps | null }));

vi.mock('@ui/build-bar', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ui/build-bar')>();
  return {
    ...original,
    BuildBar: (props: BuildBarProps) => {
      captured.bar = props;
      return null;
    },
  };
});

beforeEach(() => {
  captured.bar = null;
});

const defs = loadBundledDefs();

function landside(cash = defs.economy.startingCashCents) {
  const found = buildBarCategories(defs, cash).find((category) => category.id === 'landside');
  if (found === undefined) throw new Error('kategória Landside chýba');
  return found;
}

describe('BuildBar Landside: typy ciest z defov', () => {
  it('kategória je povolená a ponúka tri typy ciest, potom tri zamknuté zástupné položky', () => {
    const category = landside();
    expect(category.enabled).toBe(true);
    expect(category.items.map((item) => item.defId)).toEqual(['road_two_lane', 'road_one_lane', 'road_one_way', 'gate', 'waiting_area', 'ramp']);
  });

  it('názvy podľa karty: Cesta dvojpruhová, Cesta jednopruhová, Jednosmerná cesta', () => {
    expect(landside().items.slice(0, 3).map((item) => item.displayName)).toEqual(['Cesta dvojpruhová', 'Cesta jednopruhová', 'Jednosmerná cesta']);
  });

  it('cena za bunku je z defs.infrastructure.roadKinds a text ceny je „$X / bunka“ ($2,000, $1,200, $1,500)', () => {
    const roads = landside().items.slice(0, 3);
    expect(roads.map((item) => item.costCents)).toEqual(ROAD_KINDS.map((kind) => defs.infrastructure.roadKinds[kind].costPerCellCents));
    expect(roads.map((item) => item.priceText)).toEqual(['$2,000 / bunka', '$1,200 / bunka', '$1,500 / bunka']);
    expect(ROAD_PRICE_UNIT).toBe('/ bunka');
  });

  it('cestné položky majú akciu road, ikonu cesty, nie sú zamknuté a nemajú rozmer', () => {
    for (const item of landside().items.slice(0, 3)) {
      expect(item).toMatchObject({ action: 'road', icon: 'ic_road', locked: false, affordable: true });
      expect(item.footprint).toBeUndefined();
      expect(itemStatus(item)).toBe('available');
    }
  });

  it('dostupnosť: hotovosť aspoň na jednu bunku stačí; o cent menej = unaffordable s chýbajúcou sumou', () => {
    const cost = defs.infrastructure.roadKinds.two_lane.costPerCellCents;
    expect(roadKindItem(defs, 'two_lane', cost)).toMatchObject({ affordable: true });
    expect(roadKindItem(defs, 'two_lane', cost).missingCents).toBeUndefined();
    const short = roadKindItem(defs, 'two_lane', cost - 1);
    expect(short).toMatchObject({ affordable: false, missingCents: 1 });
    expect(itemStatus(short)).toBe('unaffordable');
    expect(roadKindItem(defs, 'one_way', -500)).toMatchObject({ affordable: false, missingCents: 150_000 + 500 });
  });

  it('Vrátnica, Čakacia plocha a Rampa ostávajú zamknuté s textom „čoskoro (F4)“ (bez ceny)', () => {
    const placeholders = landside().items.slice(3);
    expect(placeholders.map((item) => item.displayName)).toEqual(['Vrátnica', 'Čakacia plocha', 'Rampa']);
    for (const item of placeholders) {
      expect(item).toMatchObject({ locked: true, lockedReason: 'čoskoro (F4)', priceText: 'čoskoro (F4)' });
      expect(item.action ?? 'build').toBe('build');
      expect(itemStatus(item)).toBe('locked');
    }
    expect(COMING_SOON_F4).toBe('čoskoro (F4)');
    expect(placeholderItem({ id: 'x', displayName: 'X', icon: 'ic_gate' })).toMatchObject({ defId: 'x', locked: true });
  });

  it('zamknuté zostávajú Železnica a Potrubia', () => {
    const categories = buildBarCategories(defs, 0);
    expect(categories.filter((category) => !category.enabled).map((category) => category.id)).toEqual(['rail', 'pipes']);
  });

  it('id cestných položiek sa nezrazia s defmi modulov ani vozidiel', () => {
    const all = buildBarCategories(defs, 0).flatMap((category) => category.items.map((item) => item.defId));
    expect(new Set(all).size).toBe(all.length);
    for (const kind of ROAD_KINDS) {
      expect(defs.modules.has(roadItemId(kind))).toBe(false);
    }
  });
});

describe('ConnectedBuildBar: cestné položky a RoadSelection', () => {
  function renderBar(roadSelection: RoadSelection): BuildBarProps {
    const app = createApp();
    renderToStaticMarkup(createElement(SimBridgeProvider, { bridge: app.bridge }, createElement(ConnectedBuildBar, { selection: new BuildSelection(), roadSelection })));
    if (captured.bar === null) throw new Error('BuildBar sa nevykreslil');
    return captured.bar;
  }

  it('bez výberu nesvieti žiadna cesta; s vybraným typom dostane BuildBar jeho defId', () => {
    expect(renderBar(new RoadSelection()).selectedRoadDefId).toBeNull();
    const selection = new RoadSelection();
    selection.select('one_lane');
    expect(renderBar(selection).selectedRoadDefId).toBe('road_one_lane');
  });

  it('onSelectRoad(defId) nastaví typ vo výbere, onSelectRoad(null) ho zruší, cudzie id nie je cesta', () => {
    const selection = new RoadSelection();
    const props = renderBar(selection);
    props.onSelectRoad?.('road_one_way');
    expect(selection.get()).toBe('one_way');
    props.onSelectRoad?.('road_two_lane');
    expect(selection.get()).toBe('two_lane');
    props.onSelectRoad?.(null);
    expect(selection.get()).toBeNull();
    props.onSelectRoad?.('berth_standard');
    expect(selection.get()).toBeNull();
  });

  it('výber modulov (onSelect) ide cez BuildSelection, nie cez RoadSelection', () => {
    const roads = new RoadSelection();
    const modules = new BuildSelection();
    const app = createApp();
    renderToStaticMarkup(createElement(SimBridgeProvider, { bridge: app.bridge }, createElement(ConnectedBuildBar, { selection: modules, roadSelection: roads })));
    captured.bar?.onSelect('berth_standard');
    expect(modules.get()).toBe('berth_standard');
    expect(roads.get()).toBeNull();
  });

  it('BuildBar dostane cestné položky v Landside s cenou za bunku', () => {
    const props = renderBar(new RoadSelection());
    const category = props.categories.find((c) => c.id === 'landside');
    expect(category?.items.slice(0, 3).map((item) => [item.action, item.priceText])).toEqual([
      ['road', '$2,000 / bunka'],
      ['road', '$1,200 / bunka'],
      ['road', '$1,500 / bunka'],
    ]);
  });

  it('bez roadSelection v props si komponent vedie vlastný výber (testy/demo) a nehádže', () => {
    const app = createApp();
    expect(() => renderToStaticMarkup(createElement(SimBridgeProvider, { bridge: app.bridge }, createElement(ConnectedBuildBar, { selection: new BuildSelection() })))).not.toThrow();
    expect(captured.bar?.selectedRoadDefId).toBeNull();
  });
});
