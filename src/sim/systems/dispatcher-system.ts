/**
 * DispatcherSystem — krok 5 ticku (ARCHITECTURE §6, §7.3; rozhodnutia orchestrátora F3 č. 6, F4 č. 4 a F5 č. 9; ADR-018, ADR-023, ADR-027, ADR-041): najprv inbound (joby pre jednotky
 * na apronoch s rezerváciou slotu v sklade, `NoStorageAvailable`), vykládka pod hákom (F6a, ADR-033), nakládka exportu v poradí stowage plánu a nakoniec priradenie voľných vozidiel
 * jobom `open` — inbound a hák pred nakládkou a obsluhou kamiónov na TP na hrane bloku. Joby kamiónov vznikajú pri vzniku kamióna (krok 8), nie tu.
 * Logika je v `logistics/dispatcher.ts`; systém len určuje poradie v rámci kroku a drží znovupoužiteľné polia.
 */
import { assignOpenJobs, createExportLoadJobs, createHookUnloadJobs, createInboundJobs } from '../logistics/dispatcher';
import { beginGangPass, endGangPass } from '../logistics/gang-roster';
import type { Vehicle } from '../vehicles/vehicle';
import type { World } from '../world/world';

export class DispatcherSystem {
  /** Znovupoužiteľné pole voľných vozidiel (plní ho `assignOpenJobs` každý tick; nie je stav simulácie). */
  private readonly idle: Vehicle[] = [];

  /** Krok 5: `createInboundJobs` → `createHookUnloadJobs` (vykládka pod hákom, ADR-033) → `createExportLoadJobs` (nakládka exportu v poradí stowage plánu) → `assignOpenJobs`. */
  tick(world: World): void {
    beginGangPass(world);
    try {
      createInboundJobs(world);
      createHookUnloadJobs(world);
      createExportLoadJobs(world);
      assignOpenJobs(world, this.idle);
    } finally {
      endGangPass();
    }
  }
}
