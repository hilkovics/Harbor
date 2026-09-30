/**
 * Legitímne cesty, ako testy nastavia stav žeriavu (T02-14: `CraneModule.state` je len getter, zapisuje ho výlučne
 * `transition` a `restoreRuntimeState`):
 * - `driveCrane(crane, target)` — najkratšia cesta po `CRANE_TRANSITIONS` cez `transition()` (FSM). Nemení fázu,
 *   rezerváciu ani držanú jednotku, preto sa hodí aj na zámerne nekonzistentný svet v testoch invariantov a pravidiel.
 * - `restoreCrane(crane, patch)` — `restoreRuntimeState({ ...getRuntimeState(), ...patch })`, teda rovnaká cesta ako
 *   obnova zo save so všetkými kontrolami runtime stavu (rezervácia a fáza podľa stavu).
 */
import { CRANE_TRANSITIONS, type CraneModule, type CraneRuntimeState, type CraneState } from '@sim/modules';

/** Najkratšia cesta stavov `from → … → to` po `CRANE_TRANSITIONS` (bez `from`); nedosiahnuteľný cieľ = chyba testu. */
export function cranePath(from: CraneState, to: CraneState): readonly CraneState[] {
  const previous = new Map<CraneState, CraneState | null>([[from, null]]);
  const queue: CraneState[] = [from];
  while (queue.length > 0) {
    const state = queue.shift() as CraneState;
    if (state === to) break;
    for (const next of CRANE_TRANSITIONS.get(state) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, state);
      queue.push(next);
    }
  }
  if (!previous.has(to)) throw new Error(`stav žeriavu '${to}' nie je z '${from}' dosiahnuteľný po CRANE_TRANSITIONS`);
  const path: CraneState[] = [];
  for (let state: CraneState | null = to; state !== null && state !== from; state = previous.get(state) ?? null) path.unshift(state);
  return path;
}

/** Prevedie žeriav do `target` postupnosťou povolených prechodov FSM (`transition`); v cieľovom stave nerobí nič. */
export function driveCrane(crane: CraneModule, target: CraneState): void {
  for (const state of cranePath(crane.state, target)) crane.transition(state);
}

/** Obnoví runtime stav žeriavu ako loader save: aktuálny stav prepísaný poľami `patch` (kontroly `restoreRuntimeState`). */
export function restoreCrane(crane: CraneModule, patch: Partial<CraneRuntimeState>): void {
  crane.restoreRuntimeState({ ...crane.getRuntimeState(), ...patch });
}
