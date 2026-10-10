// TR6-04: inšpektor železničného terminálu (RailTerminalInspector) — buffer, RMG, ďalší vlak, vagóny, odpočet, meškanie
// — a strážca CSS (len tokeny, tabular-nums, žiadne hex farby).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  EM_DASH,
  RAIL_WAGON_CAPACITY_TEU,
  RailTerminalInspector,
  railBufferPct,
  railDelayText,
  railDepartureText,
  railTerminalTone,
  railWagonFill,
  type RailTerminalInspectorData,
  type RailTrainData,
} from '@ui/index';
import { TOKENS_CSS, loadCss } from './css-guard';
import { fieldText } from './react-tree';

const TRAIN: RailTrainData = {
  trainId: 112,
  label: 'Vlak V-112',
  wagons: [
    { wagonId: 1, teu: 3 },
    { wagonId: 2, teu: 2 },
    { wagonId: 3, teu: 0 },
  ],
  departureInMin: 12,
  delayMin: 5,
};

const FIXTURE: RailTerminalInspectorData = {
  id: 4,
  label: 'Železničný terminál',
  bufferUsedTeu: 22,
  bufferTotalTeu: 64,
  rmgState: 'working',
  rmgQueue: 3,
  nextTrainEtaMin: 70,
  currentTrain: TRAIN,
};

const render = (data?: RailTerminalInspectorData): string =>
  renderToStaticMarkup(createElement(RailTerminalInspector, data === undefined ? {} : { data }));

describe('RailTerminalInspector — prezentácia z props', () => {
  it('ukáže názov, buffer v TEU, stav a frontu RMG a odhad ďalšieho vlaku', () => {
    const html = render(FIXTURE);
    expect(fieldText(html, 'title')).toBe('Železničný terminál');
    expect(fieldText(html, 'buffer-used')).toBe('22 / 64 TEU');
    expect(fieldText(html, 'rmg-state')).toBe('Pracuje');
    expect(fieldText(html, 'rmg-queue')).toBe('3');
    expect(fieldText(html, 'next-train-eta')).toBe('príde za 1 h 10 min');
    expect(html).toContain('data-rail-terminal-id="4"');
  });

  it('buffer je progressbar s percentami podľa obsadenia', () => {
    const html = render(FIXTURE);
    expect(html).toContain('aria-valuenow="34"');
    expect(html).toContain('width:34.375%');
  });

  it('vlak: označenie, odchod za N min, meškanie v minútach a odznak tónu warn', () => {
    const html = render(FIXTURE);
    expect(fieldText(html, 'train-label')).toBe('Vlak V-112');
    expect(fieldText(html, 'departure')).toBe('odchod za 12 min');
    expect(fieldText(html, 'delay')).toBe('meškanie 5 min');
    expect(html).toContain('rail-inspector__delay--warn');
    expect(html).toContain('data-tone="warn"');
  });

  it('vagóny v poradí nakladania: 0–3 TEU, obsadenie a počet vagónov', () => {
    const html = render(FIXTURE);
    expect(fieldText(html, 'wagon-count')).toBe('3');
    const teu = [...html.matchAll(/data-field="wagon-teu">([^<]*)</g)].map((match) => match[1]);
    expect(teu).toEqual(['3 / 3 TEU', '2 / 3 TEU', '0 / 3 TEU']);
    const order = [...html.matchAll(/data-wagon-id="(\d+)" data-order="(\d+)"/g)].map((match) => [match[1], match[2]]);
    expect(order).toEqual([
      ['1', '1'],
      ['2', '2'],
      ['3', '3'],
    ]);
  });

  it('bunky vagónov: počet plných buniek zodpovedá TEU (3 + 2 + 0 = 5 z 9)', () => {
    const html = render(FIXTURE);
    expect(html.split('rail-inspector__cell--on').length - 1).toBe(5);
    expect((html.match(/class="rail-inspector__cell(?=[ "])/g) ?? []).length).toBe(9);
  });

  it('bez vlaku ukáže prázdny stav a bez plánovaného vlaku pomlčku', () => {
    const html = render({
      ...FIXTURE,
      currentTrain: undefined,
      nextTrainEtaMin: undefined,
    });
    expect(fieldText(html, 'train-empty')).toBe('Vlak nie je v termináli.');
    expect(fieldText(html, 'next-train-eta')).toBe(EM_DASH);
    expect(html).not.toContain('data-field="wagon-count"');
  });

  it('bez meškania a pri odchode v nule: text „bez meškania“ a „odchádza teraz“, tón podľa RMG', () => {
    const html = render({
      ...FIXTURE,
      currentTrain: { ...TRAIN, delayMin: 0, departureInMin: 0 },
    });
    expect(fieldText(html, 'delay')).toBe('bez meškania');
    expect(fieldText(html, 'departure')).toBe('odchádza teraz');
    expect(html).not.toContain('rail-inspector__delay--warn');
    expect(html).toContain('data-tone="ok"');
  });

  it('bez dát ukáže prázdny stav bez vybraného terminálu', () => {
    const html = render();
    expect(html).toContain('data-section="rail-terminal-empty"');
    expect(html).toContain('Železničný terminál nie je vybraný.');
  });

  it('prázdny vagón a prázdny vlak sa nerozpadnú', () => {
    const html = render({ ...FIXTURE, currentTrain: { ...TRAIN, wagons: [] } });
    expect(fieldText(html, 'wagons-empty')).toBe('Vlak nemá vagóny.');
  });
});

