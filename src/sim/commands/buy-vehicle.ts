/**
 * `BuyVehicle { vehicleDefId, depotId }` — nákup interného vozidla do depa (docs/tasks/phase-03.md rozhodnutie 4
 * a „Spoločné rozhrania"; ARCHITECTURE §4.4, §9.2).
 *
 * `validate` (všetky dôvody naraz v poradí `VALIDATION_REASONS`, `cells = []`, `costCents = def.purchaseCents`, pri
 * neznámom defe 0):
 * - `unknown_vehicle_def` — def nie je vo `vehicles.json`;
 * - `unknown_depot` — modul s daným id neexistuje alebo nie je depo vozidiel (`VehicleDepot`); o státiach a pripojení
 *   sa potom nerozhoduje;
 * - `depot_full` — depo nemá voľné státie (`freeStalls`, `params.capacity`);
 * - `not_connected` — depo nie je pripojené k ceste (`World.isConnected`) — vozidlo by nemalo kam vyjsť;
 * - `insufficient_funds` — cena > 0 a vyššia než hotovosť (ADR-013).
 * `techRequired` vozidla sa zatiaľ nevyhodnocuje (tech strom príde v neskoršej fáze, ako pri moduloch).
 *
 * `apply`: vozidlo s novým id (`world.ids`), stav `idle`, v strede vonkajšej bunky prvého pripojeného cestného
 * konektora depa (trasa `[táto bunka]`) s kurzom von z depa (`depotExit`), `purchaseCostCents = def.purchaseCents`;
 * `world.addVehicle` ho pripojí k depu, hotovosť −= cena, `VehicleBought` a pri nenulovej cene `MoneyChanged(vehicle_capex)`.
 */
import type { EntityId } from '../core/entity-id';
import type { CellCoord } from '../grid/grid';
import { VehicleDepot } from '../modules/vehicle-depot';
import { depotExit } from '../vehicles/depot-exit';
import { Vehicle } from '../vehicles/vehicle';
import type { World } from '../world/world';
import type { Command, SerializedCommand } from './command';
import { CommandError } from './command-error';
import { checkInteger, checkString, readPayload } from './payload';
import { orderReasons, type ValidationReason, type ValidationResult } from './validation';

/** Kľúče serializovaného tvaru v poradí `toJSON`. */
const BUY_VEHICLE_KEYS: readonly string[] = ['type', 'vehicleDefId', 'depotId'];

const NO_CELLS: readonly CellCoord[] = Object.freeze([]);

/** Vstup konštruktora (rovnaké polia ako JSON bez `type`). */
export interface BuyVehicleInput {
  readonly vehicleDefId: string;
  /** Id modulu depa; či existuje a je depo, overí `validate` (`unknown_depot`). */
  readonly depotId: number;
}

export class BuyVehicleCommand implements Command {
  static readonly TYPE = 'BuyVehicle';

  readonly type = BuyVehicleCommand.TYPE;
  readonly vehicleDefId: string;
  readonly depotId: EntityId;

  /** @param input reťazec `vehicleDefId` a celé číslo `depotId`; inak `CommandError`. */
  constructor(input: BuyVehicleInput) {
    const type = BuyVehicleCommand.TYPE;
    if (typeof input !== 'object' || input === null) throw new CommandError(`${type}: vstup musí byť objekt { vehicleDefId, depotId }`);
    this.vehicleDefId = checkString(input.vehicleDefId, type, '/vehicleDefId');
    this.depotId = checkInteger(input.depotId, type, '/depotId') as EntityId;
  }

  /** Príkaz z tvaru `{ type: 'BuyVehicle', vehicleDefId, depotId }`; iný tvar → `CommandError`. */
  static fromJSON(json: SerializedCommand): BuyVehicleCommand {
    const type = BuyVehicleCommand.TYPE;
    const raw = readPayload(json, type, BUY_VEHICLE_KEYS);
    return new BuyVehicleCommand({
      vehicleDefId: checkString(raw['vehicleDefId'], type, '/vehicleDefId'),
      depotId: checkInteger(raw['depotId'], type, '/depotId'),
    });
  }

  /** Viď hlavička súboru. Svet sa nemení, `Rng` sa nepoužije. */
  validate(world: World): ValidationResult {
    const found = new Set<ValidationReason>();
    const def = world.defs.vehicles.has(this.vehicleDefId) ? world.defs.vehicles.get(this.vehicleDefId) : undefined;
    if (def === undefined) found.add('unknown_vehicle_def');
    const depot = this.depot(world);
    if (depot === undefined) {
      found.add('unknown_depot');
    } else {
      if (depot.freeStalls <= 0) found.add('depot_full');
      if (!world.isConnected(depot)) found.add('not_connected');
    }
    const costCents = def?.purchaseCents ?? 0;
    if (costCents > 0 && costCents > world.cashCents) found.add('insufficient_funds');
    return Object.freeze({ ok: found.size === 0, reasons: orderReasons(found), cells: NO_CELLS, costCents });
  }

  /** Vykoná príkaz; svet ho volá len po úspešnom `validate` nad tým istým stavom (inak `Error`, nič nezmení). */
  apply(world: World): void {
    const result = this.validate(world);
    const depot = this.depot(world);
    const exit = depot === undefined ? undefined : depotExit(world.grid, depot);
    if (!result.ok || depot === undefined || exit === undefined) {
      throw new Error(`${this.type}.apply: príkaz nie je platný (${result.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    }
    const def = world.defs.vehicles.get(this.vehicleDefId);
    const vehicle = new Vehicle({
      id: world.ids.next(),
      def,
      depotId: depot.id,
      state: 'idle',
      x: exit.x,
      y: exit.y,
      heading: exit.heading,
      jobId: null,
      purchaseCostCents: result.costCents,
      route: [world.grid.index(exit.cell.x, exit.cell.y)],
    });
    world.addVehicle(vehicle);
    const deltaCents = 0 - result.costCents;
    world.events.emit({ type: 'VehicleBought', vehicleId: vehicle.id, defId: vehicle.defId, depotId: depot.id });
    if (deltaCents !== 0) world.economy.post(deltaCents, 'vehicle_capex', `vehicle:${String(vehicle.id)}`);
  }

  toJSON(): SerializedCommand {
    return { type: this.type, vehicleDefId: this.vehicleDefId, depotId: this.depotId };
  }

  private depot(world: World): VehicleDepot | undefined {
    const module = world.modules.get(this.depotId);
    return module instanceof VehicleDepot ? module : undefined;
  }
}
