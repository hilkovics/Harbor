/**
 * ReeferSystem — krok 6d ticku (ARCHITECTURE §6, ADR-042; docs/TERMINAL_2.md §6.7). Beží po `YardMachineSystem` (6c), takže vidí uloženie aj zdvih tohto ticku. Stav reeferu
 * (`CargoUnit.reefer`) mení len cez `CargoLedger.setReefer`; sleduje ho index `world.reeferIndex` (vzostupne podľa id, deterministické poradie). Technik sa nekreslí (ADR-036) — je len
 * čas a počet súčasných zásahov (`logistics.reefer.technicians`).
 *
 * Podľa polohy jednotky:
 * - `on_ship`: napájaný z lode (`plugged`, bez hodín). Reefer, ktorý STS preskočil (`waitSinceTick`), čaká; po `maxUnpluggedHours` reklamácia (`waiting`) a hodiny sa spustia znova.
 * - mimo lode a mimo bloku so zásuvkami (žeriav, vozidlo, stroj, apron): bez napájania od zdvihu z lode / odpojenia (`unpluggedSinceTick`); po `maxUnpluggedHours` reklamácia (`unpowered`).
 * - `in_storage` v bloku so zásuvkami: uložený reefer sa zapojí za `plugTicks` (`switchAtTick`) a hodiny sa zastavia; ak naň čaká job so zdrojom skladu (odvoz, nakládka), odpojí sa za
 *   `unplugTicks` a hodiny bez napájania bežia znova — stroj ho do odpojenia nezdvihne (`logistics/reefer-supply.ts`, `liftBlockedByPower`).
 * - zapojený reefer v sklade: raz za hernú hodinu `Rng.chance(alarmChancePerDay / 24)` (v poradí id) spustí alarm s termínom `alarmResponseHours`; technik rieši alarmy v poradí
 *   (termín, id) najviac `technicians` naraz, zásah trvá `alarmFixTicks`; alarm, ktorý sa nezačal riešiť do termínu, je reklamácia (`alarm`).
 * Elektrina: pri uzavretí hodiny `post(−zapojené × reeferPowerCentsPerHour, 'energy')`. Reklamácia: `post(−reeferClaimCents, 'penalty')` a `ReeferClaim`.
 */
