/**
 * YardMachineSystem — krok 6c ticku (ARCHITECTURE §6, ADR-040; docs/TERMINAL_2.md §5.3, §6.1, §6.3): stroje blokov (RTG) obsluhujú vozidlá stojace na TP.
 * Beží po `VehicleSystem` (6b): vozidlo, ktoré v 6b dorazilo na TP (`loading` / `unloading` s pripnutým odpočtom), sa v tom istom ticku zaradí do fronty stroja.
 *
 * **Fronta** stroja sa zoraďuje podľa `(priorita, createdTick, id vozidla)`; priorita je z `equipment.json` (`rtg.priorities`: loď < kamión < housekeeping — menšie číslo
 * skôr) podľa jobu vozidla (`priorityKindOf`). Kto príde na TP skôr, čaká: vozidlo stojí na TP, kým stroj nedokončí cyklus; stroj bez vozidla stojí v `idle`.
 *
 * **Kamióny na TP** (R4, ADR-041 bod 4): partner cyklu je vozidlo (ťahač), alebo **kamión** s jobom `in_storage ↔ in_truck` (`logistics/truck-jobs.ts`), ktorý stojí na TP v pruhu bloku vo fáze `handling` —
 * rovnaká fronta a priority (loď → kamión → housekeeping), cyklus `put` (kamión → stoh, export, prázdny) a `take` (stoh → kamión, import). Kamión sa uvoľní sám: job zanikne po zdvihu
 * (`put`) alebo po položení na návesy (`take`) a kamión (`trucks/tp-service.ts`) pokračuje bezpečnou zónou a lashingom. Kamión nikdy nečaká na stroj prefetchom.
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
import type { Truck } from '../trucks/truck';
import type { Vehicle } from '../vehicles/vehicle';
import { truckJobBlock } from '../logistics/truck-jobs';
import { HOOK_WAIT_TICKS } from '../vehicles/vehicle-fsm';
import type { World } from '../world/world';
import { completeDrop, completeLoad } from './vehicle-system';

/** Priorita úlohy podľa jobu vozidla: žeriav (hák) → loď, kamión na TP → kamión, ostatné → housekeeping (tabuľka priorít je v `equipment.json`). */
export function priorityKindOf(job: TransportJob): YardPriorityKind {
  if (job.from.kind === 'in_crane' || job.to.kind === 'in_crane') return 'ship';
  if (job.from.kind === 'in_truck' || job.to.kind === 'in_truck') return 'truck';
  return 'housekeeping';
}

/** Partner cyklu: vozidlo (ťahač), alebo kamión na TP (viď hlavička); id entít sú jedinečné. */
type Partner = Vehicle | Truck;

/** Partner s daným id (vozidlo, potom kamión), alebo `undefined`. */
function partnerById(world: World, id: EntityId): Partner | undefined {
  return world.vehicles.get(id) ?? world.trucks.get(id);
}

/** Id jobu partnera, alebo `null`. */
function jobIdOfPartner(partner: Partner): EntityId | null {
  return partner.jobId;
}

/** Poloha jednotky v partnerovi: vo vozidle, alebo v kamióne. */
function locationInPartner(partner: Partner): CargoLocation {
  return partner.kind === 'truck' ? { kind: 'in_truck', truckId: partner.id } : { kind: 'in_vehicle', vehicleId: partner.id };
}

/** Miesto zdvihu alebo odkladu v bloku: bay (spojitý — 40′ stojí medzi dvoma bayami), rad vozíka (`LANE_ROW` = pruh s TP) a vrstva. */
interface Spot {
  readonly bay: number;
  readonly row: number;
  readonly tier: number;
}

const HALF_BAY = 0.5;

/**
 * Job partnera, ktorý čaká na TP bloku `blockId` (vozidlo v stave `loading` / `unloading` s jobom, ktorého koncový bod bloku obsluhuje stroj; kamión na TP vo fáze `handling` s jobom
 * bloku); inak `undefined`.
 */
