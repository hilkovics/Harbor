// TR2-05: text objemu na karte kontraktu — hlavné číslo sú TEU (`volumeTeu`), v zátvorke počty kontajnerov 20′ a 40′; bez `volumeTeu`
// sa použije `volumeUnits`, bez počtov sa zátvorka nekreslí. Súčet voyage karty sčítava TEU.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VoyageCard, volumeOf, volumeText, type ContractCardData, type ContractsTimeScale } from '@ui/contracts-panel';

const TIME: ContractsTimeScale = { nowTick: 100_000, ticksPerHour: 360, ticksPerDay: 8640 };

const BASE: ContractCardData = {
  id: 1,
  state: 'offered',
  cargoCategory: 'container',
  cargoLabel: 'Kontajnery',
  unit: 'TEU',
  volumeUnits: 10,
  rewardCents: 316_800,
  xpReward: 24,
  shipClassId: 'feeder',
  shipClassLabel: 'Feeder',
  offerExpiresTick: 200_000,
  unitsUnloaded: 0,
  unitsExported: 0,
  penaltiesCents: 0,
};

describe('volumeText / volumeOf: TEU', () => {
  it('„N TEU (a× 20′, b× 40′)": N je `volumeTeu`, nie počet kontajnerov', () => {
    const card: ContractCardData = { ...BASE, volumeUnits: 10, volumeTeu: 14, count20: 6, count40: 4 };
    expect(volumeOf(card)).toBe(14);
    expect(volumeText(card)).toBe('14 TEU (6× 20′, 4× 40′)');
  });

  it('bez `volumeTeu` platí `volumeUnits`; bez počtov nie je zátvorka; prázdne dostanú príponu pred zátvorkou', () => {
    expect(volumeText({ ...BASE, volumeUnits: 24 })).toBe('24 TEU');
    expect(volumeText({ ...BASE, volumeUnits: 24, count20: 24, count40: 0 })).toBe('24 TEU (24× 20′, 0× 40′)');
    expect(volumeText({ ...BASE, kind: 'empty_repositioning', volumeUnits: 24, volumeTeu: 24, count20: 24, count40: 0 })).toBe('24 TEU prázdnych (24× 20′, 0× 40′)');
  });

  it('karta voyage ukáže súčet TEU častí (nie kontajnerov)', () => {
    const parts: ContractCardData[] = [
      { ...BASE, id: 4, kind: 'import', voyageId: 5, volumeUnits: 10, volumeTeu: 14 },
      { ...BASE, id: 5, kind: 'export', voyageId: 5, volumeUnits: 8, volumeTeu: 12, booking: { destinationPort: 'Gdańsk', bookedUnits: 12, pendingArrivals: 0, arrivedUnits: 0, loadedUnits: 0, lastMinuteUnits: 0, rolledUnits: 0, returnedUnits: 0, heldUnits: 0 } },
    ];
    const html = renderToStaticMarkup(createElement(VoyageCard, { group: { voyageId: 5, parts }, time: TIME, onAccept: vi.fn(), onDecline: vi.fn() }));
    expect(html).toContain('26 TEU');
  });
});
