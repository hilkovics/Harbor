/**
 * Dáta pre `ModuleInspector` (`@ui/module-inspector` je čisto prezentačný) zo živého sveta (T02-10).
 *
 * - Kotvisko: apron (obsadené / rezervované / kapacita), zakotvená loď (`dockedShipId` → trieda, náklad na palube z
 *   ledgera `cargo.countAt('on_ship', id)`, jednotka z `cargoTypes`).
 * - Žeriav: stav (`crane.state`, len čítanie) a vyťaženosť = busy / (busy + idle + blocked); blokovaný podiel
 *   analogicky. Bez odpracovaných tickov sú oba podiely 0.
 * - Sklad (F3): uložené / rezervované / kapacita z modulu, kumulatívne prijaté a vydané (`unitsIn`/`unitsOut`), jednotka
 *   počtu z typu nákladu kategórie skladu (`TEU`).
 * - Depo (F3): vozidlá depa (stav `idle` = nečinné, `no_path` = bez cesty, ostatné = pracuje; refundácia z
 *   `validate(SellVehicle)`), kapacita státí a nákup: `canBuy` = `validate(BuyVehicle)` prešlo, inak `buyBlockedReason`
 *   z `REASON_TEXT`. Kupuje sa vozidlo `depotVehicleDef` (prvý def vozidla bez technológie).
 * - Brána (F4): fronta, `processTicks` z defu a priepustnosť za hodinu = `ticksPerHour / processTicks` (`time.json`),
 *   nepripojená brána nepustí nikoho → 0. Stojisko (F4): počet stojísk, obsadené (kamión stojí) a rezervované (na ceste).
 *   Rampa (F4): docky (`staged` z ledgera / `stagingPerDock`, `truck` = kamión stojí v docku; kamióny prídu v T04-08 B,
 *   dovtedy `false`), prevádzkovosť (`World.isRampOperational`) a text dôvodu neprevádzkovosti (`rampInoperativeText`).
 * - Moduly s cestným konektorom nesú `connected` (badge „Nepripojené“).
 * - Odstránenie: refundácia a odstrániteľnosť z `validate(RemoveModule)` — `costCents` záporné = refundácia, dôvody
 *   z `REASON_TEXT` (kotvisko so žeriavom `has_cranes`, žeriav pri kotvisku s loďou `ship_docked`, pracujúci `busy` …).
 *
 * Čistá funkcia nad `bridge.world` a `bridge.validate` — nič nemení, testuje sa v Node.
 */
