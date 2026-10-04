/**
 * Kontrola a M&R prázdnych kontajnerov (F6c, ADR-034 bod 7 + dodatok T6C-02):
 * - **Uloženie** (`onEmptyStored`, krok 6: `in_vehicle → in_storage` hotové): `EmptyStored` (`fallback` = bežný dvor namiesto depa)
 *   a **kontrola len v depe** — `Rng.chance(emptyFlow.damageChance)` → `CargoLedger.setStatus(unit, 'damaged')` a `EmptyDamaged`.
 *   V bežnom dvore sa kontrola nerobí (nemá M&R, jednotka ostáva `available`; `Rng` sa nespotrebuje).
 * - **Opravy** (`EmptyDepotService.tick`, krok 2 po uvoľnení VGM hold): pre každé depo (vzostupne podľa id) jeden prechod jeho jednotiek:
 *   oprava, ktorej `repairUntilTick ≤ tick`, skončí (`in_repair → available`, `EmptyRepaired`, poplatok `economy.repairCostCents` cez
 *   `post(−cena, 'maintenance_repair', 'unit:<id>')`); potom poškodené jednotky v poradí id dostanú voľné miesta opravy depa
 *   (`repairBays − jednotky v oprave`) → `in_repair` do `tick + round(repairHours × ticksPerHour)` a `EmptyRepairStarted`.
 *   Poškodenú ani opravovanú jednotku nemožno vydať ani naložiť (`findAvailableEmpty` berie len `available`).
 *
 * Bez nového stavu v save: opravy sa odvodzujú z `CargoUnit.status` / `repairUntilTick` v ledgeri, takže obnova pokračuje bitovo rovnako;
 * zoznam dep sa cachuje podľa `World.moduleVersion` (nie je stav simulácie). Svet bez depa nič nerobí a nealokuje.
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import { EmptyDepot } from '../modules/empty-depot';
import type { Module } from '../modules/module';
import type { World } from '../world/world';

/** Linka prázdneho kontajnera (ledger ju pre smer `empty` vyžaduje — `''` len uspokojí typ). */
function lineOf(unit: CargoUnit): string {
  return unit.lineId ?? '';
}

/** Znovupoužiteľné pole poškodených jednotiek jedného depa (hot path bez alokácie; vždy sa najprv vyprázdni). */
const DAMAGED: EntityId[] = [];

/**
 * Prázdny kontajner práve prišiel do skladu `storage` (po `CargoLedger.move` a `commit`): `EmptyStored` a v depe kontrola
 * (viď hlavička). Jednotka iného smeru alebo bez linky sa ignoruje.
 */
export function onEmptyStored(world: World, unitId: EntityId, storage: Module): void {
  const unit = world.cargo.get(unitId);
  if (unit === undefined || unit.direction !== 'empty' || unit.lineId === null) return;
  const inDepot = storage instanceof EmptyDepot;
  world.events.emit({ type: 'EmptyStored', unitId, lineId: unit.lineId, moduleId: storage.id, fallback: !inDepot });
  if (!inDepot || !world.rng.chance(world.defs.logistics.emptyFlow.damageChance)) return;
  world.cargo.setStatus(unitId, 'damaged', null);
  world.events.emit({ type: 'EmptyDamaged', unitId, lineId: unit.lineId, moduleId: storage.id });
}

/** Dokončí opravu jednotky: `available`, poplatok a `EmptyRepaired`. */
function finishRepair(world: World, depot: EmptyDepot, unitId: EntityId, lineId: string): void {
  world.cargo.setStatus(unitId, 'available', null);
  const costCents = world.defs.economy.repairCostCents;
  if (costCents > 0) world.economy.post(-costCents, 'maintenance_repair', `unit:${String(unitId)}`);
  world.events.emit({ type: 'EmptyRepaired', unitId, lineId, moduleId: depot.id, costCents });
}

/** Začne opravu jednotky: `in_repair` do `untilTick` a `EmptyRepairStarted`. */
function startRepair(world: World, depot: EmptyDepot, unitId: EntityId, lineId: string, untilTick: number): void {
  world.cargo.setStatus(unitId, 'in_repair', untilTick);
  world.events.emit({ type: 'EmptyRepairStarted', unitId, lineId, moduleId: depot.id, untilTick });
}

/** Vloží `id` do vzostupne zoradeného `DAMAGED` (vkladanie — pole má pár prvkov). */
function addDamaged(id: EntityId): void {
  let at = DAMAGED.length;
  DAMAGED.push(id);
  while (at > 0 && DAMAGED[at - 1] > id) {
    DAMAGED[at] = DAMAGED[at - 1];
    at -= 1;
  }
  DAMAGED[at] = id;
}

/** Jeden prechod jednotiek depa: skončené opravy, počet opráv v behu a poškodené jednotky (`DAMAGED`); vráti počet opráv v behu. */
function scanDepot(world: World, depot: EmptyDepot): number {
  const { tick } = world.clock;
  const count = world.cargo.countAt('in_storage', depot.id);
  let repairing = 0;
  DAMAGED.length = 0;
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('in_storage', depot.id, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit === undefined || unit.status === 'available') continue;
    if (unit.status === 'damaged') {
      addDamaged(unit.id);
    } else if (unit.repairUntilTick !== null && unit.repairUntilTick <= tick) {
      finishRepair(world, depot, unit.id, lineOf(unit));
    } else {
      repairing += 1;
    }
  }
  return repairing;
}

/** Krok 2: opravy v depách (viď hlavička). Zoznam dep sa cachuje podľa `moduleVersion`. */
export class EmptyDepotService {
  private depots: readonly EmptyDepot[] = [];
  private version = Number.NaN;

  /** Depá vzostupne podľa id; prepočíta sa len po zmene množiny modulov. */
  private depotsOf(world: World): readonly EmptyDepot[] {
    if (world.moduleVersion !== this.version) {
      this.version = world.moduleVersion;
      const found: EmptyDepot[] = [];
      for (const module of world.modules.values()) if (module instanceof EmptyDepot) found.push(module);
      this.depots = found;
    }
    return this.depots;
  }

  /** Dokončí opravy a rozdá voľné miesta opravy poškodeným jednotkám každého depa (viď hlavička). */
  tick(world: World): void {
    for (const depot of this.depotsOf(world)) {
      if (world.cargo.countAt('in_storage', depot.id) === 0) continue;
      const repairing = scanDepot(world, depot);
      const free = depot.repairBays - repairing;
      if (free <= 0 || DAMAGED.length === 0) continue;
      const { repairHours } = world.defs.logistics.emptyFlow;
      const untilTick = world.clock.tick + Math.max(1, Math.round(repairHours * world.clock.ticksPerHour));
      for (let i = 0; i < DAMAGED.length && i < free; i++) {
        const unit = world.cargo.get(DAMAGED[i]);
        if (unit !== undefined) startRepair(world, depot, unit.id, lineOf(unit), untilTick);
      }
    }
  }
}
