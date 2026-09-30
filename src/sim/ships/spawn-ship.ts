/**
 * Spawn lode s nákladom (ARCHITECTURE §7.4, §9.1; ADR-016 bod 10, ADR-026) — jediný kód pre ladiacu loď
 * (`SpawnShipDebug`) aj loď kontraktu (`ContractSystem`, krok 2): loď (`inbound`) so stredom v strede `seaLane[0]`
 * a kurzom prvého úseku dráhy, potom `units` jednotiek `on_ship` s daným `contractId` (`CargoLedger.create`; id lode
 * predchádza id jednotiek) a `ShipSpawned`. Hotovosť sa nemení.
 *
 * Platnosť vstupu (známa trieda a typ, kompatibilná kategória, `1 ≤ units ≤ capacityUnits`) overuje volajúci vopred
 * (`SpawnShipDebug.validate`, pool kontraktov); chybu programu tu ohlási `Ship` / `CargoLedger` výnimkou.
 */
import type { ContractId } from '../core/entity-id';
import type { World } from '../world/world';
import { Ship } from './ship';
import { cardinalHeading, cellCenter } from './ship-route';

/** Kurz lode pri spawne, keď prvý úsek `seaLane` nemá dĺžku (sever). */
const DEFAULT_SPAWN_HEADING = 0;

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
  const [first, second] = world.map.seaLane;
  const spawn = cellCenter(first);
  const next = second === undefined ? spawn : cellCenter(second);
  const ship = new Ship({
    id: world.ids.next(),
    def: world.defs.ships.get(spec.shipClassId),
    cargoType: world.defs.cargoTypes.get(spec.cargoTypeId),
    state: 'inbound',
    x: spawn.x,
    y: spawn.y,
    heading: cardinalHeading(next.x - spawn.x, next.y - spawn.y) ?? DEFAULT_SPAWN_HEADING,
  });
  world.addShip(ship);
  for (let i = 0; i < spec.units; i++) world.cargo.create(spec.cargoTypeId, { kind: 'on_ship', shipId: ship.id }, spec.contractId);
  world.events.emit({ type: 'ShipSpawned', shipId: ship.id, classId: ship.classId, cargoTypeId: ship.cargoTypeId, units: spec.units });
  return ship;
}
