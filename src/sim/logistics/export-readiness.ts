/**
 * Pripravenosť pozemnej strany prístavu pre export (F6a, ADR-032; `AcceptContract` pri export / roundtrip bookingu, vzor
 * `berthReadiness` z ADR-031) — export prichádza kamiónmi, prechádza bránou, vykladá sa na rampe a vozidlá ho odvezú do skladu;
 * bez ktoréhokoľvek článku reťazca by kamióny nevznikli (alebo by jednotky nemali kam ísť) a booking by skončil penalizáciou.
 * Posudzuje sa **stav v čase prijatia**, obsadenosť (voľné bays, staging, kapacita skladu) nie. Svet nemení, `Rng` nespotrebuje.
 *
 * Verdikt (najskôr chýbajúci článok):
 * - `no_ramp` — žiadna rampa kategórie nákladu (alebo kamión pre ňu v `trucks.json`),
 * - `ramp_inoperative` — rampa je, ale žiadna nie je prevádzková (`World.isRampOperational`: brána, stojisko, cesta od portálu),
 * - `no_storage` — prevádzková rampa je, ale žiadny sklad kategórie nákladu nie je z nej po ceste dosiahnuteľný.
 */
import type { CargoCategory } from '../defs/types';
import { StorageModule } from '../modules/storage-module';
import { truckDefFor } from '../trucks/truck-spawner';
import type { World } from '../world/world';
import { distanceBetweenModules } from './module-access';

export type ExportReadiness = 'ready' | 'no_ramp' | 'ramp_inoperative' | 'no_storage';

/** Pripravenosť pozemnej strany pre export kategórie `category` (viď hlavička súboru). */
export function exportLandsideReadiness(world: World, category: CargoCategory): ExportReadiness {
  const ramps = world.landsideModules.ramps.filter((ramp) => ramp.category === category);
  if (ramps.length === 0 || truckDefFor(world.defs, category) === undefined) return 'no_ramp';
  const operational = ramps.filter((ramp) => world.isRampOperational(ramp));
  if (operational.length === 0) return 'ramp_inoperative';
  for (const module of world.modules.values()) {
    if (!(module instanceof StorageModule) || module.category !== category) continue;
    if (operational.some((ramp) => distanceBetweenModules(world, ramp, module) !== Infinity)) return 'ready';
  }
  return 'no_storage';
}
