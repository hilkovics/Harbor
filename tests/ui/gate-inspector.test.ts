// TR4-04: inšpektor brány (GateLaneInspector), predbránová plocha (PreGateInspector) a karta TTT (TurnTimeStat)
// nad fixture dátami; callback onSetMode a výpočty (priebeh, obsadenie, text TTT).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  GATE_LANE_MODE_LABELS,
  GATE_LANE_STEP_LABELS,
  GateLaneInspector,
  PreGateInspector,
  TurnTimeStat,
  clampProgress,
  gateLaneIcon,
  gateLaneModeTone,
  gateLaneStepText,
  preGateOccupancy,
  turnTimeText,
  type GateLaneInspectorData,
  type PreGateInspectorData,
} from '@ui/index';
import { fieldText, findAll, propsOf } from './react-tree';

const LANE_FIXTURE: GateLaneInspectorData = {
  id: 8,
  label: 'IN-8',
  kind: 'in',
  mode: 'trouble',
  step: 'ocr',
  progress: 0.4,
  queueLength: 23,
  trucksProcessed: 1240,
  trucksPerHour: 38,
};

const PREGATE_FIXTURE: PreGateInspectorData = {
  rows: [
    { label: 'P-1', slots: [true, true] },
    { label: 'P-2', slots: [true, false] },
    { label: 'P-3', slots: [false, false] },
  ],
  inlandWaiting: 7,
};

