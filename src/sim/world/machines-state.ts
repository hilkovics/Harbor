/**
 * Stroje blokov v save (`WorldState.machines`, ADR-040 bod 9): tvar (`parseMachines`) a obnova (`restoreMachines`). Stroj sa pri obnove vytvorí z uloženého stavu
 * (fáza, poloha, cyklus, fronta), nie nanovo z bloku — preto sa v save pohybuje len jeho vlastný stav; blok, vozidlá a jednotky v `in_handler` overuje `restoreMachines`
 * a krok 12 (`checkMachines`).
 */
import type { EntityId } from '../core/entity-id';
import type { DefRegistry } from '../defs/def-registry';
import { YARD_PRIORITY_KINDS, type YardPriorityKind } from '../defs/types';
import { MachineError } from '../machines/machine-error';
import { isMachineState } from '../machines/machine-fsm';
import { MACHINE_STATES } from '../machines/machine-state-types';
import type { MachineCycle, MachinePose, MachineQueueEntry } from '../machines/machine-state-types';
import { REACH_STACKER_DEF_ID, ReachStacker } from '../machines/reach-stacker';
import { RTG_DEF_ID, RtgCrane } from '../machines/rtg-crane';
import { SERIALIZED_MACHINE_KEYS, YardMachine, type SerializedMachine } from '../machines/yard-machine';
import { WorldStateError, checkArray, checkInteger, checkKeys, describeValue, pointerSegment } from './state-check';
import type { World } from './world';

const POSE_KEYS: readonly (keyof MachinePose)[] = ['gantry', 'trolley', 'hoist'];
const CYCLE_KEYS: readonly (keyof MachineCycle)[] = ['kind', 'unitId', 'vehicleId', 'truck', 'jobId', 'fromSlot', 'toSlot', 'tpBay'];
const QUEUE_KEYS: readonly (keyof MachineQueueEntry)[] = ['vehicleId', 'createdTick'];

function parsePose(value: unknown, path: string): MachinePose {
  const raw = checkKeys(value, POSE_KEYS, path);
  for (const key of POSE_KEYS) {
    const number = raw[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) throw new WorldStateError(`${path}/${key}`, `musí byť konečné číslo, dostal ${describeValue(number)}`);
  }
  return { gantry: raw['gantry'] as number, trolley: raw['trolley'] as number, hoist: raw['hoist'] as number };
}

function nullableInteger(value: unknown, min: number, path: string): number | null {
  return value === null ? null : checkInteger(value, min, path);
}

function parseCycle(value: unknown, path: string): MachineCycle | null {
  if (value === null) return null;
  const raw = checkKeys(value, CYCLE_KEYS, path);
  const { kind } = raw;
  if (!YardMachine.isCycleKind(kind)) throw new WorldStateError(`${path}/kind`, `druh cyklu musí byť put, take alebo relocate, dostal ${describeValue(kind)}`);
  const vehicleId = nullableInteger(raw['vehicleId'], 1, `${path}/vehicleId`);
  const jobId = nullableInteger(raw['jobId'], 1, `${path}/jobId`);
  // `put` po zdvihu je bez vozidla aj jobu (ťahač je voľný hneď po zdvihu, ADR-040 dodatok TR3-02); `take` vozidlo a job vyžaduje po celý cyklus.
  if ((vehicleId === null) !== (jobId === null) || (kind === 'take' && vehicleId === null) || (kind === 'relocate' && vehicleId !== null)) {
    throw new WorldStateError(`${path}/vehicleId`, kind === 'relocate' ? 'rehandling nemá vozidlo ani job' : `cyklus ${kind} vyžaduje vozidlo aj job (put ich po zdvihu nemá, ale vždy obe naraz)`);
  }
  const fromSlot = nullableInteger(raw['fromSlot'], 0, `${path}/fromSlot`);
  const toSlot = nullableInteger(raw['toSlot'], 0, `${path}/toSlot`);
  if ((kind === 'put') !== (fromSlot === null) || (kind === 'take') !== (toSlot === null)) {
    throw new WorldStateError(`${path}/fromSlot`, `cyklus ${kind}: zdroj a cieľ nezodpovedajú druhu (put zdvíha z vozidla, take odkladá na vozidlo)`);
  }
  const truck = raw['truck'];
  if (typeof truck !== 'boolean') throw new WorldStateError(`${path}/truck`, `musí byť boolean, dostal ${describeValue(truck)}`);
  return { kind, unitId: checkInteger(raw['unitId'], 1, `${path}/unitId`), vehicleId, truck, jobId, fromSlot, toSlot, tpBay: checkInteger(raw['tpBay'], 0, `${path}/tpBay`) };
}

