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
 *
 * Od F6c (ADR-034, dodatok T6C-03) majú pripravenosť aj nové druhy kontraktu — žiadny z nich nepotrebuje bránu ani rampu:
 * - **repositioning prázdnych** (`repositioningReadiness`) — prístav má depo prázdnych kategórie nákladu (odchýlka 4 ADR-034: dostatok dostupných
 *   prázdnych sa pri prijatí neposudzuje; booking sa splní podľa toho, koľko ich je v čase nakládky); bez depa `no_storage`,
 * - **prekládka** (`transhipReadiness`) — prístav má sklad kategórie nákladu, ktorý prijme prekládku (jednotky z lode A čakajú v sklade na loď B); bez
 *   neho `no_storage`.
 */
import type { CargoCategory } from '../defs/types';
import { EmptyDepot } from '../modules/empty-depot';
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
    if (!(module instanceof StorageModule) || module.category !== category || !module.acceptsDirection('export')) continue;
    if (operational.some((ramp) => distanceBetweenModules(world, ramp, module) !== Infinity)) return 'ready';
  }
  return 'no_storage';
}

/** Pripravenosť prístavu pre repositioning prázdnych kategórie `category`: depo prázdnych (`no_storage`, keď chýba). */
export function repositioningReadiness(world: World, category: CargoCategory): ExportReadiness {
  for (const module of world.modules.values()) if (module instanceof EmptyDepot && module.category === category) return 'ready';
  return 'no_storage';
}

/** Pripravenosť prístavu pre prekládku kategórie `category`: sklad, ktorý prijme jej smer (`no_storage`, keď chýba). */
export function transhipReadiness(world: World, category: CargoCategory): ExportReadiness {
  for (const module of world.modules.values()) {
    if (module instanceof StorageModule && module.category === category && module.acceptsDirection('tranship')) return 'ready';
  }
  return 'no_storage';
}
