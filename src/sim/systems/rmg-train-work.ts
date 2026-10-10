/**
 * Práca RMG s vlakom (R6, ADR-043 TR6-02; docs/TERMINAL_2.md §5, §6.9) — plánovanie cyklov stroja `RmgCrane` s partnerom `trainId` a poloha vagónov pre pojazd rámu. Volá ju `YardMachineSystem`
 * (krok 6c) pred frontou ťahačov: vlak má prednosť pred ťahačom a housekeepingom (`equipment.json` → `rmg.priorities.train`); aby ťahač pri dlhej obsluhe vlaka nestál bez konca,
 * pri čakajúcom ťahači sa cykly vlaka a ťahača striedajú (`serveQueueFirst`).
 *
 * **Vlak na koľaji terminálu** (`dwelling`, najmenšie id skôr):
 * 1. **Vykládka** — najbližšia jednotka vo vlaku iného smeru než `import` (export privezený vlakom; od lokomotívy) sa zdvihne a uloží do bufferu (`in_train → in_handler → in_storage`, slot
 *    z plánovača bloku, rezervovaný pri začiatku cyklu). Kým nie je vlak vyložený, neodíde (`RailSystem`).
 * 2. **Nakládka po vagónoch** — z bufferu sa zoberie import určený na odvoz (vrchný kontajner stohu bez jobu) na prvé miesto, ktoré sa zmestí (`findTrainSlot`: vagóny od lokomotívy, jeden vagón
 *    sa naplní 3 TEU — 40′ + 20′ alebo 3× 20′ — skôr než začne ďalší); z viacerých kandidátov sa berie ten s najnižším miestom (lokomotíva ako prvá), potom najmenšie id. Zavalený kandidát sa
 *    odkryje rehandlingom v bufferi (`relocate`).
 *
 * Poloha vozňa: vlak stojí s čelom lokomotívy na konci koľaje, TEU miesto `s` leží v bayi `trainSlotBay` (jedna bunka koľaje = jeden bay), vozík nad koľajou `track` je v rade `trackRow(track)`.
 */
import { teuOf } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import { chooseSlotInBlock, chooseRehandleSlot } from '../logistics/yard-planner';
import { trackRow } from '../machines/rmg-crane';
import type { RmgCrane } from '../machines/rmg-crane';
import type { MachineCycle } from '../machines/machine-state-types';
import type { RailTerminal } from '../modules/rail-terminal';
import { findTrainSlot, trainSlotMap } from '../rail/train-cargo';
import type { Train } from '../rail/train';
import type { World } from '../world/world';

/** Bay (spojitý) stredu jednotky na TEU mieste `slot` vlaku, ktorý stojí na konci koľaje terminálu s `bays` bayami (40′ zaberá dve miesta → stred medzi nimi). */
export function trainSlotBay(train: Train, bays: number, slot: number, teu: number): number {
  const cellsPerTeu = train.def.wagonLengthCells / train.def.wagonTeu;
  const center = (slot + teu / 2) * cellsPerTeu;
  return Math.min(bays - 1, Math.max(0, bays - 1 - train.def.locoLengthCells - center + 0.5));
}

/** Rad vozíka nad koľajou vlaka (`rmg-crane.ts` → `trackRow`). */
export function trainRow(train: Train): number {
  return trackRow(train.track);
}

/** Vlaky na koľaji terminálu `block`, ktoré stoja a smú sa obsluhovať (vzostupne podľa id). */
export function dwellingTrains(world: World, block: RailTerminal): readonly Train[] {
  const trains: Train[] = [];
  for (const train of world.trains.values()) if (train.terminalId === block.id && train.state === 'dwelling') trains.push(train);
  return trains;
}

/** Je stroj práve v cykle s vlakom `trainId` (vlak nesmie odísť)? */
export function machineWorksOnTrain(world: World, trainId: EntityId): boolean {
  for (const machine of world.machines.values()) if (machine.cycle?.trainId === trainId) return true;
  return false;
}

/** Má stroj teraz obslúžiť ťahač pred vlakom (striedanie pri čakajúcom ťahači: nepárny počet hotových cyklov)? */
export function serveQueueFirst(machine: RmgCrane): boolean {
  return machine.queue.length > 0 && machine.moves % 2 === 1;
}