/** Tvar strojov: presne kľúče `SerializedMachine`, id 1…`nextId − 1` a ostro rastúce, známy def (`rtg`), stav, poloha, fáza, cyklus a fronta; vzťahy k svetu overí `restoreMachines`. */
export function parseMachines(value: unknown, nextId: number): SerializedMachine[] {
  let previousId = 0;
  return checkArray(value, '/machines').map((raw: unknown, i): SerializedMachine => {
    const path = `/machines${pointerSegment(i)}`;
    const entry = checkKeys(raw, SERIALIZED_MACHINE_KEYS, path);
    const id = checkInteger(entry['id'], 1, `${path}/id`);
    if (id >= nextId) throw new WorldStateError(`${path}/id`, `id ${String(id)} musí byť menšie ako ids.nextId ${String(nextId)}`);
    if (id <= previousId) throw new WorldStateError(`${path}/id`, `stroje musia byť vzostupne podľa id, ${String(id)} ≤ ${String(previousId)}`);
    previousId = id;
    const defId = entry['defId'];
    if (defId !== RTG_DEF_ID && defId !== REACH_STACKER_DEF_ID) throw new WorldStateError(`${path}/defId`, `neznámy stroj ${describeValue(defId)} (známe: ${RTG_DEF_ID}, ${REACH_STACKER_DEF_ID})`);
    const { state } = entry;
    if (!isMachineState(state)) throw new WorldStateError(`${path}/state`, `stav musí byť jeden z: ${MACHINE_STATES.join(', ')}, dostal ${describeValue(state)}`);
    const queue = checkArray(entry['queue'], `${path}/queue`).map((item: unknown, q): MachineQueueEntry => {
      const at = `${path}/queue${pointerSegment(q)}`;
      const fields = checkKeys(item, QUEUE_KEYS, at);
      return { vehicleId: checkInteger(fields['vehicleId'], 1, `${at}/vehicleId`), createdTick: checkInteger(fields['createdTick'], 0, `${at}/createdTick`) };
    });
    return {
      id,
      defId,
      blockId: checkInteger(entry['blockId'], 1, `${path}/blockId`),
      state,
      pose: parsePose(entry['pose'], `${path}/pose`),
      target: parsePose(entry['target'], `${path}/target`),
      phaseTotal: checkInteger(entry['phaseTotal'], 0, `${path}/phaseTotal`),
      phaseLeft: checkInteger(entry['phaseLeft'], 0, `${path}/phaseLeft`),
      cycle: parseCycle(entry['cycle'], `${path}/cycle`),
      queue,
      moves: checkInteger(entry['moves'], 0, `${path}/moves`),
      stallTicks: checkInteger(entry['stallTicks'], 0, `${path}/stallTicks`),
      firstPriority: parseFirstPriority(entry['firstPriority'], `${path}/firstPriority`),
    };
  });
}

/** `firstPriority` zo save: `null` alebo druh úlohy z `YARD_PRIORITY_KINDS`. */
function parseFirstPriority(value: unknown, path: string): YardPriorityKind | null {
  if (value === null) return null;
  const kind = YARD_PRIORITY_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) throw new WorldStateError(path, `priorita musí byť null alebo jedna z: ${YARD_PRIORITY_KINDS.join(', ')}, dostal ${describeValue(value)}`);
  return kind;
}

/** `put` po zdvihu už nemá job, ktorý by rezerváciu slotu v bloku obnovil (`restoreJobs`): drží ju cyklus stroja (`toSlot`), takže sa obnoví tu. */
function restoreReleasedPut(world: World, entry: SerializedMachine): void {
  const cycle = entry.cycle;
  if (cycle === null || cycle.kind !== 'put' || cycle.jobId !== null || cycle.toSlot === null) return;
  const block = world.modules.get(entry.blockId as EntityId);
  const target = block?.cargoDropTarget();
  if (target === undefined || !target.reserves) throw new WorldStateError('/machines', `blok #${String(entry.blockId)} nemá kam rezervovať slot cyklu put`);
  target.restoreReservation(cycle.toSlot, cycle.unitId as EntityId);
}

/** Obnoví stroje vzostupne podľa id cez `World.addMachine` (blok je RTG blok bez stroja); `MachineError` → `WorldStateError` s poľom záznamu. Po obnove vozidiel a jobov. */
export function restoreMachines(world: World, entries: readonly SerializedMachine[], defs: DefRegistry): void {
  entries.forEach((entry, index) => {
    const path = `/machines${pointerSegment(index)}`;
    try {
      const init = { ...entry, id: entry.id as EntityId, blockId: entry.blockId as EntityId };
      world.addMachine(entry.defId === REACH_STACKER_DEF_ID ? new ReachStacker({ ...init, def: defs.equipment.reachStacker }) : new RtgCrane({ ...init, def: defs.equipment.rtg }));
      restoreReleasedPut(world, entry);
    } catch (error) {
      if (error instanceof MachineError) throw new WorldStateError(`${path}/${error.code === 'unknown_block' ? 'blockId' : 'id'}`, error.message);
      throw error;
    }
  });
}

/** Drží jednotku práve stroj v rozpracovanom cykle (`in_handler` — prechodová poloha medzi vozidlom a stohom)? Job takej jednotky nemá jednotku na zdroji ani vo vozidle. */
export function heldByMachine(world: Pick<World, 'machines'>, unit: { readonly id: number; readonly location: { readonly kind: string; readonly machineId?: EntityId } }): boolean {
  if (unit.location.kind !== 'in_handler' || unit.location.machineId === undefined) return false;
  return world.machines.get(unit.location.machineId)?.cycle?.unitId === unit.id;
}
