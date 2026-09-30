/**
 * MetricsSystem — krok 11 ticku (ARCHITECTURE §6, §7.6, §11; docs/tasks/phase-03.md rozhodnutie 9; ADR-019, ADR-024),
 * vo F3 minimálny: heatmapa dopravy. Po pohybe vozidiel (krok 6) a kamiónov (krok 8) dostane bunka pod každým vozidlom
 * a kamiónom `traffic += 1` a pri
 * uzavretí hernej hodiny (`HourClosed`) sa `traffic` všetkých buniek vynásobí `logistics.congestion.trafficDecayPerHour`;
 * hodnota pod `TRAFFIC_ZERO_THRESHOLD` sa zaokrúhli na 0, aby save (riedke `traffic`) nerástol donekonečna. Utilizácia
 * a fill % (§11) pribudnú neskôr.
 */
import type { World } from '../world/world';

/** Príspevok jedného vozidla k `traffic` bunky za jeden tick (§7.6 „traffic += 1"). */
export const TRAFFIC_PER_VEHICLE_TICK = 1;

/**
 * Hodnota `traffic`, pod ktorou sa po decay bunka vynuluje (technická hranica riedkeho save, nie balans — pri 0,9 za
 * hodinu klesne 1 pod túto hranicu asi za 66 hodín). Kandidát na `logistics.json`, ak ju bude treba ladiť (BACKLOG).
 */
export const TRAFFIC_ZERO_THRESHOLD = 1e-3;

export class MetricsSystem {
  /** Krok 11: `traffic` pod vozidlami a kamiónmi, pri `hourClosed` decay heatmapy. Bez alokácie. */
  tick(world: World, hourClosed: boolean): void {
    const { grid } = world;
    for (const vehicle of world.vehicles.values()) {
      grid.at(Math.floor(vehicle.x), Math.floor(vehicle.y)).traffic += TRAFFIC_PER_VEHICLE_TICK;
    }
    for (const truck of world.trucks.values()) {
      grid.at(Math.floor(truck.x), Math.floor(truck.y)).traffic += TRAFFIC_PER_VEHICLE_TICK;
    }
    if (!hourClosed) return;
    const decay = world.defs.logistics.congestion.trafficDecayPerHour;
    for (let i = 0; i < grid.cellCount; i++) {
      const cell = grid.atIndex(i);
      if (cell.traffic === 0) continue;
      const next = cell.traffic * decay;
      cell.traffic = next < TRAFFIC_ZERO_THRESHOLD ? 0 : next;
    }
  }
}
