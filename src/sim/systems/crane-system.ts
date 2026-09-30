/**
 * CraneSystem — krok 4 ticku (ARCHITECTURE §6, §7.2, §7.8; rozhodnutie orchestrátora 7; ADR-016): cyklus žeriavov
 * loď → apron (import). Žeriavy sa spracúvajú vzostupne podľa id; každý stav má krok v tabuľke `CRANE_STEPS`
 * (nie switch) a stav mení len `CraneModule.transition`.
 *
 * Cyklus (`c = round(StatResolver.resolve('module', defId, 'cycleTicks'))`, fázy `g = ⌊c/2⌋` a `p = c − ⌊c/2⌋`, každá
 * aspoň `MIN_CRANE_PHASE_TICKS`):
 * - `idle`/`blocked` → **štart**: kotvisko žeriavu má dokovanú loď (`docked`) s nákladom kategórie žeriavu a na lodi je
 *   jednotka, ktorú si ešte nezabral iný žeriav tej lode (žeriavy v `grabbing` nad jej kotviskami). Ak apron má voľný
 *   nerezervovaný slot → rezervácia slotu + `grabbing` (g tickov); inak `blocked` (+ `CraneBlocked` najviac raz za
 *   hernú hodinu na žeriav). Bez práce → `idle`.
 * - `grabbing`: po g tickoch okamžite `swinging` (jednotka s najmenším id na lodi `on_ship → in_crane`) → `placing`.
 * - `placing`: po p tickoch `in_crane → on_apron(slot)` + `apron.commit`, `CraneCycleDone`, `idle` a v tom istom ticku
 *   nový štart (cyklus trvá presne c tickov).
 * Tick štartu fázy je jej nultý tick; fáza končí v ticku, keď `phaseTicksLeft` klesne na 0. Po kroku sa pripočíta
 * tick do počítadla stavu (`CRANE_STATE_TRAITS[state].counter`: busy / idle / blocked).
 */
import { BerthModule } from '../modules/berth-module';
import { CRANE_STATE_TRAITS, CraneModule, type CraneCounter, type CraneState } from '../modules/crane-module';
import { ModuleError } from '../modules/module-error';
import type { Ship } from '../ships/ship';
import type { StatResolver } from '../tech/stat-resolver';
import type { World } from '../world/world';

/** Najkratšia fáza cyklu v tickoch — žeriav nemôže zdvihnúť ani položiť jednotku „za nula tickov“. */
export const MIN_CRANE_PHASE_TICKS = 1;

/** Trvanie fáz cyklu žeriavu v tickoch. */
export interface CranePhaseTicks {
  readonly grabbing: number;
  readonly placing: number;
}

/**
 * Fázy cyklu z `cycleTicks` po modifikátoroch (§10): `c` sa zaokrúhli na celé ticky, `grabbing = ⌊c/2⌋`,
 * `placing = c − ⌊c/2⌋`, každá aspoň `MIN_CRANE_PHASE_TICKS`.
 */
export function cranePhaseTicks(stats: Pick<StatResolver, 'resolve'>, crane: CraneModule): CranePhaseTicks {
  const cycle = Math.round(stats.resolve('module', crane.def.id, 'cycleTicks'));
  const half = Math.floor(cycle / 2);
  return { grabbing: Math.max(MIN_CRANE_PHASE_TICKS, half), placing: Math.max(MIN_CRANE_PHASE_TICKS, cycle - half) };
}

function berthOf(world: World, crane: CraneModule): BerthModule {
  const berth = world.modules.get(crane.berthId);
  if (!(berth instanceof BerthModule)) throw new ModuleError('no_berth', `${crane.label}: kotvisko #${String(crane.berthId)} neexistuje`);
  return berth;
}

/** Dokovaná loď na kotvisku žeriavu s nákladom jeho kategórie; inak `undefined`. */
function servedShip(world: World, crane: CraneModule, berth: BerthModule): Ship | undefined {
  const ship = berth.dockedShipId === null ? undefined : world.ships.get(berth.dockedShipId);
  return ship?.state === 'docked' && ship.cargoCategory === crane.category ? ship : undefined;
}

/** Jednotky na lodi, ktoré si ešte nezabral žiadny žeriav (žeriavy v `grabbing` nad kotviskami lode). */
function unclaimedUnits(world: World, ship: Ship): number {
  let claimed = 0;
  for (const berthId of ship.berthIds) {
    const berth = world.modules.get(berthId);
    if (!(berth instanceof BerthModule)) continue;
    for (const craneId of berth.craneIds) {
      const crane = world.modules.get(craneId);
      if (crane instanceof CraneModule && crane.state === 'grabbing' && crane.category === ship.cargoCategory) claimed += 1;
    }
  }
  return world.cargo.countAt('on_ship', ship.id) - claimed;
}

