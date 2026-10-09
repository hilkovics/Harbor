/**
 * Dáta pre `GateLaneInspector`, `PreGateInspector` a `TurnTimeStat` (TR4-05) zo živého sveta: čisté funkcie nad `bridge.world`, nič nemenia.
 * Pruh brány nesie označenie `IN-n` / `OUT-n` (poradie pruhov rovnakého smeru podľa id), priepustnosť = ticky za hodinu / stredný čas obsluhy v režime pruhu.
 * TTT (čas kamióna v termináli) je priemer z počítadiel vnútrozemia (`world.hinterland`), rovnako ako kľúč `truckTurnTimeAvgMin` v `simrun`.
 */
import { SetGateLaneModeCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { PreGateBuffer, TruckGate } from '@sim/modules';
import { hinterlandQueue } from '@sim/world';
import type { GateLaneInspectorData, GateLaneMode, GateLaneStep, PreGateInspectorData } from '@ui/gate-inspector';
import type { SimBridge } from './sim-bridge';

const SECONDS_PER_MINUTE = 60;

/** Panel pre vybraný modul: pruh brány alebo predbránová plocha (nanajvýš jedno) plus TTT. */
export interface GatePanelData {
  readonly moduleId: number;
  readonly lane: GateLaneInspectorData | null;
  readonly preGate: PreGateInspectorData | null;
  /** Priemerný TTT v minútach; `null`, kým neodišiel žiadny kamión. */
  readonly tttMinutes: number | null;
}

/** Priemerný TTT (minúty hernej doby) z počítadiel vnútrozemia; bez odídeného kamióna `null`. */
export function truckTurnMinutes(bridge: SimBridge): number | null {
  const { world } = bridge;
  const { turnTrucks, turnTicksTotal } = world.hinterland;
  if (turnTrucks === 0) return null;
  return (turnTicksTotal / turnTrucks) * world.defs.time.tickGameSeconds / SECONDS_PER_MINUTE;
}

/** Označenie pruhu pre hráča: `IN-1`, `OUT-2` (poradie pruhov rovnakého smeru podľa id). */
function laneLabel(bridge: SimBridge, gate: TruckGate): string {
  let index = 0;
  for (const module of bridge.world.modules.values()) {
    if (!(module instanceof TruckGate) || module.direction !== gate.direction) continue;
    index += 1;
    if (module.id === gate.id) break;
  }
  return `${gate.direction === 'in' ? 'IN' : 'OUT'}-${String(index)}`;
}

function laneData(bridge: SimBridge, gate: TruckGate): GateLaneInspectorData {
  const { world } = bridge;
  const step = gate.currentStep();
  const processTicks = Math.max(1, gate.meanServiceTicks(gate.mode));
  return {
    id: gate.id,
    label: laneLabel(bridge, gate),
    kind: gate.direction,
    mode: gate.mode,
    step: step === null ? null : (step.id as GateLaneStep),
    progress: step === null ? 0 : step.progress,
    queueLength: gate.queueLength,
    trucksProcessed: gate.trucksProcessed,
    trucksPerHour: world.isConnected(gate) ? Math.round((world.clock.ticksPerHour / processTicks) * 10) / 10 : 0,
  };
}

function preGateData(bridge: SimBridge, buffer: PreGateBuffer): PreGateInspectorData {
  const rows: { label: string; slots: readonly [boolean, boolean] }[] = [];
  for (let row = 0; row < buffer.rowCount; row++) {
    const count = buffer.rowTrucks(row).length;
    rows.push({ label: `R${String(row + 1)}`, slots: [count >= 1, count >= 2] });
  }
  return { rows, inlandWaiting: hinterlandQueue(bridge.world).total };
}

/** Panel brány / predbránovej plochy pre `moduleId`, alebo `null`, ak modul nie je ani jedno. */
export function gatePanelData(bridge: SimBridge, moduleId: number): GatePanelData | null {
  const module = bridge.world.modules.get(moduleId as EntityId);
  if (module instanceof TruckGate) return { moduleId, lane: laneData(bridge, module), preGate: null, tttMinutes: truckTurnMinutes(bridge) };
  if (module instanceof PreGateBuffer) return { moduleId, lane: null, preGate: preGateData(bridge, module), tttMinutes: truckTurnMinutes(bridge) };
  return null;
}

/** Štrukturálna zhoda panelov (bez prekreslenia, kým sa nič nezmení). */
export function sameGatePanel(a: GatePanelData | null, b: GatePanelData | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `SetGateLaneMode` cez validate → dispatch. */
export function setGateLaneMode(bridge: SimBridge, laneId: number, mode: GateLaneMode): void {
  const command = new SetGateLaneModeCommand(laneId, mode);
  if (bridge.validate(command).ok) bridge.dispatch(command);
}
