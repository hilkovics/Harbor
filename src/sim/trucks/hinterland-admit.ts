/**
 * Vpúšťanie kamiónov z vnútrozemia do prístavu (F6d, ADR-035; krok 8 po spawne kamiónov na odvoz): poradie podľa priority, v rámci druhu FIFO
 * podľa `dueTick` (čas vzniku kamióna vo vnútrozemí) a pri zhode podľa poradia plánu:
 * 1. **výdaj prázdneho** (`collect`, `trucks/empty-trucks.ts`) — kamión, ktorý náklad z prístavu odváža, má prednosť pred dovozom;
 * 2. **export** (`delivery`, `trucks/export-trucks.ts`) — platí, na rozdiel od prázdneho, a viaže ho cut-off;
 * 3. **návrat prázdneho** (`delivery`, `trucks/empty-trucks.ts`).
 * Kamióny na odvoz importu (`pickup`) vznikajú pred nimi podľa dopytu (`trucks/truck-spawner.ts`) a smú obsadiť aj stojiská rezervované kvótou — dovoz ich
 * nikdy nevytlačí. Bez road portálu alebo rampy sa nevpúšťa nič (položky plánu čakajú).
 */
import { NO_ACCESS } from '../logistics/module-access';
import type { World } from '../world/world';
import { admitCollectTrucks, admitReturnTrucks } from './empty-trucks';
import { admitExportTrucks } from './export-trucks';

/** Krok 8, časť vjazd z vnútrozemia (viď hlavička). */
export function admitFromHinterland(world: World): void {
  const portal = world.landside.portalCell;
  if (portal === NO_ACCESS || world.landsideModules.ramps.length === 0) return;
  admitCollectTrucks(world, portal);
  admitExportTrucks(world, portal);
  admitReturnTrucks(world, portal);
}
