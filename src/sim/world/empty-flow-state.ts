/**
 * Parsovanie plánu prázdnych kontajnerov vo `WorldState` v8 (`emptyFlow`, F6c, ADR-034): `returnPlan` (návraty z vnútrozemia)
 * a `pickupPlan` (výdaj prázdneho exportérovi). Fail-fast `WorldStateError` s JSON pointerom pod `/emptyFlow/…`.
 *
 * Tvar: presné kľúče `EMPTY_FLOW_STATE_KEYS` a položiek (`RETURN_PLAN_ENTRY_KEYS`, `PICKUP_PLAN_ENTRY_KEYS`), `dueTick` celé ≥ 0
 * neklesajúce, `lineId` linka z `lines.json`, `contractId` (výdaj) celé ≥ 1. Súlad s knihou kontraktov (booking existuje a patrí
 * linke) overuje T6C-02, keď sa plán začne napĺňať.
 */
import type { DefRegistry } from '../defs/def-registry';
import {
  EMPTY_FLOW_STATE_KEYS,
  PICKUP_PLAN_ENTRY_KEYS,
  RETURN_PLAN_ENTRY_KEYS,
  type EmptyFlowState,
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
  return { returnPlan, pickupPlan };
}
