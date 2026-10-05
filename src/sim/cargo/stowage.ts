/**
 * Zjednodušený stowage plán F6a (ARCHITECTURE §7.2, §7.3; docs/tasks/phase-06a.md rozhodnutie 8; ADR-032 bod 8) s prázdnymi z F6c
 * (ADR-034): poradie nakládky jednotiek jednej lode je **úplné usporiadanie** — plné jednotky (export, prekládka) `heavy → medium →
 * light`, **po nich prázdne kontajnery** repositioningu (`STOWAGE_DIRECTION_RANK`), pri zhode vzostupne podľa id. Je to čistá funkcia
 * štítkov jednotky (nemenných od vzniku), preto sa plán neukladá — dispatcher (sklad → apron / hák) aj žeriav (apron / vozidlo → loď)
 * ho kedykoľvek odvodia rovnako, aj po načítaní save. Viac cieľových prístavov na voyage a 40'/20' pribudnú vo F12 (ADR).
 */
import type { EntityId } from '../core/entity-id';
import type { CargoDirection, WeightClass } from './cargo-unit';

/** Poradie hmotnostnej triedy v pláne: menšie = skôr (ťažké naspodok, rozhodnutie 8). */
export const STOWAGE_WEIGHT_RANK: { readonly [W in WeightClass]: number } = Object.freeze({ heavy: 0, medium: 1, light: 2 });

/**
 * Poradie smeru v pláne: plné jednotky (export, prekládka) pred prázdnymi (`empty` je posledný, ADR-034 bod 10). Import sa nenakladá,
 * takže jeho miesto je len formálne (rovnaké ako pri plných).
 */
export const STOWAGE_DIRECTION_RANK: { readonly [D in CargoDirection]: number } = Object.freeze({ import: 0, export: 0, tranship: 0, empty: 1 });

/** Čo z jednotky stowage plán číta (`direction` chýba = plná jednotka). */
export interface StowageKey {
  readonly id: EntityId;
  readonly weightClass: WeightClass;
  readonly direction?: CargoDirection;
}

/** Poradie smeru kľúča (chýbajúci smer = plná jednotka). */
function directionRank(key: StowageKey): number {
  return key.direction === undefined ? 0 : STOWAGE_DIRECTION_RANK[key.direction];
}

/**
 * Porovnanie dvoch jednotiek podľa **triedy** stowage plánu (záporné = `a` skôr): smer a hmotnostná trieda, bez id. Jednotky jednej triedy sú pre stowage
 * zameniteľné (R2, ADR-039: sklad ich segreguje práve podľa voyage a hmotnosti), takže dispatcher z nich berie tú, ktorú vybrať najlacnejšie (navrchu stohu).
 */
export function compareStowageClass(a: StowageKey, b: StowageKey): number {
  const direction = directionRank(a) - directionRank(b);
  return direction !== 0 ? direction : STOWAGE_WEIGHT_RANK[a.weightClass] - STOWAGE_WEIGHT_RANK[b.weightClass];
}

/**
 * Porovnanie dvoch jednotiek podľa stowage plánu (záporné = `a` sa nakladá skôr): smer (`STOWAGE_DIRECTION_RANK` — plné pred
 * prázdnymi), hmotnostná trieda (`STOWAGE_WEIGHT_RANK`), potom id. Dve rôzne jednotky nie sú nikdy rovnocenné (id sú jedinečné).
 */
export function compareStowageOrder(a: StowageKey, b: StowageKey): number {
  const direction = directionRank(a) - directionRank(b);
  if (direction !== 0) return direction;
  const rank = STOWAGE_WEIGHT_RANK[a.weightClass] - STOWAGE_WEIGHT_RANK[b.weightClass];
  return rank !== 0 ? rank : a.id - b.id;
}
