/**
 * DispatcherSystem — krok 5 ticku (ARCHITECTURE §6, §7.3; rozhodnutie orchestrátora F3 č. 6; ADR-018): najprv inbound
 * (joby pre jednotky na apronoch s rezerváciou slotu v sklade, `NoStorageAvailable`), potom priradenie voľných vozidiel
 * jobom `open`. Logika je v `logistics/dispatcher.ts`; systém len určuje poradie v rámci kroku.
 */
import { assignOpenJobs, createInboundJobs } from '../logistics/dispatcher';
import type { Vehicle } from '../vehicles/vehicle';
import type { World } from '../world/world';

export class DispatcherSystem {
  /** Znovupoužiteľné pole voľných vozidiel (plní ho `assignOpenJobs` každý tick; nie je stav simulácie). */
  private readonly idle: Vehicle[] = [];

  /** Krok 5: `createInboundJobs` → `assignOpenJobs`. */
  tick(world: World): void {
    createInboundJobs(world);
    assignOpenJobs(world, this.idle);
  }
}
