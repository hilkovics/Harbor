/**
 * Nákup a predaj vozidiel z UI (T03-10): výber depa pre nákup z BuildBar a odoslanie `BuyVehicle` / `SellVehicle`
 * po úspešnej validácii (CLAUDE.md pravidlo 5). Čisté funkcie nad `World` a `SimBridge`, testujú sa v Node.
 *
 * Nákup z BuildBar (položka `straddle_carrier`, `action: 'buy'`) nemá ghost: vozidlo ide do **pripojeného depa s voľným
 * státím s najmenším id** (`vehicleBuyTarget`). Bez takého depa je položka zamknutá s dôvodom — „Postav a pripoj depo
 * vozidiel“ (depo chýba alebo nie je pripojené k ceste), resp. „Depá sú plné“ (pripojené depá nemajú voľné státie).
 */
import { BuyVehicleCommand, SellVehicleCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { VehicleDepot } from '@sim/modules';
import type { World } from '@sim/world';
import type { SimBridge } from './sim-bridge';

/** Dôvod zámku, keď vo svete nie je pripojené depo vozidiel. */
export const NO_DEPOT_REASON = 'Postav a pripoj depo vozidiel';
/** Dôvod zámku, keď sú všetky pripojené depá plné. */
export const DEPOTS_FULL_REASON = 'Depá sú plné';

/** Depo, do ktorého sa nakupuje z BuildBar; `depotId === null` = nákup nie je možný a `reason` hovorí prečo. */
export interface VehicleBuyTarget {
  readonly depotId: EntityId | null;
  /** Slovenský dôvod, prečo sa nedá kúpiť (len pri `depotId === null`). */
  readonly reason: string | null;
}

/** Bez depa: východisko pre čisté funkcie, ktoré depo nepoznajú (testy, demo). */
export const NO_BUY_TARGET: VehicleBuyTarget = Object.freeze({ depotId: null, reason: NO_DEPOT_REASON });

/** Rovnaký cieľ nákupu (`useSimSnapshot` vďaka tomu neprekresľuje BuildBar, kým sa depo nezmení). */
export function sameBuyTarget(a: VehicleBuyTarget, b: VehicleBuyTarget): boolean {
  return a.depotId === b.depotId && a.reason === b.reason;
}

/** Cieľ nákupu vozidla: pripojené depo s voľným státím s najmenším id, inak dôvod zámku. */
export function vehicleBuyTarget(world: World): VehicleBuyTarget {
  let anyConnected = false;
  let best: VehicleDepot | null = null;
  for (const module of world.modules.values()) {
    if (!(module instanceof VehicleDepot) || !world.isConnected(module)) continue;
    anyConnected = true;
    if (module.freeStalls > 0 && (best === null || module.id < best.id)) best = module;
  }
  if (best !== null) return { depotId: best.id, reason: null };
  return { depotId: null, reason: anyConnected ? DEPOTS_FULL_REASON : NO_DEPOT_REASON };
}

/** Časť `SimBridge`, ktorú nákup a predaj používajú. */
export type PurchaseBridge = Pick<SimBridge, 'world' | 'validate' | 'dispatch'>;

/** Odošle `BuyVehicle` do depa `depotId`, ak prejde validáciou. @returns `true`, ak sa príkaz odoslal. */
export function buyVehicleInDepot(bridge: PurchaseBridge, vehicleDefId: string, depotId: number): boolean {
  const command = new BuyVehicleCommand({ vehicleDefId, depotId });
  if (!bridge.validate(command).ok) return false;
  bridge.dispatch(command);
  return true;
}

/** Nákup z BuildBar: `BuyVehicle` do `vehicleBuyTarget` (živý stav v okamihu kliku). @returns `true`, ak sa príkaz odoslal. */
export function buyVehicleFromBuildBar(bridge: PurchaseBridge, vehicleDefId: string): boolean {
  const { depotId } = vehicleBuyTarget(bridge.world);
  return depotId !== null && buyVehicleInDepot(bridge, vehicleDefId, depotId);
}

/** Odošle `SellVehicle`, ak prejde validáciou (vozidlo musí byť nečinné a bez nákladu). @returns `true`, ak sa príkaz odoslal. */
export function sellVehicle(bridge: PurchaseBridge, vehicleId: number): boolean {
  const command = new SellVehicleCommand(vehicleId);
  if (!bridge.validate(command).ok) return false;
  bridge.dispatch(command);
  return true;
}
