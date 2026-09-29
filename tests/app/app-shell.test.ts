import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SetGameSpeedCommand, VALIDATION_REASONS } from '@sim/commands';
import { App } from '@app/app';
import { BuildFeedbackLabel, REASON_TEXT, cellCountLabel, feedbackText, type FeedbackSource } from '@app/build-feedback';
import type { BuildFeedback } from '@app/input-controller';
import { PausedBanner } from '@app/paused-banner';
import { SimBridgeProvider } from '@app/use-sim-snapshot';
import { createApp } from './app-fixtures';

const NO_FEEDBACK: FeedbackSource = { feedback: () => null, subscribeFeedback: () => () => undefined };

const sample = (overrides: Partial<BuildFeedback> = {}): BuildFeedback => ({
  kind: 'place',
  ok: true,
  reasons: [],
  costCents: 600_000,
  cellCount: 3,
  x: 100,
  y: 80,
  dragging: true,
  ...overrides,
});

describe('App (UI vrstva nad mapou)', () => {
  it('obsahuje (vizuálne skrytý) nadpis „Modular Harbor“ a HUD s hotovosťou', () => {
    const { bridge } = createApp();
    const html = renderToStaticMarkup(createElement(App, { bridge, feedback: NO_FEEDBACK }));
    expect(html).toContain('<h1 class="app__title">Modular Harbor</h1>');
    expect(html).toContain('data-field="cash"');
    expect(html).toContain('$1,200,000');
    expect(html).not.toContain('paused-banner'); // hra beží
    expect(html).not.toContain('build-tip'); // žiadna spätná väzba
  });
});

describe('PausedBanner', () => {
  const render = (bridge: ReturnType<typeof createApp>['bridge']): string =>
    renderToStaticMarkup(createElement(SimBridgeProvider, { bridge }, createElement(PausedBanner)));

  it('pri rýchlosti 0 ukáže „Pozastavené“ s nápovedou klávesu a ikonou', () => {
    const app = createApp();
    app.bridge.dispatch(new SetGameSpeedCommand(0));
    app.world.applyPending();
    const html = render(app.bridge);
    expect(html).toContain('Pozastavené');
    expect(html).toContain('<kbd class="paused-banner__key">Medzerník</kbd>');
    expect(html).toContain('ic_pause');
  });

  it('pri bežiacej hre nič nevykreslí', () => {
    expect(render(createApp().bridge)).toBe('');
  });
});

describe('BuildFeedbackLabel', () => {
  const source = (feedback: BuildFeedback | null): FeedbackSource => ({ feedback: () => feedback, subscribeFeedback: () => () => undefined });

  it('platný ťah: názov, počet buniek a cena; poloha z kurzora; stav nesie ikona aj text', () => {
    const html = renderToStaticMarkup(createElement(BuildFeedbackLabel, { source: source(sample()) }));
    expect(html).toContain('Cesta · 3 bunky · $6,000');
    expect(html).toContain('build-tip--ok');
    expect(html).toContain('left:100px;top:80px');
    expect(html).toContain('ic_road');
  });

  it('neplatný ťah: dôvody odmietnutia a varovná ikona', () => {
    const html = renderToStaticMarkup(
      createElement(BuildFeedbackLabel, { source: source(sample({ ok: false, reasons: ['terrain', 'insufficient_funds'], cellCount: 0 })) }),
    );
    expect(html).toContain('Nevhodný terén · Nedostatok peňazí');
    expect(html).toContain('build-tip--bad');
    expect(html).toContain('ic_warning');
  });

  it('bez spätnej väzby nič nevykreslí', () => {
    expect(renderToStaticMarkup(createElement(BuildFeedbackLabel, { source: source(null) }))).toBe('');
  });
});

describe('feedbackText', () => {
  it('odstránenie ukáže refundáciu ako príjem so znamienkom (costCents je záporné)', () => {
    expect(feedbackText(sample({ kind: 'remove', costCents: -300_000, cellCount: 3 }))).toBe('Odstrániť · 3 bunky · +$3,000');
  });

  it('cellCountLabel: slovenské tvary 1 / 2–4 / 5+', () => {
    expect([0, 1, 2, 4, 5, 11].map(cellCountLabel)).toEqual(['0 buniek', '1 bunka', '2 bunky', '4 bunky', '5 buniek', '11 buniek']);
  });

  it('každý dôvod odmietnutia zo simu má slovenský popis', () => {
    for (const reason of VALIDATION_REASONS) expect(REASON_TEXT[reason], reason).toMatch(/\S/);
  });
});