import { BuyVehicleCommand, RemoveModuleCommand, SellVehicleCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { DefRegistry, VehicleDef } from '@sim/defs';
import { BerthModule, CraneModule, LoadingRamp, StorageModule, TruckGate, VehicleDepot, WaitingArea, type Module } from '@sim/modules';
import type { VehicleState } from '@sim/vehicles';
import {
  craneStateLabel,
  craneStateOk,
  rampInoperativeText,
  type DepotVehicleData,
  type DepotVehicleState,
  type ModuleInspectorData,
  type RampDockData,
} from '@ui/module-inspector';
import { REASON_TEXT } from './build-feedback';
import { hasRoadConnector } from './entities-vm';
import type { SimBridge } from './sim-bridge';

/** Časť `SimBridge`, ktorú inšpektor číta. */
export type InspectorBridge = Pick<SimBridge, 'world' | 'validate'>;

/** Stav kotviska v hlavičke inšpektora (badge). */
export const BERTH_STATE_DOCKED = 'Loď kotví';
export const BERTH_STATE_FREE = 'Voľné';

/** Stav modulu bez vlastného obsahu (F2 ho nepoužíva: budúce druhy modulov si dodajú vlastný popis). */
export const MODULE_STATE_ACTIVE = 'V prevádzke';

/** Stav FSM vozidla → stav v zozname depa (tabuľka, nie switch): pracovné stavy sú pre hráča jedno „Pracuje“. */
export const DEPOT_VEHICLE_STATE: Readonly<Record<VehicleState, DepotVehicleState>> = Object.freeze({
  idle: 'idle',
  to_pickup: 'busy',
  loading: 'busy',
  to_dropoff: 'busy',
  unloading: 'busy',
  no_path: 'no_path',
});

/**
 * Vozidlo, ktoré ponúka nákup v depe: prvý def z `vehicles.json` bez technológie (`techRequired` sa vyhodnocuje až vo
 * F8), inak `undefined` (nákup nemá čo ponúknuť).
 */
export function depotVehicleDef(defs: DefRegistry): Readonly<VehicleDef> | undefined {
  return defs.vehicles.items.find((def) => def.techRequired === undefined);
}

/** Podiel `part / total` v percentách; `total <= 0` → 0. */
function percentOf(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

function berthFields(bridge: InspectorBridge, berth: BerthModule): Pick<ModuleInspectorData, 'stateLabel' | 'ok' | 'apron' | 'dockedShip'> {
  const { world } = bridge;
  const { apron } = berth;
  const ship = berth.dockedShipId === null ? undefined : world.ships.get(berth.dockedShipId);
  return {
    stateLabel: ship === undefined ? BERTH_STATE_FREE : BERTH_STATE_DOCKED,
    ok: true,
    apron: { used: apron.usedCount, reserved: apron.reservedCount, capacity: apron.capacity },
    dockedShip:
      ship === undefined
        ? null
        : {
            classLabel: ship.def.displayName,
            unitsOnBoard: world.cargo.countAt('on_ship', ship.id),
            capacityUnits: ship.def.capacityUnits,
            unitLabel: world.defs.cargoTypes.get(ship.cargoTypeId).unitName,
          },
  };
}

function craneFields(crane: CraneModule): Pick<ModuleInspectorData, 'stateLabel' | 'ok' | 'crane'> {
  const worked = crane.busyTicks + crane.idleTicks + crane.blockedTicks;
  const { state } = crane;
  return {
    stateLabel: craneStateLabel(state),
    ok: craneStateOk(state),
    crane: { state, utilizationPct: percentOf(crane.busyTicks, worked), blockedPct: percentOf(crane.blockedTicks, worked) },
  };
}

function storageFields(bridge: InspectorBridge, storage: StorageModule): Pick<ModuleInspectorData, 'stateLabel' | 'ok' | 'storage'> {
  const unit = bridge.world.defs.cargoTypes.items.find((type) => type.category === storage.category);
  return {
    stateLabel: MODULE_STATE_ACTIVE,
    ok: true,
    storage: {
      stored: storage.storedCount,
      reserved: storage.reservedCount,
      capacity: storage.capacity,
      unitsIn: storage.unitsIn,
      unitsOut: storage.unitsOut,
      ...(unit === undefined ? {} : { unitLabel: unit.unitName }),
    },
  };
}

/** Riadok vozidla v zozname depa; refundácia z `validate(SellVehicle)` (záporná cena = príjem). */
function depotVehicleRow(bridge: InspectorBridge, vehicleId: EntityId): DepotVehicleData | null {
  const vehicle = bridge.world.vehicles.get(vehicleId);
  if (vehicle === undefined) return null;
  const sale = bridge.validate(new SellVehicleCommand(vehicle.id));
  return {
    id: vehicle.id,
    label: vehicle.def.displayName,
    state: DEPOT_VEHICLE_STATE[vehicle.state],
    refundCents: sale.costCents < 0 ? 0 - sale.costCents : 0,
  };
}

function depotFields(bridge: InspectorBridge, depot: VehicleDepot): Pick<ModuleInspectorData, 'stateLabel' | 'ok' | 'depot'> {
  const vehicles: DepotVehicleData[] = [];
  for (const vehicleId of depot.vehicleIds) {
    const row = depotVehicleRow(bridge, vehicleId);
    if (row !== null) vehicles.push(row);
  }
  const offer = depotVehicleDef(bridge.world.defs);
  // Bez ponuky (žiadny def vozidla) nie je čo kúpiť: rovnaký dôvod ako pri neznámom defe v `BuyVehicle`.
  const purchase = offer === undefined ? null : bridge.validate(new BuyVehicleCommand({ vehicleDefId: offer.id, depotId: depot.id }));
  const blocked = purchase === null ? REASON_TEXT['unknown_vehicle_def'] : purchase.reasons.map((reason) => REASON_TEXT[reason]).join(' · ');
  return {
    stateLabel: MODULE_STATE_ACTIVE,
    ok: true,
    depot: {
      vehicles,
      capacity: depot.capacity,
      canBuy: purchase?.ok === true,
      ...(purchase?.ok === true ? {} : { buyBlockedReason: blocked }),
      ...(offer === undefined ? {} : { buyPriceCents: offer.purchaseCents }),
    },
  };
}

/** Brána: fronta a priepustnosť za herný čas jednej hodiny; nepripojená brána → 0 (nepustí nikoho). */
function gateFields(bridge: InspectorBridge, gate: TruckGate): Pick<ModuleInspectorData, 'stateLabel' | 'ok' | 'gate'> {
  const { world } = bridge;
  const { processTicks } = gate.params;
  const throughputPerHour = world.isConnected(gate) ? world.clock.ticksPerHour / processTicks : 0;
  return { stateLabel: MODULE_STATE_ACTIVE, ok: true, gate: { queueLength: gate.queueLength, throughputPerHour, processTicks } };
}

function waitingAreaFields(area: WaitingArea): Pick<ModuleInspectorData, 'stateLabel' | 'ok' | 'waitingArea'> {
  return { stateLabel: MODULE_STATE_ACTIVE, ok: true, waitingArea: { bays: area.bays, occupied: area.occupiedBays, reserved: area.reservedBays } };
}

/** Rampa: docky so staging sloty; neprevádzková rampa nesie text dôvodu (bez známeho dôvodu ho UI nahradí všeobecným). */
function rampFields(bridge: InspectorBridge, ramp: LoadingRamp): Pick<ModuleInspectorData, 'stateLabel' | 'ok' | 'ramp'> {
  const status = bridge.world.rampStatus(ramp);
  const docks: RampDockData[] = [];
  // Kamión v docku: `Truck` vzniká v T04-04 (časť B tejto karty ho doplní); dovtedy nikto nestojí.
  for (let dock = 0; dock < ramp.docks; dock++) docks.push({ staged: ramp.stagedAt(dock), capacity: ramp.stagingPerDock, truck: false });
  const reason = rampInoperativeText(status.reason);
  return {
    stateLabel: MODULE_STATE_ACTIVE,
    ok: true,
    ramp: { docks, operational: status.operational, ...(reason === undefined ? {} : { inoperativeReason: reason }) },
  };
}

/** Polia závislé od druhu modulu (badge stavu + sekcie kotviska / žeriavu / skladu / depa / brány / stojiska / rampy). */
function kindFields(bridge: InspectorBridge, module: Module): Pick<ModuleInspectorData, 'stateLabel' | 'ok'> & Partial<ModuleInspectorData> {
  if (module instanceof BerthModule) return berthFields(bridge, module);
  if (module instanceof CraneModule) return craneFields(module);
  if (module instanceof StorageModule) return storageFields(bridge, module);
  if (module instanceof VehicleDepot) return depotFields(bridge, module);
  if (module instanceof TruckGate) return gateFields(bridge, module);
  if (module instanceof WaitingArea) return waitingAreaFields(module);
  if (module instanceof LoadingRamp) return rampFields(bridge, module);
  return { stateLabel: MODULE_STATE_ACTIVE, ok: true };
}

/**
 * Dáta inšpektora pre modul `moduleId`, alebo `null`, ak modul vo svete nie je (zanikol — panel sa skryje).
 * `removeBlockedReason` je slovenský text všetkých dôvodov oddelených ` · `.
 */
export function inspectorData(bridge: InspectorBridge, moduleId: EntityId): ModuleInspectorData | null {
  const module = bridge.world.modules.get(moduleId);
  if (module === undefined) return null;
  const removal = bridge.validate(new RemoveModuleCommand(module.id));
  const data: ModuleInspectorData = {
    id: module.id,
    defId: module.def.id,
    displayName: module.def.displayName,
    kind: module.kind,
    footprint: { w: module.size.w, h: module.size.h },
    ...kindFields(bridge, module),
    ...(hasRoadConnector(module) ? { connected: bridge.world.isConnected(module) } : {}),
    refundCents: removal.costCents < 0 ? 0 - removal.costCents : 0,
    removable: removal.ok,
    ...(removal.ok ? {} : { removeBlockedReason: removal.reasons.map((reason) => REASON_TEXT[reason]).join(' · ') }),
  };
  return data;
}

/** Rovnaké dáta inšpektora (štrukturálne) — `useSimSnapshot` vďaka tomu neprekresľuje panel, kým sa nič nezmenilo. */
export function sameInspectorData(previous: ModuleInspectorData | null, next: ModuleInspectorData | null): boolean {
  if (previous === next) return true;
  if (previous === null || next === null) return false;
  return JSON.stringify(previous) === JSON.stringify(next);
}
