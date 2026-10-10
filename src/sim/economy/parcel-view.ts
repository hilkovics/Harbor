/**
 * Pohľad na parcely pre prezentáciu (F7, ADR-044; VM `ParcelVM`): len čítanie sveta, nové objekty pri každom volaní.
 * Stav `for_sale` = `ownership: 'none'`, `owned` / `leased` ako v sime.
 */
import type { Rect } from '../grid/grid';
import type { World } from '../world/world';
import { leasePerDayCents, leasePerMonthCents } from './parcel-lease';

export type ParcelViewState = 'for_sale' | 'owned' | 'leased';

export interface ParcelView {
  readonly id: string;
  readonly rect: Readonly<Rect>;
  readonly state: ParcelViewState;
  /** Kúpna cena v centoch. */
  readonly priceCents: number;
  /** Nájomné za mesiac v centoch (`price × leaseMonthlyRateOfPrice`); informácia aj pri `leasable: false`. */
  readonly leasePerMonthCents: number;
  /** Nájomné za deň v centoch (to, čo sa strhne pri `DayClosed`). */
  readonly leasePerDayCents: number;
  /** Parcelu možno prenajať. */
  readonly leasable: boolean;
}

/** Všetky parcely v poradí mapy. */
export function listParcels(world: Pick<World, 'parcels' | 'defs'>): readonly ParcelView[] {
  const rate = world.defs.economy.leaseMonthlyRateOfPrice;
  return [...world.parcels.values()].map(
    (parcel): ParcelView => ({
      id: parcel.id,
      rect: { ...parcel.rect },
      state: parcel.ownership === 'none' ? 'for_sale' : parcel.ownership,
      priceCents: parcel.priceCents,
      leasePerMonthCents: leasePerMonthCents(parcel.priceCents, rate),
      leasePerDayCents: leasePerDayCents(parcel.priceCents, rate),
      leasable: parcel.leasable,
    }),
  );
}
