/**
 * Spustenie nákladu na vozidlo pod hákom (F6d, ADR-033 dodatok T6D-02) — čistá matematika bez Pixi, aby šla testovať v Node.
 *
 * V režime `under_hook` stojí vozidlo pri odovzdaní pod žeriavom (`CraneVM.hook`, bunka v landward riadku footprintu žeriava). Vozík na
 * pevninskom konci výložníka drží kontajner nad osou výložníka; kým sim jednotku odovzdá, renderer ju **spustí na vozidlo**
 * (a pri nakládke ju z vozidla zdvihne) — posunie ju z vozíka na stred bunky pod hákom a pri tom jemne zmenší (kontajner v zdvihu je
 * „bližšie ku kamere“). Podiel spustenia `L` (0 = visí pod vozíkom, 1 = leží na vozidle) závisí len od smeru cyklu a postupu fázy
 * `placing`: vykládka (`unload`, `dual_unload`) klesá v poslednej tretine fázy (žeriav čakajúci na vozidlo má `progress` tesne pod 1,
 * takže ostane spustený nad bunkou pod hákom), nakládka (`load`, `dual_load`) stúpa v prvej tretine (`lift` práve vzal jednotku
 * z vozidla).
 */
import type { Rotation } from '@sim/grid';
import { rotateOffset } from './footprint-pose';
import type { ManifestPoint } from './entity-assets';

/** Vykládka: spúšťanie začína pri tomto postupe `placing` … */
export const HOOK_LOWER_START = 0.55;
/** … a končí pri tomto (potom kontajner leží na vozidle). */
export const HOOK_LOWER_END = 0.8;
/** Nakládka: kontajner stúpa z vozidla do tohto postupu `placing`. */
export const HOOK_LIFT_END = 0.3;
/** Zväčšenie kontajnera v zdvihu (spustený na vozidle = 1). */
export const HOOK_RAISED_SCALE = 1.12;

/** Hladký prechod 0 → 1 medzi `edge0` a `edge1` (mimo rozsahu sa orezáva). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Podiel spustenia nákladu na vozidlo pod hákom: 0 = visí pod vozíkom, 1 = leží na vozidle. Vykládka (`unload`) klesá, nakládka (`load`)
 * stúpa (viď hlavička); mimo `placing` je náklad pod vozíkom, okrem `swinging` nakládky (jednotka je práve zdvihnutá z vozidla).
 */
export function hookLowering(direction: 'unload' | 'load', state: string, progress: number): number {
  if (state === 'swinging') return direction === 'load' ? 1 : 0;
  if (state !== 'placing') return 0;
  return direction === 'unload' ? smoothstep(HOOK_LOWER_START, HOOK_LOWER_END, progress) : 1 - smoothstep(0, HOOK_LIFT_END, progress);
}

/** Mierka kontajnera v zdvihu: `HOOK_RAISED_SCALE` pod vozíkom (`lowering` 0) → 1 na vozidle (`lowering` 1). */
export function hookCargoScale(lowering: number): number {
  return 1 + (HOOK_RAISED_SCALE - 1) * (1 - lowering);
}

/** Inverzná rotácia k `rotation` (kontajner modulu sa otáča v smere hodinových ručičiek, lokálna súradnica = svet otočený späť). */
function inverseRotation(rotation: Rotation): Rotation {
  return ((360 - rotation) % 360) as Rotation;
}

/**
 * Stred bunky pod hákom v lokálnych súradniciach žeriava (px, rot 0, počiatok = stred footprintu žeriava): `hook` je stred bunky vo svete
 * (bunky), `center` stred footprintu žeriava vo svete (px), `rotation` rotácia žeriava.
 */
export function hookLocalPx(center: ManifestPoint, rotation: Rotation, hook: ManifestPoint, cellPx: number): ManifestPoint {
  return rotateOffset(hook.x * cellPx - center.x, hook.y * cellPx - center.y, inverseRotation(rotation));
}
