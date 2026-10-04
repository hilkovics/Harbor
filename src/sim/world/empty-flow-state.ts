/**
 * Parsovanie plánu prázdnych kontajnerov vo `WorldState` v8 (`emptyFlow`, F6c, ADR-034): `returnPlan` (návraty z vnútrozemia)
 * a `pickupPlan` (výdaj prázdneho exportérovi) a `errands` (poverenia kamiónov misie `collect`, dodatok T6C-02). Fail-fast
 * `WorldStateError` s JSON pointerom pod `/emptyFlow/…`.
 *
 * Tvar: presné kľúče `EMPTY_FLOW_STATE_KEYS` a položiek (`RETURN_PLAN_ENTRY_KEYS`, `PICKUP_PLAN_ENTRY_KEYS`, `ERRAND_ENTRY_KEYS`),
 * `dueTick` celé ≥ 0 neklesajúce, `lineId` linka z `lines.json`, `contractId` (výdaj, poverenie) celé ≥ 1, poverenia vzostupne podľa
 * `truckId`, `unitId` `null` alebo celé ≥ 1, `giveUpTick` `null` (kamión ešte nedorazil do stojiska) alebo celé ≥ 0. Súlad s kontraktmi a plánom
 * zachytáva obnova: výdaj `pickupPlan` musí ukazovať na kontrakt druhu `export` v knihe a jeho linku (`checkPickupPlan` vo `world-restore`, fail-fast
 * `WorldStateError` s pointerom `/emptyFlow/pickupPlan/i/…`); poverenia (kamión misie `collect`, kontrakt a linka, jednotka prázdna tej istej linky)
 * overuje invariant sveta (`findWorldViolation`, `checkEmptyFlow`), ktorý beží pri obnove aj po každom ticku.
 */
import type { DefRegistry } from '../defs/def-registry';
import {
  EMPTY_FLOW_STATE_KEYS,
  ERRAND_ENTRY_KEYS,
  PICKUP_PLAN_ENTRY_KEYS,
  RETURN_PLAN_ENTRY_KEYS,
  type EmptyFlowState,
  type ErrandEntry,
  type PickupPlanEntry,
  type ReturnPlanEntry,
} from '../logistics/empty-flow';
import { WorldStateError, checkArray, checkInteger, checkKeys, describeValue, pointerSegment } from './state-check';

/** Linka záznamu plánu: reťazec z `lines.json`. */
function checkLine(value: unknown, defs: DefRegistry, path: string): string {
  if (typeof value !== 'string' || !defs.lines.has(value)) throw new WorldStateError(path, `neznáma linka ${describeValue(value)}`);
  return value;
}

/** `dueTick` celé ≥ 0, neklesajúce voči predchádzajúcej položke (`previous`). */
function checkDue(value: unknown, previous: number, path: string): number {
  const due = checkInteger(value, 0, path);
  if (due < previous) throw new WorldStateError(path, `plán musí byť zoradený neklesajúco podľa dueTick (${String(due)} po ${String(previous)})`);
  return due;
}

/** Overí `emptyFlow` (viď hlavička súboru). Výsledok nezdieľa objekty so vstupom. */
export function parseEmptyFlowState(raw: unknown, defs: DefRegistry): EmptyFlowState {
  const state = checkKeys(raw, EMPTY_FLOW_STATE_KEYS, '/emptyFlow');
  let previous = 0;
  const returnPlan = checkArray(state['returnPlan'], '/emptyFlow/returnPlan').map((entry: unknown, i): ReturnPlanEntry => {
    const path = `/emptyFlow/returnPlan${pointerSegment(i)}`;
    const fields = checkKeys(entry, RETURN_PLAN_ENTRY_KEYS, path);
    previous = checkDue(fields['dueTick'], previous, `${path}/dueTick`);
    return { dueTick: previous, lineId: checkLine(fields['lineId'], defs, `${path}/lineId`) };
  });
  previous = 0;
  const pickupPlan = checkArray(state['pickupPlan'], '/emptyFlow/pickupPlan').map((entry: unknown, i): PickupPlanEntry => {
    const path = `/emptyFlow/pickupPlan${pointerSegment(i)}`;
    const fields = checkKeys(entry, PICKUP_PLAN_ENTRY_KEYS, path);
    previous = checkDue(fields['dueTick'], previous, `${path}/dueTick`);
    return { dueTick: previous, lineId: checkLine(fields['lineId'], defs, `${path}/lineId`), contractId: checkInteger(fields['contractId'], 1, `${path}/contractId`) };
  });
  let previousTruck = 0;
  const errands = checkArray(state['errands'], '/emptyFlow/errands').map((entry: unknown, i): ErrandEntry => {
    const path = `/emptyFlow/errands${pointerSegment(i)}`;
    const fields = checkKeys(entry, ERRAND_ENTRY_KEYS, path);
    const truckId = checkInteger(fields['truckId'], 1, `${path}/truckId`);
    if (truckId <= previousTruck) throw new WorldStateError(`${path}/truckId`, `poverenia musia byť vzostupne podľa truckId (${String(truckId)} po ${String(previousTruck)})`);
    previousTruck = truckId;
    return {
      truckId,
      lineId: checkLine(fields['lineId'], defs, `${path}/lineId`),
      contractId: checkInteger(fields['contractId'], 1, `${path}/contractId`),
      unitId: fields['unitId'] === null ? null : checkInteger(fields['unitId'], 1, `${path}/unitId`),
      giveUpTick: fields['giveUpTick'] === null ? null : checkInteger(fields['giveUpTick'], 0, `${path}/giveUpTick`),
    };
  });
  return { returnPlan, pickupPlan, errands };
}
