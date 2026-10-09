/**
 * Pripravenosť pozemnej strany prístavu pre export (F6a, ADR-032; `AcceptContract` pri export / roundtrip bookingu, vzor `berthReadiness` z ADR-031; od R4 ADR-041) — export prichádza kamiónmi,
 * prechádza vstupným pruhom brány a na TP bloku ho obslúži stroj bloku alebo vozidlo; bez ktoréhokoľvek článku reťazca by kamióny nevznikli (alebo by jednotky nemali kam ísť) a booking by skončil
 * penalizáciou. Posudzuje sa **stav v čase prijatia**, obsadenosť (TP, státia, kapacita skladu) nie. Svet nemení, `Rng` nespotrebuje.
 *
 * Verdikt (najskôr chýbajúci článok):
 * - `no_gate` — žiadny platný vstupný pruh brány s výstupným pruhom a portálom (`LandsideNetwork`), alebo kamión pre kategóriu v `trucks.json`,
 * - `no_storage` — brána je, ale žiadny sklad kategórie nákladu nie je z nej po ceste dosiahnuteľný (vrátane TP s cestou von).
 *
 * Od F6c (ADR-034, dodatok T6C-03) majú pripravenosť aj nové druhy kontraktu — žiadny z nich nepotrebuje bránu:
 * - **repositioning prázdnych** (`repositioningReadiness`) — prístav má depo prázdnych kategórie nákladu s cestou ku kotvisku so žeriavom (odchýlka 4 ADR-034:
 *   dostatok dostupných prázdnych sa pri prijatí neposudzuje; booking sa splní podľa toho, koľko ich je v čase nakládky); bez depa `no_storage`,
 * - **prekládka** (`transhipReadiness`) — prístav má sklad kategórie nákladu, ktorý prijme prekládku (jednotky z lode A čakajú v sklade na loď B); bez
 *   neho `no_storage`.
 */
import type { CargoCategory } from '../defs/types';
import { BerthModule } from '../modules/berth-module';
import { EmptyDepot } from '../modules/empty-depot';
import { StorageModule } from '../modules/storage-module';
import { truckDefFor } from '../trucks/truck-spawner';
import type { World } from '../world/world';
import { berthHasCraneFor } from './load-access';
import { distanceBetweenModules } from './module-access';

export type ExportReadiness = 'ready' | 'no_gate' | 'no_storage';

/** Pripravenosť pozemnej strany pre export kategórie `category` (viď hlavička súboru). */
export function exportLandsideReadiness(world: World, category: CargoCategory): ExportReadiness {
  const lanes = world.landside.inLanes;
  if (lanes.length === 0 || world.landside.outLanes.length === 0 || truckDefFor(world.defs, category) === undefined) return 'no_gate';
  for (const module of world.modules.values()) {
    if (!(module instanceof StorageModule) || module.category !== category || !module.acceptsDirection('export')) continue;
    if (lanes.some((lane) => distanceBetweenModules(world, lane, module) !== Infinity)) return 'ready';
  }
  return 'no_storage';
}

/**
 * Pripravenosť prístavu pre repositioning prázdnych kategórie `category`: depo prázdnych s cestou aspoň k jednému kotvisku so žeriavom tej kategórie
 * (T6C-07b, M2: odrezané depo by nakládku nikdy nedodalo); inak `no_storage` (depo chýba alebo je nedosiahnuteľné).
 */
export function repositioningReadiness(world: World, category: CargoCategory): ExportReadiness {
  for (const module of world.modules.values()) {
    if (!(module instanceof EmptyDepot) || module.category !== category) continue;
    for (const berth of world.modules.values()) {
      if (berth instanceof BerthModule && berthHasCraneFor(world, berth, { cargoCategory: category }) && distanceBetweenModules(world, module, berth) !== Infinity) return 'ready';
    }
  }
  return 'no_storage';
}

/** Pripravenosť prístavu pre prekládku kategórie `category`: sklad, ktorý prijme jej smer (`no_storage`, keď chýba). */
export function transhipReadiness(world: World, category: CargoCategory): ExportReadiness {
  for (const module of world.modules.values()) {
    if (module instanceof StorageModule && module.category === category && module.acceptsDirection('tranship')) return 'ready';
  }
  return 'no_storage';
}
