/**
 * Zdroj jobu a odovzdávanie pod hákom (F6a, ADR-033). Job vykládky pod hákom (`in_crane → in_storage`) vzniká vopred — pre
 * ďalšie jednotky importu, kým žeriav ešte vykladá, aby dispatcher poslal vozidlá k háku a žeriav nečakal — jednotka je vtedy
 * ešte na lodi na kotvisku žeriava. „Jednotka leží na zdroji jobu" teda pre zdroj `in_crane` znamená: je v žeriave `from.craneId`,
 * alebo je na lodi, ktorá stojí pri kotvisku tohto žeriava (žeriav si ju vyberie za cieľ cyklu, `CraneModule.targetUnitId`).
 * Pre ostatné zdroje je to presná zhoda polohy (`isSameLocation`).
 *
 * `isHookWait` rozhoduje, či vozidlo vo `loading` / `unloading` čaká pod hákom na odovzdanie od / pre žeriav (koncový bod jobu je
 * `in_crane`), alebo manipuluje s modulom po tickoch (`VehicleSystem`).
 */
import { isSameLocation } from '../cargo/cargo-location';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import { BerthModule } from '../modules/berth-module';
import { CraneModule } from '../modules/crane-module';
import type { Module } from '../modules/module';
import type { TransportJob } from './transport-job';

/** Čítanie modulov sveta (`World.modules` ho spĺňa). */
export interface ModuleLookup {
  readonly modules: ReadonlyMap<EntityId, Module>;
}

/** Leží jednotka na zdroji jobu (viď hlavička súboru)? */
export function unitAtJobSource(world: ModuleLookup, job: TransportJob, unit: CargoUnit): boolean {
  if (isSameLocation(unit.location, job.from)) return true;
  if (job.from.kind !== 'in_crane' || unit.location.kind !== 'on_ship') return false;
  const crane = world.modules.get(job.from.craneId);
  if (!(crane instanceof CraneModule)) return false;
  const berth = world.modules.get(crane.berthId);
  return berth instanceof BerthModule && berth.dockedShipId === unit.location.shipId;
}

/** Čaká vozidlo vo `loading` (zdroj jobu je hák) pod hákom na odovzdanie od žeriava? */
export function isHookPickup(job: TransportJob): boolean {
  return job.from.kind === 'in_crane';
}

/** Čaká vozidlo v `unloading` (cieľ jobu je hák) pod hákom, kým ho žeriav zdvihne? */
export function isHookDropoff(job: TransportJob): boolean {
  return job.to.kind === 'in_crane';
}

/** Id žeriava háku jobu (zdroj alebo cieľ `in_crane`), inak `undefined`. */
export function hookCraneOf(job: TransportJob): EntityId | undefined {
  if (job.from.kind === 'in_crane') return job.from.craneId;
  if (job.to.kind === 'in_crane') return job.to.craneId;
  return undefined;
}
