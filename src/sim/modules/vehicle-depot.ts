/**
 * Depo vozidiel (ARCHITECTURE §5.3 `vehicle_depot`; rozhodnutie orchestrátora F3 č. 4; ADR-017). Má `params.capacity`
 * státí; vozidlo patrí depu (`Vehicle.depotId`, T03-04) a depo eviduje svoje vozidlá v `vehicleIds` v poradí
 * pripojenia — rovnako ako berth eviduje žeriavy. Zoznam spravuje výlučne `World` (`addVehicle` / `removeVehicle`,
 * T03-04) cez `attachVehicle` / `detachVehicle`; do save sa neukladá (odvodí sa z `depotId` vozidiel), `runtime` je `{}`.
 *
 * Depo s vozidlami nejde odstrániť (`has_vehicles`, `module-rules.ts`). Nákup vozidla vyžaduje voľné státie
 * (`freeStalls > 0`, dôvod `depot_full`) a pripojené depo (`World.isConnected`, dôvod `not_connected`) — T03-04.
 */
import type { EntityId } from '../core/entity-id';
import { depotParams } from '../defs/module-def';
import type { DepotParams } from '../defs/types';
import { Module, type ModuleInit } from './module';
import { ModuleError } from './module-error';

export class VehicleDepot extends Module {
  /** Typované `params` defu (`depotParams`). */
  readonly params: DepotParams;
  private readonly vehicles: EntityId[] = [];

  /** Def iného druhu než `depot` → `DefError`. */
  constructor(init: ModuleInit) {
    super(init);
    this.params = depotParams(init.def);
  }

  /** Počet státí (`params.capacity`). */
  get capacity(): number {
    return this.params.capacity;
  }

  /** Vozidlá depa v poradí pripojenia. Nemeň — spravuje ho `World`. */
  get vehicleIds(): readonly EntityId[] {
    return this.vehicles;
  }

  /** Voľné státia (`capacity − vehicleIds.length`). */
  get freeStalls(): number {
    return this.params.capacity - this.vehicles.length;
  }

  /**
   * Pripojí vozidlo; volá výlučne `World` (T03-04) po overení príkazu. Chyby (`ModuleError`, stav sa nezmení):
   * vozidlo už pripojené → `duplicate_id`, depo plné → `depot_full`.
   */
  attachVehicle(vehicleId: EntityId): void {
    if (this.vehicles.includes(vehicleId)) throw new ModuleError('duplicate_id', `${this.label}: vozidlo #${String(vehicleId)} je už v depe`);
    if (this.vehicles.length >= this.params.capacity) {
      throw new ModuleError('depot_full', `${this.label}: depo je plné (${String(this.vehicles.length)}/${String(this.params.capacity)})`);
    }
    this.vehicles.push(vehicleId);
  }

  /** Odpojí vozidlo; volá výlučne `World` (T03-04). Vozidlo k depu nepatrí → `ModuleError('unknown_vehicle')`. */
  detachVehicle(vehicleId: EntityId): void {
    const index = this.vehicles.indexOf(vehicleId);
    if (index < 0) throw new ModuleError('unknown_vehicle', `${this.label}: vozidlo #${String(vehicleId)} k depu nepatrí`);
    this.vehicles.splice(index, 1);
  }
}
