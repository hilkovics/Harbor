/**
 * Zásuvky pre reefery z pohľadu STS (R5, ADR-042; docs/TERMINAL_2.md §6.7 bod 1): žeriav smie vyložiť reefer z lode, len keď mu plánovač (`chooseYardSlot`) nájde voľnú
 * zásuvku (stoh so zásuvkou, ktorý ostane po rezerváciách rozbehnutých jobov voľný). Inak ho **preskočí**: jednotka čaká na palube a od prvého preskočenia beží
 * `ReeferState.waitSinceTick` (po `maxUnpluggedHours` reklamácia, `systems/reefer-system.ts`); hráč dostane `ReeferSkipped` (pri prvom preskočení a potom raz za hernú hodinu).
 * Dotaz sa volá pri plánovaní vykládky v kroku 4 (`planUnload`), takže stav mení len krok 4 — deterministicky a bez `Rng`.
 */
import { teuOf, type CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import type { BerthModule } from '../modules/berth-module';
import type { CraneModule } from '../modules/crane-module';
import { YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';
import type { TransportJob } from './transport-job';
import { chooseYardSlot } from './yard-planner';

/** Odmietnuté reefery v aktuálnom ticku (odvodená cache, nie je v save): `unitId → kotvisko a `pendingTeu` pri odmietnutí`. */
interface RejectedCache {
  readonly tick: number;
  readonly units: Map<EntityId, { readonly berthId: EntityId; readonly pendingTeu: number }>;
}
const REJECTED = new WeakMap<World, RejectedCache>();

/** Voľné TEU blokov so zásuvkami po rezerváciách rozbehnutých jobov. */
function freeSocketTeu(world: World): number {
  let free = 0;
  for (const module of world.modules.values()) if (module instanceof YardBlock && module.hasSockets) free += module.freeCount;
  return free;
}

/**
 * Smie `crane` vyložiť `unit` z lode teraz? Jednotka bez reeferu vždy; reefer len s voľnou zásuvkou (a tá sa pri úspechu čaká už nepočíta). `pendingTeu` = TEU reeferov, ktoré si zabrali iné žeriavy a job so zásuvkou im ešte nevznikol (dispatcher beží až v kroku 5) — nesmú sa
 * započítať dvakrát. Pri odmietnutí zapíše
 * `waitSinceTick` (ak ešte nebeží) a emituje `ReeferSkipped`.
 */
export function mayUnload(world: World, unit: CargoUnit, berth: BerthModule, crane: CraneModule, pendingTeu = 0): boolean {
  const reefer = unit.reefer;
  if (reefer === null) return true;
  const tick = world.clock.tick;
  // Odmietnutie sa v rámci ticku nemení (zásuvky sa uvoľňujú až v kroku 5): opakovaný dotaz iného žeriava / plánu neráta znova ani nehlási `ReeferSkipped` (TR5-06b).
  const cached = REJECTED.get(world);
  if (cached !== undefined && cached.tick === tick) {
    const earlier = cached.units.get(unit.id);
    if (earlier !== undefined && earlier.berthId === berth.id && pendingTeu >= earlier.pendingTeu) return false;
  } else {
    REJECTED.set(world, { tick, units: new Map() });
  }
  if (chooseYardSlot(world, unit, berth) !== null && freeSocketTeu(world) - pendingTeu >= teuOf(unit)) {
    if (reefer.waitSinceTick !== null) world.cargo.setReefer(unit.id, { ...reefer, waitSinceTick: null });
    return true;
  }
  if (reefer.waitSinceTick === null) {
    world.cargo.setReefer(unit.id, { ...reefer, waitSinceTick: tick });
    world.reeferIndex.add(unit.id);
  }
  const waited = tick - (reefer.waitSinceTick ?? tick);
  if (waited % world.clock.ticksPerHour === 0) world.events.emit({ type: 'ReeferSkipped', unitId: unit.id, craneId: crane.id, berthId: berth.id });
  (REJECTED.get(world) as RejectedCache).units.set(unit.id, { berthId: berth.id, pendingTeu });
  return false;
}

/**
 * Stojí zdvihu zo skladu v ceste napájanie? Job so zdrojom `in_storage`, ktorého jednotka je reefer, smie stroj začať, až keď je reefer odpojený (`plugged: false`; odpojenie
 * po vzniku jobu začne systém reeferov, `unplugTicks`). Ostatné joby (aj shift/rehandle) nič nebrzdí. Čistý dotaz.
 */
export function liftBlockedByPower(world: World, job: Pick<TransportJob, 'from'>): boolean {
  if (job.from.kind !== 'in_storage') return false;
  const id = world.cargo.unitAtSlot('in_storage', job.from.moduleId, job.from.slot);
  const reefer = id === undefined ? null : (world.cargo.get(id)?.reefer ?? null);
  return reefer !== null && reefer.plugged;
}
