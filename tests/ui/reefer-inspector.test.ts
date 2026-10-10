// TR5-04: inšpektor reefer bloku (ReeferBlockInspector) a pomocné funkcie nad fixture dátami (zásuvky, alarmy, odpojené,
// cena elektriny za hodinu).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ReeferBlockInspector,
  formatMinutesLeft,
  reeferBlockTone,
  reeferPlugsFree,
  reeferPlugsUsedPct,
  reeferTemperatureText,
  type ReeferBlockInspectorData,
} from '@ui/index';
import { fieldText } from './react-tree';

const FIXTURE: ReeferBlockInspectorData = {
  id: 21,
  label: 'Reefer blok R1',
  plugsTotal: 48,
  plugsUsed: 44,
  alarms: [{ unitId: 7, label: 'SUDU 618 220', temperatureC: -14, targetC: -18, minutesToRespond: 18 }],
  unplugged: [
    { unitId: 9, label: 'MSKU 412 038', minutesToClaim: 18 },
    { unitId: 11, label: 'MEDU 300 116', minutesToClaim: 70 },
  ],
  powerCostCentsPerHour: 432_000,
};

const CLEAN: ReeferBlockInspectorData = { ...FIXTURE, alarms: [], unplugged: [] };

describe('ReeferBlockInspector — prezentácia z props', () => {
  it('ukáže názov, zásuvky celkom / obsadené / voľné a cenu elektriny za hodinu', () => {
    const html = renderToStaticMarkup(createElement(ReeferBlockInspector, { data: FIXTURE }));
    expect(fieldText(html, 'title')).toBe('Reefer blok R1');
    expect(fieldText(html, 'plugs-used')).toBe('44 / 48');
    expect(fieldText(html, 'plugs-total')).toBe('48');
    expect(fieldText(html, 'plugs-free')).toBe('4');
    expect(fieldText(html, 'power-cost')).toBe('$4,320 / h');
    expect(fieldText(html, 'status-badge')).toBe('Alarm');
    expect(html).toContain('data-tone="bad"');
  });

  it('alarmy: označenie, teplota s mínusom, cieľ a minúty do reakcie', () => {
    const html = renderToStaticMarkup(createElement(ReeferBlockInspector, { data: FIXTURE }));
    expect(html).toContain('SUDU 618 220');
    expect(html).toContain('−14 °C · cieľ −18 °C');
    expect(fieldText(html, 'alarm-minutes')).toBe('reagovať do 18 min');
    expect(fieldText(html, 'alarm-count')).toBe('1');
  });

  it('odpojené reefery: odpočet do reklamácie, dlhší odpočet v hodinách', () => {
    const html = renderToStaticMarkup(createElement(ReeferBlockInspector, { data: FIXTURE }));
    expect(fieldText(html, 'unplugged-count')).toBe('2');
    const minutes = [...html.matchAll(/data-field="claim-minutes">([^<]*)</g)].map((match) => match[1]);
    expect(minutes).toEqual(['reklamácia o 18 min', 'reklamácia o 1 h 10 min']);
  });

  it('bez alarmov a odpojených ukáže prázdne stavy a odznak OK', () => {
    const html = renderToStaticMarkup(createElement(ReeferBlockInspector, { data: CLEAN }));
    expect(fieldText(html, 'alarms-empty')).toBe('Žiadne alarmy.');
    expect(fieldText(html, 'unplugged-empty')).toBe('Všetky reefery majú zásuvku.');
    expect(fieldText(html, 'status-badge')).toBe('OK');
  });

  it('bez dát vykreslí prázdny stav', () => {
    const html = renderToStaticMarkup(createElement(ReeferBlockInspector, {}));
    expect(html).toContain('data-section="reefer-block-empty"');
    expect(html).toContain('Reefer blok nie je vybraný.');
  });

  it('progress bar zásuviek nesie aria hodnotu a šírku', () => {
    const html = renderToStaticMarkup(createElement(ReeferBlockInspector, { data: FIXTURE }));
    expect(html).toContain('aria-valuenow="92"');
    expect(html).toContain('width:91.66666666666666%');
  });
});

describe('pomocné funkcie reefer bloku', () => {
  it('voľné zásuvky sa orezávajú na 0..celkom', () => {
    expect(reeferPlugsFree(48, 44)).toBe(4);
    expect(reeferPlugsFree(48, 60)).toBe(0);
    expect(reeferPlugsFree(0, 0)).toBe(0);
    expect(reeferPlugsFree(Number.NaN, 3)).toBe(0);
  });

  it('percento obsadenia: bez zásuviek 0, inak orezané', () => {
    expect(reeferPlugsUsedPct(0, 0)).toBe(0);
    expect(reeferPlugsUsedPct(40, 10)).toBe(25);
    expect(reeferPlugsUsedPct(40, 99)).toBe(100);
  });

  it('minúty ako text: pod hodinu v min, nad hodinu h a min, záporné na 0 min', () => {
    expect(formatMinutesLeft(18)).toBe('18 min');
    expect(formatMinutesLeft(60)).toBe('1 h');
    expect(formatMinutesLeft(130)).toBe('2 h 10 min');
    expect(formatMinutesLeft(-5)).toBe('0 min');
    expect(formatMinutesLeft(Number.NaN)).toBe('0 min');
  });

  it('teplota s typografickým mínusom a zaokrúhlením', () => {
    expect(reeferTemperatureText(-14.4)).toBe('−14 °C');
    expect(reeferTemperatureText(4)).toBe('4 °C');
    expect(reeferTemperatureText(undefined)).toBe('');
  });

  it('tón odznaku: alarm > bez napájania > OK', () => {
    expect(reeferBlockTone(FIXTURE)).toBe('bad');
    expect(reeferBlockTone({ ...CLEAN, unplugged: FIXTURE.unplugged })).toBe('warn');
    expect(reeferBlockTone(CLEAN)).toBe('ok');
  });
});
