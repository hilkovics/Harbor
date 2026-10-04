/**
 * RampAllocator (ARCHITECTURE §7.3 bod 2, §7.5; rozhodnutia orchestrátora F4 č. 1 a 4; ADR-022, ADR-023) — výber rampy
 * pre outbound job zo skladu.
 *
 * Kandidát = `LoadingRamp` s kategóriou nákladu, voľným staging miestom (t. j. niektorý dock má `staged + reserved < stagingPerDock`
 * a miesto nie je prisľúbené kamiónu s dovozom, `outboundRoom`, ADR-035), **prevádzková** (`isRampOperational`: cesta portál → brána → stojisko → rampa,
 * ADR-022) a dosiahnuteľná po ceste zo skladu. Vyhráva najmenšia cestná vzdialenosť sklad → rampa
 * (`distanceBetweenModules`, `DistanceMatrix`), pri zhode menšie id (kandidáti idú vzostupne podľa id a berie sa len
 * ostro menšia vzdialenosť). Rezerváciu miesta robí volajúci (`LoadingRamp.reserve(firstFreeDock())`) — výber sám svet
 * nemení a nealokuje.
 */
import type { CargoCategory } from '../defs/types';
import type { LoadingRamp } from '../modules/loading-ramp';
import type { Module } from '../modules/module';
import { distanceBetweenModules, type ModuleAccessEnv } from './module-access';

/** Voľné staging miesta rampy po odpočítaní miest prisľúbených kamiónom s dovozom (`DockIntake`, ADR-035). */
export interface DockRoom {
  roomCount(ramp: LoadingRamp): number;
}

/** Časť sveta, ktorú alokátor číta (`World` ju spĺňa). */
export interface RampAllocatorEnv extends ModuleAccessEnv {
  /**
   * Prisľúbený príjem na dockoch (`World.dockIntake`): outbound job smie vziať len miesto, ktoré nie je prisľúbené kamiónu s dovozom — príjem a odvoz
   * majú vlastnú kapacitu docku a navzájom sa nezablokujú (ADR-035). Chýba = všetky voľné miesta (svet bez kamiónov, testy).
   */
  readonly dockIntake?: DockRoom;
  /** Register pozemných modulov — rampy vzostupne podľa id (`World.landsideModules`, pravidlo 7). */
  readonly landsideModules: { readonly ramps: readonly LoadingRamp[] };
  /** Aktuálna prevádzkovosť rampy (ADR-022) — bez alokácie pri nezmenenej sieti. */
  isRampOperational(ramp: Module): boolean;
}

/** Voľné staging miesta rampy pre outbound job: po odpočítaní prisľúbených príjmu (`env.dockIntake`), inak všetky voľné. */
export function outboundRoom(env: RampAllocatorEnv, ramp: LoadingRamp): number {
  return env.dockIntake === undefined ? ramp.freeCount : env.dockIntake.roomCount(ramp);
}

/** Môže rampa ešte dostať outbound job pre náklad kategórie `category` (bez ohľadu na zdroj)? */
export function acceptsOutbound(env: RampAllocatorEnv, ramp: LoadingRamp, category: CargoCategory): boolean {
  return ramp.category === category && outboundRoom(env, ramp) > 0 && env.isRampOperational(ramp);
}

/**
 * Najbližšia vhodná rampa (viď hlavička) pre náklad kategórie `category` zo skladu `source`; inak `undefined`.
 * `candidates` (predvolene všetky rampy sveta z registra, vzostupne podľa id) môže byť predvýber rámp v tom istom
 * poradí — dispatcher ich zbiera raz za tick (`collectOutboundRamps`); podmienky kandidáta sa overia aj tak.
 */
export function allocateRamp(
  env: RampAllocatorEnv,
  source: Module,
  category: CargoCategory,
  candidates: Iterable<LoadingRamp> = env.landsideModules.ramps,
): LoadingRamp | undefined {
  let best: LoadingRamp | undefined;
  let bestDistance = Infinity;
  for (const ramp of candidates) {
    if (!acceptsOutbound(env, ramp, category)) continue;
    const distance = distanceBetweenModules(env, source, ramp);
    if (distance < bestDistance) {
      best = ramp;
      bestDistance = distance;
    }
  }
  return best;
}
