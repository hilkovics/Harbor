/**
 * CraneSystem — krok 4 ticku (ARCHITECTURE §6, §7.2, §7.8; rozhodnutie orchestrátora 7; ADR-016, ADR-032 bod 9–11, ADR-033):
 * cyklus žeriavov — vykládka lode, nakládka exportu a dual cycling. Žeriavy sa spracúvajú vzostupne podľa id; každý stav má
 * krok v tabuľke `CRANE_STEPS` (nie switch) a stav mení len `CraneModule.transition`, smer cyklu len `CraneModule.changeCycle`
 * (tabuľka `CRANE_CYCLE_TRANSITIONS`, T6A-09b). Čo sa líši podľa režimu odovzdávania
 * kotviska (`apron` | `under_hook`), je v stratégiách `HANDOVERS` (`crane-handover.ts`).
 *
 * Cyklus (`c = round(StatResolver.resolve('module', defId, 'cycleTicks'))`, fázy `g = ⌊c/2⌋` a `p = c − ⌊c/2⌋`, každá
 * aspoň `MIN_CRANE_PHASE_TICKS`):
 * - `idle`/`blocked` → **štart**: kotvisko žeriavu má dokovanú loď (`docked`) s nákladom kategórie žeriavu. Výber cyklu:
 *   (1) je pripravený export na nakládku (apron: jednotka na aprone, hook: vozidlo pod hákom s jednotkou) a na lodi je miesto
 *   (`capacityUnits` platí pre import + export na palube) → ak je na lodi aj import, **dual cycle** (`dual_load` a hneď
 *   `dual_unload`), inak `load`; (2) inak je na lodi import, ktorú si ešte nezabral iný žeriav → `unload` (apron: rezervácia
 *   slotu — bez voľného slotu `blocked` + `CraneBlocked` najviac raz za hernú hodinu; hook: bez rezervácie); (3) inak `idle`.
 * - `grabbing`: po g tickoch okamžite `swinging` → `placing`. Vykládka: jednotka importu `on_ship → in_crane` (apron: najmenšie
 *   id importu, hook: cieľ cyklu `targetUnitId` vybraný pri štarte, aby dispatcher poslal vozidlo vopred). Nakládka: jednotka
 *   `targetUnitId` `on_apron | in_vehicle → in_crane` (`Handover.lift`).
 * - `placing`: po p tickoch vykládka odovzdá jednotku (`Handover.deliver`: apron `in_crane → on_apron` na rezervovaný slot,
 *   hook `in_crane → in_vehicle` / buffer; ak sa nedá, žeriav čaká v `placing` s `phaseTicksLeft = 1` a počíta
 *   `waitForVehicleTicks`), `CraneCycleDone`; nakládka `in_crane → on_ship` a `UnitLoaded`. Potom `idle` a v tom istom ticku
 *   nový štart (cyklus trvá presne c tickov).
 * - **Dual cycle** (`dualCycleFactor`): `D = round(factor × c)`; `dual_load` trvá `⌊D/2⌋` a `dual_unload` `D − ⌊D/2⌋` tickov, každá
 *   polovica `h` sa delí na `grabbing` `max(1, ⌊h/2⌋)` a `placing` `max(1, h − ⌊h/2⌋)`. Po `dual_load` žeriav v tom istom ticku
 *   začne `dual_unload` (slot uvoľnený exportom je už rezervovaný pre import); na konci `CraneCycleDone` a `DualCycle`.
 * Tick štartu fázy je jej nultý tick; fáza končí v ticku, keď `phaseTicksLeft` klesne na 0. Po kroku sa pripočíta
 * tick do počítadla stavu (`CRANE_STATE_TRAITS[state].counter`: busy / idle / blocked).
 */
import { BerthModule } from '../modules/berth-module';
import {
  CRANE_CYCLE_TRAITS,
  CRANE_STATE_TRAITS,
  CraneModule,
  DEFAULT_CRANE_CYCLE,
  MIN_CRANE_PHASE_TICKS,
  type CraneCounter,
  type CraneCycle,
  type CraneState,
} from '../modules/crane-module';
import { ModuleError } from '../modules/module-error';
import { countShipCranes, importAboard, isLoadingInFlight, openExportBookings, stowageOutOfOrder } from '../logistics/voyage-cargo';
import type { Contract } from '../contracts/contract';
import type { EntityId } from '../core/entity-id';
import type { Ship } from '../ships/ship';
import type { StatResolver } from '../tech/stat-resolver';
import type { World } from '../world/world';
import { HANDOVERS, type CraneEnv } from './crane-handover';

