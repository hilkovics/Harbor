/**
 * Dáta pre `RailTerminalInspector` a `TrainTimetable` (TR6-05) zo živého sveta: čisté funkcie nad `World`, nič nemenia.
 * Cestovný poriadok: vlaky na mape (`world.rail.trains`) + najbližší plánovaný príchod (`rail.nextArrivalTick`, interval z `rail.json`).
 */
import type { EntityId } from '@sim/core';
import { RailTerminal } from '@sim/modules';
import type { World } from '@sim/world';
import { formatClock, formatDayAndClock } from '@ui/format';
import type { MachineStateName } from '@ui/machine-inspector';
import type { RailTerminalInspectorData, RailTrainData } from '@ui/rail-terminal-inspector';
import type { TrainTimetableRow } from '@ui/train-timetable';

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = MINUTES_PER_HOUR * HOURS_PER_DAY;

/** Tick ako `Deň N · HH:MM` herného času. */
export function tickLabel(world: World, tick: number): string {
  const totalMinutes = Math.floor(tick / world.clock.ticksPerMinute);
  const minuteOfDay = totalMinutes % MINUTES_PER_DAY;
  const day = Math.floor(totalMinutes / MINUTES_PER_DAY);
  return formatDayAndClock(day, formatClock(Math.floor(minuteOfDay / MINUTES_PER_HOUR), minuteOfDay % MINUTES_PER_HOUR));
}

function minutesUntil(world: World, tick: number): number {
  return Math.max(0, Math.ceil((tick - world.clock.tick) / world.clock.ticksPerMinute));
}

/** Údaje inšpektora pre vybraný modul, alebo `null`, ak nie je železničný terminál. */
export function railInspectorData(world: World, moduleId: number): RailTerminalInspectorData | null {
  const terminal = world.modules.get(moduleId as EntityId);
  if (!(terminal instanceof RailTerminal)) return null;
  const machine = world.machineOfBlock(terminal.id);
  const rmgState: MachineStateName = machine === undefined ? 'idle' : machine.state !== 'idle' ? 'working' : machine.queue.length > 0 ? 'waiting' : 'idle';
  let train: RailTrainData | undefined;
  for (const candidate of world.rail.trains.values()) {
    if (candidate.terminalId !== terminal.id) continue;
    const teu = new Array<number>(candidate.wagons).fill(0);
    for (const unitId of world.cargo.unitsAt('in_train', candidate.id)) {
      const unit = world.cargo.get(unitId);
      if (unit === undefined || unit.location.kind !== 'in_train') continue;
      const wagon = candidate.wagonOfSlot(unit.location.slot);
      if (wagon < teu.length) teu[wagon] += unit.sizeFt === 40 ? 2 : 1;
    }
    train = {
      trainId: candidate.id,
      label: candidate.label,
      wagons: teu.map((used, wagonId) => ({ wagonId, teu: used, capacityTeu: candidate.def.wagonTeu })),
      departureInMin: candidate.departAtTick === null ? 0 : minutesUntil(world, candidate.departAtTick),
      delayMin: Math.max(0, Math.round((candidate.spawnedTick - candidate.scheduledTick) / world.clock.ticksPerMinute)),
    };
    break;
  }
  return {
    id: terminal.id,
    label: terminal.def.displayName,
    bufferUsedTeu: terminal.usedTeu,
    bufferTotalTeu: terminal.capacityTeu,
    rmgState,
    rmgQueue: machine?.queue.length ?? 0,
    ...(world.hasRailService ? { nextTrainEtaMin: minutesUntil(world, world.rail.nextArrivalTick) } : {}),
    ...(train === undefined ? {} : { currentTrain: train }),
  };
}

/** Riadky cestovného poriadku: vlaky na mape + najbližší plánovaný príchod. */
export function trainTimetableRows(world: World): readonly TrainTimetableRow[] {
  const rows: TrainTimetableRow[] = [];
  for (const train of world.rail.trains.values()) {
    const delayed = train.spawnedTick > train.scheduledTick;
    rows.push({
      trainId: train.id,
      arrivalLabel: tickLabel(world, train.spawnedTick),
      ...(train.departAtTick === null ? {} : { departureLabel: tickLabel(world, train.departAtTick) }),
      wagons: train.wagons,
      status: train.state === 'departing' ? 'departed' : train.state === 'dwelling' ? 'loading' : delayed ? 'delayed' : 'planned',
    });
  }
  if (world.hasRailService) {
    rows.push({ trainId: world.rail.counters.trainsSpawned + 1, arrivalLabel: tickLabel(world, world.rail.nextArrivalTick), wagons: world.rail.def.timetable.wagonsPerTrain, status: 'planned' });
  }
  return rows;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sameRailInspector(a: RailTerminalInspectorData | null, b: RailTerminalInspectorData | null): boolean {
  return sameJson(a, b);
}

export function sameTimetable(a: readonly TrainTimetableRow[], b: readonly TrainTimetableRow[]): boolean {
  return sameJson(a, b);
}
