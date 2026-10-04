import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SpeedControl } from '@ui/speed-control';
import { findAll, propsOf } from './react-tree';

const SPEEDS = [0, 1, 2, 4, 8] as const;

function buttonsOf(value: number, onChange: (speed: number) => void = () => undefined) {
  // SpeedControl je čistý komponent bez hookov → dá sa zavolať ako funkcia a prehľadať výsledný strom.
  const tree = SpeedControl({ value, speeds: SPEEDS, onChange });
  return findAll(tree, (element) => element.type === 'button');
}

describe('SpeedControl', () => {
  it('vykreslí jedno tlačidlo na každú rýchlosť v poradí zo `speeds` (⏸ 1× 2× 4× 8×)', () => {
    const html = renderToStaticMarkup(createElement(SpeedControl, { value: 1, speeds: SPEEDS, onChange: () => undefined }));
    const order = [...html.matchAll(/data-speed="(\d+)"/g)].map((match) => Number(match[1]));
    expect(order).toEqual([...SPEEDS]);
    for (const label of ['1×', '2×', '4×', '8×']) expect(html).toContain(`>${label}</button>`);
    // 0 = pauza → ikona (SVG zo spritu), nie text.
    expect(html).toMatch(/data-speed="0"[^>]*><svg[^>]*><use href="[^"]*#ic_pause"/);
  });

  it.each(SPEEDS)('aktívne je len tlačidlo zodpovedajúce hodnote %i (aria-pressed + trieda)', (value) => {
    const pressed = buttonsOf(value).map((button) => [propsOf(button)['data-speed'], propsOf(button)['aria-pressed']]);
    expect(pressed).toEqual(SPEEDS.map((speed) => [speed, speed === value]));

    const html = renderToStaticMarkup(createElement(SpeedControl, { value, speeds: SPEEDS, onChange: () => undefined }));
    expect(html.match(/speed-control__btn--active/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it('pauza má vlastný variant triedy (žltý aktívny stav), prístupný názov a pri pauze ikonu ▶ (klik = obnoviť)', () => {
    const html = renderToStaticMarkup(createElement(SpeedControl, { value: 0, speeds: SPEEDS, onChange: () => undefined }));
    expect(html).toContain('speed-control__btn--active speed-control__btn--pause');
    expect(html).toContain('aria-label="Pauza"');
    expect(html).toContain('aria-label="Rýchlosť 4×"');
    expect(html).toMatch(/data-speed="0"[^>]*><svg[^>]*><use href="[^"]*#ic_play"/);
    expect(html).not.toContain('#ic_pause');
  });

  it('kliknutie zavolá onChange so zodpovedajúcou rýchlosťou — aj na už aktívne tlačidlo', () => {
    const onChange = vi.fn();
    const buttons = buttonsOf(2, onChange);
    for (const button of buttons) (propsOf(button).onClick as () => void)();
    expect(onChange.mock.calls).toEqual(SPEEDS.map((speed) => [speed]));
  });

  it('zoznam rýchlostí je vstup (nie natvrdo): iné speeds → iné tlačidlá', () => {
    const html = renderToStaticMarkup(createElement(SpeedControl, { value: 3, speeds: [0, 3, 6], onChange: () => undefined }));
    expect([...html.matchAll(/data-speed="(\d+)"/g)].map((match) => Number(match[1]))).toEqual([0, 3, 6]);
    expect(html).toContain('>3×</button>');
    expect(html).toContain('>6×</button>');
    expect(html).not.toContain('>8×</button>');
  });

  it('title nesie klávesu: medzerník pre pauzu, 1…n pre nenulové rýchlosti', () => {
    const titles = buttonsOf(1).map((button) => propsOf(button).title);
    expect(titles).toEqual(['Pauza (Medzerník)', 'Rýchlosť 1× (1)', 'Rýchlosť 2× (2)', 'Rýchlosť 4× (3)', 'Rýchlosť 8× (4)']);
  });

  it('skupina má rolu a názov pre asistívne technológie', () => {
    const html = renderToStaticMarkup(createElement(SpeedControl, { value: 1, speeds: SPEEDS, onChange: () => undefined }));
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Rýchlosť hry"');
  });
});
