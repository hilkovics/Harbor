/**
 * `SellVehicle { vehicleId }` — predaj nečinného vozidla (docs/tasks/phase-03.md rozhodnutie 4 a „Spoločné
 * rozhrania"; ARCHITECTURE §9.2; ADR-015 bod 5).
 *
 * `validate` (`cells = []`, `costCents` = −refundácia):
 * - `unknown_vehicle` — vozidlo s daným id neexistuje (bez ceny);
 * - `vehicle_busy` — vozidlo nie je `idle`, má job alebo vezie náklad (`in_vehicle` v ledgeri).
 *
 * Refundácia = `refundCents(purchaseCostCents, economy.removalRefundRate)` zo **zaplatenej** ceny (celočíselne
 * v bázických bodoch, ako `RemoveModule`). `apply`: `world.removeVehicle` (odpojí vozidlo od depa; `VehicleError` je
 * druhá poistka), hotovosť += refundácia, `VehicleSold` a len pri refundácii > 0 `MoneyChanged(vehicle_sale)`.
 */
import type { EntityId } from '../core/entity-id';
import type { CellCoord } from '../grid/grid';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { SimCommand } from './sim-command';
import { checkInteger, readPayload } from './payload';
import { refundCents } from './refund';
import { orderReasons, type ValidationReason, type ValidationResult } from './validation';

/** Kľúče serializovaného tvaru `{ type, vehicleId }`. */
const SELL_VEHICLE_KEYS: readonly string[] = ['type', 'vehicleId'];

const NO_CELLS: readonly CellCoord[] = Object.freeze([]);

const UNKNOWN_VEHICLE: ValidationResult = Object.freeze({
  ok: false,
  reasons: Object.freeze(['unknown_vehicle'] as const),
  cells: NO_CELLS,
  costCents: 0,
});

export class SellVehicleCommand extends SimCommand {
  static readonly TYPE = 'SellVehicle';

  readonly type = SellVehicleCommand.TYPE;
  readonly vehicleId: EntityId;

  /** @param vehicleId bezpečné celé číslo (inak `CommandError`); či vozidlo existuje, overí `validate`. */
  constructor(vehicleId: number) {
    super();
    this.vehicleId = checkInteger(vehicleId, SellVehicleCommand.TYPE, '/vehicleId') as EntityId;
  }

  /** Príkaz z tvaru `{ type: 'SellVehicle', vehicleId }`; iný tvar → `CommandError`. */
  static fromJSON(json: SerializedCommand): SellVehicleCommand {
    const raw = readPayload(json, SellVehicleCommand.TYPE, SELL_VEHICLE_KEYS);
    return new SellVehicleCommand(checkInteger(raw['vehicleId'], SellVehicleCommand.TYPE, '/vehicleId'));
  }

  /** Viď hlavička súboru. Svet sa nemení, `Rng` sa nepoužije. */
  protected check(world: World): ValidationResult {
    const vehicle = world.vehicles.get(this.vehicleId);
    if (vehicle === undefined) return UNKNOWN_VEHICLE;
    const found = new Set<ValidationReason>();
    const busy = vehicle.state !== 'idle' || vehicle.jobId !== null || world.cargo.countAt('in_vehicle', vehicle.id) > 0;
    if (busy) found.add('vehicle_busy');
    const refund = refundCents(vehicle.purchaseCostCents, world.defs.economy.removalRefundRate);
    return Object.freeze({ ok: found.size === 0, reasons: orderReasons(found), cells: NO_CELLS, costCents: 0 - refund });
  }

  /** Vykoná príkaz; svet ho volá len po úspešnom `validate` nad tým istým stavom (inak `Error`, nič nezmení). */
  apply(world: World): void {
    const result = this.validate(world);
    if (!result.ok) {
      throw new Error(`${this.type}.apply: príkaz nie je platný (${result.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    }
    const vehicle = world.removeVehicle(this.vehicleId);
    const deltaCents = 0 - result.costCents;
    world.events.emit({ type: 'VehicleSold', vehicleId: vehicle.id });
    if (deltaCents > 0) world.economy.post(deltaCents, 'vehicle_sale', `vehicle:${String(vehicle.id)}`);
  }

  toJSON(): SerializedCommand {
    return { type: this.type, vehicleId: this.vehicleId };
  }
}
