// T03-20: BuildBar kategória Landside — typy ciest z defov (cena za bunku) a napojenie ConnectedBuildBar na RoadSelection
// (klik na položku → výber typu, zvýraznenie, opakovaný klik ruší). T04-08: za cestami nasledujú moduly z defov, bez zástupných položiek.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROAD_KINDS } from '@sim/grid';
import { loadBundledDefs } from '@sim/defs';
import { ROAD_PRICE_UNIT, buildBarCategories, roadKindItem } from '@app/build-bar-data';
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
  it('kategória je povolená a ponúka len jednosmerku (R1: ADR-037), potom moduly z defov (bez zástupných položiek)', () => {
    const category = landside();
    expect(category.enabled).toBe(true);
    expect(category.items.map((item) => item.defId)).toEqual([
      'road_one_way',
      'gate_in_lane',
      'gate_out_lane',
      'pre_gate_buffer',
      'truck_holding',
    ]);
  });

  it('názov: Jednosmerná cesta', () => {
    expect(landside().items[0].displayName).toEqual('Jednosmerná cesta');
  });

  it('cena za bunku je z defs.infrastructure.roadKinds a text ceny je „$X / bunka” ($1,500)', () => {
    const road = landside().items[0];
    expect(road.costCents).toEqual(defs.infrastructure.roadKinds.one_way.costPerCellCents);
    expect(road.priceText).toEqual('$1,500 / bunka');
    expect(ROAD_PRICE_UNIT).toBe('/ bunka');
  });

  it('cestná položka má akciu road, ikonu cesty, nie je zamknutá a nemá rozmer', () => {
    const item = landside().items[0];
    expect(item).toMatchObject({ action: 'road', icon: 'ic_road', locked: false, affordable: true });
    expect(item.footprint).toBeUndefined();
    expect(itemStatus(item)).toBe('available');
  });

  it('dostupnosť: hotovosť aspoň na jednu bunku stačí; o cent menej = unaffordable s chýbajúcou sumou', () => {
    const cost = defs.infrastructure.roadKinds.one_way.costPerCellCents;
    expect(roadKindItem(defs, 'one_way', cost)).toMatchObject({ affordable: true });
    expect(roadKindItem(defs, 'one_way', cost).missingCents).toBeUndefined();
    const short = roadKindItem(defs, 'one_way', cost - 1);
    expect(short).toMatchObject({ affordable: false, missingCents: 1 });
    expect(itemStatus(short)).toBe('unaffordable');
  });

  it('moduly Landside z defov: názov, cena, ikona druhu, rozmer; nie sú zamknuté a majú akciu stavby', () => {
    const modules = landside().items.slice(1);
    expect(modules.map((item) => [item.displayName, item.costCents, item.icon, item.footprint])).toEqual([
      ['Vstupný pruh brány', 2_500_000, 'ic_gate', { w: 1, h: 4 }],
      ['Výstupný pruh brány', 2_500_000, 'ic_gate', { w: 1, h: 4 }],
      ['Predbránová plocha', 9_000_000, 'ic_inspect', { w: 8, h: 8 }],
      ['Odstavná plocha kamiónov', 5_000_000, 'ic_inspect', { w: 6, h: 5 }],
    ]);
    for (const item of modules) {
      expect(item).toMatchObject({ locked: false, affordable: true });
      expect(item.lockedReason).toBeUndefined();
      expect(item.priceText).toBeUndefined();
      expect(item.action ?? 'build').toBe('build');
      expect(itemStatus(item)).toBe('available');
    }
  });

  it('moduly Landside bez peňazí: nedostupné (unaffordable) s chýbajúcou sumou, nie zamknuté', () => {
    const modules = landside(0).items.slice(1);
    expect(modules.map((item) => item.missingCents)).toEqual([2_500_000, 2_500_000, 9_000_000, 5_000_000]);
    for (const item of modules) expect(itemStatus(item)).toBe('unaffordable');
  });

  it('ponuka nemá zástupné položky (gate, waiting_area, ramp, „čoskoro (F4)“)', () => {
    const items = buildBarCategories(defs, defs.economy.startingCashCents).flatMap((category) => category.items);
    for (const defId of ['gate', 'waiting_area', 'ramp']) expect(items.some((item) => item.defId === defId)).toBe(false);
    expect(items.some((item) => item.priceText === 'čoskoro (F4)' || item.lockedReason === 'čoskoro (F4)')).toBe(false);
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

  it('BuildBar dostane cestné položky v Landside — len jednosmerka s cenou za bunku (R1: ADR-037)', () => {
    const props = renderBar(new RoadSelection());
    const category = props.categories.find((c) => c.id === 'landside');
    expect(category?.items.slice(0, 1).map((item) => [item.action, item.priceText])).toEqual([
      ['road', '$1,500 / bunka'],
    ]);
  });

  it('bez roadSelection v props si komponent vedie vlastný výber (testy/demo) a nehádže', () => {
    const app = createApp();
    expect(() => renderToStaticMarkup(createElement(SimBridgeProvider, { bridge: app.bridge }, createElement(ConnectedBuildBar, { selection: new BuildSelection() })))).not.toThrow();
    expect(captured.bar?.selectedRoadDefId).toBeNull();
  });
});
