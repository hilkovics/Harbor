/**
 * Nájomné parciel (F7, ADR-044, ARCHITECTURE §9.2 `lease`): denné nájomné = `price × economy.leaseMonthlyRateOfPrice / DAYS_PER_MONTH`
 * zaokrúhlené na celé centy; mesačné = `price × rate`.
 */
import { DAYS_PER_MONTH } from '../core/sim-clock';
import type { Parcel } from '../grid/parcel';

/** Nájomné za deň v centoch (celé). */
export function leasePerDayCents(priceCents: number, monthlyRateOfPrice: number): number {
  return Math.round((priceCents * monthlyRateOfPrice) / DAYS_PER_MONTH);
}

/** Nájomné za mesiac v centoch (celé; informácia pre UI). */
export function leasePerMonthCents(priceCents: number, monthlyRateOfPrice: number): number {
  return Math.round(priceCents * monthlyRateOfPrice);
}

/** Σ denného nájomného všetkých prenajatých parciel (poradie mapy). */
export function totalLeasePerDayCents(parcels: Iterable<Readonly<Parcel>>, monthlyRateOfPrice: number): number {
  let total = 0;
  for (const parcel of parcels) {
    if (parcel.ownership === 'leased') total += leasePerDayCents(parcel.priceCents, monthlyRateOfPrice);
  }
  return total;
}
