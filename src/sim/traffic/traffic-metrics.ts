/**
 * Metriky dopravy v jednom ticku (ADR-037 bod 8, rozhodnutie R1 č. 12): koľko nosičov práve čaká na voľný slot, najdlhšie čakanie
 * a koľko nosičov je v zápche (`blockedTicks ≥ traffic.stuckTicks`). Čistý pohľad na stav sveta (`Carrier.blockedTicks` je v save),
 * takže po obnove save sedí; behové súčty (čakanie za beh, počet hlásených zápch z `TrafficJam`) skladá volajúci (`simrun`).
 */
import type { World } from '../world/world';

export interface TrafficMetrics {
  /** Vozidlá s `blockedTicks > 0`. */
  readonly vehiclesBlocked: number;
  /** Kamióny s `blockedTicks > 0`. */
  readonly trucksBlocked: number;
  /** Najväčšie `blockedTicks` spomedzi všetkých nosičov. */
  readonly maxBlockedTicks: number;
  /** Nosiče so `blockedTicks ≥ stuckTicks` (nahlásená zápcha trvá). */
  readonly jammed: number;
}

/** Metriky dopravy teraz (nová hodnota pri každom volaní; nie hot path). */
export function trafficMetrics(world: World): TrafficMetrics {
  const stuck = world.defs.logistics.traffic.stuckTicks;
  let vehiclesBlocked = 0;
  let trucksBlocked = 0;
  let maxBlockedTicks = 0;
  let jammed = 0;
  for (const vehicle of world.vehicles.values()) {
    if (vehicle.blockedTicks > 0) vehiclesBlocked += 1;
    if (vehicle.blockedTicks > maxBlockedTicks) maxBlockedTicks = vehicle.blockedTicks;
    if (vehicle.blockedTicks >= stuck) jammed += 1;
  }
  for (const truck of world.trucks.values()) {
    if (truck.blockedTicks > 0) trucksBlocked += 1;
    if (truck.blockedTicks > maxBlockedTicks) maxBlockedTicks = truck.blockedTicks;
    if (truck.blockedTicks >= stuck) jammed += 1;
  }
  return { vehiclesBlocked, trucksBlocked, maxBlockedTicks, jammed };
}
