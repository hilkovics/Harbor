/**
 * Poloha vozíka a náklad žeriava STS pre prezentáciu (TR3-05, VM `CraneVM.trolleyY` a `CraneVM.cargo`): čistý dotaz nad stavom FSM žeriava, nič sa neukladá.
 *
 * Vozík jazdí po výložníku kolmo na nábrežie: `0` = nad loďou (morský koniec), `1` = nad hákom pri pevnine (bunka pod hákom). Vykládka (`unload`, `dual_unload`) ide `grabbing` nad
 * loďou (0) → `placing` 0 → 1 podľa postupu fázy; nakládka (`load`, `dual_load`) `grabbing` pri háku (1) → `placing` 1 → 0. Žeriav mimo cyklu (`idle`, `blocked`) stojí pri háku (1).
 * Náklad = jednotka, ktorú žeriav práve drží (`heldUnitId`, `in_crane` v ledgeri), inak `null`.
 */
import { CRANE_CYCLE_TRAITS, type CraneModule } from './crane-module';

/** Vozík pri háku (pevninský koniec výložníka). */
const LAND_END = 1;
/** Vozík nad loďou (morský koniec výložníka). */
const SEA_END = 0;

/** Poloha vozíka `0 … 1` (viď hlavička). */
export function craneTrolley(crane: Pick<CraneModule, 'state' | 'cycle' | 'phaseTicksLeft' | 'phaseTicksTotal'>): number {
  const unloading = CRANE_CYCLE_TRAITS[crane.cycle].direction === 'unload';
  const pickup = unloading ? SEA_END : LAND_END;
  if (crane.state === 'idle' || crane.state === 'blocked') return LAND_END;
  if (crane.state === 'grabbing') return pickup;
  const progress = crane.phaseTicksTotal === 0 ? 1 : 1 - crane.phaseTicksLeft / crane.phaseTicksTotal;
  const place = unloading ? LAND_END : SEA_END;
  return pickup + (place - pickup) * progress;
}

/** Id jednotky v háku žeriava, alebo `null`. */
export function craneCargo(crane: Pick<CraneModule, 'heldUnitId'>): number | null {
  return crane.heldUnitId;
}
