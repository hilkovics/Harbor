/**
 * Metriky terminálu s ťahačmi a RTG (TR3-02, ADR-040): priepustnosť strojov a čakanie STS na ťahač. Čistý dotaz nad svetom (nič sa neukladá okrem počítadiel strojov).
 *
 * - `stsMovesPerHour` = Σ `CraneModule.moves` (dokončené presuny STS) za hernú hodinu od začiatku hry;
 * - `rtgMovesPerHour` = Σ `YardMachine.moves` (dokončené cykly RTG, aj rehandling) za hernú hodinu;
 * - `stsWaitForTractorPct` = Σ `waitForVehicleTicks` / Σ (`busyTicks` + `idleWaitTicks`) × 100 — podiel času cyklu STS (práca + čakanie nečinného žeriava na vozidlo), ktorý žeriav
 *   strávil čakaním na vozidlo pod hákom (čakanie vo fáze `placing` je už v `busyTicks`); bez práce `null`.
 */
import { CraneModule } from '../modules/crane-module';
import type { World } from '../world/world';

export interface TerminalMetrics {
  readonly stsMoves: number;
  readonly rtgMoves: number;
  /** Uplynulé herné hodiny (zlomok), z ktorých sa počítajú presuny za hodinu; 0 na začiatku. */
  readonly hours: number;
  readonly stsMovesPerHour: number;
  readonly rtgMovesPerHour: number;
  readonly stsWaitForTractorPct: number | null;
}

const PERCENT = 100;

export function terminalMetrics(world: Pick<World, 'modules' | 'machines' | 'clock'>): TerminalMetrics {
  let stsMoves = 0;
  let wait = 0;
  let busy = 0;
  let idleWait = 0;
  for (const module of world.modules.values()) {
    if (!(module instanceof CraneModule)) continue;
    stsMoves += module.moves;
    wait += module.waitForVehicleTicks;
    busy += module.busyTicks;
    idleWait += module.idleWaitTicks;
  }
  let rtgMoves = 0;
  for (const machine of world.machines.values()) rtgMoves += machine.moves;
  const hours = world.clock.tick / world.clock.ticksPerHour;
  return {
    stsMoves,
    rtgMoves,
    hours,
    stsMovesPerHour: hours === 0 ? 0 : stsMoves / hours,
    rtgMovesPerHour: hours === 0 ? 0 : rtgMoves / hours,
    stsWaitForTractorPct: busy + idleWait === 0 ? null : (wait * PERCENT) / (busy + idleWait),
  };
}
