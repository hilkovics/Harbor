/**
 * YardMachineSystem — krok 6c ticku (ARCHITECTURE §6, ADR-040; docs/TERMINAL_2.md §5.3, §6.1, §6.3): stroje blokov (RTG) obsluhujú vozidlá stojace na TP.
 * Beží po `VehicleSystem` (6b): vozidlo, ktoré v 6b dorazilo na TP (`loading` / `unloading` s pripnutým odpočtom), sa v tom istom ticku zaradí do fronty stroja.
 *
 * **Fronta** stroja sa zoraďuje podľa `(priorita, createdTick, id vozidla)`; priorita je z `equipment.json` (`rtg.priorities`: loď < kamión < housekeeping — menšie číslo
 * skôr) podľa jobu vozidla (`priorityKindOf`). Kto príde na TP skôr, čaká: vozidlo stojí na TP, kým stroj nedokončí cyklus; stroj bez vozidla stojí v `idle`.
 *
 * **Cyklus** (`machines/machine-fsm.ts`): `idle → travel` (žeriav a vozík k miestu zdvihu) `→ lift` (uchopenie, zdvih; na konci `→ in_handler`) `→ shift` (žeriav k bayu odkladu)
 * `→ trolley` (vozík k radu) `→ lower` (spustenie, pustenie; na konci `in_handler →` cieľ) `→ idle`. Časy fáz z `equipment.json` (`gantryCellsPerTick`, `hoistTicksPerTier`,
 * `trolleyTicksPerRow`, `lockTicks`); fáza bez dráhy sa preskočí. Druhy cyklu: `put` (vozidlo → stoh, vykládka), `take` (stoh → vozidlo, nakládka), `relocate` (rehandling v bloku).
 *
 * **Ledger** (pravidlo 2, výlučne `CargoLedger.move`): vykládka `in_vehicle → in_handler → in_storage`, nakládka `in_storage → in_handler → in_vehicle`, rehandling `in_storage →
 * in_handler → in_storage`. Po `put` / `take` sa dokončí job vozidla rovnako ako pri vlastnom zdvihu (`completeDrop`, `completeLoad` z `VehicleSystem`).
 *
 * **Rehandling** robí stroj sám (R2): kým je cieľ `take` zavalený, najprv sa prekladá vrchný kontajner nad ním (`chooseRehandleSlot`, `beginRelocation` / `endRelocation`).
 * Bez cieľa presunu stroj skúša obslúžiť iné vozidlo z fronty; trpezlivosť `rehandleGiveUpTicks` sa po vyčerpaní zapíše do `rehandleStalls` bloku a počíta sa odznova (vozidlo
 * ostáva čakať, job sa nezruší — vozidlo na TP ho nedrží na ceste ako vozidlo pri vlastnom rehandlingu).
 */
import { isSameLocation, slotOf, type CargoLocation } from '../cargo/cargo-location';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import type { YardPriorityKind } from '../defs/types';
import { onEmptyStored } from '../logistics/empty-depot-service';
import { chainBlockOf, isMachineEndpoint } from '../logistics/handling-chains';
import { accessCellIndex } from '../logistics/module-access';
import type { TransportJob } from '../logistics/transport-job';
import { beginRelocation, endRelocation } from '../logistics/yard-rehandle';
import { settleYardDrop } from '../logistics/yard-settle';
import { chooseRehandleSlot } from '../logistics/yard-planner';
import { LANE_ROW, RtgCrane } from '../machines/rtg-crane';
import { MachineError } from '../machines/machine-error';
import type { MachineCycle, MachinePose, MachineQueueEntry, MachineState } from '../machines/machine-state-types';
import { RtgBlock } from '../modules/rtg-block';
import type { Vehicle } from '../vehicles/vehicle';
import { HOOK_WAIT_TICKS } from '../vehicles/vehicle-fsm';
import type { World } from '../world/world';
import { completeDrop, completeLoad } from './vehicle-system';

/** Priorita úlohy podľa jobu vozidla: žeriav (hák) → loď, rampa → kamión, ostatné → housekeeping (tabuľka priorít je v `equipment.json`). */
export function priorityKindOf(job: TransportJob): YardPriorityKind {
  if (job.from.kind === 'in_crane' || job.to.kind === 'in_crane') return 'ship';
  if (job.from.kind === 'at_ramp' || job.to.kind === 'at_ramp') return 'truck';
  return 'housekeeping';
}

