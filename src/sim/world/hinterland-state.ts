/**
 * Parsovanie počítadiel vnútrozemia vo `WorldState` v9 (`hinterland`, F6d, ADR-035): počet, súčet a maximum čakania vpustených kamiónov a počet
 * tých, čo sa vzdali, podľa misie (`delivery`, `collect`), a ticky nedostatku stojísk pre odvoz. Fail-fast `WorldStateError` s JSON pointerom pod
 * `/hinterland/…`. Čakajúce kamióny samotné nie sú v tomto stave — sú to splatné položky plánov (`emptyFlow`, `arrivalPlan` bookingov).
 *
 * Tvar: presné kľúče `HINTERLAND_STATE_KEYS` a `MISSION_WAIT_KEYS`, všetky hodnoty celé ≥ 0; navyše `waitTicksMax ≤ waitTicksTotal` a bez vpustených
 * kamiónov nulové čakanie (`waitTicksTotal`, `waitTicksMax`).
 */
import { HINTERLAND_STATE_KEYS, MISSION_WAIT_KEYS, type HinterlandState, type MissionWaitState } from '../trucks/hinterland';
import { WorldStateError, checkInteger, checkKeys } from './state-check';

/** Počítadlá jednej misie (`/hinterland/<misia>`). */
function parseMissionWait(raw: unknown, path: string): MissionWaitState {
  const fields = checkKeys(raw, MISSION_WAIT_KEYS, path);
  const admitted = checkInteger(fields['admitted'], 0, `${path}/admitted`);
  const waitTicksTotal = checkInteger(fields['waitTicksTotal'], 0, `${path}/waitTicksTotal`);
  const waitTicksMax = checkInteger(fields['waitTicksMax'], 0, `${path}/waitTicksMax`);
  const turnedAway = checkInteger(fields['turnedAway'], 0, `${path}/turnedAway`);
  if (waitTicksMax > waitTicksTotal) throw new WorldStateError(`${path}/waitTicksMax`, `najdlhšie čakanie ${String(waitTicksMax)} presahuje súčet ${String(waitTicksTotal)}`);
  if (admitted === 0 && waitTicksTotal > 0) throw new WorldStateError(`${path}/waitTicksTotal`, `bez vpustených kamiónov nemôže byť čakanie ${String(waitTicksTotal)}`);
  return { admitted, waitTicksTotal, waitTicksMax, turnedAway };
}

/** Overí `hinterland` (viď hlavička súboru). Výsledok nezdieľa objekty so vstupom. */
export function parseHinterlandState(raw: unknown): HinterlandState {
  const state = checkKeys(raw, HINTERLAND_STATE_KEYS, '/hinterland');
  return {
    delivery: parseMissionWait(state['delivery'], '/hinterland/delivery'),
    collect: parseMissionWait(state['collect'], '/hinterland/collect'),
    pickupBayStarvationTicks: checkInteger(state['pickupBayStarvationTicks'], 0, '/hinterland/pickupBayStarvationTicks'),
  };
}
