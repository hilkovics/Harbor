/**
 * ParcelPanel (TF7-03): inšpektor parcely s porovnaním kúpy a prenájmu (rozloženie z prototypu
 * design/ui/game-ui.source.html, sekcia `parcel`): náhľad obrysu parcely, karty „Kúpa“ / „Prenájom“, fakty
 * (plocha, návratnosť kúpy oproti prenájmu, stav) a tlačidlá Kúpiť / Prenajať / Uvoľniť.
 *
 * Čisto prezentačný: parcelu, hotovosť a callbacky dodá rodič. Tlačidlo kúpy je vypnuté, ak parcela nie je na predaj
 * alebo hotovosť nestačí na cenu; prenájom vyžaduje hotovosť aspoň na prvý mesiac (predplatné). Uvoľniť je vypnuté pri
 * `releaseBlockedReason` (text sa zobrazí pod tlačidlom). `cash` nevyplnené = hotovosť sa neobmedzuje.
 * Peniaze cez `formatMoney`, čísla s `tabular-nums`; farby len cez tokeny (stav parcely = `data-state` v CSS).
 */
import { formatCount, formatMoney } from './format';
import { Icon } from './icon';
import './parcel-panel.css';

/** Stav parcely: na predaj, vlastnená hráčom, prenajatá (ADR parciel F7). */
export type ParcelState = 'for_sale' | 'owned' | 'leased';

export interface ParcelInfo {
  readonly id: string;
  /** Rozmery v bunkách. */
  readonly w: number;
  readonly h: number;
  readonly state: ParcelState;
  readonly priceCents: number;
  readonly leasePerMonthCents: number;
}

export interface ParcelPanelProps {
  readonly parcel?: ParcelInfo;
  /** Hotovosť v centoch; nevyplnené = bez obmedzenia. */
  readonly cash?: number;
  readonly onBuy?: (parcelId: string) => void;
  readonly onLease?: (parcelId: string) => void;
  readonly onRelease?: (parcelId: string) => void;
  /** Dôvod, prečo sa parcela nedá uvoľniť (napr. „Na parcele stojí modul“); vypne Uvoľniť a zobrazí sa pod ním. */
  readonly releaseBlockedReason?: string;
}

/** Popisky stavu parcely. */
export const PARCEL_STATE_LABELS: Readonly<Record<ParcelState, string>> = {
  for_sale: 'Na predaj',
  owned: 'Vlastnená',
  leased: 'Prenajatá',
};

/** Plocha v bunkách (`w × h`). */
export function parcelArea(w: number, h: number): number {
  return Math.max(0, Math.trunc(w)) * Math.max(0, Math.trunc(h));
}

/**
 * Počet mesiacov prenájmu, za ktoré by sa suma kúpy rovnala prenájmu (zaokrúhlené na celé mesiace). Bez prenájmu
 * (nula, záporná alebo neplatná hodnota) → `undefined`.
 */
export function paybackMonths(priceCents: number, leasePerMonthCents: number): number | undefined {
  if (!Number.isFinite(priceCents) || !Number.isFinite(leasePerMonthCents) || leasePerMonthCents <= 0) return undefined;
  return Math.round(Math.max(0, priceCents) / leasePerMonthCents);
}

/** Hotovosť stačí na sumu (neobmedzené, ak `cash` nie je zadané). */
function affordable(amountCents: number, cash: number | undefined): boolean {
  return cash === undefined || cash >= amountCents;
}

/** Kúpa je možná: parcela na predaj a hotovosť pokrýva cenu. */
export function canBuyParcel(parcel: ParcelInfo, cash?: number): boolean {
  return parcel.state === 'for_sale' && affordable(parcel.priceCents, cash);
}

/** Prenájom je možný: parcela na predaj a hotovosť pokrýva prvý mesiac. */
export function canLeaseParcel(parcel: ParcelInfo, cash?: number): boolean {
  return parcel.state === 'for_sale' && affordable(parcel.leasePerMonthCents, cash);
}

/** Uvoľnenie: parcela nie je na predaj a nie je blokované dôvodom. */
export function canReleaseParcel(parcel: ParcelInfo, releaseBlockedReason?: string): boolean {
  return parcel.state !== 'for_sale' && (releaseBlockedReason === undefined || releaseBlockedReason === '');
}

/** Text chýbajúcej hotovosti pre tooltip: `Chýba $X` (bez záporného znamienka). */
function shortfallText(amountCents: number, cash: number | undefined): string | undefined {
  if (cash === undefined || cash >= amountCents) return undefined;
  return `Chýba ${formatMoney(amountCents - cash)}`;
}