/** Miesto zdvihu alebo odkladu v bloku: bay (spojitý — 40′ stojí medzi dvoma bayami), rad vozíka (`LANE_ROW` = pruh s TP) a vrstva. */
interface Spot {
  readonly bay: number;
  readonly row: number;
  readonly tier: number;
}

const HALF_BAY = 0.5;

/** Vozidlo, ktoré čaká na TP bloku `block` (stav `loading` / `unloading` s jobom, ktorého koncový bod bloku obsluhuje stroj); inak `undefined`. */
function waitingJob(world: World, vehicle: Vehicle, blockId: EntityId): TransportJob | undefined {
  if (vehicle.state !== 'loading' && vehicle.state !== 'unloading') return undefined;
  const job = vehicle.jobId === null ? undefined : world.jobs.get(vehicle.jobId);
  if (job === undefined || !isMachineEndpoint(world, job, vehicle.state)) return undefined;
  return chainBlockOf(world, job)?.id === blockId ? job : undefined;
}

/** Zaradí do fronty vozidlá čakajúce na TP bloku stroja (vzostupne podľa id) a vyradí tie, ktoré už nečakajú. */
function refreshQueue(world: World, machine: RtgCrane): void {
  for (const entry of [...machine.queue]) {
    const vehicle = world.vehicles.get(entry.vehicleId as EntityId);
    if (vehicle === undefined || waitingJob(world, vehicle, machine.blockId) === undefined) machine.dequeue(entry.vehicleId as EntityId);
  }
  for (const vehicle of world.vehicles.values()) {
    if (waitingJob(world, vehicle, machine.blockId) !== undefined && !machine.serves(vehicle.id)) machine.enqueue(vehicle.id, world.clock.tick);
  }
}

/** Bay TP, pri ktorom vozidlo stojí: konektor bloku, ktorého vonkajšia bunka je bunkou vozidla (vjazd / výjazd); inak vjazd. */
function tpBayOf(world: World, block: RtgBlock, vehicle: Vehicle): number {
  for (let index = 0; index < block.connectors.length; index++) {
    if (accessCellIndex(world.grid, block.connectors[index]) === vehicle.cell) return block.tpBayOfConnector(index);
  }
  return block.tpBayOfConnector(0);
}

/** Bay stredu kontajnera v slote: 40′ zaberá pár bays (2k, 2k+1), jeho stred je medzi nimi. */
function bayCenter(unit: CargoUnit, bay: number): number {
  return unit.sizeFt === 40 ? bay + HALF_BAY : bay;
}

function spotOfSlot(block: RtgBlock, unit: CargoUnit, slot: number): Spot {
  const { bay, row, tier } = block.positionOfSlot(slot);
  return { bay: bayCenter(unit, bay), row, tier };
}

/** Miesto zdvihu a odkladu cyklu (viď `MachineCycle`); jednotka cyklu musí byť v ledgeri. */
function spotsOf(world: World, block: RtgBlock, cycle: MachineCycle): { readonly pick: Spot; readonly drop: Spot } {
  const unit = world.cargo.get(cycle.unitId as EntityId);
  if (unit === undefined) throw new MachineError('inconsistent', `blok ${block.label}: jednotka #${String(cycle.unitId)} cyklu ${cycle.kind} v ledgeri nie je`);
  const lane: Spot = { bay: cycle.tpBay, row: LANE_ROW, tier: 0 };
  return {
    pick: cycle.fromSlot === null ? lane : spotOfSlot(block, unit, cycle.fromSlot),
    drop: cycle.toSlot === null ? lane : spotOfSlot(block, unit, cycle.toSlot),
  };
}

/** Prvá jednotka jobu na mieste `location`; `undefined`, ak tam žiadna nie je. */
function firstUnitAt(world: World, job: TransportJob, location: CargoLocation): CargoUnit | undefined {
  for (const unitId of job.unitIds) {
    const unit = world.cargo.get(unitId);
    if (unit !== undefined && isSameLocation(unit.location, location)) return unit;
  }
  return undefined;
}

function blockOf(world: World, machine: RtgCrane): RtgBlock {
  const block = world.modules.get(machine.blockId);
  if (!(block instanceof RtgBlock)) throw new MachineError('inconsistent', `${machine.label}: blok #${String(machine.blockId)} nie je RTG blok`);
  return block;
}

function vehicleOfCycle(world: World, machine: RtgCrane, cycle: MachineCycle): Vehicle {
  const vehicle = cycle.vehicleId === null ? undefined : world.vehicles.get(cycle.vehicleId as EntityId);
  if (vehicle === undefined) throw new MachineError('inconsistent', `${machine.label}: cyklus ${cycle.kind} bez vozidla #${String(cycle.vehicleId)}`);
  return vehicle;
}

