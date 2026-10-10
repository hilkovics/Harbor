/**
 * Dotazy nad nákladom pre prezentáciu a metriky (F6a, ADR-032; docs/tasks/phase-06a.md „Spoločné rozhrania") — čisté
 * funkcie nad ledgerom a indexom uskladneného nákladu, svet nemenia ani nespotrebujú `Rng`. Sú O(jednotky držiteľa)
 * bez alokácie okrem výsledku; prezentácia ich volá pri zmene `revision` snapshotu, nie každý frame.
 */
import type { CargoHolderKind } from '../cargo/cargo-location';
import type { CargoDirection, CargoStatus } from '../cargo/cargo-unit';
import type { ContractId, EntityId } from '../core/entity-id';
import type { World } from './world';

/** Počet jednotiek podľa smeru (import / export / tranship / empty; F6c, ADR-034). */
export type CargoDirectionSplit = { readonly [D in CargoDirection]: number };

/** Jednotky u držiteľa `holderId` druhu `kind` rozdelené podľa smeru (`CargoUnit.direction`). */
export function cargoSplitAt(world: Pick<World, 'cargo'>, kind: CargoHolderKind, holderId: EntityId): CargoDirectionSplit {
  const split: { [D in CargoDirection]: number } = { import: 0, export: 0, tranship: 0, empty: 0 };
  const count = world.cargo.countAt(kind, holderId);
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex(kind, holderId, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit !== undefined) split[unit.direction] += 1;
  }
  return split;
}

/** Náklad na palube lode: import (na vykládku) a naložený export (inšpektor lode, render nákladu na palube). */
export function shipCargoSplit(world: Pick<World, 'cargo'>, shipId: EntityId): CargoDirectionSplit {
  return cargoSplitAt(world, 'on_ship', shipId);
}

/** Uskladnené jednotky skladu podľa smeru (inšpektor skladu). */
export function storageCargoSplit(world: Pick<World, 'cargo'>, moduleId: EntityId): CargoDirectionSplit {
  return cargoSplitAt(world, 'in_storage', moduleId);
}

/**
 * Zoskupenie exportu v skladoch (metrika `exportGroupingPct`, ADR-032 bod 7): podiel uskladnených jednotiek kontraktu
 * v sklade, kde ich leží najviac (0 … 1); kontrakt bez uskladnených jednotiek → `null`. Číta `World.storedCargo`
 * (skupina kontraktu má sklady neklesajúco, takže najdlhší úsek rovnakého skladu = najviac jednotiek v jednom sklade).
 */
export function exportGroupingShare(world: Pick<World, 'storedCargo'>, contractId: ContractId): number | null {
  const group = world.storedCargo.groupOf(contractId);
  if (group === undefined || group.units.length === 0) return null;
  const { storages } = group;
  let best = 0;
  let run = 0;
  for (let i = 0; i < storages.length; i++) {
    run = i > 0 && storages[i] === storages[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best / storages.length;
}

/** Počet prázdnych jednotiek jednej linky podľa stavu kvality (F6c, ADR-034). */
export interface LineStatusSplit {
  readonly lineId: string;
  readonly available: number;
  readonly damaged: number;
  readonly in_repair: number;
}

/** Obsah skladu rozdelený pre inšpektor depa prázdnych: prázdne podľa linky a stavu a ostatné jednotky (záložné uloženie). */
export interface DepotCargoSplit {
  /** Všetky linky z `lines.json` v poradí defu (aj s nulami — stabilný tvar tabuľky). */
  readonly lines: readonly LineStatusSplit[];
  /** Jednotky iného smeru než `empty` v sklade (bežný dvor, ktorý prijal prázdne ako záložný sklad, ich má; depo nie). */
  readonly other: number;
}

type MutableLineSplit = { lineId: string; available: number; damaged: number; in_repair: number };

function emptyLineSplits(lines: readonly { readonly id: string }[]): MutableLineSplit[] {
  return lines.map((line) => ({ lineId: line.id, available: 0, damaged: 0, in_repair: 0 }));
}

function addEmpty(splits: readonly MutableLineSplit[], lineId: string | null, status: CargoStatus): void {
  const split = splits.find((candidate) => candidate.lineId === lineId);
  if (split !== undefined) split[status] += 1;
}

/**
 * Obsah skladu `moduleId` pre inšpektor depa (F6c, ADR-034): prázdne podľa linky a stavu kvality (dostupné / poškodené / v oprave)
 * a ostatné jednotky. Funguje pre depo prázdnych aj bežný dvor (záložné uloženie prázdnych). O(jednotky skladu).
 */
export function depotCargoSplit(world: Pick<World, 'cargo' | 'defs'>, moduleId: EntityId): DepotCargoSplit {
  const splits = emptyLineSplits(world.defs.lines.items);
  let other = 0;
  const count = world.cargo.countAt('in_storage', moduleId);
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('in_storage', moduleId, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit === undefined) continue;
    if (unit.direction === 'empty') addEmpty(splits, unit.lineId, unit.status);
    else other += 1;
  }
  return { lines: splits, other };
}

/**
 * Prázdne kontajnery uskladnené v celom prístave podľa linky a stavu (HUD, karta repositioningu: `available` = „dostupných prázdnych
 * linky“). O(živé jednotky) — prezentácia ho volá pri zmene `revision`, nie každý frame.
 */
export function terminalEmptySplit(world: Pick<World, 'cargo' | 'defs'>): readonly LineStatusSplit[] {
  const splits = emptyLineSplits(world.defs.lines.items);
  for (const unit of world.cargo.liveUnits()) {
    if (unit.direction === 'empty' && unit.location.kind === 'in_storage') addEmpty(splits, unit.lineId, unit.status);
  }
  return splits;
}