function waitingJob(world: World, partner: Partner, blockId: EntityId): TransportJob | undefined {
  if (partner.kind === 'truck') {
    const truckJob = partner.jobId === null ? undefined : world.jobs.get(partner.jobId);
    if (truckJob === undefined || !partner.traits.atTp || partner.phase !== 'handling' || truckJob.state !== 'open') return undefined;
    return truckJobBlock(world, truckJob)?.id === blockId ? truckJob : undefined;
  }
  if (partner.state !== 'loading' && partner.state !== 'unloading') return undefined;
  const job = partner.jobId === null ? undefined : world.jobs.get(partner.jobId);
  if (job === undefined || !isMachineEndpoint(world, job, partner.state)) return undefined;
  return chainBlockOf(world, job)?.id === blockId ? job : undefined;
}

/** Vyradí z fronty partnerov, ktorí už nečakajú (prechod od konca bez kópie fronty — `dequeue` ukrajuje pole). */
function pruneQueue(world: World, machine: RtgCrane): void {
  const queue = machine.queue;
  for (let i = queue.length - 1; i >= 0; i--) {
    const partnerId = queue[i].vehicleId as EntityId;
    const partner = partnerById(world, partnerId);
    if (partner === undefined || waitingJob(world, partner, machine.blockId) === undefined) machine.dequeue(partnerId);
  }
}

/** Jeden prechod vozidiel a kamiónov sveta (vzostupne podľa id): čakajúci na TP bloku so strojom sa zaradia do jeho fronty (`enqueue` je idempotentné). */
function enqueueWaiting(world: World): void {
  for (const vehicle of world.vehicles.values()) {
    if (vehicle.state !== 'loading' && vehicle.state !== 'unloading') continue;
    const job = vehicle.jobId === null ? undefined : world.jobs.get(vehicle.jobId);
    if (job === undefined || !isMachineEndpoint(world, job, vehicle.state)) continue;
    const blockId = chainBlockOf(world, job)?.id;
    const machine = blockId === undefined ? undefined : world.machineOfBlock(blockId);
    if (machine instanceof RtgCrane && !machine.serves(vehicle.id)) machine.enqueue(vehicle.id, world.clock.tick);
  }
  for (const truck of world.trucks.values()) {
    if (truck.state !== 'at_tp' || truck.phase !== 'handling' || truck.jobId === null) continue;
    const job = world.jobs.get(truck.jobId);
    const blockId = job === undefined ? undefined : truckJobBlock(world, job)?.id;
    const machine = blockId === undefined ? undefined : world.machineOfBlock(blockId);
    if (machine instanceof RtgCrane && !machine.serves(truck.id)) machine.enqueue(truck.id, world.clock.tick);
  }
}

