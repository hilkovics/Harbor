/**
 * Dáta pre `ReeferBlockInspector` (R5, TR5-05) z živého sveta: zásuvky bloku (celkom = stohy so zásuvkou × výška, obsadené = zapojené reefery), reefery s alarmom
 * (odpočet do reakcie technika), reefery bez napájania (odpočet do reklamácie) a cena elektriny za hernú hodinu. Čisté funkcie, nič nemenia.
 * Odpočty v minútach herného času (`ticksPerHour`); teplota sa nezobrazuje (sim ju nemodeluje).
 */
import type { EntityId } from '@sim/core';
import { YardBlock } from '@sim/modules';
import type { World } from '@sim/world';
import type { ReeferAlarmRow, ReeferBlockInspectorData, ReeferUnpluggedRow } from '@ui/reefer-inspector';

/** Je modul blok so zásuvkami (`reefer_block_8`)? */
export function isReeferBlock(world: Pick<World, 'modules'>, moduleId: number): boolean {
  const module = world.modules.get(moduleId as EntityId);
  return module instanceof YardBlock && module.hasSockets;
}

export function reeferInspectorData(world: World, moduleId: number): ReeferBlockInspectorData | null {
  const block = world.modules.get(moduleId as EntityId);
  if (!(block instanceof YardBlock) || !block.hasSockets) return null;
  const { tick, ticksPerHour } = world.clock;
  const maxUnpluggedTicks = world.defs.logistics.reefer.maxUnpluggedHours * ticksPerHour;
  const minutes = (ticks: number): number => Math.max(0, Math.ceil((ticks / ticksPerHour) * 60));
  const alarms: ReeferAlarmRow[] = [];
  const unplugged: ReeferUnpluggedRow[] = [];
  let used = 0;
  const ids: EntityId[] = [];
  for (const { bay, row } of block.plugCells()) {
    ids.length = 0;
    block.columnUnits(bay, row, ids);
    for (const id of ids) {
      const state = world.cargo.get(id)?.reefer;
      if (state === null || state === undefined) continue;
      const label = `Reefer #${String(id)}`;
      if (state.plugged) used += 1;
      if (state.alarmUntilTick !== null) alarms.push({ unitId: id, label, minutesToRespond: minutes(state.alarmUntilTick - tick) });
      if (!state.plugged && state.unpluggedSinceTick !== null) unplugged.push({ unitId: id, label, minutesToClaim: minutes(maxUnpluggedTicks - (tick - state.unpluggedSinceTick)) });
    }
  }
  return {
    id: moduleId,
    label: block.label,
    plugsTotal: block.plugCells().length * block.geometry.maxTier,
    plugsUsed: used,
    alarms,
    unplugged,
    powerCostCentsPerHour: used * world.defs.economy.reeferPowerCentsPerHour,
  };
}

/** Zhoda dvoch dát inšpektora (prekreslenie len pri zmene). */
export function sameReeferInspector(a: ReeferBlockInspectorData | null, b: ReeferBlockInspectorData | null): boolean {
  return a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));
}
