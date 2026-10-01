/**
 * DispatcherSystem — krok 5 ticku (ARCHITECTURE §6, §7.3; rozhodnutia orchestrátora F3 č. 6, F4 č. 4 a F5 č. 9; ADR-018,
 * ADR-023, ADR-027): najprv zrušenie `open` outbound jobov, ktorých rampa už nie je použiteľná (neprevádzková alebo zo skladu
 * nedosiahnuteľná), potom inbound (joby pre jednotky na apronoch s rezerváciou slotu v sklade, `NoStorageAvailable`),
 * outbound (joby pre uskladnené jednotky kontraktov `unloading`/`exporting` podľa SLA, potom `failed` a bez kontraktu, s rezerváciou
 * staging miesta na prevádzkovej rampe) a nakoniec priradenie voľných vozidiel jobom `open` — inbound pred outbound.
 * Logika je v `logistics/dispatcher.ts`; systém len určuje poradie v rámci kroku a drží znovupoužiteľné polia.
 */
import { OutboundCancelGate, assignOpenJobs, cancelUnusableOutboundJobs, createInboundJobs, createOutboundJobs } from '../logistics/dispatcher';
import type { StoredCargoGroup } from '../logistics/stored-cargo-index';
import type { LoadingRamp } from '../modules/loading-ramp';
import type { Vehicle } from '../vehicles/vehicle';
import type { World } from '../world/world';

export class DispatcherSystem {
  /** Znovupoužiteľné pole voľných vozidiel (plní ho `assignOpenJobs` každý tick; nie je stav simulácie). */
  private readonly idle: Vehicle[] = [];
  /** Znovupoužiteľné pole rámp, ktoré môžu dostať outbound job (plní ho `createOutboundJobs`; nie je stav simulácie). */
  private readonly ramps: LoadingRamp[] = [];
  /** Znovupoužiteľné pole outbound skupín v poradí priority (plní ho `createOutboundJobs`; nie je stav simulácie). */
  private readonly groups: StoredCargoGroup[] = [];
  /** Kontrola zrušenia open outbound jobov len po zmene ciest alebo modulov (T06-07; nie je stav simulácie). */
  private readonly cancelGate = new OutboundCancelGate();

  /**
   * Krok 5: `cancelUnusableOutboundJobs` (len po zmene ciest alebo modulov, `OutboundCancelGate`) → `createInboundJobs`
   * → `createOutboundJobs` → `assignOpenJobs`.
   */
  tick(world: World): void {
    if (this.cancelGate.due(world)) cancelUnusableOutboundJobs(world);
    createInboundJobs(world);
    createOutboundJobs(world, this.ramps, this.groups);
    assignOpenJobs(world, this.idle);
  }
}
