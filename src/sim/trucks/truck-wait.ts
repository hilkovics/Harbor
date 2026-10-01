/**
 * Odpočty kamióna v stavoch s čakaním (ARCHITECTURE §7.5; ADR-024, ADR-029; T06-07): jediný zdroj pravidiel, koľko
 * tickov kamión čaká — používa ich krok 8 (`LandsideSystem`) aj obnova save, ktorá väčší odpočet zarovná na hranicu
 * stavu podľa aktuálnych defov (`truckWaitLimit`; T06-08b — save spred zmeny balansu sa načíta).
 *
 * - `waiting`: po príchode pobyt stojiska `waitingStayTicks` = max(`MIN_STAY_TICKS`, `internalTicks` stojiska, inak
 *   `logistics.defaultInternalTicks`); pri obsadenom docku nový pokus o `MIN_STAY_TICKS`; bez okruhu o
 *   `repathIntervalTicks` → hranica max(pobyt, `repathIntervalTicks`).
 * - `loading`: `loadTicksPerUnit` rampy na jednotku.
 * - `no_path`: nový pokus o `repathIntervalTicks`.
 */
import type { EntityId } from '../core/entity-id';
import type { LogisticsDef } from '../defs/types';
import { LoadingRamp } from '../modules/loading-ramp';
import type { Module } from '../modules/module';
import { WaitingArea } from '../modules/waiting-area';
import type { Truck } from './truck';
import type { TruckState } from './truck-fsm';

/**
 * Najkratší pobyt v stave s odpočtom: stav trvá aspoň tick príchodu (nultý tick) a skončí najskôr v ďalšom ticku —
 * `waitTicks ≥ 1` je invariant stavov s čakaním (krok 12). Pri `internalTicks` stojiska 0 kamión odíde hneď v ďalšom
 * ticku. Štrukturálna hranica konvencie odpočtu (ADR-016), nie balans.
 */
export const MIN_STAY_TICKS = 1;

/** Pobyt kamióna v stojisku po príchode: max(`MIN_STAY_TICKS`, `internalTicks` stojiska, inak predvolený). */
export function waitingStayTicks(area: WaitingArea, logistics: Readonly<LogisticsDef>): number {
  return Math.max(MIN_STAY_TICKS, area.internalTicks ?? logistics.defaultInternalTicks);
}

/** Čo hranica odpočtu zo sveta číta (`World` to spĺňa). */
export interface TruckWaitWorld {
  readonly modules: ReadonlyMap<EntityId, Module>;
  readonly defs: { readonly logistics: Readonly<LogisticsDef> };
}

type WaitLimit = (world: TruckWaitWorld, truck: Truck) => number;

/** Hranica odpočtu podľa stavu (tabuľka, nie switch); stav bez čakania → 0 (`waitTicks` musí byť 0, krok 12). */
const WAIT_LIMITS: { readonly [S in TruckState]: WaitLimit } = Object.freeze({
  to_gate: () => 0,
  gate_queue: () => 0,
  to_bay: () => 0,
  waiting: (world: TruckWaitWorld, truck: Truck) => {
    const area = world.modules.get(truck.waitingAreaId);
    const stay = area instanceof WaitingArea ? waitingStayTicks(area, world.defs.logistics) : MIN_STAY_TICKS;
    return Math.max(stay, world.defs.logistics.repathIntervalTicks);
  },
  to_dock: () => 0,
  loading: (world: TruckWaitWorld, truck: Truck) => {
    const ramp = world.modules.get(truck.rampId);
    return ramp instanceof LoadingRamp ? ramp.params.loadTicksPerUnit : 0;
  },
  // Vykládka exportu ide po jednotkách rovnakým tempom ako nakládka (`loadTicksPerUnit` rampy, ADR-032).
  unloading: (world: TruckWaitWorld, truck: Truck) => {
    const ramp = world.modules.get(truck.rampId);
    return ramp instanceof LoadingRamp ? ramp.params.loadTicksPerUnit : 0;
  },
  to_gate_out: () => 0,
  gate_queue_out: () => 0,
  to_portal: () => 0,
  exited: () => 0,
  no_path: (world: TruckWaitWorld) => world.defs.logistics.repathIntervalTicks,
});

/** Najväčší odpočet, aký krok 8 kamiónu v jeho stave nastaví (viď hlavička); chýbajúci modul väzby → 0. */
export function truckWaitLimit(world: TruckWaitWorld, truck: Truck): number {
  return WAIT_LIMITS[truck.state](world, truck);
}
