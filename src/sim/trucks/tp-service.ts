/**
 * Kamión na odovzdávacom mieste (TP; R4, ADR-041 bod 4, 6 a 7; docs/TERMINAL_2.md §6.4, §6.5) — fázy pobytu (`Truck.phase`), odovzdanie, dual transaction a odchod z TP.
 *
 * Fázy podľa úlohy (`TP_PHASE_SEQUENCE`): `take` = bezpečná zóna (`safeZoneTicks`) → odovzdanie → bezpečná zóna → lashing (`lashTicks`); `put` = bezpečná zóna → unlashing (`unlashTicks`) →
 * odovzdanie → bezpečná zóna. Fáza s nulovým časom sa preskočí. V **odovzdaní** (`handling`) kamión čaká, kým stroj bloku (RTG, `systems/yard-machine-system.ts`) alebo straddle carrier
 * (dispatcher mu priradí job, `logistics/dispatcher.ts`) neodovzdá jednotku — koniec spozná podľa zániku jobu (`Truck.jobId` už nie je vo `world.jobs`). Osoby sa nekreslia (ADR-036): bezpečná
 * zóna a lashing sú len čas a stav.
 *
 * **Odchod** (`depart`): `put` kamión (delivery) sa najprv pokúsi o **dual transaction** — nájde jednotku na odvoz (`forEachPickupCandidate`) s voľným TP a cestou tam aj von, nárokuje si ju
 * (job `receive`), zmení misiu na `pickup` a pokračuje na ďalšie TP s tým istým lístkom (`to_tp`; na tom istom TP rovno `handling`). Inak odchádza k výstupnej bráne (`to_gate_out`):
 * TP v pruhu bloku len rozbehne jazdu, TP na hrane bloku (kamión je mimo cesty) vyžaduje voľný slot výjazdovej bunky, inak čaká.
 */
import type { World } from '../world/world';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import { forEachPickupCandidate } from '../logistics/pickup-demand';
import type { YardBlock } from '../modules/yard-block';
import { openReceiveJob } from '../logistics/truck-jobs';
import { slotOf } from '../cargo/cargo-location';
import { nearBayOfSlot, reserveToken } from './destination';
import type { Truck } from './truck';
import { TP_PHASE_SEQUENCE, TP_ROLE_OF_MISSION, changeTruckState, type TpPhase } from './truck-fsm';
import { canExitTo, exitTo, startTruckTrip } from './truck-trip';

/** Najviac kandidátov na odvoz, ktoré dual transaction porovná (deterministický strop prechodu dopytov). */
const DUAL_CANDIDATE_LIMIT = 64;

/** Trvanie fázy v tickoch z defu kamióna; `handling` a `depart` nemajú pevný čas (pripnuté na 1). */
function phaseTicks(truck: Truck, phase: TpPhase): number {
  switch (phase) {
    case 'safe_in':
    case 'safe_out':
      return truck.def.safeZoneTicks;
    case 'unlash':
      return truck.def.unlashTicks;
    case 'lash':
      return truck.def.lashTicks;
    case 'handling':
    case 'depart':
      return 1;
  }
}

/** Fáza po `phase` podľa úlohy kamióna (`TP_PHASE_SEQUENCE`); po poslednej `depart`. */
function nextPhase(truck: Truck, phase: TpPhase): TpPhase {
  const sequence = TP_PHASE_SEQUENCE[TP_ROLE_OF_MISSION[truck.mission]];
  return sequence[sequence.indexOf(phase) + 1] ?? 'depart';
}

/** Vstúpi do fázy `phase` (nulové fázy preskočí): `phase` a odpočet `waitTicks ≥ 1`. */
function enterPhase(truck: Truck, phase: TpPhase): void {
  let next = phase;
  while (phaseTicks(truck, next) === 0) next = nextPhase(truck, next);
  truck.phase = next;
  truck.waitTicks = phaseTicks(truck, next);
}

