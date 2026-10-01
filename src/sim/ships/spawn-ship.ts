/**
 * Spawn lode s nákladom (ARCHITECTURE §7.4, §9.1; ADR-016 bod 10, ADR-026) — jediný kód pre ladiacu loď
 * (`SpawnShipDebug`) aj loď kontraktu (`ContractSystem`, krok 2): loď (`arriving`) so stredom v strede `seaLane[0]`
 * a kurzom prvého úseku dráhy, potom `units` jednotiek `on_ship` s daným `contractId` (`CargoLedger.create`; id lode
 * predchádza id jednotiek) a `ShipSpawned`. Hneď potom loď skúsi vplávať (`ShipTraffic.tryEnterOnSpawn`, ADR-029):
 * keď nečaká iná loď a má cieľ s voľnou trasou, je `inbound` a pohne sa v kroku 3 toho istého ticku ako doteraz;
 * inak čaká pred vstupom (`arriving`) a vstup skúša krok 3 v poradí podľa id. Hotovosť sa nemení.
 *
 * Platnosť vstupu (známa trieda a typ, kompatibilná kategória, `1 ≤ units ≤ capacityUnits`) overuje volajúci vopred
 * (`SpawnShipDebug.validate`, pool kontraktov); chybu programu tu ohlási `Ship` / `CargoLedger` výnimkou.
 */
import type { ContractId } from '../core/entity-id';
import type { World } from '../world/world';
import { Ship } from './ship';
import { cellCenter, laneStartHeading } from './ship-route';

/** Čo sa spawnuje. */
export interface ShipSpawnSpec {
  readonly shipClassId: string;
  readonly cargoTypeId: string;
  /** Počet jednotiek nákladu (celé 1 … `capacityUnits`, overuje volajúci). */
  readonly units: number;
  /** Kontrakt, ku ktorému náklad patrí; `null` = bez kontraktu (ladiaca loď). */
  readonly contractId: ContractId | null;
}

/** Vytvorí loď s nákladom podľa `spec` (viď hlavička súboru) a vráti ju. */
export function spawnShip(world: World, spec: ShipSpawnSpec): Ship {
  const spawn = cellCenter(world.map.seaLane[0]);
  const ship = new Ship({
    id: world.ids.next(),
    def: world.defs.ships.get(spec.shipClassId),
    cargoType: world.defs.cargoTypes.get(spec.cargoTypeId),
    state: 'arriving',
    x: spawn.x,
    y: spawn.y,
    heading: laneStartHeading(world.map),
  });
  world.addShip(ship);
  for (let i = 0; i < spec.units; i++) world.cargo.create(spec.cargoTypeId, { kind: 'on_ship', shipId: ship.id }, spec.contractId);
  world.events.emit({ type: 'ShipSpawned', shipId: ship.id, classId: ship.classId, cargoTypeId: ship.cargoTypeId, units: spec.units });
  world.shipTraffic.tryEnterOnSpawn(ship);
  return ship;
}