function jobOfCycle(world: World, machine: RtgCrane, cycle: MachineCycle): TransportJob {
  const job = cycle.jobId === null ? undefined : world.jobs.get(cycle.jobId as EntityId);
  if (job === undefined) throw new MachineError('inconsistent', `${machine.label}: cyklus ${cycle.kind} bez jobu #${String(cycle.jobId)}`);
  return job;
}

// ---------------------------------------------------------------------------------------------------------
// Plán fáz
// ---------------------------------------------------------------------------------------------------------

/** Fáza, ktorú stroj nastúpi: stav, trvanie v tickoch (≥ 1) a cieľová poloha. */
interface PhasePlan {
  readonly state: MachineState;
  readonly ticks: number;
  readonly target: MachinePose;
}

/** Spúšťač stojí na vrstve, z ktorej sa dvíha; počas jazdy je hore na úrovni `carryTier` (= `maxTier`, nad stohmi). */
function carryTierOf(block: RtgBlock): number {
  return block.geometry.maxTier;
}

/**
 * Plán `travel`: žeriav a vozík k miestu zdvihu a spúšťač dole na vrstvu zdvihu, súčasne; trvá najdlhšia z troch dráh. `null`, keď stroj už stojí na mieste (dráha 0) —
 * `idle → travel → lift` vtedy prebehne bez času.
 */
function planTravel(machine: RtgCrane, pick: Spot): PhasePlan | null {
  const rest = machine.restPose;
  const ticks = Math.max(machine.gantryTicks(pick.bay - rest.gantry), machine.trolleyTicks(pick.row - rest.trolley), machine.hoistTicks(pick.tier - rest.hoist));
  return ticks === 0 ? null : { state: 'travel', ticks, target: { gantry: pick.bay, trolley: pick.row, hoist: pick.tier } };
}

/** Plán `lift`: uchopenie a zdvih z vrstvy zdvihu na `carryTier`. */
function planLift(machine: RtgCrane, block: RtgBlock, pick: Spot): PhasePlan {
  const carry = carryTierOf(block);
  return { state: 'lift', ticks: machine.def.lockTicks + machine.hoistTicks(carry - pick.tier), target: { ...machine.restPose, hoist: carry } };
}

/** Plán `lower`: spustenie na vrstvu odkladu a pustenie. */
function planLower(machine: RtgCrane, block: RtgBlock, drop: Spot): PhasePlan {
  return { state: 'lower', ticks: machine.hoistTicks(carryTierOf(block) - drop.tier) + machine.def.lockTicks, target: { ...machine.restPose, hoist: drop.tier } };
}

/** Fáza po `lift` / `shift` / `trolley`: pojazd žeriavu, potom vozík, potom spustenie; fázy bez dráhy sa preskočia. */
function planAfterCarry(machine: RtgCrane, block: RtgBlock, drop: Spot): PhasePlan {
  const rest = machine.restPose;
  const gantry = machine.gantryTicks(drop.bay - rest.gantry);
  if (gantry > 0) return { state: 'shift', ticks: gantry, target: { ...rest, gantry: drop.bay } };
  const trolley = machine.trolleyTicks(drop.row - rest.trolley);
  if (trolley > 0) return { state: 'trolley', ticks: trolley, target: { ...rest, trolley: drop.row } };
  return planLower(machine, block, drop);
}

/** Vstúpi do fázy (prechod podľa tabuľky FSM + odpočet). */
function enter(machine: RtgCrane, plan: PhasePlan): void {
  machine.enterPhase(plan.state, plan.ticks, plan.target);
}

// ---------------------------------------------------------------------------------------------------------
// Výber a začiatok cyklu
// ---------------------------------------------------------------------------------------------------------

/** Fronta zoradená podľa `(priorita, createdTick, id vozidla)` (ADR-040 bod 6). */
export function sortedQueue(world: Pick<World, 'vehicles' | 'jobs'>, machine: RtgCrane): MachineQueueEntry[] {
  const { priorities } = machine.def;
  const keyOf = (entry: MachineQueueEntry): number => {
    const vehicle = world.vehicles.get(entry.vehicleId as EntityId);
    const job = vehicle?.jobId === null || vehicle === undefined ? undefined : world.jobs.get(vehicle.jobId as EntityId);
    return job === undefined ? Number.MAX_SAFE_INTEGER : priorities[priorityKindOf(job)];
  };
  return [...machine.queue].sort((a, b) => keyOf(a) - keyOf(b) || a.createdTick - b.createdTick || a.vehicleId - b.vehicleId);
}