describe('GateLaneInspector — prezentácia z props', () => {
  it('ukáže označenie, druh, režim, krok, priebeh a číselné riadky', () => {
    const html = renderToStaticMarkup(createElement(GateLaneInspector, { data: LANE_FIXTURE }));
    expect(fieldText(html, 'title')).toBe('IN-8');
    expect(fieldText(html, 'kind')).toBe('Vstup');
    expect(fieldText(html, 'mode-badge')).toBe('Trouble');
    expect(fieldText(html, 'step')).toBe('Čítanie OCR');
    expect(fieldText(html, 'progress')).toBe('40 %');
    expect(fieldText(html, 'queue')).toBe('23');
    expect(fieldText(html, 'processed')).toBe('1,240');
    expect(fieldText(html, 'throughput')).toBe('38');
    expect(html).toContain('data-kind="in"');
    expect(html).toContain('data-step="ocr"');
  });

  it('progress bar nesie aria hodnotu a šírku podľa priebehu', () => {
    const html = renderToStaticMarkup(createElement(GateLaneInspector, { data: LANE_FIXTURE }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain('width:40%');
  });

  it('tri režimy ako radiogroup, označený je aktuálny; klik volá onSetMode s režimom', () => {
    const picked: string[] = [];
    const tree = GateLaneInspector({ data: LANE_FIXTURE, onSetMode: (mode) => picked.push(mode) });
    const buttons = findAll(tree, (element) => element.type === 'button');
    expect(buttons.map((button) => propsOf(button)['data-mode'])).toEqual(['standard', 'express', 'trouble']);
    const checked = buttons.filter((button) => propsOf(button)['aria-checked'] === true);
    expect(checked.map((button) => propsOf(button)['data-mode'])).toEqual(['trouble']);
    for (const button of buttons) (propsOf(button)['onClick'] as () => void)();
    expect(picked).toEqual(['standard', 'express', 'trouble']);
  });

  it('bez onSetMode sa klik nerozbije', () => {
    const tree = GateLaneInspector({ data: LANE_FIXTURE });
    const first = findAll(tree, (element) => element.type === 'button')[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(() => (propsOf(first)['onClick'] as () => void)()).not.toThrow();
  });

  it('voľný pruh: krok „Voľný", priebeh 0 %, výstupný pruh má ikonu výstupu', () => {
    const html = renderToStaticMarkup(
      createElement(GateLaneInspector, {
        data: { ...LANE_FIXTURE, id: 12, label: 'OUT-4', kind: 'out', mode: 'standard', step: null, progress: 0, queueLength: 0 },
      }),
    );
    expect(fieldText(html, 'step')).toBe('Voľný');
    expect(fieldText(html, 'progress')).toBe('0 %');
    expect(fieldText(html, 'kind')).toBe('Výstup');
    expect(html).toContain('data-step="idle"');
    expect(html).toContain('#ic_gate_out');
  });

  it('bez dát vykreslí prázdny stav bez pádu', () => {
    const html = renderToStaticMarkup(createElement(GateLaneInspector, {}));
    expect(html).toContain('data-section="gate-lane-empty"');
    expect(html).toContain('Pruh brány nie je vybraný.');
  });
});

describe('gate lane — pomocné funkcie', () => {
  it('priebeh sa orezáva do 0..1, neplatná hodnota je 0', () => {
    expect(clampProgress(-0.5)).toBe(0);
    expect(clampProgress(1.7)).toBe(1);
    expect(clampProgress(Number.NaN)).toBe(0);
    expect(clampProgress(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampProgress(0.25)).toBe(0.25);
  });

  it('názvy režimov, krokov a tón režimu', () => {
    expect(GATE_LANE_MODE_LABELS).toEqual({ standard: 'Štandard', express: 'Express', trouble: 'Trouble' });
    expect(GATE_LANE_STEP_LABELS.weigh).toBe('Váženie');
    expect(gateLaneStepText(null)).toBe('Voľný');
    expect(gateLaneStepText('seal')).toBe('Kontrola plomby');
    expect(gateLaneModeTone('standard')).toBe('ok');
    expect(gateLaneModeTone('express')).toBe('info');
    expect(gateLaneModeTone('trouble')).toBe('warn');
    expect(gateLaneIcon('in')).toBe('ic_gate_in');
    expect(gateLaneIcon('out')).toBe('ic_gate_out');
  });
});

describe('PreGateInspector — obsadenie a vnútrozemie', () => {
  it('riadky × 2 sloty, obsadené sloty majú data-slot=taken, súhrn obsadenia a čakajúci vo vnútrozemí', () => {
    const html = renderToStaticMarkup(createElement(PreGateInspector, { data: PREGATE_FIXTURE }));
    expect(html).toContain('data-row-label="P-1"');
    expect(html).toContain('data-row-label="P-3"');
    expect((html.match(/data-slot="taken"/g) ?? []).length).toBe(3);
    expect((html.match(/data-slot="free"/g) ?? []).length).toBe(3);
    expect(fieldText(html, 'occupancy')).toBe('3 / 6 slotov');
    expect(fieldText(html, 'inland')).toBe('7');
  });

  it('preGateOccupancy počíta dva sloty na riadok, aj pre prázdnu plochu', () => {
    expect(preGateOccupancy(PREGATE_FIXTURE.rows)).toEqual({ occupied: 3, total: 6 });
    expect(preGateOccupancy([])).toEqual({ occupied: 0, total: 0 });
  });

  it('veľké čísla s tisícovým oddeľovačom; bez dát prázdny stav', () => {
    const html = renderToStaticMarkup(createElement(PreGateInspector, { data: { rows: [], inlandWaiting: 1240 } }));
    expect(fieldText(html, 'inland')).toBe('1,240');
    const empty = renderToStaticMarkup(createElement(PreGateInspector, {}));
    expect(empty).toContain('data-section="pregate-empty"');
  });
});

describe('TurnTimeStat — karta TTT', () => {
  it('zobrazí celé minúty s jednotkou', () => {
    const html = renderToStaticMarkup(createElement(TurnTimeStat, { minutes: 52.4 }));
    expect(fieldText(html, 'ttt')).toBe('52 min');
    expect(html).toContain('TTT');
  });

  it('bez hodnoty alebo s neplatnou hodnotou ukáže pomlčku', () => {
    expect(fieldText(renderToStaticMarkup(createElement(TurnTimeStat)), 'ttt')).toBe('—');
    expect(turnTimeText(Number.NaN)).toBe('—');
    expect(turnTimeText(undefined)).toBe('—');
  });

  it('záporná hodnota sa zaokrúhli na 0 min; tisíce majú oddeľovač', () => {
    expect(turnTimeText(-3)).toBe('0 min');
    expect(turnTimeText(1240)).toBe('1,240 min');
  });
});
