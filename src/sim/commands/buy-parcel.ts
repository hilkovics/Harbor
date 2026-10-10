/**
 * `BuyParcel { parcelId }` (F7, ADR-044): kúpa parcely na predaj (`ownership: 'none'`) za `parcel.priceCents`.
 * Dôvody: `unknown_parcel`, `parcel_not_for_sale` (už vlastnená alebo prenajatá), `insufficient_funds`.
 * `apply`: `ownership = 'owned'`, `MoneyChanged(parcel_purchase)` a `ParcelOwnershipChanged`. Prenajatú parcelu možno kúpiť až po uvoľnení.
 */
import type { Parcel } from '../grid/parcel';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { ParcelCommand, readParcelId } from './parcel-command';
import type { ValidationReason } from './validation';

export class BuyParcelCommand extends ParcelCommand {
  static readonly TYPE = 'BuyParcel';
  readonly type = BuyParcelCommand.TYPE;

  constructor(parcelId: string) {
    super(parcelId, BuyParcelCommand.TYPE);
  }

  static fromJSON(json: SerializedCommand): BuyParcelCommand {
    return new BuyParcelCommand(readParcelId(json, BuyParcelCommand.TYPE));
  }

  protected rules(_world: World, parcel: Readonly<Parcel>): readonly ValidationReason[] {
    return parcel.ownership === 'none' ? [] : ['parcel_not_for_sale'];
  }

  protected price(_world: World, parcel: Readonly<Parcel>): number {
    return parcel.priceCents;
  }

  protected change(world: World, parcel: Parcel, costCents: number): void {
    parcel.ownership = 'owned';
    world.economy.post(-costCents, 'parcel_purchase', `parcel:${parcel.id}`);
    world.events.emit({ type: 'ParcelOwnershipChanged', parcelId: parcel.id, ownership: 'owned' });
  }
}
