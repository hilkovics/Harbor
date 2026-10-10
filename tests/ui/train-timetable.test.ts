// TR6-04: cestovný poriadok vlakov (TrainTimetable) — prázdny stav, riadky, pomlčka pri chýbajúcom odchode, stavy.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EM_DASH, TRAIN_STATUS_LABELS, TRAIN_STATUS_TONES, TrainTimetable, type TrainTimetableRow } from '@ui/index';
import { loadCss } from './css-guard';

const ROWS: readonly TrainTimetableRow[] = [
  {
    trainId: 111,
    label: 'V-111',
    arrivalLabel: 'Deň 2 · 08:00',
    departureLabel: 'Deň 2 · 08:40',
    wagons: 12,
    status: 'departed',
  },
  {
    trainId: 112,
    arrivalLabel: 'Deň 2 · 14:30',
    departureLabel: 'Deň 2 · 15:10',
    wagons: 9,
    status: 'delayed',
  },
  { trainId: 113, arrivalLabel: 'Deň 2 · 20:00', wagons: 1, status: 'planned' },
];

const render = (rows?: readonly TrainTimetableRow[]): string =>
  renderToStaticMarkup(createElement(TrainTimetable, rows === undefined ? {} : { rows }));

describe('TrainTimetable', () => {
  it('bez riadkov ukáže prázdny stav', () => {
    expect(render()).toContain('Cestovný poriadok je prázdny.');
    expect(render([])).toContain('data-section="train-timetable"');
  });

  it('hlavička tabuľky: vlak, príchod, odchod, vagóny, stav', () => {
    const html = render(ROWS);
    for (const head of ['Vlak', 'Príchod', 'Odchod', 'Vagóny', 'Stav']) {
      expect(html).toContain(`>${head}<`);
    }
  });

  it('každý riadok: označenie, príchod, odchod, počet vagónov a stav', () => {
    const html = render(ROWS);
    expect([...html.matchAll(/data-train-id="(\d+)"/g)].map((match) => match[1])).toEqual(['111', '112', '113']);
    expect([...html.matchAll(/data-field="train">([^<]*)</g)].map((match) => match[1])).toEqual([
      'V-111',
      'Vlak 112',
      'Vlak 113',
    ]);
    expect([...html.matchAll(/data-field="arrival">([^<]*)</g)].map((match) => match[1])).toEqual([
      'Deň 2 · 08:00',
      'Deň 2 · 14:30',
      'Deň 2 · 20:00',
    ]);
    expect([...html.matchAll(/data-field="wagons">([^<]*)</g)].map((match) => match[1])).toEqual(['12', '9', '1']);
    expect([...html.matchAll(/data-field="status">.*?<span[^>]*>([^<]*)</g)].map((match) => match[1])).toEqual([
      'Odišiel',
      'Mešká',
      'Plánovaný',
    ]);
  });

  it('chýbajúci odchod sa zobrazí ako pomlčka', () => {
    const html = render(ROWS);
    expect([...html.matchAll(/data-field="departure">([^<]*)</g)].map((match) => match[1])).toEqual([
      'Deň 2 · 08:40',
      'Deň 2 · 15:10',
      EM_DASH,
    ]);
  });

  it('meškajúci riadok nesie modifikátor a tón warn', () => {
    const html = render(ROWS);
    expect(html).toContain('train-timetable__row--delayed');
    expect(html).toContain('train-timetable__badge--warn');
    expect(TRAIN_STATUS_TONES.loading).toBe('ok');
    expect(TRAIN_STATUS_LABELS.loading).toBe('Nakladá sa');
  });
});

describe('train-timetable.css — tokeny a čísla', () => {
  it('stĺpce s číslami používajú tabular-nums a žiadne hex farby', () => {
    const css = loadCss('src/ui/train-timetable.css');
    expect(css.ruleBody('.train-timetable__cell--num')).toContain('tabular-nums');
    expect(css.source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css.source).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });
});
