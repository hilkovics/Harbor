/**
 * `LeaseParcel { parcelId }` (F7, ADR-044): prenájom parcely na predaj (`leasable`). Bez poplatku pri uzavretí; nájomné
 * `round(price × economy.leaseMonthlyRateOfPrice / 30)` za deň strhne `EconomySystem` pri `DayClosed` (`parcel_lease`).
 * Dôvody: `unknown_parcel`, `parcel_not_for_sale`, `parcel_not_leasable`.
 */
import type { Parcel } from '../grid/parcel';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { ParcelCommand, readParcelId } from './parcel-command';
import type { ValidationReason } from './validation';

export class LeaseParcelCommand extends ParcelCommand {
  static readonly TYPE = 'LeaseParcel';
  readonly type = LeaseParcelCommand.TYPE;

  constructor(parcelId: string) {
    super(parcelId, LeaseParcelCommand.TYPE);
  }

  static fromJSON(json: SerializedCommand): LeaseParcelCommand {
    return new LeaseParcelCommand(readParcelId(json, LeaseParcelCommand.TYPE));
  }

  protected rules(_world: World, parcel: Readonly<Parcel>): readonly ValidationReason[] {
    if (parcel.ownership !== 'none') return ['parcel_not_for_sale'];
    return parcel.leasable ? [] : ['parcel_not_leasable'];
  }

  protected price(): number {
    return 0;
  }

  protected change(world: World, parcel: Parcel): void {
    parcel.ownership = 'leased';
    world.events.emit({ type: 'ParcelOwnershipChanged', parcelId: parcel.id, ownership: 'leased' });
  }
}
