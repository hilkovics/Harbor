/**
 * DispatcherSystem — krok 5 ticku (ARCHITECTURE §6, §7.3; rozhodnutia orchestrátora F3 č. 6, F4 č. 4 a F5 č. 9; ADR-018,
 * ADR-023, ADR-027): najprv zrušenie `open` outbound jobov, ktorých rampa už nie je použiteľná (neprevádzková alebo zo skladu
 * nedosiahnuteľná), potom inbound (joby pre jednotky na apronoch s rezerváciou slotu v sklade, `NoStorageAvailable`),
 * outbound (joby pre uskladnené jednotky kontraktov `unloading`/`exporting` podľa SLA, potom `failed` a bez kontraktu, s rezerváciou
 * staging miesta na prevádzkovej rampe), prijatie exportu z rampy do skladu (F6a), nakládka exportu v poradí stowage plánu a vykládka pod
 * hákom (F6a, ADR-033) a nakoniec priradenie voľných vozidiel jobom `open` — inbound a hák pred outbound a nakládkou.
 * Logika je v `logistics/dispatcher.ts`; systém len určuje poradie v rámci kroku a drží znovupoužiteľné polia.
 */
import {
  OutboundCancelGate,
  assignOpenJobs,
  cancelUnusableOutboundJobs,
  createEmptyJobs,
  createExportJobs,
  createExportLoadJobs,
  createHookUnloadJobs,
  createInboundJobs,
  createOutboundJobs,
} from '../logistics/dispatcher';
import { beginGangPass, endGangPass } from '../logistics/gang-roster';
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
   * Krok 5: obnova prisľúbených staging miest príjmu (`DockIntake.refresh`) → `cancelUnusableOutboundJobs` (len po zmene ciest alebo modulov, `OutboundCancelGate`) → `createInboundJobs`
   * → `createHookUnloadJobs` (vykládka pod hákom, ADR-033) → `createExportJobs` (prijatie exportu z rampy, ADR-032) →
   * `createEmptyJobs` (prázdne kontajnery: prijatie do depa, výdaj kamiónu `collect`, ADR-034) → `createExportLoadJobs` (nakládka exportu
   * v poradí stowage plánu) → `createOutboundJobs` → `assignOpenJobs`.
   */
  tick(world: World): void {
    // Staging miesta prisľúbené kamiónom s dovozom (ADR-035): outbound joby ich nesmú vziať (`DockIntake.roomAt`).
    world.dockIntake.refresh(world);
    beginGangPass(world);
    try {
      if (this.cancelGate.due(world)) cancelUnusableOutboundJobs(world);
      createInboundJobs(world);
      createHookUnloadJobs(world);
      createExportJobs(world);
      createEmptyJobs(world);
      createExportLoadJobs(world);
      createOutboundJobs(world, this.ramps, this.groups);
      assignOpenJobs(world, this.idle);
    } finally {
      endGangPass();
    }
  }
}
