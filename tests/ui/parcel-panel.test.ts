// TF7-03: ParcelPanel — porovnanie kúpy a prenájmu, vypnutie podľa hotovosti a stavu, blokované uvoľnenie.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  PARCEL_STATE_LABELS,
  ParcelPanel,
  canBuyParcel,
  canLeaseParcel,
  canReleaseParcel,
  parcelArea,
  paybackMonths,
  type ParcelPanelProps,
} from '@ui/index';
import { F7_PARCEL_FOR_SALE, F7_PARCEL_LEASED, F7_PARCEL_OWNED } from './f7-finance-fixtures';
import { fieldText } from './react-tree';

const render = (props: ParcelPanelProps): string => renderToStaticMarkup(createElement(ParcelPanel, props));

/** Otváracia značka tlačidla s `data-action` (atribúty v jednom tagu). */
const actionTag = (html: string, action: string): string => {
  const match = new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(html);
  return match?.[0] ?? '';
};

describe('výpočty parciel', () => {
  it('plocha a návratnosť kúpy v mesiacoch prenájmu (zaokrúhlené)', () => {
    expect(parcelArea(12, 8)).toBe(96);
    expect(paybackMonths(64_000_000, 980_000)).toBe(65);
    expect(paybackMonths(64_000_000, 0)).toBeUndefined();
    expect(paybackMonths(Number.NaN, 980_000)).toBeUndefined();
  });

  it('kúpa a prenájom vyžadujú parcelu na predaj a hotovosť na cenu / prvý mesiac', () => {
    expect(canBuyParcel(F7_PARCEL_FOR_SALE, 63_999_999)).toBe(false);
    expect(canBuyParcel(F7_PARCEL_FOR_SALE, 64_000_000)).toBe(true);
    expect(canBuyParcel(F7_PARCEL_FOR_SALE)).toBe(true);
    expect(canLeaseParcel(F7_PARCEL_FOR_SALE, 979_999)).toBe(false);
    expect(canLeaseParcel(F7_PARCEL_FOR_SALE, 980_000)).toBe(true);
    expect(canBuyParcel(F7_PARCEL_OWNED, 1_000_000_000)).toBe(false);
    expect(canLeaseParcel(F7_PARCEL_LEASED, 1_000_000_000)).toBe(false);
  });

  it('uvoľnenie: len vlastnená/prenajatá a bez dôvodu blokovania', () => {
    expect(canReleaseParcel(F7_PARCEL_FOR_SALE)).toBe(false);
    expect(canReleaseParcel(F7_PARCEL_OWNED)).toBe(true);
    expect(canReleaseParcel(F7_PARCEL_LEASED, 'Na parcele stojí modul')).toBe(false);
    expect(PARCEL_STATE_LABELS.for_sale).toBe('Na predaj');
  });
});

describe('ParcelPanel — render', () => {
  it('peniaze, plocha, návratnosť a stav cez formatMoney / formatCount', () => {
    const html = render({ parcel: F7_PARCEL_FOR_SALE, cash: 100_000_000 });
    expect(fieldText(html, 'price')).toBe('$640,000');
    expect(fieldText(html, 'lease')).toBe('$9,800');
    expect(fieldText(html, 'area')).toBe('96 buniek · 12 × 8');
    expect(fieldText(html, 'payback')).toBe('65 mesiacov');
    expect(fieldText(html, 'state')).toBe('Na predaj');
    expect(html).toContain('data-parcel="parcel_east_1"');
    expect(html).toContain('data-state="for_sale"');
  });

  it('nedostatok hotovosti vypne Kúpiť s tooltipom o chýbajúcej sume; Prenajať ostane zapnutý', () => {
    const html = render({ parcel: F7_PARCEL_FOR_SALE, cash: 10_000_000, onBuy: vi.fn(), onLease: vi.fn() });
    expect(actionTag(html, 'buy')).toContain('disabled');
    expect(actionTag(html, 'buy')).toContain('title="Chýba $540,000"');
    expect(actionTag(html, 'lease')).not.toContain('disabled');
  });

  it('bez handlera je tlačidlo vypnuté aj pri dostatku hotovosti', () => {
    const html = render({ parcel: F7_PARCEL_FOR_SALE });
    expect(actionTag(html, 'buy')).toContain('disabled');
    expect(actionTag(html, 'lease')).toContain('disabled');
  });

  it('vlastnená parcela: kúpa a prenájom vypnuté, Uvoľniť zapnuté s handlerom', () => {
    const html = render({ parcel: F7_PARCEL_OWNED, cash: 1_000_000_000, onRelease: vi.fn() });
    expect(actionTag(html, 'buy')).toContain('disabled');
    expect(actionTag(html, 'buy')).toContain('title="Parcela nie je na predaj"');
    expect(actionTag(html, 'lease')).toContain('disabled');
    expect(actionTag(html, 'release')).not.toContain('disabled');
    expect(fieldText(html, 'state')).toBe('Vlastnená');
  });

  it('blokované uvoľnenie: Uvoľniť vypnuté a dôvod zobrazený pod ním', () => {
    const html = render({
      parcel: F7_PARCEL_LEASED,
      onRelease: vi.fn(),
      releaseBlockedReason: 'Na parcele stojí modul',
    });
    expect(actionTag(html, 'release')).toContain('disabled');
    expect(actionTag(html, 'release')).toContain('title="Na parcele stojí modul"');
    expect(fieldText(html, 'release-blocked')).toBe('Na parcele stojí modul');
  });

  it('bez vybranej parcely prázdny stav', () => {
    const html = render({});
    expect(html).toContain('Žiadna parcela nie je vybraná.');
    expect(html).not.toContain('data-action=');
  });

  it('žiadne pevné farby v markupe', () => {
    const html = render({ parcel: F7_PARCEL_OWNED });
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});