/** Bay TP, pri ktorom vozidlo stojí: bunka pruhu bloku, na ktorej vozidlo stojí (ťahač do pruhu vchádza, ADR-040 TR3-02); mimo pruhu (starý stav, testy) bay podľa konektora, ktorého vonkajšia bunka je bunkou vozidla. */
function tpBayOf(world: World, block: RtgBlock, vehicle: Partner, cell: number = vehicle.cell): number {
  const bay = world.quay.laneCellsOf(block.id)?.indexOf(cell) ?? -1;
  if (bay >= 0) return block.tpBayNear(bay);
  for (let index = 0; index < block.connectors.length; index++) {
    if (accessCellIndex(world.grid, block.connectors[index]) === cell) return block.tpBayOfConnector(index);
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

function vehicleOfCycle(world: World, machine: RtgCrane, cycle: MachineCycle): Partner {
  const vehicle = cycle.vehicleId === null ? undefined : partnerById(world, cycle.vehicleId as EntityId);
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

/**
 * Výška nosenia (vrstva spúšťača počas presunu): nad najvyšším stohom, ktorý kontajner prejde medzi miestom zdvihu a odkladu (bays a rady oboch miest vrátane), nie vždy na plnú
 * výšku bloku — spúšťač sa zdvíha len na výšku potrebnú na prejazd (TR3-02). Nikdy nad `maxTier`; pri prázdnych stohoch 0.
 */
function carryTierOf(block: RtgBlock, pick: Spot, drop: Spot): number {
  const { bays, rows, maxTier } = block.geometry;
  const bayFrom = Math.max(0, Math.floor(Math.min(pick.bay, drop.bay)));
  const bayTo = Math.min(bays - 1, Math.ceil(Math.max(pick.bay, drop.bay)));
  const rowFrom = Math.max(0, Math.min(pick.row, drop.row));
  const rowTo = Math.min(rows - 1, Math.max(pick.row, drop.row));
  let need = Math.max(pick.tier, drop.tier);
  for (let bay = bayFrom; bay <= bayTo; bay++) {
    for (let row = rowFrom; row <= rowTo; row++) need = Math.max(need, block.stackHeight(bay, row));
  }
  return Math.min(maxTier, need);
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

/** Plán `lift`: uchopenie kontajnera (twist-lock); stúpanie spúšťača prebieha až súbežne s pojazdom (`planAfterCarry`). */
function planLift(machine: RtgCrane): PhasePlan {
  return { state: 'lift', ticks: machine.def.lockTicks, target: { ...machine.restPose } };
}

/** Plán `lower`: spustenie z výšky nosenia na vrstvu odkladu a pustenie. */
function planLower(machine: RtgCrane, drop: Spot): PhasePlan {
  return { state: 'lower', ticks: machine.hoistTicks(machine.restPose.hoist - drop.tier) + machine.def.lockTicks, target: { ...machine.restPose, hoist: drop.tier } };
}

/**
 * Fáza po `lift` / `shift` / `trolley`: **súbežný** pojazd žeriavu, vozíka a stúpanie spúšťača na výšku nosenia (`carryTierOf`) — trvá najdlhšia z troch dráh (ako `travel`;
 * stav `shift`, ak žeriav nejde kratšie než vozík, inak `trolley`); bez dráhy rovno spustenie.
 */
function planAfterCarry(machine: RtgCrane, block: RtgBlock, pick: Spot, drop: Spot): PhasePlan {
  const rest = machine.restPose;
  const carry = Math.max(rest.hoist, carryTierOf(block, pick, drop));
  const gantry = machine.gantryTicks(drop.bay - rest.gantry);
  const trolley = machine.trolleyTicks(drop.row - rest.trolley);
  const ticks = Math.max(gantry, trolley, machine.hoistTicks(carry - rest.hoist));
  if (ticks === 0) return planLower(machine, drop);
  return { state: gantry > 0 && gantry >= trolley ? 'shift' : 'trolley', ticks, target: { gantry: drop.bay, trolley: drop.row, hoist: carry } };
}

/** Vstúpi do fázy (prechod podľa tabuľky FSM + odpočet). */
function enter(machine: RtgCrane, plan: PhasePlan): void {
  machine.enterPhase(plan.state, plan.ticks, plan.target);
}

// ---------------------------------------------------------------------------------------------------------
// Výber a začiatok cyklu
// ---------------------------------------------------------------------------------------------------------

/** Kľúč priority záznamu fronty: priorita jobu vozidla stroja; bez jobu poslední. */
function queueKey(world: Pick<World, 'vehicles' | 'trucks' | 'jobs'>, machine: RtgCrane, entry: MachineQueueEntry): number {
  const vehicle = world.vehicles.get(entry.vehicleId as EntityId) ?? world.trucks.get(entry.vehicleId as EntityId);
  const job = vehicle?.jobId === null || vehicle === undefined ? undefined : world.jobs.get(vehicle.jobId);
  return job === undefined ? Number.MAX_SAFE_INTEGER : machine.priorityOf(priorityKindOf(job));
}

/** Poradie dvoch záznamov: `(priorita, createdTick, id vozidla)` (ADR-040 bod 6). */
function entryBefore(aKey: number, a: MachineQueueEntry, bKey: number, b: MachineQueueEntry): boolean {
  return aKey !== bKey ? aKey < bKey : a.createdTick !== b.createdTick ? a.createdTick < b.createdTick : a.vehicleId < b.vehicleId;
}

/** Fronta zoradená podľa `(priorita, createdTick, id vozidla)` (ADR-040 bod 6); alokuje kópiu — na dotazy a testy, systém ju v tickoch nepoužíva (`nextInQueue`). */
export function sortedQueue(world: Pick<World, 'vehicles' | 'trucks' | 'jobs'>, machine: RtgCrane): MachineQueueEntry[] {
  return [...machine.queue].sort((a, b) => queueKey(world, machine, a) - queueKey(world, machine, b) || a.createdTick - b.createdTick || a.vehicleId - b.vehicleId);
}

/**
 * Najbližší záznam fronty za `after` v poradí `sortedQueue` (`undefined` = od začiatku); `undefined`, keď žiadny nezostal. Lineárny výber bez kópie a triedenia —
 * fronta stroja je krátka a väčšinou sa berie jej prvý záznam.
 */
function nextInQueue(world: World, machine: RtgCrane, after: MachineQueueEntry | undefined): MachineQueueEntry | undefined {
  const afterKey = after === undefined ? 0 : queueKey(world, machine, after);
  let best: MachineQueueEntry | undefined;
  let bestKey = 0;
  for (const entry of machine.queue) {
    const key = queueKey(world, machine, entry);
    if (after !== undefined && !entryBefore(afterKey, after, key, entry)) continue;
    if (best === undefined || entryBefore(key, entry, bestKey, best)) {
      best = entry;
      bestKey = key;
    }
  }
  return best;
}

/** Cyklus pre vozidlo z fronty, alebo `null`, ak sa teraz nedá začať (zavalený cieľ bez miesta na rehandling); zapíše `stallTicks` stroja. */
function planCycle(world: World, machine: RtgCrane, block: RtgBlock, vehicle: Partner, job: TransportJob, tpCell: number = vehicle.cell): MachineCycle | null {
  const truck = vehicle.kind === 'truck';
  const tpBay = tpBayOf(world, block, vehicle, tpCell);
  if (job.to.kind === 'in_storage') {
    const unit = firstUnitAt(world, job, locationInPartner(vehicle));
    const slot = slotOf(job.to);
    if (unit === undefined || slot === null) throw new MachineError('inconsistent', `${machine.label}: ${vehicle.label} čaká s ${job.label} bez jednotky vo vozidle`);
    return { kind: 'put', unitId: unit.id, vehicleId: vehicle.id, truck, jobId: job.id, fromSlot: null, toSlot: slot, tpBay };
  }
  const unit = job.unitIds.map((id) => world.cargo.get(id)).find((candidate) => candidate !== undefined && isSameLocation(candidate.location, job.from));
  if (unit === undefined || unit.location.kind !== 'in_storage') {
    // Jednotka jobu práve prekladá tento stroj (ako blokujúci kontajner) — nie je dôvod čakať ďalej, nová fronta sa zoradí v ďalšom ticku.
    if (job.unitIds.some((id) => world.cargo.get(id)?.location.kind === 'in_handler')) return null;
    throw new MachineError('inconsistent', `${machine.label}: ${vehicle.label} čaká s ${job.label} bez jednotky v bloku`);
  }
  const blockerId = block.topBlockerOf(unit.id);
  if (blockerId === null) return { kind: 'take', unitId: unit.id, vehicleId: vehicle.id, truck, jobId: job.id, fromSlot: unit.location.slot, toSlot: null, tpBay };
  const blocker = world.cargo.get(blockerId);
  if (blocker === undefined || blocker.location.kind !== 'in_storage') throw new MachineError('inconsistent', `${machine.label}: kontajner nad #${String(unit.id)} (#${String(blockerId)}) nie je v bloku`);
  const target = chooseRehandleSlot(world, block, blocker, block.positionOfSlot(blocker.location.slot));
  if (target === null) return null;
  return { kind: 'relocate', unitId: blocker.id, vehicleId: null, truck: false, jobId: null, fromSlot: blocker.location.slot, toSlot: target, tpBay: block.positionOfSlot(blocker.location.slot).bay };
}

/** Výsledok `approachingJob` (bez alokácie na vozidlo): cieľová bunka trasy ťahača. */
let approachCell = -1;

/**
 * Ťahač s jobom tohto bloku (nakládka `to_pickup`, vykládka `to_dropoff`), ktorý ide k TP pruhu a do cieľa mu ostáva najviac `prefetchCells` buniek trasy (ADR-040 dodatok TR3-02, predzásobenie): stroj
 * môže cyklus začať skôr, než ťahač dorazí — `take` zdvihne kontajner zo stohu a presunie ho nad TP, `put` sa nastaví nad TP; potom počká na ťahač (`holdForVehicle`). Vracia job
 * (cieľová bunka trasy je v `approachCell`), inak `undefined`. Lacné vylúčenia (stav, vzdialenosť) idú pred hľadaním jobu.
 */
function approachingJob(world: World, vehicle: Vehicle, block: RtgBlock, lane: Int32Array, prefetchCells: number): TransportJob | undefined {
  if (vehicle.jobId === null || vehicle.cellsAhead > prefetchCells) return undefined;
  if (vehicle.state !== 'to_pickup' && vehicle.state !== 'to_dropoff') return undefined;
  const job = world.jobs.get(vehicle.jobId);
  if (job === undefined || chainBlockOf(world, job)?.id !== block.id) return undefined;
  const take = vehicle.state === 'to_pickup' && job.from.kind === 'in_storage' && isMachineEndpoint(world, job, 'loading');
  const put = vehicle.state === 'to_dropoff' && job.to.kind === 'in_storage' && isMachineEndpoint(world, job, 'unloading');
  if (!take && !put) return undefined;
  const tpCell = vehicle.routeCellAt(vehicle.cellsAhead);
  if (tpCell === undefined || !lane.includes(tpCell)) return undefined;
  approachCell = tpCell;
  return job;
}

/**
 * Predzásobenie: začne cyklus pre ťahač, ktorý je v poradí pruhu prvý — najbližšie k vjazdu pruhu / najhlbšie v ňom (`cellsAhead − index TP`), potom najplytší TP; `true`, keď stroj opustil `idle`.
 * Jednosmerný pruh sa nepredbieha: ťahač, ktorý je fyzicky pred iným (hoci s hlbším TP), musí prísť na rad skôr, inak by stroj čakal na ťahač za ním a ten pred sebou
 * ťahač čakajúci na TP (zápcha, ADR-040 dodatok TR3-02c a TR3-02d). Výber beží bez alokácie (premenné miesto objektu na kandidáta).
 */
function startPrefetch(world: World, machine: RtgCrane, block: RtgBlock): boolean {
  const lane = world.quay.laneCellsOf(block.id);
  const { prefetchCells } = machine.def;
  if (lane === undefined || prefetchCells <= 0) return false;
  let bestVehicle: Vehicle | undefined;
  let bestJob: TransportJob | undefined;
  let bestCell = -1;
  let bestBay = 0;
  let bestToEntry = 0;
  for (const vehicle of world.vehicles.values()) {
    if (vehicle.jobId === null || machine.serves(vehicle.id)) continue;
    const job = approachingJob(world, vehicle, block, lane, prefetchCells);
    if (job === undefined) continue;
    const tpBay = lane.indexOf(approachCell);
    // Poradie v pruhu = vzdialenosť k vjazdu pruhu (buniek do TP − index TP; záporná = ťahač je už v pruhu); pri rovnosti plytší TP.
    const toEntry = vehicle.cellsAhead - tpBay;
    // Mimo pruhu (pred vjazdom) sa nepredzásobuje: pri zlievaní na vjazde by predbehol iný ťahač a stroj by čakal na ťahač za ťahačom, ktorý stojí na jeho TP (TR3-02d).
    if (toEntry > 0) continue;
    if (bestVehicle === undefined || toEntry < bestToEntry || (toEntry === bestToEntry && tpBay < bestBay)) {
      bestVehicle = vehicle;
      bestJob = job;
      bestCell = approachCell;
      bestBay = tpBay;
      bestToEntry = toEntry;
    }
  }
  if (bestVehicle === undefined || bestJob === undefined) return false;
  const cycle = planCycle(world, machine, block, bestVehicle, bestJob, bestCell);
  if (cycle === null) return false;
  machine.beginCycle(cycle);
  if (cycle.kind === 'relocate') beginRelocation(world, block, cycle.toSlot as number);
  const { pick } = spotsOf(world, block, cycle);
  const travel = planTravel(machine, pick);
  if (travel === null) {
    machine.transition('travel');
    enter(machine, planLift(machine));
  } else {
    enter(machine, travel);
  }
  return true;
}

/**
 * Cyklus s ťahačom, ktorý ešte nedorazil na TP (predzásobenie): `put` čaká nad TP pred zdvihom (`lift`), `take` s kontajnerom nad TP pred spustením (`lower`) — stroj sa na 1 tick
 * „zdrží“ (`shift` bez pohybu), kým ťahač nestojí na TP (`unloading` pri `put`, `loading` pri `take`). Ostatné cykly a fázy idú ďalej bez čakania.
 * Čakanie je ohraničené: po `rtg.handoverGiveUpTicks` (ťahač `no_path`, bunka pruhu nesedí) stroj cyklus vzdá (`abortCycle`) a vráti `null`.
 */
function holdForVehicle(world: World, machine: RtgCrane, block: RtgBlock, cycle: MachineCycle, next: PhasePlan): PhasePlan | null {
  const put = cycle.kind === 'put' && cycle.vehicleId !== null && next.state === 'lift';
  const take = cycle.kind === 'take' && next.state === 'lower';
  if (!put && !take) return next;
  // Kamión na TP stojí od zaradenia do fronty (fáza `handling`) a neodíde, kým neskončí odovzdanie — stroj naňho nečaká.
  if (cycle.truck) return next;
  const vehicle = world.vehicles.get(cycle.vehicleId as EntityId);
  const lane = world.quay.laneCellsOf(block.id);
  if (vehicle !== undefined && vehicle.state === (put ? 'unloading' : 'loading') && lane?.[cycle.tpBay] === vehicle.cell) {
    machine.resetStall();
    return next;
  }
  // Počas cyklu je `stallTicks` voľné (`beginCycle` ho nuluje) — slúži ako počítadlo čakania na ťahač.
  if (machine.addStall() >= machine.def.handoverGiveUpTicks && abortCycle(world, machine, block, cycle)) return null;
  return { state: 'shift', ticks: 1, target: { ...machine.restPose } };
}

/** Vstúpi do fázy po čakaní na ťahač (`holdForVehicle`); `false`, keď stroj cyklus vzdal. */
function enterHeld(world: World, machine: RtgCrane, block: RtgBlock, cycle: MachineCycle, next: PhasePlan): boolean {
  const plan = holdForVehicle(world, machine, block, cycle, next);
  if (plan === null) return false;
  enter(machine, plan);
  return true;
}

/** Je pre jednotku `unit` cyklu uvoľnený slot `slot` s rovnakou výškou stohu (vrch stohu), takže ju možno vrátiť presne tam? */
function slotIsStackTop(block: RtgBlock, unit: CargoUnit, slot: number): boolean {
  const { bay, row, tier } = block.positionOfSlot(slot);
  if (block.stackHeight(bay, row) !== tier) return false;
  return unit.sizeFt !== 40 || (bay + 1 < block.geometry.bays && block.stackHeight(bay + 1, row) === tier);
}

/**
 * Vzdá rozpracovaný cyklus: jednotka v `in_handler` sa vráti do stohu (pôvodný slot, ak je jeho vrch voľný, inak slot z plánovača rehandlingu; `in_handler → in_storage`
 * cez ledger, rovnako ako koniec `relocate`) a stroj je `idle` bez započítaného presunu. Vozidlo a job sa nemenia — vozidlo sa zaradí do fronty znova (príchod na TP).
 * `false`, keď jednotku nemá kam vrátiť (blok plný) — stroj ju drží ďalej a skúsi to v ďalšom ticku.
 */
function abortCycle(world: World, machine: RtgCrane, block: RtgBlock, cycle: MachineCycle): boolean {
  const unit = world.cargo.get(cycle.unitId as EntityId);
  if (unit !== undefined && unit.location.kind === 'in_handler') {
    let slot: number | null = cycle.fromSlot !== null && slotIsStackTop(block, unit, cycle.fromSlot) ? cycle.fromSlot : null;
    if (slot === null) {
      const origin = cycle.fromSlot === null ? { bay: cycle.tpBay, row: LANE_ROW } : block.positionOfSlot(cycle.fromSlot);
      slot = chooseRehandleSlot(world, block, unit, origin);
    }
    if (slot === null) return false;
    beginRelocation(world, block, slot);
    world.cargo.move(unit.id, { kind: 'in_storage', moduleId: block.id, slot });
    // Nie je to rehandle (`recordRehandle` sa nepočíta); job jednotky zo skladu dostane nový slot zdroja.
    const unitJob = world.jobOfUnit(unit.id);
    if (unitJob?.from.kind === 'in_storage') unitJob.rebindStorageSource(slot);
  }
  machine.abortCycle();
  return true;
}

/** Cyklus s vozidlom (`put` / `take`), ktorého vozidlo alebo job medzitým zanikol (job zrušený počas predzásobenia, vozidlo odstránené) — nemá komu odovzdať. */
function cycleOrphaned(world: World, cycle: MachineCycle): boolean {
  if (cycle.vehicleId === null) return false;
  const vehicle = partnerById(world, cycle.vehicleId as EntityId);
  return vehicle === undefined || cycle.jobId === null || vehicle.jobId !== cycle.jobId || !world.jobs.has(cycle.jobId as EntityId);
}

/** Začne ďalší cyklus podľa fronty; `true`, keď stroj opustil `idle`. Bez použiteľného vozidla beží trpezlivosť rehandlingu. */
function startCycle(world: World, machine: RtgCrane, block: RtgBlock): boolean {
  let stalled = false;
  for (let entry = nextInQueue(world, machine, undefined); entry !== undefined; entry = nextInQueue(world, machine, entry)) {
    const vehicle = partnerById(world, entry.vehicleId as EntityId);
    const job = vehicle === undefined || jobIdOfPartner(vehicle) === null ? undefined : world.jobs.get(jobIdOfPartner(vehicle) as EntityId);
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
      enter(machine, planLift(machine));
    } else {
      enter(machine, travel);
    }
    return true;
  }
  if (!stalled && startPrefetch(world, machine, block)) return true;
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

/**
 * Koniec `lift`: jednotka z vozidla / stohu do `in_handler`. Pri `put` je ťahač **voľný hneď po zdvihu** (ADR-040 dodatok TR3-02): `put` usadí rezerváciu slotu na skutočnú vrstvu stohu,
 * job vozidla sa dokončí (`completeDrop` — `JobDone`, vozidlo `idle`) a cyklus stroja pokračuje bez vozidla a jobu (`vehicleId` a `jobId` `null`; rezerváciu slotu drží cyklus, nie job).
 * Ďalší ťahač tak vojde na TP, kým stroj ešte ukladá.
 */
function pickUp(world: World, machine: RtgCrane, block: RtgBlock, cycle: MachineCycle): void {
  const handler: CargoLocation = { kind: 'in_handler', machineId: machine.id };
  world.cargo.move(cycle.unitId as EntityId, handler);
  if (cycle.kind === 'take') block.recordTaken(cycle.unitId as EntityId);
  if (cycle.kind === 'put') {
    const vehicle = vehicleOfCycle(world, machine, cycle);
    const job = jobOfCycle(world, machine, cycle);
    settleYardDrop(world, job);
    machine.replaceCycle({ ...cycle, toSlot: slotOf(job.to), vehicleId: null, truck: false, jobId: null });
    if (vehicle.kind === 'truck') finishTruckJob(world, job);
    else completeDrop(world, vehicle, job, HOOK_WAIT_TICKS);
  }
}

/** Koniec `lower`: jednotka z `in_handler` na cieľ cyklu (stoh, alebo vozidlo pri `take`; `take` dokončí job vozidla), alebo rehandle bloku (`relocate`). */
function putDown(world: World, machine: RtgCrane, block: RtgBlock, cycle: MachineCycle): void {
  const unitId = cycle.unitId as EntityId;
  if (cycle.kind === 'relocate') {
    const slot = cycle.toSlot as number;
    world.cargo.move(unitId, { kind: 'in_storage', moduleId: block.id, slot });
    endRelocation(world, block, unitId, slot);
    return;
  }
  if (cycle.kind === 'take') {
    const vehicle = vehicleOfCycle(world, machine, cycle);
    const job = jobOfCycle(world, machine, cycle);
    if (vehicle.kind === 'truck') {
      world.cargo.move(unitId, { kind: 'in_truck', truckId: vehicle.id });
      finishTruckJob(world, job);
      return;
    }
    world.cargo.move(unitId, { kind: 'in_vehicle', vehicleId: vehicle.id });
    completeLoad(world, vehicle, job, HOOK_WAIT_TICKS);
    return;
  }
  const place = cycle.toSlot;
  if (place === null) throw new MachineError('inconsistent', `${machine.label}: cyklus put bez cieľového slotu`);
  const target = block.cargoDropTarget();
  target.assertCommittable(place, unitId);
  world.cargo.move(unitId, { kind: 'in_storage', moduleId: block.id, slot: place });
  target.commit(place, unitId);
  onEmptyStored(world, unitId, block);
}

/** Obsluha kamióna skončila (zdvih z kamióna pri `put`, položenie na kamión pri `take`): job `open → done`, `JobDone`; kamión zanikom jobu pokračuje (`trucks/tp-service.ts`). */
function finishTruckJob(world: World, job: TransportJob): void {
  job.transition('done');
  world.removeJob(job.id);
  world.events.emit({ type: 'JobDone', jobId: job.id });
}

/** Koniec fázy: ledger, potom ďalšia fáza (alebo `idle`). */
function onPhaseEnd(world: World, machine: RtgCrane, block: RtgBlock): void {
  const cycle = machine.cycle;
  if (cycle === null) throw new MachineError('inconsistent', `${machine.label}: fáza '${machine.state}' bez cyklu`);
  const { pick, drop } = spotsOf(world, block, cycle);
  switch (NEXT_AFTER[machine.state]) {
    case 'lift':
      enterHeld(world, machine, block, cycle, planLift(machine));
      return;
    case 'carry':
      // `put` pred zdvihom (vozidlo ešte v cykle) je v `shift` len ako čakanie nad TP (`holdForVehicle`): po ňom nasleduje zdvih, nie nosenie.
      if (cycle.kind === 'put' && cycle.vehicleId !== null && machine.state === 'shift') {
        enterHeld(world, machine, block, cycle, planLift(machine));
        return;
      }
      if (machine.state !== 'lift') {
        enterHeld(world, machine, block, cycle, planAfterCarry(machine, block, pick, drop));
        return;
      }
      pickUp(world, machine, block, cycle);
      enterHeld(world, machine, block, cycle, planAfterCarry(machine, block, pick, spotsOf(world, block, machine.cycle as MachineCycle).drop));
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
  /** Krok 6c: čakajúce vozidlá sa zaradia do front strojov (raz za tick) a každý stroj (vzostupne podľa id) posunie svoj cyklus o jeden tick. */
  tick(world: World): void {
    if (world.machines.size === 0) return;
    enqueueWaiting(world);
    for (const machine of world.machines.values()) {
      if (!(machine instanceof RtgCrane)) continue;
      const block = blockOf(world, machine);
      pruneQueue(world, machine);
      if (isIdle(machine)) {
        startCycle(world, machine, block);
        continue;
      }
      const cycle = machine.cycle;
      // Job zrušený / vozidlo zaniklo uprostred cyklu (napr. predzásobenie): cyklus sa vzdá bez výnimky, jednotka sa vráti do stohu.
      if (cycle !== null && cycleOrphaned(world, cycle) && abortCycle(world, machine, block, cycle)) continue;
      if (!machine.advancePhase()) continue;
      onPhaseEnd(world, machine, block);
      // Stroj, ktorý práve dokončil (alebo vzdal) cyklus, začne ďalší hneď (bez zbytočného ticku v `idle`).
      if (isIdle(machine)) {
        pruneQueue(world, machine);
        startCycle(world, machine, block);
      }
    }
  }
}