describe('RailTerminalInspector — pomocné funkcie', () => {
  it('railBufferPct ohraničí obsadenie na 0..100 a bez kapacity vráti 0', () => {
    expect(railBufferPct(22, 64)).toBeCloseTo(34.375);
    expect(railBufferPct(70, 64)).toBe(100);
    expect(railBufferPct(-3, 64)).toBe(0);
    expect(railBufferPct(5, 0)).toBe(0);
  });

  it('railWagonFill: default kapacita 3 TEU, ohraničenie a vlastná kapacita', () => {
    expect(RAIL_WAGON_CAPACITY_TEU).toBe(3);
    expect(railWagonFill({ wagonId: 1, teu: 7 })).toEqual({
      teu: 3,
      capacityTeu: 3,
    });
    expect(railWagonFill({ wagonId: 1, teu: -1 })).toEqual({
      teu: 0,
      capacityTeu: 3,
    });
    expect(railWagonFill({ wagonId: 1, teu: 2, capacityTeu: 4 })).toEqual({
      teu: 2,
      capacityTeu: 4,
    });
    expect(railWagonFill({ wagonId: 1, teu: Number.NaN })).toEqual({
      teu: 0,
      capacityTeu: 3,
    });
  });

  it('railDelayText a railDepartureText pokrývajú nulu a hodiny', () => {
    expect(railDelayText(0)).toBe('bez meškania');
    expect(railDelayText(65)).toBe('meškanie 1 h 5 min');
    expect(railDepartureText(0)).toBe('odchádza teraz');
    expect(railDepartureText(90)).toBe('odchod za 1 h 30 min');
  });

  it('railTerminalTone: blokovaný RMG = bad, meškanie = warn, inak tón stroja', () => {
    expect(
      railTerminalTone({
        ...FIXTURE,
        currentTrain: undefined,
        rmgState: 'blocked',
      }),
    ).toBe('bad');
    expect(railTerminalTone(FIXTURE)).toBe('warn');
    expect(
      railTerminalTone({
        ...FIXTURE,
        currentTrain: undefined,
        rmgState: 'idle',
      }),
    ).toBe('mute');
  });
});

describe('rail-terminal-inspector.css — tokeny a čísla', () => {
  const css = loadCss('src/ui/rail-terminal-inspector.css');

  it('hodnoty a bunky používajú tabular-nums', () => {
    expect(css.ruleBody('.rail-inspector__value')).toContain('tabular-nums');
    expect(css.ruleBody('.rail-inspector__wagon-teu')).toContain('tabular-nums');
  });

  it('žiadne hex farby ani rgb/hsl literály (len tokeny)', () => {
    expect(css.source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css.source).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  it('každá použitá custom property je definovaná v design/tokens.css', () => {
    for (const name of css.usedProperties()) {
      expect(TOKENS_CSS, name).toContain(`${name}:`);
    }
  });
});
