/**
 * `ReleaseParcel { parcelId }` (F7, ADR-044): ukončenie prenájmu — parcela sa vráti na predaj (`ownership: 'none'`).
 * Dôvody: `unknown_parcel`, `parcel_not_leased` (kúpenú parcelu uvoľniť nemožno), `parcel_in_use` (na parcele stojí modul,
 * cesta alebo koľaj). Zadarmo.
 */
import type { Parcel } from '../grid/parcel';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { ParcelCommand, parcelInUse, readParcelId } from './parcel-command';
import type { ValidationReason } from './validation';

export class ReleaseParcelCommand extends ParcelCommand {
  static readonly TYPE = 'ReleaseParcel';
  readonly type = ReleaseParcelCommand.TYPE;

  constructor(parcelId: string) {
    super(parcelId, ReleaseParcelCommand.TYPE);
  }

  static fromJSON(json: SerializedCommand): ReleaseParcelCommand {
    return new ReleaseParcelCommand(readParcelId(json, ReleaseParcelCommand.TYPE));
  }

  protected rules(world: World, parcel: Readonly<Parcel>): readonly ValidationReason[] {
    if (parcel.ownership !== 'leased') return ['parcel_not_leased'];
    return parcelInUse(world, parcel) ? ['parcel_in_use'] : [];
  }

  protected price(): number {
    return 0;
  }

  protected change(world: World, parcel: Parcel): void {
    parcel.ownership = 'none';
    world.events.emit({ type: 'ParcelOwnershipChanged', parcelId: parcel.id, ownership: 'none' });
  }
}
