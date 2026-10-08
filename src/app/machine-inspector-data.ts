/**
 * Dáta pre `MachineInspector` / `BlockInspector` / `CraneInspector` (TR3-05) zo živého sveta: čisté funkcie nad `bridge.world`, nič nemenia.
 * Stav stroja sa mapuje na stavy UI (`working` = ktorákoľvek fáza cyklu, `waiting` = nečinný s frontou vozidiel, inak `idle`).
 */
import { SetBlockPriorityCommand, SetCraneGangCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { CraneModule, RtgBlock } from '@sim/modules';
import type { GangMode, MachineInspectorData, RtgPriority } from '@ui/machine-inspector';
import type { SimBridge } from './sim-bridge';

export interface BlockPanelData {
  readonly blockId: number;
  readonly priority: RtgPriority;
  readonly machine: MachineInspectorData | null;
}

export interface CranePanelData {
  readonly craneId: number;
  readonly gang: GangMode;
  readonly tractorsPerSts: number;
}

/** Panel RTG bloku (priorita + stroj bloku) alebo `null`, ak modul nie je RTG blok. */
export function blockPanelData(bridge: SimBridge, moduleId: number): BlockPanelData | null {
  const { world } = bridge;
  const block = world.modules.get(moduleId as EntityId);
  if (!(block instanceof RtgBlock)) return null;
  const machine = world.machineOfBlock(block.id);
  if (machine === undefined) return { blockId: block.id, priority: 'ship', machine: null };
  const unitId = world.cargo.countAt('in_handler', machine.id) > 0 ? world.cargo.unitAtIndex('in_handler', machine.id, 0) : undefined;
  const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
  const { ticksPerHour, tick } = world.clock;
  const hours = tick / ticksPerHour;
  const state = machine.state !== 'idle' ? 'working' : machine.queue.length > 0 ? 'waiting' : 'idle';
  return {
    blockId: block.id,
    priority: machine.firstPriority ?? 'ship',
    machine: {
      id: machine.id,
      defId: machine.defId,
      blockId: block.id,
      state,
      cargo: unit === undefined ? null : { sizeFt: unit.sizeFt as 20 | 40, containerType: unit.containerType },
      queueLength: machine.queue.length,
      movesPerHour: hours > 0 ? Math.round(machine.moves / hours) : 0,
    },
  };
}

/** Panel gangu STS alebo `null`, ak modul nie je žeriav. */
export function cranePanelData(bridge: SimBridge, moduleId: number): CranePanelData | null {
  const crane = bridge.world.modules.get(moduleId as EntityId);
  if (!(crane instanceof CraneModule)) return null;
  return { craneId: crane.id, gang: crane.gangMode ?? 'gang', tractorsPerSts: crane.tractorsPerSts ?? bridge.world.defs.equipment.tractors.defaultPerSts };
}

export function sameBlockPanel(a: BlockPanelData | null, b: BlockPanelData | null): boolean {
  if (a === null || b === null) return a === b;
  const ma = a.machine;
  const mb = b.machine;
  const sameMachine =
    ma === null || mb === null
      ? ma === mb
      : ma.id === mb.id && ma.state === mb.state && ma.queueLength === mb.queueLength && ma.movesPerHour === mb.movesPerHour && ma.cargo?.sizeFt === mb.cargo?.sizeFt && ma.cargo?.containerType === mb.cargo?.containerType;
  return a.blockId === b.blockId && a.priority === b.priority && sameMachine;
}

export function sameCranePanel(a: CranePanelData | null, b: CranePanelData | null): boolean {
  if (a === null || b === null) return a === b;
  return a.craneId === b.craneId && a.gang === b.gang && a.tractorsPerSts === b.tractorsPerSts;
}

/** `SetBlockPriority` cez validate → dispatch. */
export function setBlockPriority(bridge: SimBridge, blockId: number, order: RtgPriority): void {
  const command = new SetBlockPriorityCommand(blockId, order);
  if (bridge.validate(command).ok) bridge.dispatch(command);
}

/** `SetCraneGang` cez validate → dispatch. */
export function setCraneGang(bridge: SimBridge, craneId: number, mode: GangMode, tractorsPerSts: number): void {
  const command = new SetCraneGangCommand(craneId, mode, tractorsPerSts);
  if (bridge.validate(command).ok) bridge.dispatch(command);
}