// Konštanta je definovaná pri `CraneModule` (nižšia vrstva, bez cyklického importu) a verejne sa exportuje odtiaľto.
export { MIN_CRANE_PHASE_TICKS };

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

/** Rozdelenie polovice dual cyklu dĺžky `h` na `grabbing` a `placing` (rovnako ako cyklus c, každá aspoň 1 tick). */
function halfPhaseTicks(h: number): CranePhaseTicks {
  const half = Math.floor(h / 2);
  return { grabbing: Math.max(MIN_CRANE_PHASE_TICKS, half), placing: Math.max(MIN_CRANE_PHASE_TICKS, h - half) };
}

/**
 * Fázy polovice dual cyklu (`dual_load` | `dual_unload`): `D = round(dualCycleFactor × c)`, `dual_load` trvá `⌊D/2⌋`,
 * `dual_unload` `D − ⌊D/2⌋` tickov (ADR-032 bod 11).
 */
export function dualPhaseTicks(stats: Pick<StatResolver, 'resolve'>, crane: CraneModule, cycle: 'dual_load' | 'dual_unload'): CranePhaseTicks {
  const c = Math.round(stats.resolve('module', crane.def.id, 'cycleTicks'));
  const total = Math.round(crane.params.dualCycleFactor * c);
  const first = Math.floor(total / 2);
  return halfPhaseTicks(cycle === 'dual_load' ? first : total - first);
}

