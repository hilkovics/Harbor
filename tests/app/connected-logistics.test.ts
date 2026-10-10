// T03-10: BuildBar a inšpektor pripojené na sim — nákup vozidla (BuildBar aj depo), predaj, dáta skladu a depa.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuyVehicleCommand, SellVehicleCommand } from '@sim/commands';
import { BuildSelection } from '@app/build-selection';
import { ConnectedBuildBar } from '@app/connected-build-bar';
import { ConnectedModuleInspector } from '@app/connected-module-inspector';
import { ModuleSelection } from '@app/module-selection';
import { SimBridgeProvider } from '@app/use-sim-snapshot';
import type { BuildBarProps } from '@ui/build-bar';
import type { ModuleInspectorProps } from '@ui/module-inspector';
import { DEPOT_ID, YARD_ID, buildLogistics, buyVehicles, createApp, type App } from './app-fixtures';

// Prezentačné komponenty nahradíme atrapami, ktoré zachytia props — overujeme napojenie na sim, nie vzhľad (tests/ui).
const captured = vi.hoisted(() => ({ bar: null as BuildBarProps | null, inspector: null as ModuleInspectorProps | null }));

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

vi.mock('@ui/module-inspector', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ui/module-inspector')>();
  return {
    ...original,
    ModuleInspector: (props: ModuleInspectorProps) => {
      captured.inspector = props;
      return null;
    },
  };
});

beforeEach(() => {
  captured.bar = null;
  captured.inspector = null;
});

function renderBar(app: App, selection = new BuildSelection()): BuildBarProps {
  renderToStaticMarkup(createElement(SimBridgeProvider, { bridge: app.bridge }, createElement(ConnectedBuildBar, { selection })));
  if (captured.bar === null) throw new Error('BuildBar sa nevykreslil');
  return captured.bar;
}

function renderInspector(app: App, moduleId: number): ModuleInspectorProps {
  const selection = new ModuleSelection();
  selection.select(moduleId as never);
  renderToStaticMarkup(createElement(SimBridgeProvider, { bridge: app.bridge }, createElement(ConnectedModuleInspector, { selection })));
  if (captured.inspector === null) throw new Error('ModuleInspector sa nevykreslil');
  return captured.inspector;
}

const carrierItem = (props: BuildBarProps) => props.categories.find((c) => c.id === 'logistics')?.items.find((item) => item.defId === 'straddle_carrier');

describe('ConnectedBuildBar: Sklady a Logistika', () => {
  it('kategórie Sklady a Logistika sú povolené; vozidlo bez depa je zamknuté s dôvodom', () => {
    const props = renderBar(createApp());
    expect(props.categories.filter((c) => c.enabled).map((c) => c.id)).toEqual(['terminal', 'storage', 'logistics', 'landside']);
    expect(carrierItem(props)).toMatchObject({ action: 'buy', locked: true, lockedReason: 'Postav a pripoj depo vozidiel' });
  });

  it('s pripojeným depom je vozidlo odomknuté; kliknutie (onBuy) odošle BuyVehicle do depa a vozidlo pribudne', () => {
    const app = createApp();
    buildLogistics(app);
    const props = renderBar(app);
    expect(carrierItem(props)).toMatchObject({ locked: false, affordable: true });
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    props.onBuy?.('straddle_carrier');
    expect(dispatch.mock.calls[0]?.[0]).toBeInstanceOf(BuyVehicleCommand);
    expect(dispatch.mock.calls[0]?.[0].toJSON()).toEqual({ type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID });
    app.loop.frame(0);
    expect(app.world.vehicles.size).toBe(1);
  });

  it('plné depo: vozidlo zamknuté „Depá sú plné“ a onBuy nič neodošle', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, app.world.defs.modules.get('vehicle_depot').params['capacity'] as number);
    const props = renderBar(app);
    expect(carrierItem(props)).toMatchObject({ locked: true, lockedReason: 'Depá sú plné' });
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    props.onBuy?.('straddle_carrier');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('výber stavby (dvor) ide cez BuildSelection, nákup ho nemení', () => {
    const app = createApp();
    buildLogistics(app);
    const selection = new BuildSelection();
    const props = renderBar(app, selection);
    props.onSelect('container_yard_small');
    expect(selection.get()).toBe('container_yard_small');
    props.onBuy?.('straddle_carrier');
    expect(selection.get()).toBe('container_yard_small');
  });
});

describe('ConnectedModuleInspector: sklad a depo', () => {
  it('vybraný dvor: dáta skladu a connected z modulu', () => {
    const app = createApp();
    buildLogistics(app);
    expect(renderInspector(app, YARD_ID).data).toMatchObject({
      kind: 'storage',
      connected: true,
      storage: { stored: 0, reserved: 0, capacity: 48, unitsIn: 0, unitsOut: 0 },
    });
  });

  it('vybrané depo: onBuyVehicle(depotId) odošle BuyVehicle do tohto depa', () => {
    const app = createApp();
    buildLogistics(app);
    const props = renderInspector(app, DEPOT_ID);
    expect(props.data.depot).toMatchObject({ canBuy: true, vehicles: [] });
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    props.onBuyVehicle?.(DEPOT_ID);
    expect(dispatch.mock.calls[0]?.[0]).toBeInstanceOf(BuyVehicleCommand);
    expect(dispatch.mock.calls[0]?.[0].toJSON()).toEqual({ type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID });
    app.loop.frame(0);
    expect(app.world.vehicles.size).toBe(1);
  });

  it('onBuyVehicle do plného depa sa neodošle (validate)', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, app.world.defs.modules.get('vehicle_depot').params['capacity'] as number);
    const props = renderInspector(app, DEPOT_ID);
    expect(props.data.depot?.canBuy).toBe(false);
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    props.onBuyVehicle?.(DEPOT_ID);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('onSellVehicle predá nečinné vozidlo (SellVehicle) a hotovosť sa zvýši o refund z inšpektora', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 1);
    const props = renderInspector(app, DEPOT_ID);
    const row = props.data.depot?.vehicles[0];
    expect(row).toMatchObject({ state: 'idle', refundCents: 2_400_000 });
    const cash = app.world.cashCents;
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    props.onSellVehicle?.(row?.id ?? 0);
    expect(dispatch.mock.calls[0]?.[0]).toBeInstanceOf(SellVehicleCommand);
    app.loop.frame(0);
    expect(app.world.vehicles.size).toBe(0);
    expect(app.world.cashCents).toBe(cash + (row?.refundCents ?? 0));
  });
});
