import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SetGameSpeedCommand, SpawnShipDebugCommand, VALIDATION_REASONS, commandFromJSON } from '@sim/commands';
import { App } from '@app/app';
import {
  BuildFeedbackLabel,
  REASON_TEXT,
  cellCountLabel,
  feedbackIcon,
  feedbackText,
  isFundsOnly,
  type FeedbackSource,
} from '@app/build-feedback';
import { BuildSelection } from '@app/build-selection';
import type { BuildFeedback } from '@app/input-controller';
import { ModuleSelection } from '@app/module-selection';
import type { EntityId } from '@sim/core';
import { PausedBanner } from '@app/paused-banner';
import { SimBridgeProvider } from '@app/use-sim-snapshot';
import { createApp } from './app-fixtures';
import { setCash } from '../sim/helpers/economy';

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

describe('App: BuildBar dole (kategória Terminál z defs.modules)', () => {
  const render = (props: Partial<Parameters<typeof App>[0]> = {}): string => {
    const { bridge } = createApp();
    return renderToStaticMarkup(createElement(App, { bridge, feedback: NO_FEEDBACK, ...props }));
  };

  it('pás Stavba s aktívnym tabom Terminál a položkami Kotvisko a Kontajnerový žeriav (cena a rozmer z defov)', () => {
    const html = render();
    expect(html).toContain('class="app__build"');
    expect(html).toContain('aria-label="Stavba"');
    expect(html).toContain('data-active-category="terminal"');
    expect(html).toMatch(/data-category="terminal"[^>]*>/);
    expect(html).toContain('data-def-id="berth_standard"');
    expect(html).toContain('data-def-id="crane_container_gantry"');
    expect(html).toContain('Kotvisko');
    expect(html).toContain('Kontajnerový žeriav');
    expect(html).toContain('$400,000');
    expect(html).toContain('$600,000');
    expect(html).toContain('8×3');
    expect(html).toContain('2×3');
  });

  it('pri štartovej hotovosti (1 200 000 USD) sú obe položky dostupné', () => {
    const html = render();
    expect(html.match(/data-status="available"/g)).toHaveLength(2);
    expect(html).not.toContain('data-status="unaffordable"');
  });

  it('nedostatok peňazí: položka je „unaffordable“ s tooltipom „Chýba …“', () => {
    const { bridge, world } = createApp();
    setCash(world, 45_000_000);
    const html = renderToStaticMarkup(createElement(App, { bridge, feedback: NO_FEEDBACK }));
    expect(html).toMatch(/data-def-id="crane_container_gantry" data-status="unaffordable"/);
    expect(html).toContain('Chýba $150,000');
    expect(html).toMatch(/data-def-id="berth_standard" data-status="available"/);
  });

  it('kategórie mimo fázy sú zamknuté (disabled tab so zámkom); Terminál, Sklady, Logistika a Landside (cesty) sú povolené', () => {
    const html = render();
    for (const id of ['rail', 'pipes']) {
      expect(html, id).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*data-category="${id}"`));
    }
    for (const id of ['terminal', 'storage', 'logistics', 'landside']) {
      expect(html, id).not.toMatch(new RegExp(`<button[^>]*disabled=""[^>]*data-category="${id}"`));
    }
  });

  it('vybraná položka z BuildSelection je zvýraznená (aria-pressed)', () => {
    const selection = new BuildSelection();
    selection.select('berth_standard');
    const html = render({ selection });
    expect(html).toMatch(/aria-pressed="true"[^>]*data-def-id="berth_standard"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-def-id="crane_container_gantry"/);
  });

  it('bez výberu nie je nič stlačené', () => {
    const html = render();
    expect(html).not.toMatch(/aria-pressed="true"[^>]*data-def-id/);
  });
});

describe('App: DEV tlačidlo „Spawn feeder (DEV)“ je odstránené (T05-07)', () => {
  it('v strome nie je žiadny DEV nástroj ani tlačidlo spawnu lode', () => {
    const { bridge } = createApp();
    const html = renderToStaticMarkup(createElement(App, { bridge, feedback: NO_FEEDBACK }));
    expect(html).not.toContain('app__dev');
    expect(html).not.toContain('dev-spawn');
    expect(html).not.toContain('(DEV)');
  });

  it('modul tlačidla ani jeho konfigurácia neexistujú; príkaz SpawnShipDebug v sime ostáva', async () => {
    const config: Record<string, unknown> = await import('@app/config');
    expect(config['DEV_SPAWN_SHIP']).toBeUndefined();
    const modules = import.meta.glob('/src/app/*.tsx');
    expect(Object.keys(modules).some((path) => path.includes('dev-spawn'))).toBe(false);
    const { bridge } = createApp();
    const command = commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 });
    expect(command).toBeInstanceOf(SpawnShipDebugCommand);
    expect(bridge.validate(command).ok).toBe(true);
  });
});

describe('BuildFeedbackLabel: ghost modulu (T02-10)', () => {
  const module = (overrides: Partial<BuildFeedback> = {}): BuildFeedback =>
    sample({ kind: 'module', label: 'Kotvisko', moduleKind: 'berth', costCents: 40_000_000, cellCount: 24, dragging: false, fundsShort: false, ...overrides });
  const html = (feedback: BuildFeedback): string =>
    renderToStaticMarkup(createElement(BuildFeedbackLabel, { source: { feedback: () => feedback, subscribeFeedback: () => () => undefined } }));

  it('platný ghost: názov a cena, ikona druhu modulu, zelený štítok', () => {
    const feedback = module();
    expect(feedbackText(feedback)).toBe('Kotvisko · $400,000');
    expect(feedbackIcon(feedback)).toBe('ic_berth');
    const markup = html(feedback);
    expect(markup).toContain('build-tip--ok');
    expect(markup).toContain('data-kind="module"');
    expect(markup).toContain('data-funds-short="false"');
    expect(markup).toContain('ic_berth');
  });

  it('žeriav dostane ikonu žeriavu', () => {
    expect(feedbackIcon(module({ label: 'Kontajnerový žeriav', moduleKind: 'crane' }))).toBe('ic_crane');
  });

  it('neplatný ghost: názov, cena a slovenské dôvody; varovná ikona, červený štítok', () => {
    const feedback = module({ ok: false, reasons: ['terrain', 'no_water_side'] });
    expect(feedbackText(feedback)).toBe('Kotvisko · $400,000 · Nevhodný terén · Dlhá hrana musí byť pri vode');
    expect(feedbackIcon(feedback)).toBe('ic_warning');
    expect(isFundsOnly(feedback)).toBe(false);
    const markup = html(feedback);
    expect(markup).toContain('build-tip--bad');
    expect(markup).toContain('ic_warning');
    expect(markup).toContain('Dlhá hrana musí byť pri vode');
  });

  it('len nedostatok peňazí: ikona $ a varovný (nie chybový) štítok, klik ale nič nepostaví', () => {
    const feedback = module({ ok: false, reasons: ['insufficient_funds'], fundsShort: true });
    expect(isFundsOnly(feedback)).toBe(true);
    expect(feedbackIcon(feedback)).toBe('ic_cash');
    expect(feedbackText(feedback)).toBe('Kotvisko · $400,000 · Nedostatok peňazí');
    const markup = html(feedback);
    expect(markup).toContain('build-tip--funds');
    expect(markup).not.toContain('build-tip--bad');
    expect(markup).toContain('data-funds-short="true"');
    expect(markup).toContain('ic_cash');
  });

  it('nedostatok peňazí spolu s iným dôvodom je chyba (ikona varovania)', () => {
    const feedback = module({ ok: false, reasons: ['insufficient_funds', 'occupied'], fundsShort: true });
    expect(isFundsOnly(feedback)).toBe(false);
    expect(feedbackIcon(feedback)).toBe('ic_warning');
    expect(html(feedback)).toContain('build-tip--bad');
  });

  it('cesty: ikona cesty / búrania / varovania; nedostatok peňazí (fundsShort) je ako pri moduloch $ a nie chyba (T03-20)', () => {
    expect(feedbackIcon(sample())).toBe('ic_road');
    expect(feedbackIcon(sample({ kind: 'remove' }))).toBe('ic_demolish');
    expect(feedbackIcon(sample({ ok: false, reasons: ['insufficient_funds'] }))).toBe('ic_warning'); // bez fundsShort: chyba
    const short = sample({ ok: false, reasons: ['insufficient_funds'], fundsShort: true });
    expect(isFundsOnly(short)).toBe(true);
    expect(feedbackIcon(short)).toBe('ic_cash');
    expect(isFundsOnly(sample({ ok: false, reasons: ['insufficient_funds', 'terrain'], fundsShort: true }))).toBe(false);
  });
});

describe('App: inšpektor modulu vpravo (T02-10)', () => {
  const render = (moduleSelection?: ModuleSelection): string => {
    const { bridge } = createApp();
    return renderToStaticMarkup(createElement(App, { bridge, feedback: NO_FEEDBACK, ...(moduleSelection === undefined ? {} : { moduleSelection }) }));
  };

  it('bez výberu panel v DOM nie je', () => {
    const html = render();
    expect(html).not.toContain('app__side');
    expect(html).not.toContain('Inšpektor modulu');
  });

  it('vybraný Root žeriav: panel s názvom, stavom Nečinný, vrátením $0 a aktívnym Odstrániť', () => {
    const selection = new ModuleSelection();
    selection.select(2 as EntityId);
    const html = render(selection);
    expect(html).toContain('class="app__side"');
    expect(html).toContain('aria-label="Inšpektor modulu"');
    expect(html).toContain('Kontajnerový žeriav');
    expect(html).toContain('Nečinný');
    expect(html).toMatch(/aria-disabled="false"[^>]*data-action="remove"/);
  });

  it('vybrané Root kotvisko: apron 0 / 8 a zablokované Odstrániť s dôvodom', () => {
    const selection = new ModuleSelection();
    selection.select(1 as EntityId);
    const html = render(selection);
    expect(html).toContain('0 / 8 slotov');
    expect(html).toMatch(/aria-disabled="true"[^>]*data-action="remove"/);
    expect(html).toContain('Na kotvisku stoja žeriavy');
  });
});
