/**
 * Dáta pre `ModuleInspector` (`@ui/module-inspector` je čisto prezentačný) zo živého sveta (T02-10).
 *
 * - Kotvisko: apron (obsadené / rezervované / kapacita), zakotvená loď (`dockedShipId` → trieda, náklad na palube z
 *   ledgera `cargo.countAt('on_ship', id)`, jednotka z `cargoTypes`).
 * - Žeriav: stav (`crane.state`, len čítanie) a vyťaženosť = busy / (busy + idle + blocked); blokovaný podiel
 *   analogicky. Bez odpracovaných tickov sú oba podiely 0.
 * - Odstránenie: refundácia a odstrániteľnosť z `validate(RemoveModule)` — `costCents` záporné = refundácia, dôvody
 *   z `REASON_TEXT` (kotvisko so žeriavom `has_cranes`, žeriav pri kotvisku s loďou `ship_docked`, pracujúci `busy` …).
 *
 * Čistá funkcia nad `bridge.world` a `bridge.validate` — nič nemení, testuje sa v Node.
 */
import { RemoveModuleCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { BerthModule, CraneModule, type Module } from '@sim/modules';
import {
  craneStateLabel,
  craneStateOk,
  type ModuleInspectorData,
} from '@ui/module-inspector';
import { REASON_TEXT } from './build-feedback';
import type { SimBridge } from './sim-bridge';

/** Časť `SimBridge`, ktorú inšpektor číta. */
export type InspectorBridge = Pick<SimBridge, 'world' | 'validate'>;

/** Stav kotviska v hlavičke inšpektora (badge). */
export const BERTH_STATE_DOCKED = 'Loď kotví';
export const BERTH_STATE_FREE = 'Voľné';

/** Stav modulu bez vlastného obsahu (F2 ho nepoužíva: budúce druhy modulov si dodajú vlastný popis). */
export const MODULE_STATE_ACTIVE = 'V prevádzke';

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

/** Polia závislé od druhu modulu (badge stavu + sekcie kotviska / žeriavu). */
function kindFields(bridge: InspectorBridge, module: Module): Pick<ModuleInspectorData, 'stateLabel' | 'ok'> & Partial<ModuleInspectorData> {
  if (module instanceof BerthModule) return berthFields(bridge, module);
  if (module instanceof CraneModule) return craneFields(module);
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
