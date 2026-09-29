/**
 * Parcela (ARCHITECTURE §5.2): obdĺžnik buniek na predaj alebo prenájom. Moduly len na `owned`/`leased`
 * parcele; cesty a koľaje aj na verejných bunkách, nie však na parcele `none` (ADR-008).
 *
 * Geometria (`rect`) a cena sa po načítaní mapy nemenia; mení sa iba `ownership` (kúpa, prenájom, ukončenie).
 */
import type { Rect } from './grid';

export type ParcelOwnership = 'none' | 'owned' | 'leased';

export interface Parcel {
  readonly id: string;
  readonly rect: Rect;
  /** Kúpna cena v centoch (USD); z nej sa počíta aj nájom (§5.2). */
  readonly priceCents: number;
  readonly leasable: boolean;
  ownership: ParcelOwnership;
}
