/**
 * Vpúšťanie kamiónov z vnútrozemia do prístavu (F6d, ADR-035; krok 8 po spawne kamiónov na odvoz): poradie podľa priority; v rámci druhu prázdne
 * v poradí jediného plánu prázdnych (FIFO podľa `dueTick` — čas vzniku kamióna vo vnútrozemí), export po kontraktoch vzostupne podľa id a v rámci kontraktu
 * podľa `dueTick` (nie FIFO naprieč bookingmi):
 * 1. **výdaj prázdneho** (`collect`, `trucks/empty-trucks.ts`) — kamión, ktorý náklad z prístavu odváža, má prednosť pred dovozom;
 * 2. **export** (`delivery`, `trucks/export-trucks.ts`) — platí, na rozdiel od prázdneho, a viaže ho cut-off;
 * 3. **návrat prázdneho** (`delivery`, `trucks/empty-trucks.ts`).
 * Kamióny na odvoz importu (`pickup`) vznikajú pred nimi podľa dopytu (`trucks/truck-spawner.ts`) a nikdy nie sú vytlačené dovozom. Bez portálu vjazdu sa nevpúšťa nič (položky plánu čakajú).
 */
import type { World } from '../world/world';
import { admitCollectTrucks, admitReturnTrucks } from './empty-trucks';
import { admitExportTrucks } from './export-trucks';

/** Krok 8, časť vjazd z vnútrozemia (viď hlavička). */
export function admitFromHinterland(world: World): void {
  if (world.landside.inPortals.length === 0) return;
  admitCollectTrucks(world);
  admitExportTrucks(world);
  admitReturnTrucks(world);
}
