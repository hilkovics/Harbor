// T05-07: App s kontraktmi — HUD (delta dňa, XP, ikona panelu), ContractsPanel z kariet snapshotu, prednosť panelu pred
// inšpektorom, GameOverModal pri bankrote a výmena „Novej hry“.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { App } from '@app/app';
import type { FeedbackSource } from '@app/build-feedback';
import { ModuleSelection } from '@app/module-selection';
import { PanelSelection, bindPanelExclusion, isPanelId } from '@app/panel-selection';
import { createApp } from './app-fixtures';
import { createAppWithEconomy, runDays } from './contracts-fixtures';

const NO_FEEDBACK: FeedbackSource = { feedback: () => null, subscribeFeedback: () => () => undefined };

function render(app: ReturnType<typeof createApp>, props: Partial<Parameters<typeof App>[0]> = {}): string {
  return renderToStaticMarkup(createElement(App, { bridge: app.bridge, feedback: NO_FEEDBACK, ...props }));
}

describe('App: HUD s dátami F5', () => {
  it('ukazuje delta dňa a XP zo snapshotu (nie zástupné `—`)', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    const html = render(app);
    expect(html).toMatch(/data-field="cash-delta"[^>]*>[^<]*(?:<[^>]+>)*\$0\/deň/);
    expect(html).not.toContain('—/deň');
    expect(html).toContain('>0 XP<');
  });

  it('ikona kontraktov je aktívna (nie placeholder), stlačená, keď je panel otvorený', () => {
    const app = createApp();
    const panels = new PanelSelection();
    expect(render(app, { panels })).toMatch(/aria-pressed="false"[^>]*data-field="panel-contracts"/);
    panels.select('contracts');
    const html = render(app, { panels });
    expect(html).toMatch(/aria-pressed="true"[^>]*data-field="panel-contracts"/);
    expect(html).not.toMatch(/data-field="panel-contracts"[^>]*disabled/);
  });
});

describe('App: panel kontraktov', () => {
  it('zatvorený panel v strome nie je; otvorený ukáže ponuky s tlačidlami Prijať / Odmietnuť', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    const panels = new PanelSelection();
    expect(render(app, { panels })).not.toContain('contracts-panel');
    panels.select('contracts');
    const html = render(app, { panels });
    expect(html).toContain('class="contracts-panel"');
    expect(html).toContain('data-panel="contracts"');
    expect(html.match(/data-action="accept"/g)).toHaveLength(app.world.defs.economy.offersPerDay);
    expect(html.match(/data-action="decline"/g)).toHaveLength(app.world.defs.economy.offersPerDay);
    expect(html).toContain('Kontajnery');
    expect(html).toContain('TEU');
  });

  it('po bankrote je „Prijať“ zablokované s dôvodom zo simu', () => {
    const app = createAppWithEconomy({ bankruptcyDays: 1 }, -1);
    app.loop.frame(app.loop.tickMs);
    runDays(app, 1);
    const panels = new PanelSelection();
    panels.select('contracts');
    const html = render(app, { panels });
    expect(html).toContain('Hra skončila');
    expect(html).toMatch(/aria-disabled="true"[^>]*data-action="accept"/);
  });
});

describe('PanelSelection a vylúčenie s inšpektorom', () => {
  it('toggle otvára a zatvára; isPanelId pozná len existujúce panely', () => {
    const panels = new PanelSelection();
    panels.toggle('contracts');
    expect(panels.get()).toBe('contracts');
    panels.toggle('contracts');
    expect(panels.get()).toBeNull();
    expect([isPanelId('contracts'), isPanelId('finance')]).toEqual([true, false]);
  });

  it('otvorený panel zruší výber modulu; výber modulu panel zavrie; po odhlásení sa nič nedeje', () => {
    const panels = new PanelSelection();
    const modules = new ModuleSelection();
    const stop = bindPanelExclusion(panels, modules);
    modules.select(1 as EntityId);
    panels.select('contracts');
    expect(modules.get()).toBeNull();
    expect(panels.get()).toBe('contracts');
    modules.select(1 as EntityId);
    expect(panels.get()).toBeNull();
    expect(modules.get()).toBe(1);
    stop();
    panels.select('contracts');
    expect(modules.get()).toBe(1);
  });

  it('inšpektor sa pri otvorenom paneli nevykreslí, panel má prednosť', () => {
    const app = createApp();
    const moduleSelection = new ModuleSelection();
    moduleSelection.select(1 as EntityId);
    const panels = new PanelSelection();
    expect(render(app, { moduleSelection, panels })).toContain('aria-label="Inšpektor modulu"');
    // Vylúčenie beží v `useEffect` (SSR ho nespustí) — výber preto zrušíme tak, ako ho zruší App po otvorení panelu.
    const stop = bindPanelExclusion(panels, moduleSelection);
    panels.select('contracts');
    const html = render(app, { moduleSelection, panels });
    stop();
    expect(html).not.toContain('aria-label="Inšpektor modulu"');
    expect(html).toContain('class="contracts-panel"');
  });
});

describe('App: GameOverModal', () => {
  it('bez bankrotu modál nie je', () => {
    const app = createApp();
    app.loop.frame(app.loop.tickMs);
    expect(render(app)).not.toContain('game-over');
  });

  it('po bankrote: modál „Bankrot“ so štatistikami zo snapshotu a tlačidlom „Nová hra“', () => {
    const app = createAppWithEconomy({ bankruptcyDays: 1 }, -1);
    app.loop.frame(app.loop.tickMs);
    runDays(app, 1);
    expect(app.world.gameOver).toBe(true);
    const html = render(app);
    expect(html).toContain('class="app__modal"');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('Bankrot');
    expect(html).toContain('Hotovosť zostala záporná 1 dní po sebe');
    expect(html).toMatch(/data-field="days">1</);
    expect(html).toMatch(/data-field="contracts">0</);
    expect(html).toMatch(/data-field="xp">0 XP</);
    expect(html).toContain('data-action="new-game"');
  });
});
