// TR5-04: karta kontraktu so zmesou typov kontajnerov (čipy dry / reefer / open top / flat rack / tank, odznak OOG).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CONTAINER_TYPE_ICONS, CONTAINER_TYPE_LABELS, ContractCard, type ContractCardData, type ContractTypeChip } from '@ui/index';
import { fieldText } from './react-tree';

const DAY = 24 * 60;
const HOUR = 60;
const NOW = 10_000;

const CONTRACT: ContractCardData = {
  id: 3,
  state: 'offered',
  cargoCategory: 'container',
  cargoLabel: 'Export · Maersk Kobe',
  unit: 'TEU',
  volumeUnits: 24,
  rewardCents: 186_000,
  xpReward: 24,
  shipClassId: 'handy',
  offerExpiresTick: NOW + DAY,
  unitsUnloaded: 0,
  unitsExported: 0,
  penaltiesCents: 0,
};

const MIX: readonly ContractTypeChip[] = [
  { type: 'dry', count: 152 },
  { type: 'reefer', count: 0 },
  { type: 'flat_rack', count: 8, oogCount: 3 },
  { type: 'tank', count: 10 },
];

const render = (typeMix?: readonly ContractTypeChip[]): string =>
  renderToStaticMarkup(
    createElement(ContractCard, {
      contract: CONTRACT,
      time: { nowTick: NOW, ticksPerHour: HOUR, ticksPerDay: DAY },
      onAccept: vi.fn(),
      onDecline: vi.fn(),
      ...(typeMix === undefined ? {} : { typeMix }),
    }),
  );

describe('ContractCard — zmes typov', () => {
  it('bez typeMix sa rad nekreslí (pôvodná karta)', () => {
    const html = render();
    expect(html).not.toContain('data-section="type-mix"');
    expect(html).not.toContain('contract-card__type');
  });

  it('prázdny typeMix sa tiež nekreslí', () => {
    expect(render([])).not.toContain('data-section="type-mix"');
  });

  it('každý typ je čip s počtom a názvom; nulový čip je stlmený', () => {
    const html = render(MIX);
    expect(html).toContain('data-section="type-mix"');
    expect(fieldText(html, 'type-count-dry')).toBe('152');
    expect(fieldText(html, 'type-count-reefer')).toBe('0');
    expect(html).toContain('contract-card__type--empty');
    expect(html).toContain('>dry<');
    expect(html).toContain('>flat rack<');
    expect(html).toContain('>tank<');
  });

  it('OOG odznak sa kreslí len pri oogCount > 0', () => {
    const html = render(MIX);
    expect(fieldText(html, 'oog-flat_rack')).toBe('OOG 3');
    expect(html).not.toContain('data-field="oog-dry"');
    expect(html).not.toContain('data-field="oog-tank"');
  });

  it('ikony a názvy typov sú pre všetkých päť typov definované', () => {
    expect(Object.keys(CONTAINER_TYPE_LABELS).sort()).toEqual(['dry', 'flat_rack', 'open_top', 'reefer', 'tank']);
    expect(CONTAINER_TYPE_ICONS.open_top).toBe('ic_open_top');
    expect(CONTAINER_TYPE_LABELS.open_top).toBe('open top');
  });
});
