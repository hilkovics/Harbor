/**
 * Zjednodušený stowage plán F6a (ARCHITECTURE §7.2, §7.3; docs/tasks/phase-06a.md rozhodnutie 8; ADR-032 bod 8):
 * poradie nakládky exportných jednotiek jednej voyage je **úplné usporiadanie** `heavy → medium → light`, pri zhode
 * vzostupne podľa id. Je to čistá funkcia štítkov jednotky (nemenných od vzniku), preto sa plán neukladá — dispatcher
 * (sklad → apron) aj žeriav (apron → loď) ho kedykoľvek odvodia rovnako, aj po načítaní save. Viac cieľových prístavov
 * na voyage a 40'/20' pribudnú vo F12 (ADR).
 */
import type { EntityId } from '../core/entity-id';
import type { WeightClass } from './cargo-unit';

/** Poradie hmotnostnej triedy v pláne: menšie = skôr (ťažké naspodok, rozhodnutie 8). */
export const STOWAGE_WEIGHT_RANK: { readonly [W in WeightClass]: number } = Object.freeze({ heavy: 0, medium: 1, light: 2 });

/** Čo z jednotky stowage plán číta. */
export interface StowageKey {
  readonly id: EntityId;
  readonly weightClass: WeightClass;
}

/**
 * Porovnanie dvoch jednotiek podľa stowage plánu (záporné = `a` sa nakladá skôr): hmotnostná trieda
 * (`STOWAGE_WEIGHT_RANK`), potom id. Dve rôzne jednotky nie sú nikdy rovnocenné (id sú jedinečné).
 */
export function compareStowageOrder(a: StowageKey, b: StowageKey): number {
  const rank = STOWAGE_WEIGHT_RANK[a.weightClass] - STOWAGE_WEIGHT_RANK[b.weightClass];
  return rank !== 0 ? rank : a.id - b.id;
}