/** Vyloženie: cyklus `put` z vlaka do bufferu pre prvú jednotku iného smeru než import; `null`, keď nie je čo vykladať alebo buffer nemá miesto. Rezervuje slot v bufferi. */
function planUnload(world: World, block: RailTerminal, train: Train): MachineCycle | null {
  let first: { readonly unitId: EntityId; readonly slot: number } | undefined;
  for (const unitId of world.cargo.unitsAt('in_train', train.id)) {
    const unit = world.cargo.get(unitId);
    if (unit === undefined || unit.location.kind !== 'in_train' || unit.direction === 'import') continue;
    if (first === undefined || unit.location.slot < first.slot) first = { unitId, slot: unit.location.slot };
  }
  if (first === undefined) return null;
  const unit = world.cargo.get(first.unitId);
  if (unit === undefined) return null;
  const toSlot = chooseSlotInBlock(world, block, unit);
  if (toSlot === null) return null;
  block.reserveFor(toSlot, unit);
  return { kind: 'put', unitId: unit.id, vehicleId: null, truck: false, jobId: null, fromSlot: null, toSlot, tpBay: first.slot, trainId: train.id };
}

/** Nakládka: cyklus `take` z bufferu na vlak, alebo `relocate` zavalenej jednotky (viď hlavička); `null`, keď nie je čo naložiť (alebo sa nič nezmestí). */
function planLoad(world: World, block: RailTerminal, train: Train): MachineCycle | null {
  let best: { readonly unitId: EntityId; readonly slot: number; readonly trainSlot: number } | undefined;
  let buried: { readonly unitId: EntityId; readonly slot: number } | undefined;
  const taken = trainSlotMap(world.cargo, train);
  for (const unitId of world.cargo.unitsAt('in_storage', block.id)) {
    const unit = world.cargo.get(unitId);
    if (unit === undefined || unit.location.kind !== 'in_storage' || unit.direction !== 'import' || world.jobOfUnit(unitId) !== undefined) continue;
    const trainSlot = findTrainSlot(world.cargo, train, teuOf(unit), taken);
    if (trainSlot === undefined) continue;
    if (block.topBlockerOf(unitId) !== null) {
      if (buried === undefined) buried = { unitId, slot: unit.location.slot };
      continue;
    }
    if (best === undefined || trainSlot < best.trainSlot || (trainSlot === best.trainSlot && unitId < best.unitId)) best = { unitId, slot: unit.location.slot, trainSlot };
  }
  if (best !== undefined) return { kind: 'take', unitId: best.unitId, vehicleId: null, truck: false, jobId: null, fromSlot: best.slot, toSlot: null, tpBay: best.trainSlot, trainId: train.id };
  if (buried === undefined) return null;
  const blockerId = block.topBlockerOf(buried.unitId);
  const blocker = blockerId === null ? undefined : world.cargo.get(blockerId);
  if (blocker === undefined || blocker.location.kind !== 'in_storage') return null;
  const toSlot = chooseRehandleSlot(world, block, blocker, block.positionOfSlot(blocker.location.slot));
  if (toSlot === null) return null;
  return { kind: 'relocate', unitId: blocker.id, vehicleId: null, truck: false, jobId: null, fromSlot: blocker.location.slot, toSlot, tpBay: block.positionOfSlot(blocker.location.slot).bay };
}

/**
 * Ďalší cyklus s vlakom pre stroj bloku `block`: najprv vykládka, potom nakládka, vlaky vzostupne podľa id; `null`, keď žiadny vlak nepotrebuje stroj. Vykládka rezervuje slot v bufferi,
 * volajúci cyklus hneď začne (`machine.beginCycle`).
 */
export function planTrainCycle(world: World, block: RailTerminal): MachineCycle | null {
  for (const train of dwellingTrains(world, block)) {
    if (world.rail.isOverdue(train, world.clock.tick)) continue;
    const cycle = planUnload(world, block, train) ?? planLoad(world, block, train);
    if (cycle !== null) return cycle;
  }
  return null;
}
