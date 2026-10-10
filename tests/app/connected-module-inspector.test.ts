import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoveModuleCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { ConnectedModuleInspector } from '@app/connected-module-inspector';
import { ModuleSelection } from '@app/module-selection';
import { SimBridgeProvider } from '@app/use-sim-snapshot';
import type { ModuleInspectorProps } from '@ui/module-inspector';
import { CHAIN_GATE_ID, buildFullChain, createApp, createPortApp } from './app-fixtures';

// `ModuleInspector` je čisto prezentačný (jeho vzhľad testuje tests/ui) — tu ho nahradíme atrapou, ktorá zachytí props,
// aby sme overili napojenie: dáta zo sveta, „Odstrániť“ cez validate + dispatch a „Zavrieť“ cez výber.
const captured = vi.hoisted(() => ({ props: null as ModuleInspectorProps | null }));

vi.mock('@ui/module-inspector', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ui/module-inspector')>();
  return {
    ...original,
    ModuleInspector: (props: ModuleInspectorProps) => {
      captured.props = props;
      return null;
    },
  };
});

const ROOT_BERTH = 1 as EntityId;
const ROOT_CRANE = 2 as EntityId;

beforeEach(() => {
  captured.props = null;
});

function render(app: ReturnType<typeof createApp | typeof createPortApp>, selection: ModuleSelection): string {
  return renderToStaticMarkup(createElement(SimBridgeProvider, { bridge: app.bridge }, createElement(ConnectedModuleInspector, { selection })));
}

const inspectorProps = (): ModuleInspectorProps => {
  if (captured.props === null) throw new Error('ModuleInspector sa nevykreslil');
  return captured.props;
};

describe('ConnectedModuleInspector', () => {
  it('bez výberu nevykreslí nič (pravý okraj mapy ostáva klikateľný)', () => {
    const html = render(createApp(), new ModuleSelection());
    expect(html).toBe('');
    expect(captured.props).toBeNull();
  });

  it('vybraný žeriav: panel v `.app__side` s dátami zo sveta', () => {
    const selection = new ModuleSelection();
    selection.select(ROOT_CRANE);
    const html = render(createApp(), selection);
    expect(html).toContain('class="app__side"');
    expect(inspectorProps().data).toMatchObject({ id: 2, kind: 'crane', stateLabel: 'Nečinný', removable: true, refundCents: 0 });
  });

  it('vybrané kotvisko: apron a dôvod, prečo sa nedá odstrániť', () => {
    const selection = new ModuleSelection();
    selection.select(ROOT_BERTH);
    render(createApp(), selection);
    expect(inspectorProps().data).toMatchObject({
      id: 1,
      apron: { used: 0, reserved: 0, capacity: 8 },
      removable: false,
      removeBlockedReason: 'Na kotvisku stoja žeriavy',
    });
  });

  it('vybraná brána (R4): panel dostane pozemné dáta zo sveta', () => {
    const app = createPortApp();
    buildFullChain(app, { units: 0, vehicles: 0 });
    const selection = new ModuleSelection();
    selection.select(CHAIN_GATE_ID);
    render(app, selection);
    expect(inspectorProps().data).toMatchObject({ kind: 'gate', gate: { queueLength: 0 }, connected: true });
  });

  it('výber modulu, ktorý vo svete nie je, nevykreslí nič', () => {
    const selection = new ModuleSelection();
    selection.select(999 as EntityId);
    expect(render(createApp(), selection)).toBe('');
    expect(captured.props).toBeNull();
  });

  it('Odstrániť: platný príkaz sa odošle cez dispatch a žeriav zmizne až po aplikovaní', () => {
    const app = createApp();
    const selection = new ModuleSelection();
    selection.select(ROOT_CRANE);
    render(app, selection);
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    inspectorProps().onRemove(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toBeInstanceOf(RemoveModuleCommand);
    expect(dispatch.mock.calls[0]?.[0].toJSON()).toEqual({ type: 'RemoveModule', moduleId: 2 });
    expect(app.world.modules.has(ROOT_CRANE)).toBe(true);
    app.loop.frame(0);
    expect(app.world.modules.has(ROOT_CRANE)).toBe(false);
  });

  it('Odstrániť: príkaz, ktorý validácia odmietne (kotvisko so žeriavom), sa neodošle', () => {
    const app = createApp();
    const selection = new ModuleSelection();
    selection.select(ROOT_BERTH);
    render(app, selection);
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    inspectorProps().onRemove(1);
    expect(dispatch).not.toHaveBeenCalled();
    app.loop.frame(0);
    expect(app.world.modules.has(ROOT_BERTH)).toBe(true);
  });

  it('Zavrieť zruší výber', () => {
    const app = createApp();
    const selection = new ModuleSelection();
    selection.select(ROOT_CRANE);
    render(app, selection);
    inspectorProps().onClose();
    expect(selection.get()).toBeNull();
  });
});