/** Cyklus pre vozidlo z fronty, alebo `null`, ak sa teraz nedá začať (zavalený cieľ bez miesta na rehandling); zapíše `stallTicks` stroja. */
function planCycle(world: World, machine: RtgCrane, block: RtgBlock, vehicle: Vehicle, job: TransportJob): MachineCycle | null {
  const tpBay = tpBayOf(world, block, vehicle);
  if (vehicle.state === 'unloading') {
    const unit = firstUnitAt(world, job, { kind: 'in_vehicle', vehicleId: vehicle.id });
    const slot = slotOf(job.to);
    if (unit === undefined || slot === null) throw new MachineError('inconsistent', `${machine.label}: ${vehicle.label} čaká s ${job.label} bez jednotky vo vozidle`);
    return { kind: 'put', unitId: unit.id, vehicleId: vehicle.id, jobId: job.id, fromSlot: null, toSlot: slot, tpBay };
  }
  const unit = job.unitIds.map((id) => world.cargo.get(id)).find((candidate) => candidate !== undefined && isSameLocation(candidate.location, job.from));
  if (unit === undefined || unit.location.kind !== 'in_storage') {
    // Jednotka jobu práve prekladá tento stroj (ako blokujúci kontajner) — nie je dôvod čakať ďalej, nová fronta sa zoradí v ďalšom ticku.
    if (job.unitIds.some((id) => world.cargo.get(id)?.location.kind === 'in_handler')) return null;
    throw new MachineError('inconsistent', `${machine.label}: ${vehicle.label} čaká s ${job.label} bez jednotky v bloku`);
  }
  const blockerId = block.topBlockerOf(unit.id);
  if (blockerId === null) return { kind: 'take', unitId: unit.id, vehicleId: vehicle.id, jobId: job.id, fromSlot: unit.location.slot, toSlot: null, tpBay };
  const blocker = world.cargo.get(blockerId);
  if (blocker === undefined || blocker.location.kind !== 'in_storage') throw new MachineError('inconsistent', `${machine.label}: kontajner nad #${String(unit.id)} (#${String(blockerId)}) nie je v bloku`);
  const target = chooseRehandleSlot(world, block, blocker, block.positionOfSlot(blocker.location.slot));
  if (target === null) return null;
  return { kind: 'relocate', unitId: blocker.id, vehicleId: null, jobId: null, fromSlot: blocker.location.slot, toSlot: target, tpBay: block.positionOfSlot(blocker.location.slot).bay };
}

