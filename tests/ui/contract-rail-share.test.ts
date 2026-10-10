// TR6-04: karta kontraktu s voliteľným odznakom železničného podielu (railSharePct): ikona koľaje + „60 % vlakom“.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ContractCard, type ContractCardData } from '@ui/index';
import { fieldText } from './react-tree';

const DAY = 24 * 60;
const HOUR = 60;
const NOW = 10_000;

const CONTRACT: ContractCardData = {
  id: 9,
  state: 'offered',
  cargoCategory: 'container',
  cargoLabel: 'Import · Kontajnery',
  unit: 'TEU',
  volumeUnits: 40,
  rewardCents: 240_000,
  xpReward: 30,
  shipClassId: 'handy',
  offerExpiresTick: NOW + DAY,
  unitsUnloaded: 0,
  unitsExported: 0,
  penaltiesCents: 0,
};

const render = (railSharePct?: number): string =>
  renderToStaticMarkup(
    createElement(ContractCard, {
      contract: CONTRACT,
      time: { nowTick: NOW, ticksPerHour: HOUR, ticksPerDay: DAY },
      onAccept: vi.fn(),
      onDecline: vi.fn(),
      ...(railSharePct === undefined ? {} : { railSharePct }),
    }),
  );

describe('ContractCard — železničný podiel (railSharePct)', () => {
  it('bez railSharePct sa odznak nekreslí (pôvodná karta)', () => {
    const html = render();
    expect(html).not.toContain('data-field="rail-share"');
    expect(html).not.toContain('contract-card__rail');
  });

  it('s 60 % ukáže odznak s ikonou koľaje a textom „60 % vlakom“', () => {
    const html = render(60);
    expect(fieldText(html, 'rail-share')).toBe('60 % vlakom');
    expect(html).toContain('data-pct="60"');
    expect(html).toContain('#ic_rail');
  });

  it('odznak je v riadku čipov karty (za odznakom lode)', () => {
    const html = render(35);
    const chips = html.indexOf('contract-card__chips');
    const ship = html.indexOf('data-field="ship"');
    const rail = html.indexOf('data-field="rail-share"');
    expect(chips).toBeGreaterThan(-1);
    expect(ship).toBeGreaterThan(chips);
    expect(rail).toBeGreaterThan(ship);
  });

  it('hodnoty mimo 0–100 sa ohraničia, neplatné číslo odznak nekreslí', () => {
    expect(fieldText(render(140), 'rail-share')).toBe('100 % vlakom');
    expect(fieldText(render(-5), 'rail-share')).toBe('0 % vlakom');
    expect(render(Number.NaN)).not.toContain('data-field="rail-share"');
  });
});
