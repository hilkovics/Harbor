/**
 * Dotazy nad nákladom pre prezentáciu a metriky (F6a, ADR-032; docs/tasks/phase-06a.md „Spoločné rozhrania") — čisté
 * funkcie nad ledgerom a indexom uskladneného nákladu, svet nemenia ani nespotrebujú `Rng`. Sú O(jednotky držiteľa)
 * bez alokácie okrem výsledku; prezentácia ich volá pri zmene `revision` snapshotu, nie každý frame.
 */
import type { CargoHolderKind } from '../cargo/cargo-location';
import type { CargoDirection } from '../cargo/cargo-unit';
import type { ContractId, EntityId } from '../core/entity-id';
import type { World } from './world';

/** Počet jednotiek podľa smeru (import / export). */
export type CargoDirectionSplit = { readonly [D in CargoDirection]: number };

/** Jednotky u držiteľa `holderId` druhu `kind` rozdelené podľa smeru (`CargoUnit.direction`). */
export function cargoSplitAt(world: Pick<World, 'cargo'>, kind: CargoHolderKind, holderId: EntityId): CargoDirectionSplit {
  const split = { import: 0, export: 0 };
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