/** `CraneBlocked` najviac raz za hernú hodinu na žeriav (index hodiny v `lastBlockedHour`). */
function emitBlocked(world: World, crane: CraneModule, berth: BerthModule): void {
  const hour = world.clock.gameHour;
  if (crane.lastBlockedHour === hour) return;
  crane.lastBlockedHour = hour;
  world.events.emit({ type: 'CraneBlocked', craneId: crane.id, berthId: berth.id, reason: 'apron_full' });
}

/** Štart cyklu z `idle`/`blocked` (viď hlavička súboru). */
function start(crane: CraneModule, world: World): void {
  const berth = berthOf(world, crane);
  const ship = servedShip(world, crane, berth);
  if (ship === undefined || unclaimedUnits(world, ship) <= 0) {
    if (crane.state !== 'idle') crane.transition('idle');
    crane.enterPhase(0);
    return;
  }
  if (berth.apron.freeUnreservedCount > 0) {
    crane.reservedSlot = berth.apron.reserve();
    crane.transition('grabbing');
    crane.enterPhase(cranePhaseTicks(world.stats, crane).grabbing);
    return;
  }
  if (crane.state === 'blocked') return;
  crane.transition('blocked');
  crane.enterPhase(0);
  emitBlocked(world, crane, berth);
}

/** `swinging` → `placing` (jednotku už drží). */
function beginPlacing(crane: CraneModule, world: World): void {
  crane.transition('placing');
  crane.enterPhase(cranePhaseTicks(world.stats, crane).placing);
}

/** Koniec `grabbing`: jednotka s najmenším id na lodi `on_ship → in_crane`, `swinging` a hneď `placing`. */
function swing(crane: CraneModule, world: World): void {
  const berth = berthOf(world, crane);
  const ship = servedShip(world, crane, berth);
  const unitId = ship === undefined ? undefined : world.cargo.firstUnitAt('on_ship', ship.id);
  if (ship === undefined || unitId === undefined) {
    throw new ModuleError('invalid_transition', `${crane.label}: koniec grabbing bez dokovanej lode s nákladom na ${berth.label}`);
  }
  world.cargo.move(unitId, { kind: 'in_crane', craneId: crane.id });
  crane.heldUnitId = unitId;
  crane.transition('swinging');
  beginPlacing(crane, world);
}

/** Koniec `placing`: jednotka na rezervovaný slot apronu, `CraneCycleDone`, `idle` a nový štart. */
function place(crane: CraneModule, world: World): void {
  const berth = berthOf(world, crane);
  const unitId = crane.heldUnitId;
  const slot = crane.reservedSlot;
  if (unitId === null || slot === null) {
    throw new ModuleError('invalid_transition', `${crane.label}: koniec placing bez jednotky (${String(unitId)}) alebo slotu (${String(slot)})`);
  }
  world.cargo.move(unitId, { kind: 'on_apron', berthId: berth.id, slot });
  berth.apron.commit(slot, unitId);
  crane.heldUnitId = null;
  crane.reservedSlot = null;
  crane.transition('idle');
  crane.enterPhase(0);
  world.events.emit({ type: 'CraneCycleDone', craneId: crane.id, unitId });
  start(crane, world);
}

/** Jeden tick fázy; `true`, keď fáza práve skončila. */
function countDown(crane: CraneModule): boolean {
  crane.phaseTicksLeft = Math.max(0, crane.phaseTicksLeft - 1);
  return crane.phaseTicksLeft === 0;
}

type CraneStep = (crane: CraneModule, world: World) => void;

const CRANE_STEPS: { readonly [S in CraneState]: CraneStep } = {
  idle: start,
  blocked: start,
  grabbing: (crane, world) => {
    if (countDown(crane)) swing(crane, world);
  },
  // `swinging` je okamžitý (v rámci `swing`); žeriav v ňom tick nekončí — len ak by prišiel zo save, pokračuje placing.
  swinging: beginPlacing,
  placing: (crane, world) => {
    if (countDown(crane)) place(crane, world);
  },
};

/** Počítadlá utilizácie (§11) podľa `CRANE_STATE_TRAITS[state].counter`. */
const COUNT_TICK: { readonly [C in CraneCounter]: (crane: CraneModule) => void } = {
  idle: (crane) => {
    crane.idleTicks += 1;
  },
  busy: (crane) => {
    crane.busyTicks += 1;
  },
  blocked: (crane) => {
    crane.blockedTicks += 1;
  },
};

export class CraneSystem {
  /** Krok 4: jeden krok FSM každého žeriavu vzostupne podľa id a tick do počítadla jeho výsledného stavu. */
  tick(world: World): void {
    for (const module of world.modules.values()) {
      if (!(module instanceof CraneModule)) continue;
      CRANE_STEPS[module.state](module, world);
      COUNT_TICK[CRANE_STATE_TRAITS[module.state].counter](module);
    }
  }
}