/** Fázy cyklu `cycle` (jednoduchý cyklus: `cranePhaseTicks`, polovice dual cyklu: `dualPhaseTicks`). */
function phaseTicksOf(world: World, crane: CraneModule, cycle: CraneCycle): CranePhaseTicks {
  return cycle === 'dual_load' || cycle === 'dual_unload' ? dualPhaseTicks(world.stats, crane, cycle) : cranePhaseTicks(world.stats, crane);
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

/** Žeriav kategórie lode v `grabbing` s vykládkou — zabral si jednotku importu, ktorá je ešte na lodi. */
const isGrabbingUnloader = (crane: CraneModule): boolean => crane.state === 'grabbing' && CRANE_CYCLE_TRAITS[crane.cycle].direction === 'unload';

/** Jednotky importu na lodi, ktoré si ešte nezabral žiaden žeriav (vykládka v `grabbing` nad kotviskami lode). */
function unclaimedImports(world: World, ship: Ship): number {
  return importAboard(world, ship.id) - countShipCranes(world, ship, isGrabbingUnloader);
}

/** Je na lodi miesto pre ďalšiu jednotku exportu (import + export na palube ≤ `capacityUnits`, rátajú sa aj jednotky v ceste)? */
function shipHasRoom(world: World, ship: Ship): boolean {
  return world.cargo.countAt('on_ship', ship.id) + countShipCranes(world, ship, isLoadingInFlight) < ship.def.capacityUnits;
}

/** `CraneBlocked` najviac raz za hernú hodinu na žeriav (index hodiny v `lastBlockedHour`). */
function emitBlocked(world: World, crane: CraneModule, berth: BerthModule): void {
  const hour = world.clock.gameHour;
  if (crane.lastBlockedHour === hour) return;
  crane.lastBlockedHour = hour;
  world.events.emit({ type: 'CraneBlocked', craneId: crane.id, berthId: berth.id, reason: 'apron_full' });
}

/** Žeriav bez cyklu: `idle`, fáza 0, smer cyklu a cieľ vynulované. */
function rest(crane: CraneModule): void {
  if (crane.state !== 'idle') crane.transition('idle');
  crane.enterPhase(0);
  crane.changeCycle(DEFAULT_CRANE_CYCLE);
  crane.targetUnitId = null;
  crane.dualUnitId = null;
}

/** Vstup do `grabbing` cyklu `cycle` (z `idle`/`blocked`, alebo po `dual_load` v tom istom ticku). */
function enterGrabbing(world: World, crane: CraneModule, cycle: CraneCycle, target: EntityId | null): void {
  crane.changeCycle(cycle);
  crane.targetUnitId = target;
  crane.transition('grabbing');
  crane.enterPhase(phaseTicksOf(world, crane, cycle).grabbing);
}

/** Znovupoužiteľné pole bookingov lode pre `start` (hot path bez alokácie; obsah sa vždy najprv vyprázdni). */
const EXPORT_BOOKINGS: Contract[] = [];

/** Štart cyklu z `idle`/`blocked` (viď hlavička súboru). */
function start(crane: CraneModule, world: World): void {
  const berth = berthOf(world, crane);
  const ship = servedShip(world, crane, berth);
  if (ship === undefined) {
    rest(crane);
    return;
  }
  const env: CraneEnv = { world, crane, berth, ship };
  const handover = HANDOVERS[berth.params.handoverMode];
  const imports = unclaimedImports(world, ship);
  const bookings: readonly Contract[] = openExportBookings(world, ship.id, EXPORT_BOOKINGS);
  const loadUnit = bookings.length > 0 && shipHasRoom(world, ship) ? handover.loadable(env, bookings) : undefined;
  if (loadUnit !== undefined) {
    enterGrabbing(world, crane, imports > 0 ? 'dual_load' : 'load', loadUnit);
    return;
  }
  const plan = imports > 0 ? handover.planUnload(env, false) : undefined;
  if (plan !== undefined) {
    handover.reserveUnload(env);
    enterGrabbing(world, crane, 'unload', plan);
    return;
  }
  if (imports > 0 && handover.blocksWhenNotReady) {
    if (crane.state === 'blocked') return;
    crane.transition('blocked');
    crane.enterPhase(0);
    emitBlocked(world, crane, berth);
    return;
  }
  rest(crane);
  if (bookings.length > 0 && handover.idleWaits(env)) crane.waitForVehicleTicks += 1;
}

/** `swinging` → `placing` (jednotku už drží). */
function beginPlacing(crane: CraneModule, world: World): void {
  crane.transition('placing');
  crane.enterPhase(phaseTicksOf(world, crane, crane.cycle).placing);
}

/** Koniec `grabbing`: jednotka `→ in_crane` (vykládka z lode, nakládka z apronu / vozidla), `swinging` a hneď `placing`. */
function swing(crane: CraneModule, world: World): void {
  const berth = berthOf(world, crane);
  const ship = servedShip(world, crane, berth);
  if (ship === undefined) {
    throw new ModuleError('invalid_transition', `${crane.label}: koniec grabbing bez dokovanej lode s nákladom na ${berth.label}`);
  }
  const env: CraneEnv = { world, crane, berth, ship };
  const handover = HANDOVERS[berth.params.handoverMode];
  if (CRANE_CYCLE_TRAITS[crane.cycle].direction === 'unload') {
    const unitId = handover.unloadUnit(env);
    if (unitId === undefined) throw new ModuleError('invalid_transition', `${crane.label}: koniec grabbing bez jednotky importu na lodi #${String(ship.id)}`);
    world.cargo.move(unitId, { kind: 'in_crane', craneId: crane.id });
    crane.heldUnitId = unitId;
  } else {
    const unitId = crane.targetUnitId;
    handover.lift(env);
    crane.heldUnitId = unitId;
  }
  crane.transition('swinging');
  beginPlacing(crane, world);
}

/** Koniec cyklu: žeriav je voľný, smer cyklu a ciele vynulované a v tom istom ticku nový štart. */
function finish(crane: CraneModule, world: World): void {
  crane.heldUnitId = null;
  crane.reservedSlot = null;
  rest(crane);
  start(crane, world);
}

/**
 * Koniec `placing` vykládky: `Handover.deliver` odovzdá jednotku; keď sa nedá (hook bez vozidla a bez bufferu), žeriav ostane
 * s jednotkou v `placing` (`phaseTicksLeft = 1`), počíta `waitForVehicleTicks` a skúsi to v ďalšom ticku. Po odovzdaní
 * `CraneCycleDone` (a pri `dual_unload` `DualCycle`) a nový štart.
 */
function placeUnloaded(crane: CraneModule, world: World): void {
  const berth = berthOf(world, crane);
  const unitId = crane.heldUnitId;
  if (unitId === null) throw new ModuleError('invalid_transition', `${crane.label}: koniec placing vykládky bez jednotky`);
  // Loď už mohla odísť (posledný import je v žeriave, na palube nič nie je) — odovzdanie potrebuje len kotvisko žeriava.
  if (!HANDOVERS[berth.params.handoverMode].deliver({ world, crane, berth })) {
    crane.phaseTicksLeft = 1;
    crane.waitForVehicleTicks += 1;
    return;
  }
  const loadedUnitId = crane.dualUnitId;
  crane.heldUnitId = null;
  crane.transition('idle');
  world.events.emit({ type: 'CraneCycleDone', craneId: crane.id, unitId });
  if (loadedUnitId !== null && berth.dockedShipId !== null) {
    world.events.emit({ type: 'DualCycle', craneId: crane.id, shipId: berth.dockedShipId, loadedUnitId, unloadedUnitId: unitId });
  }
  finish(crane, world);
}

/**
 * Koniec `placing` nakládky: jednotka `in_crane → on_ship` a `UnitLoaded` (`lastMinute` = rolled jednotka, `outOfOrder` =
 * na termináli ostala skoršia jednotka stowage plánu). `dual_load` v tom istom ticku pokračuje `dual_unload` (ak je ešte
 * import na vykládku), inak sa žeriav uvoľní a vybaví nový štart.
 */
function placeLoaded(crane: CraneModule, world: World): void {
  const berth = berthOf(world, crane);
  const ship = servedShip(world, crane, berth);
  const unitId = crane.heldUnitId;
  const unit = unitId === null ? undefined : world.cargo.get(unitId);
  if (ship === undefined || unit === undefined || unit.contractId === null) {
    throw new ModuleError('invalid_transition', `${crane.label}: koniec placing nakládky bez lode (${String(ship?.id)}) alebo jednotky exportu (${String(unitId)})`);
  }
  const outOfOrder = stowageOutOfOrder(world, unit);
  const contract = world.contractBook.get(unit.contractId);
  const lastMinute = contract?.booking?.rolledUnitIds.includes(unit.id) ?? false;
  world.cargo.move(unit.id, { kind: 'on_ship', shipId: ship.id });
  world.events.emit({ type: 'UnitLoaded', craneId: crane.id, shipId: ship.id, unitId: unit.id, contractId: unit.contractId, lastMinute, outOfOrder });
  crane.heldUnitId = null;
  crane.transition('idle');
  if (crane.cycle === 'dual_load' && unclaimedImports(world, ship) > 0) {
    const env: CraneEnv = { world, crane, berth, ship };
    const handover = HANDOVERS[berth.params.handoverMode];
    const plan = handover.planUnload(env, true);
    if (plan !== undefined) {
      handover.reserveUnload(env);
      crane.dualUnitId = unit.id;
      enterGrabbing(world, crane, 'dual_unload', plan);
      return;
    }
    // Pre druhú polovicu nie je jednotka (hook: import berú iné žeriavy) — slot uvoľnený exportom sa vráti apronu.
    if (crane.reservedSlot !== null) {
      berth.apron.release(crane.reservedSlot);
      crane.reservedSlot = null;
    }
  }
  finish(crane, world);
}

/** Koniec `placing` podľa smeru cyklu (tabuľka, nie switch). */
const PLACE: { readonly [D in 'unload' | 'load']: (crane: CraneModule, world: World) => void } = {
  unload: placeUnloaded,
  load: placeLoaded,
};

function place(crane: CraneModule, world: World): void {
  PLACE[CRANE_CYCLE_TRAITS[crane.cycle].direction](crane, world);
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
  // `swinging` je okamžitý (v rámci `swing`) a neukladá sa (`restoreRuntimeState` ho odmietne) — žeriav v ňom tick
  // nikdy nezačne; ak áno, svet je poškodený mimo simulácie (T02-14).
  swinging: (crane) => {
    throw new ModuleError('invalid_transition', `${crane.label}: tick začal v okamžitom stave 'swinging' (poškodený stav žeriavu)`);
  },
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