export function ParcelPanel({ parcel, cash, onBuy, onLease, onRelease, releaseBlockedReason }: ParcelPanelProps) {
  if (parcel === undefined) {
    return (
      <section className="parcel-panel parcel-panel--empty" aria-label="Parcela" data-section="parcel">
        <p className="parcel-panel__empty">Žiadna parcela nie je vybraná.</p>
      </section>
    );
  }
  const months = paybackMonths(parcel.priceCents, parcel.leasePerMonthCents);
  const buyEnabled = canBuyParcel(parcel, cash) && onBuy !== undefined;
  const leaseEnabled = canLeaseParcel(parcel, cash) && onLease !== undefined;
  const releaseEnabled = canReleaseParcel(parcel, releaseBlockedReason) && onRelease !== undefined;
  const buyTitle = parcel.state !== 'for_sale' ? 'Parcela nie je na predaj' : shortfallText(parcel.priceCents, cash);
  const leaseTitle = parcel.state !== 'for_sale' ? 'Parcela nie je na predaj' : shortfallText(parcel.leasePerMonthCents, cash);
  const releaseTitle = releaseBlockedReason ?? (parcel.state === 'for_sale' ? 'Parcela nie je vlastnená ani prenajatá' : undefined);
  const size = `${formatCount(parcel.w)} × ${formatCount(parcel.h)}`;
  return (
    <section className="parcel-panel" aria-label="Parcela" data-section="parcel" data-parcel={parcel.id} data-state={parcel.state}>
      <div className="parcel-panel__plot">
        <div className="parcel-panel__outline" data-state={parcel.state} />
        <span className="parcel-panel__size" data-field="size">
          {size}
        </span>
      </div>
      <div className="parcel-panel__cards">
        <div className="parcel-panel__card" data-option="buy">
          <span className="parcel-panel__card-label">Kúpa</span>
          <span className="parcel-panel__card-value" data-field="price">
            {formatMoney(parcel.priceCents)}
          </span>
          <span className="parcel-panel__card-note">jednorazovo</span>
        </div>
        <div className="parcel-panel__card" data-option="lease">
          <span className="parcel-panel__card-label">Prenájom</span>
          <span className="parcel-panel__card-value" data-field="lease">
            {formatMoney(parcel.leasePerMonthCents)}
          </span>
          <span className="parcel-panel__card-note">mesačne</span>
        </div>
      </div>
      <dl className="parcel-panel__facts">
        <div className="parcel-panel__fact">
          <dt>Plocha</dt>
          <dd data-field="area">{`${formatCount(parcelArea(parcel.w, parcel.h))} buniek · ${size}`}</dd>
        </div>
        <div className="parcel-panel__fact">
          <dt>Kúpa sa vráti za</dt>
          <dd data-field="payback">{months === undefined ? '—' : formatCount(months, 'mesiacov')}</dd>
        </div>
        <div className="parcel-panel__fact">
          <dt>Stav</dt>
          <dd data-field="state">{PARCEL_STATE_LABELS[parcel.state]}</dd>
        </div>
      </dl>
      <div className="parcel-panel__actions">
        <div className="parcel-panel__row">
          <button
            type="button"
            className="parcel-panel__btn parcel-panel__btn--primary"
            disabled={!buyEnabled}
            title={buyTitle}
            data-action="buy"
            onClick={onBuy === undefined ? undefined : () => onBuy(parcel.id)}
          >
            <Icon name="ic_cash" className="parcel-panel__btn-icon" />
            Kúpiť
          </button>
          <button
            type="button"
            className="parcel-panel__btn"
            disabled={!leaseEnabled}
            title={leaseTitle}
            data-action="lease"
            onClick={onLease === undefined ? undefined : () => onLease(parcel.id)}
          >
            <Icon name="ic_calendar" className="parcel-panel__btn-icon" />
            Prenajať
          </button>
        </div>
        <button
          type="button"
          className="parcel-panel__btn parcel-panel__btn--release"
          disabled={!releaseEnabled}
          title={releaseTitle}
          data-action="release"
          onClick={onRelease === undefined ? undefined : () => onRelease(parcel.id)}
        >
          Uvoľniť
        </button>
        {releaseBlockedReason === undefined || releaseBlockedReason === '' ? null : (
          <p className="parcel-panel__hint" data-field="release-blocked">
            {releaseBlockedReason}
          </p>
        )}
      </div>
    </section>
  );
}