/** Začne ďalší cyklus podľa fronty; `true`, keď stroj opustil `idle`. Bez použiteľného vozidla beží trpezlivosť rehandlingu. */
function startCycle(world: World, machine: RtgCrane, block: RtgBlock): boolean {
  let stalled = false;
  for (const entry of sortedQueue(world, machine)) {
    const vehicle = world.vehicles.get(entry.vehicleId as EntityId);
    const job = vehicle?.jobId === null || vehicle === undefined ? undefined : world.jobs.get(vehicle.jobId as EntityId);
    if (vehicle === undefined || job === undefined) continue;
    const cycle = planCycle(world, machine, block, vehicle, job);
    if (cycle === null) {
      stalled = true;
      continue;
    }
    machine.beginCycle(cycle);
    if (cycle.kind === 'relocate') beginRelocation(world, block, cycle.toSlot as number);
    else machine.dequeue(vehicle.id);
    const { pick } = spotsOf(world, block, cycle);
    const travel = planTravel(machine, pick);
    if (travel === null) {
      machine.transition('travel');
      enter(machine, planLift(machine, block, pick));
    } else {
      enter(machine, travel);
    }
    return true;
  }
  if (stalled) {
    const waited = machine.addStall();
    if (waited >= world.defs.logistics.rehandleGiveUpTicks) {
      block.recordRehandleStall();
      machine.resetStall();
    }
  } else {
    machine.resetStall();
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// Koniec fáz
// ---------------------------------------------------------------------------------------------------------

/** Koniec `lift`: jednotka z vozidla / stohu do `in_handler`; `put` usadí rezerváciu slotu na skutočnú vrstvu stohu. */
function pickUp(world: World, machine: RtgCrane, block: RtgBlock, cycle: MachineCycle): void {
  const handler: CargoLocation = { kind: 'in_handler', machineId: machine.id };
  world.cargo.move(cycle.unitId as EntityId, handler);
  if (cycle.kind === 'take') block.recordTaken(cycle.unitId as EntityId);
  if (cycle.kind === 'put') {
    const job = jobOfCycle(world, machine, cycle);
    settleYardDrop(world, job);
    machine.replaceCycle({ ...cycle, toSlot: slotOf(job.to) });
  }
}

/** Koniec `lower`: jednotka z `in_handler` na cieľ cyklu a dokončenie jobu vozidla (`put`, `take`), alebo rehandle bloku (`relocate`). */
function putDown(world: World, machine: RtgCrane, block: RtgBlock, cycle: MachineCycle): void {
  const unitId = cycle.unitId as EntityId;
  if (cycle.kind === 'relocate') {
    const slot = cycle.toSlot as number;
    world.cargo.move(unitId, { kind: 'in_storage', moduleId: block.id, slot });
    endRelocation(world, block, unitId, slot);
    return;
  }
  const vehicle = vehicleOfCycle(world, machine, cycle);
  const job = jobOfCycle(world, machine, cycle);
  if (cycle.kind === 'take') {
    world.cargo.move(unitId, { kind: 'in_vehicle', vehicleId: vehicle.id });
    completeLoad(world, vehicle, job, HOOK_WAIT_TICKS);
    return;
  }
  const target = block.cargoDropTarget();
  settleYardDrop(world, job);
  const place = slotOf(job.to);
  if (place === null || job.to.kind !== 'in_storage') throw new MachineError('inconsistent', `${machine.label}: ${job.label} nemá cieľ s miestom v bloku`);
  target.assertCommittable(place, unitId);
  world.cargo.move(unitId, job.to);
  target.commit(place, unitId);
  onEmptyStored(world, unitId, block);
  completeDrop(world, vehicle, job, HOOK_WAIT_TICKS);
}

/** Koniec fázy: ledger, potom ďalšia fáza (alebo `idle`). */
function onPhaseEnd(world: World, machine: RtgCrane, block: RtgBlock): void {
  const cycle = machine.cycle;
  if (cycle === null) throw new MachineError('inconsistent', `${machine.label}: fáza '${machine.state}' bez cyklu`);
  const { pick, drop } = spotsOf(world, block, cycle);
  switch (NEXT_AFTER[machine.state]) {
    case 'lift':
      enter(machine, planLift(machine, block, pick));
      return;
    case 'carry':
      if (machine.state !== 'lift') {
        enter(machine, planAfterCarry(machine, block, drop));
        return;
      }
      pickUp(world, machine, block, cycle);
      enter(machine, planAfterCarry(machine, block, spotsOf(world, block, machine.cycle as MachineCycle).drop));
      return;
    case 'idle':
      putDown(world, machine, block, cycle);
      machine.endCycle();
      return;
    default:
      throw new MachineError('inconsistent', `${machine.label}: fáza '${machine.state}' nemá pokračovanie`);
  }
}

/** Čo nasleduje po konci fázy (tabuľka, nie switch podľa stavu v kóde plánovania): `travel → lift`, `lift | shift | trolley → ďalšia fáza nosenia`, `lower → idle`. */
const NEXT_AFTER: { readonly [S in MachineState]: 'lift' | 'carry' | 'idle' | null } = {
  idle: null,
  travel: 'lift',
  shift: 'carry',
  lift: 'carry',
  trolley: 'carry',
  lower: 'idle',
};

/** Stojí stroj bez cyklu? (Funkcia kvôli zúženiu typu stavu v `tick`.) */
function isIdle(machine: RtgCrane): boolean {
  return machine.state === 'idle';
}

export class YardMachineSystem {
  /** Krok 6c: každý stroj (vzostupne podľa id) zaradí čakajúce vozidlá a posunie svoj cyklus o jeden tick. */
  tick(world: World): void {
    for (const machine of world.machines.values()) {
      if (!(machine instanceof RtgCrane)) continue;
      const block = blockOf(world, machine);
      refreshQueue(world, machine);
      if (isIdle(machine)) {
        startCycle(world, machine, block);
        continue;
      }
      if (!machine.advancePhase()) continue;
      onPhaseEnd(world, machine, block);
      // Stroj, ktorý práve dokončil cyklus, začne ďalší hneď (bez zbytočného ticku v `idle`).
      if (isIdle(machine)) {
        refreshQueue(world, machine);
        startCycle(world, machine, block);
      }
    }
  }
}
