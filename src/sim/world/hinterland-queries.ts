/**
 * Dotazy nad vnútrozemím pre prezentáciu a metriky (F6d, ADR-035) — čisté funkcie nad svetom, nič nemenia a nie sú hot path ticku (volá ich snapshot
 * pre UI a `simrun`):
 * - `hinterlandQueue` — kamióny, ktoré práve čakajú vo vnútrozemí pred vjazdom do prístavu, podľa misie (údaj pre inšpektor brány) a najdlhšie čakanie;
 * - `hinterlandMetrics` — počítadlá čakania vpustených kamiónov (priemer a maximum v tickoch, počet vpustených a tých, čo sa vzdali) a nedostatok tokenov (TP, státí)
 *   pre odvoz (`pickupBayStarvationTicks`).
 *
 * Čakajúci kamión = splatná položka plánu (`dueTick ≤ tick`): návrat prázdneho (`returnPlan`), výdaj prázdneho (`pickupPlan`, booking beží) a export
 * (`arrivalPlan` bookingu po prijatí) — `delivery` je export + návrat. Kamióny na odvoz importu (`pickup`) nečakajú v zozname: ich dopyt je počet
 * jednotiek v sklade, na ktoré kamión ešte nevznikol (`forEachPickupCandidate`).
 */
import type { ContractId } from '../core/entity-id';
import { CONTRACT_STATE_TRAITS } from '../contracts/contract-fsm';
import { WAITING_MISSIONS, type WaitingMission } from '../trucks/hinterland';
import { forEachPickupCandidate } from '../logistics/pickup-demand';
import type { World } from './world';

/** Kamióny čakajúce vo vnútrozemí podľa misie (viď hlavička súboru). */
export interface HinterlandQueue {
  /** Kamióny na odvoz importu, ktoré by vznikli na náklad čakajúci na dockoch (dopyt, nie zoznam). */
  readonly pickup: number;
  /** Kamióny s dovozom (export + návrat prázdneho) čakajúce na vjazd. */
  readonly delivery: number;
  /** Kamióny po prázdny kontajner (výdaj exportérovi) čakajúce na vjazd. */
  readonly collect: number;
  /** Súčet všetkých misií. */
  readonly total: number;
  /** Najdlhšie čakanie spomedzi čakajúcich kamiónov `delivery` a `collect` (ticky od `dueTick`); 0, keď nikto nečaká. */
  readonly oldestWaitTicks: number;
}

/** Počítadlá čakania jednej misie (kumulatívne od začiatku hry, v save). */
export interface MissionWaitMetrics {
  readonly admitted: number;
  readonly turnedAway: number;
  /** Priemerné čakanie vpusteného kamióna (ticky; 0, keď nikto vpustený nebol). */
  readonly waitTicksAvg: number;
  readonly waitTicksMax: number;
}

/** Metriky vnútrozemia (viď hlavička súboru). */
export interface HinterlandMetrics {
  /** Kamióny čakajúce teraz (`hinterlandQueue`). */
  readonly waiting: HinterlandQueue;
  readonly delivery: MissionWaitMetrics;
  readonly collect: MissionWaitMetrics;
  /** Čakanie vpustených kamiónov všetkých misií: priemer a maximum (ticky). */
  readonly waitTicks: { readonly avg: number; readonly max: number };
  /** Ticky, v ktorých dopyt po kamióne na odvoz nemal token (TP ani státie). */
  readonly pickupBayStarvationTicks: number;
}

/** Dopyt po kamiónoch na odvoz: počet jednotiek v sklade, ktoré treba odviezť a kamión na ne ešte nevznikol (`logistics/pickup-demand.ts`; prechod len pri snapshote, nie v ticku). */
function pickupDemand(world: World): number {
  let demand = 0;
  forEachPickupCandidate(world, () => {
    demand += 1;
    return true;
  });
  return demand;
}

/** Kamióny čakajúce vo vnútrozemí pred vjazdom do prístavu (viď hlavička súboru). */
export function hinterlandQueue(world: World): HinterlandQueue {
  const { tick } = world.clock;
  let delivery = 0;
  let collect = 0;
  let oldest = 0;
  const waited = (dueTick: number): void => {
    if (tick - dueTick > oldest) oldest = tick - dueTick;
  };
  for (const entry of world.emptyFlow.returnPlan) {
    if (entry.dueTick > tick) break;
    delivery += 1;
    waited(entry.dueTick);
  }
  for (const entry of world.emptyFlow.pickupPlan) {
    if (entry.dueTick > tick) break;
    if (!world.contractBook.openContracts.has(entry.contractId as ContractId)) continue;
    collect += 1;
    waited(entry.dueTick);
  }
  for (const contract of world.contractBook.openContracts.values()) {
    if (CONTRACT_STATE_TRAITS[contract.state].plan !== 'required') continue;
    for (const dueTick of contract.booking?.arrivalPlan ?? []) {
      if (dueTick > tick) break;
      delivery += 1;
      waited(dueTick);
    }
  }
  const pickup = pickupDemand(world);
  return { pickup, delivery, collect, total: pickup + delivery + collect, oldestWaitTicks: oldest };
}

/** Metriky čakania vnútrozemia (viď hlavička súboru). */
export function hinterlandMetrics(world: World): HinterlandMetrics {
  const { hinterland } = world;
  let admitted = 0;
  let total = 0;
  let max = 0;
  const perMission = {} as { [M in WaitingMission]: MissionWaitMetrics };
  for (const mission of WAITING_MISSIONS) {
    const count = hinterland.admitted(mission);
    const sum = hinterland.waitTicksTotal(mission);
    perMission[mission] = { admitted: count, turnedAway: hinterland.turnedAway(mission), waitTicksAvg: count === 0 ? 0 : sum / count, waitTicksMax: hinterland.waitTicksMax(mission) };
    admitted += count;
    total += sum;
    max = Math.max(max, hinterland.waitTicksMax(mission));
  }
  return {
    waiting: hinterlandQueue(world),
    delivery: perMission.delivery,
    collect: perMission.collect,
    waitTicks: { avg: admitted === 0 ? 0 : total / admitted, max },
    pickupBayStarvationTicks: hinterland.pickupBayStarvationTicks,
  };
}
