import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SetGameSpeedCommand } from '@sim/commands';
import { SimBridgeProvider } from '@app/use-sim-snapshot';
import { createStaticBridge } from '@ui/__demo__/static-bridge';
import { SpeedControl } from '@ui/speed-control';
import { HUD_PANEL_BUTTONS, TopHUD, TopHUDView, resolveSpeedRequest, useSetGameSpeed, type TopHUDProps } from '@ui/top-hud';
import { createApp } from '../app/app-fixtures';
import { fieldText, findAll, propsOf } from './react-tree';

const MINUS = '−';

function renderHud(app: ReturnType<typeof createApp>, props: TopHUDProps = {}): string {
  return renderToStaticMarkup(createElement(SimBridgeProvider, { bridge: app.bridge }, createElement(TopHUD, props)));
}

function speedButtons(html: string): number[] {
  return [...html.matchAll(/data-speed="(\d+)"/g)].map((match) => Number(match[1]));
}

describe('TopHUD (pripojený na SimBridge)', () => {
  it('nový svet: hotovosť z defs, „Deň 1 · 00:00", rýchlosť 1× je aktívna', () => {
    const app = createApp();
    const html = renderHud(app);
    expect(app.world.cashCents).toBe(120_000_000); // data/defs/economy.json → startingCashCents
    expect(fieldText(html, 'cash')).toBe('$1,200,000');
    expect(fieldText(html, 'time')).toBe('Deň 1 · 00:00');
    expect(app.world.clock.speed).toBe(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-speed="1"/);
    expect(html.match(/speed-control__btn--active/g)).toHaveLength(1);
    expect(html).toContain('data-paused="false"');
    expect(html).toContain('data-debt="false"');
  });

  it('zoznam rýchlostí je z world.defs.time.speeds, nie natvrdo', () => {
    const app = createApp();
    expect(speedButtons(renderHud(app))).toEqual([...app.world.defs.time.speeds]);
    expect(speedButtons(renderHud(app, { speeds: [0, 5] }))).toEqual([0, 5]);
  });

  it('zoznam rýchlostí sa číta zo snapshotu (speeds), nie zo sveta: falošný bridge bez `world` stačí', () => {
    const { bridge } = createStaticBridge({}, [0, 3, 6]);
    const html = renderToStaticMarkup(createElement(SimBridgeProvider, { bridge }, createElement(TopHUD)));
    expect(speedButtons(html)).toEqual([0, 3, 6]);
  });

  it('snapshot.speeds je time.speeds sveta (rovnaká referencia)', () => {
    const app = createApp();
    expect(app.bridge.snapshot().speeds).toBe(app.world.defs.time.speeds);
  });

  it('čas sleduje snapshot: Deň 12 · 14:20 po zodpovedajúcom počte tickov', () => {
    // ~100 000 tickov len kvôli kalendáru — invarianty kroku 12 by beh zbytočne naťahovali k limitu 5 s.
    const app = createApp({ checkInvariants: false });
    const { ticksPerDay, ticksPerHour, ticksPerMinute } = app.world.clock;
    const target = 11 * ticksPerDay + 14 * ticksPerHour + 20 * ticksPerMinute;
    for (let i = 0; i < target; i++) app.world.tick();
    expect(fieldText(renderHud(app), 'time')).toBe('Deň 12 · 14:20');
  });

  it('záporná hotovosť: U+2212 v sume, varovný stav a čitateľný text pre asistívne technológie', () => {
    const app = createApp();
    app.world.cashCents = -250_000;
    const html = renderHud(app);
    expect(fieldText(html, 'cash')).toBe(`${MINUS}$2,500`);
    expect(html).toContain('top-hud--debt');
    expect(html).toContain('data-debt="true"');
    expect(html).toContain('>Záporná hotovosť</span>');
  });

  it('pauza (speed 0): stav pauzy v HUD, stlačené ⏸ so zmenenou ikonou ▶', () => {
    const app = createApp();
    app.world.clock.setSpeed(0);
    const html = renderHud(app);
    expect(html).toContain('data-paused="true"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-speed="0"/);
    expect(html).toContain('#ic_play');
    expect(html).not.toContain('#ic_pause');
  });

  it('denný delta a XP: zástupný „—" bez dát, hodnoty s formátom pri zadaní', () => {
    const app = createApp();
    const placeholder = renderHud(app);
    expect(fieldText(placeholder, 'cash-delta')).toBe('—/deň');
    expect(fieldText(placeholder, 'xp')).toBe('— XP');
    expect(placeholder.match(/data-placeholder="true"/g)).toHaveLength(2 + 4); // delta + XP + 4 neaktívne panely

    const filled = renderHud(app, { dailyDeltaCents: 1_230_000, xp: 340 });
    expect(filled).toContain('+$12,300/deň');
    expect(filled).toContain('top-hud__delta--pos');
    expect(fieldText(filled, 'xp')).toBe('340 XP');
    expect(filled).not.toContain('data-field="xp" data-placeholder');

    const negative = renderHud(app, { dailyDeltaCents: -482_000 });
    expect(negative).toContain(`${MINUS}$4,820/deň`);
    expect(negative).toContain('top-hud__delta--neg');
  });

  it('ikony sú zo spritu ic_* a každý použitý symbol v assets/icons/icons.svg existuje', () => {
    const sprite = readFileSync(new URL('../../assets/icons/icons.svg', import.meta.url), 'utf8');
    const html = renderHud(createApp(), { dailyDeltaCents: 1_230_000, xp: 340 });
    const used = new Set([...html.matchAll(/<use href="[^"]*#(ic_[a-z0-9_]+)"/g)].map((match) => match[1] as string));
    for (const name of ['ic_cash', 'ic_xp', 'ic_calendar', 'ic_pause', 'ic_contract', 'ic_utilization', 'ic_settings']) {
      expect(used, name).toContain(name);
    }
    for (const name of used) expect(sprite, name).toContain(`<symbol id="${name}"`);
  });

  it('panely vpravo: 4 neaktívne placeholdery (disabled), ⚙ aktívne aj bez handlera', () => {
    const html = renderHud(createApp());
    expect(HUD_PANEL_BUTTONS.map((button) => button.id)).toEqual(['contracts', 'finance', 'stats', 'tech', 'settings']);
    for (const id of ['contracts', 'finance', 'stats', 'tech']) {
      expect(html, id).toMatch(new RegExp(`<button[^>]*data-field="panel-${id}"[^>]*disabled`));
    }
    expect(html).not.toMatch(/<button[^>]*data-field="panel-settings"[^>]*disabled/);
    expect(html).toContain('title="Kontrakty (C) · čoskoro"');
  });

  it('s handlerom sú ikony panelov aktívne a zvýrazní sa otvorený panel', () => {
    const app = createApp();
    const html = renderHud(app, { onTogglePanel: () => undefined, activePanel: 'finance' });
    expect(html).not.toMatch(/<button[^>]*data-field="panel-contracts"[^>]*disabled/);
    expect(html).toMatch(/top-hud__panel top-hud__panel--active"[^>]*aria-pressed="true"[^>]*data-field="panel-finance"/);
  });
});

describe('zápis rýchlosti (len cez dispatch)', () => {
  function captureSetter(app: ReturnType<typeof createApp>): (speed: number) => void {
    const holder: { setter: ((speed: number) => void) | null } = { setter: null };
    const Probe = (): null => {
      holder.setter = useSetGameSpeed();
      return null;
    };
    renderToStaticMarkup(createElement(SimBridgeProvider, { bridge: app.bridge }, createElement(Probe)));
    if (holder.setter === null) throw new Error('Probe sa nevykreslil');
    return holder.setter;
  }

  it.each([0, 1, 2, 4, 8])('speed %i → dispatch(SetGameSpeed) so serializovaným tvarom { type, speed }', (speed) => {
    const app = createApp();
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    captureSetter(app)(speed);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const command = dispatch.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SetGameSpeedCommand);
    expect(command?.toJSON()).toEqual({ type: 'SetGameSpeed', speed });
  });

  it('UI nemení sim priamo: rýchlosť sa zmení až po aplikovaní príkazu vo svete', () => {
    const app = createApp();
    captureSetter(app)(4);
    expect(app.world.clock.speed).toBe(1);
    app.world.applyPending();
    expect(app.world.clock.speed).toBe(4);
    expect(app.bridge.snapshot().speed).toBe(4);
  });

  it('resolveSpeedRequest: klik na ⏸ počas pauzy obnoví poslednú nenulovú rýchlosť, inak platí výber', () => {
    expect(resolveSpeedRequest(0, 0, 4)).toBe(4); // pauza → obnov
    expect(resolveSpeedRequest(0, 2, 4)).toBe(0); // beží → pauza
    expect(resolveSpeedRequest(8, 0, 4)).toBe(8); // pauza, hráč vybral 8× → 8×
    expect(resolveSpeedRequest(0, 0, undefined)).toBe(0); // nie je kam obnoviť
  });
});

describe('TopHUDView (prezentačný)', () => {
  const baseProps = {
    cashCents: 123_456_000,
    day: 11,
    hour: 14,
    minute: 20,
    speed: 1,
    speeds: [0, 1, 2, 4, 8],
  } as const;

  it('SpeedControl dostane speeds, aktuálnu rýchlosť a handler od rodiča', () => {
    const onSpeedChange = vi.fn();
    const tree: ReactElement = TopHUDView({ ...baseProps, onSpeedChange });
    const [control] = findAll(tree, (element) => element.type === SpeedControl);
    expect(control).toBeDefined();
    const props = propsOf(control as ReactElement);
    expect(props.speeds).toEqual(baseProps.speeds);
    expect(props.value).toBe(1);
    (props.onChange as (speed: number) => void)(8);
    expect(onSpeedChange).toHaveBeenCalledWith(8);
  });

  it('príklad z prototypu: $1,234,560 │ Deň 12 · 14:20; BEM triedy a data-field', () => {
    const html = renderToStaticMarkup(createElement(TopHUDView, { ...baseProps, onSpeedChange: () => undefined, dailyDeltaCents: 1_230_000, xp: 340 }));
    expect(fieldText(html, 'cash')).toBe('$1,234,560');
    expect(fieldText(html, 'time')).toBe('Deň 12 · 14:20');
    expect(fieldText(html, 'xp')).toBe('340 XP');
    expect(html).toContain('class="top-hud"');
    for (const cls of ['top-hud__cash', 'top-hud__cash-value', 'top-hud__delta', 'top-hud__xp', 'top-hud__clock', 'top-hud__time', 'top-hud__panels', 'speed-control']) {
      expect(html).toContain(cls);
    }
    // Poradie zľava doprava podľa prototypu: cash → XP → čas → rýchlosť → panely.
    const order = ['top-hud__cash"', 'top-hud__xp"', 'top-hud__clock"', 'speed-control"', 'top-hud__panels"'].map((cls) => html.indexOf(`class="${cls}`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('hotovosť presne 0 nie je varovanie', () => {
    const html = renderToStaticMarkup(createElement(TopHUDView, { ...baseProps, cashCents: 0, onSpeedChange: () => undefined }));
    expect(html).toContain('data-debt="false"');
    expect(fieldText(html, 'cash')).toBe('$0');
  });
});