import type { CargoUnit, ReeferState } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import type { ClockBoundaries } from '../core/sim-clock';
import type { ReeferClaimReason } from '../events/sim-event';
import { YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';

/** Stav bez napájania od `tick` (zdvih z lode, odpojenie, presun mimo bloku): všetko ostatné sa vynuluje. */
function unpowered(since: number): ReeferState {
  return { plugged: false, unpluggedSinceTick: since, switchAtTick: null, waitSinceTick: null, alarmUntilTick: null, fixUntilTick: null };
}

/** Napájaný (z lode, alebo zapojený v sklade) bez hodín, čakania a alarmu. */
const POWERED: ReeferState = { plugged: true, unpluggedSinceTick: null, switchAtTick: null, waitSinceTick: null, alarmUntilTick: null, fixUntilTick: null };

function same(a: ReeferState, b: ReeferState): boolean {
  return (
    a.plugged === b.plugged &&
    a.unpluggedSinceTick === b.unpluggedSinceTick &&
    a.switchAtTick === b.switchAtTick &&
    a.waitSinceTick === b.waitSinceTick &&
    a.alarmUntilTick === b.alarmUntilTick &&
    a.fixUntilTick === b.fixUntilTick
  );
}

/** Reklamácia: strhne `reeferClaimCents` (`penalty`) a emituje `ReeferClaim`. */
function claim(world: World, unit: CargoUnit, reason: ReeferClaimReason): void {
  const cents = world.defs.economy.reeferClaimCents;
  world.economy.post(-cents, 'penalty', `reefer:${String(unit.id)}`);
  world.events.emit({ type: 'ReeferClaim', unitId: unit.id, reason, cents });
}

export class ReeferSystem {
  /** Krok 6d: stav reeferov podľa polohy, hodiny bez napájania, alarmy, technici a (pri uzavretí hodiny) elektrina. */
  tick(world: World, closed: ClockBoundaries): void {
    const index = world.reeferIndex;
    if (index.size === 0) return;
    const { reefer: cfg } = world.defs.logistics;
    const tick = world.clock.tick;
    const hourTicks = world.clock.ticksPerHour;
    const maxUnpoweredTicks = Math.round(cfg.maxUnpluggedHours * hourTicks);
    const responseTicks = Math.round(cfg.alarmResponseHours * hourTicks);
    const alarmChancePerHour = cfg.alarmChancePerDay / (world.clock.ticksPerDay / hourTicks);
    let pluggedInStorage = 0;
    const ids = index.ids();
    for (const id of ids) {
      const unit = world.cargo.get(id);
      if (unit === undefined || unit.reefer === null) {
        index.remove(id);
        continue;
      }
      const current = unit.reefer;
      let next: ReeferState = current;
      const kind = unit.location.kind;
      const block = kind === 'in_storage' ? world.modules.get(unit.location.moduleId) : undefined;
      if (kind === 'on_ship') {
        if (current.waitSinceTick === null) {
          next = POWERED;
        } else if (tick - current.waitSinceTick >= maxUnpoweredTicks) {
          claim(world, unit, 'waiting');
          next = { ...current, waitSinceTick: tick };
        }
      } else if (block instanceof YardBlock && block.hasSockets) {
        const job = world.jobOfUnit(id);
        const leaving = job !== undefined && job.from.kind === 'in_storage';
        if (current.plugged) {
          if (!leaving) {
            if (current.switchAtTick !== null) next = { ...current, switchAtTick: null };
          } else if (current.switchAtTick === null) {
            next = { ...current, switchAtTick: tick + cfg.unplugTicks };
          } else if (tick >= current.switchAtTick) {
            next = unpowered(tick);
          }
          if (next.plugged) {
            pluggedInStorage += 1;
            if (closed.hourClosed && !leaving && next.alarmUntilTick === null && world.rng.chance(alarmChancePerHour)) {
              next = { ...next, alarmUntilTick: tick + responseTicks, fixUntilTick: null };
              world.events.emit({ type: 'ReeferAlarm', unitId: id });
            }
          }
        } else {
          if (!leaving) {
            if (current.switchAtTick === null) next = { ...current, switchAtTick: tick + cfg.plugTicks };
            else if (tick >= current.switchAtTick) next = POWERED;
          }
          if (!next.plugged && next.unpluggedSinceTick !== null && tick - next.unpluggedSinceTick >= maxUnpoweredTicks) {
            claim(world, unit, 'unpowered');
            next = { ...next, unpluggedSinceTick: tick };
          }
        }
      } else {
        // V pohybe (žeriav, vozidlo, stroj, apron) alebo v sklade bez zásuvky: bez napájania od okamihu, keď prestal byť napájaný.
        if (current.plugged || current.waitSinceTick !== null || current.unpluggedSinceTick === null) next = unpowered(tick);
        if (next.unpluggedSinceTick !== null && tick - next.unpluggedSinceTick >= maxUnpoweredTicks) {
          claim(world, unit, 'unpowered');
          next = { ...next, unpluggedSinceTick: tick };
        }
      }
      if (!same(current, next)) world.cargo.setReefer(id, next);
    }
    this.serveAlarms(world, ids, tick, cfg.technicians, cfg.alarmFixTicks);
    if (closed.hourClosed && pluggedInStorage > 0 && world.defs.economy.reeferPowerCentsPerHour > 0) {
      world.economy.post(-pluggedInStorage * world.defs.economy.reeferPowerCentsPerHour, 'energy');
    }
  }

  /** Technici: dokončené zásahy sa uzavrú, voľná kapacita ide alarmom v poradí (termín, id), alarm po termíne bez začatého zásahu je reklamácia. */
  private serveAlarms(world: World, ids: readonly EntityId[], tick: number, technicians: number, fixTicks: number): void {
    let active = 0;
    const waiting: CargoUnit[] = [];
    for (const id of ids) {
      const unit = world.cargo.get(id);
      const state = unit?.reefer;
      if (unit === undefined || state === null || state === undefined || state.alarmUntilTick === null) continue;
      if (state.fixUntilTick !== null) {
        if (tick >= state.fixUntilTick) world.cargo.setReefer(id, { ...state, alarmUntilTick: null, fixUntilTick: null });
        else active += 1;
      } else {
        waiting.push(unit);
      }
    }
    waiting.sort((a, b) => (a.reefer?.alarmUntilTick ?? 0) - (b.reefer?.alarmUntilTick ?? 0) || a.id - b.id);
    for (const unit of waiting) {
      const state = unit.reefer as ReeferState;
      if (active < technicians) {
        active += 1;
        world.cargo.setReefer(unit.id, { ...state, fixUntilTick: tick + fixTicks });
      } else if (tick >= (state.alarmUntilTick as number)) {
        claim(world, unit, 'alarm');
        world.cargo.setReefer(unit.id, { ...state, alarmUntilTick: null, fixUntilTick: null });
      }
    }
  }
}