/** Príchod na TP (`to_tp` → `at_tp` v pruhu bloku, `at_edge_tp` na hrane): začína prvá fáza úlohy. */
export function arriveAtTp(world: World, truck: Truck, onLane: boolean): void {
  changeTruckState(world.events, truck, onLane ? 'at_tp' : 'at_edge_tp');
  enterPhase(truck, TP_PHASE_SEQUENCE[TP_ROLE_OF_MISSION[truck.mission]][0]);
}

/** Kandidát druhej zastávky: jednotka, blok a TP. */
interface DualChoice {
  readonly unit: CargoUnit;
  readonly block: YardBlock;
  readonly cell: number;
}

/** Dual transaction (viď hlavička): `true`, keď si kamión nárokoval ďalšiu jednotku a pokračuje druhou zastávkou. */
function tryDualTransaction(world: World, truck: Truck): boolean {
  let best: DualChoice | undefined;
  let bestCost = Infinity;
  let seen = 0;
  forEachPickupCandidate(world, (unit, block) => {
    const slot = slotOf(unit.location);
    if (slot === null) return true;
    const token = reserveToken(world, block, nearBayOfSlot(block, slot), false, truck.id);
    if (token === null || token.kind !== 'tp') return true;
    const cost = token.cell === truck.cell ? 0 : world.distances.distance(truck.cell, token.cell);
    if (Number.isFinite(cost) && cost < bestCost) {
      best = { unit, block, cell: token.cell };
      bestCost = cost;
    }
    seen += 1;
    return seen < DUAL_CANDIDATE_LIMIT;
  });
  if (best === undefined) return false;
  const choice: DualChoice = best;
  const edge = truck.state === 'at_edge_tp';
  const previousCell = truck.tpCell;
  const sameTp = choice.cell === previousCell;
  truck.tpCell = choice.cell;
  if (!sameTp && edge && !canExitTo(world, truck, truck.cell, 'to_tp')) {
    truck.tpCell = previousCell;
    return false;
  }
  world.events.emit({ type: 'TruckUnloaded', truckId: truck.id, blockId: truck.blockId, unitId: truck.unitId as EntityId, dualTransaction: true });
  truck.becomePickup();
  truck.blockId = choice.block.id;
  openReceiveJob(world, truck, choice.unit, choice.block);
  if (sameTp) {
    enterPhase(truck, 'handling');
    return true;
  }
  truck.phase = null;
  truck.waitTicks = 0;
  if (edge) exitTo(world, truck, truck.cell, 'to_tp');
  else startTruckTrip(world, truck, 'to_tp');
  return true;
}

/** Odchod z TP k výstupnej bráne; `false` = kamión na hrane bloku nemá voľný slot výjazdovej bunky a skúsi to v ďalšom ticku. */
function leaveTp(world: World, truck: Truck): boolean {
  const edge = truck.state === 'at_edge_tp';
  if (edge && !canExitTo(world, truck, truck.cell, 'to_gate_out')) return false;
  if (truck.mission === 'delivery') {
    world.events.emit({ type: 'TruckUnloaded', truckId: truck.id, blockId: truck.blockId, unitId: truck.unitId as EntityId, dualTransaction: false });
  }
  truck.tpCell = null;
  truck.phase = null;
  truck.jobId = null;
  truck.unitId = null;
  truck.waitTicks = 0;
  if (edge) exitTo(world, truck, truck.cell, 'to_gate_out');
  else startTruckTrip(world, truck, 'to_gate_out');
  return true;
}

/** Jeden tick kamióna na TP: odpočet fázy, koniec odovzdania (job zanikol), odchod / dual transaction. */
export function stepTp(world: World, truck: Truck): void {
  const phase = truck.phase;
  if (phase === null) return;
  if (phase === 'handling') {
    if (truck.jobId !== null && world.jobs.has(truck.jobId)) return;
    truck.jobId = null;
    enterPhase(truck, nextPhase(truck, 'handling'));
    return;
  }
  if (phase === 'depart') {
    if (truck.mission === 'delivery' && tryDualTransaction(world, truck)) return;
    leaveTp(world, truck);
    return;
  }
  truck.waitTicks = Math.max(0, truck.waitTicks - 1);
  if (truck.waitTicks === 0) enterPhase(truck, nextPhase(truck, phase));
}
