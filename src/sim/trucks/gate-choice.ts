/**
 * Výber vstupu do prístavu pre kamión (R4, ADR-041 bod 2 a 3): portál vjazdu, predbránová plocha alebo vstupný pruh brány, trasa k rampe. Všetko deterministické; `Rng` sa
 * spotrebuje len pri výbere medzi viacerými voľnými portálmi (`pickInPortal`, váha `trafficShare`).
 *
 * - **Portál:** kamión vznikne na voľnom portáli vjazdu (bunku nedrží nosič, `isPortalBlocked`); pri viacerých voľných portáloch ho vyberie `Rng.weighted` podľa `trafficShare`.
 *   Obsadený portál sa preskočí — vnútrozemie čaká pri každom portáli zvlášť (ADR-035): položka plánu ostane, kým niektorý portál nie je voľný.
 * - **Brána:** spomedzi trás rampy so stojiskom s voľným bayom (`routeWithFreeBay` pravidlá misie) vyhrá vstup s najkratším odhadom času
 *   `cesta z portálu / rýchlosť kamióna + záťaž × stredný čas obsluhy`. Vstup je predbránová plocha (ak pruh trasy obsluhuje; len s voľným miestom) alebo samotný pruh.
 *   Pri zhode vyhrá prvá trasa (najnižšie id pruhu, potom stojiska). Vstup bez cesty z portálu (nekonečný odhad) sa preskočí.
 */
import type { TruckDef } from '../defs/types';
import { NO_ACCESS, accessCellIndex } from '../logistics/module-access';
import type { LoadingRamp } from '../modules/loading-ramp';
import type { PreGateBuffer } from '../modules/pre-gate-buffer';
import { TruckGate } from '../modules/truck-gate';
import { WaitingArea } from '../modules/waiting-area';
import { LANES_PER_CELL } from '../traffic/lane-slots';
import type { LandsidePortal, LandsideRoute } from '../world/landside';
import type { World } from '../world/world';
import { TRUCK_MISSION_USES_PICKUP_BAYS, type TruckMission } from './truck-fsm';

/**
 * Drží niektorý nosič slot bunky portálu `portal` (v ktoromkoľvek pruhu)? Na obsadenom portáli kamión nevznikne (ADR-037, R1 č. 10);
 * kontrola je konzervatívna — pruh nového kamióna sa určuje až podľa jeho trasy, tá sa pred vznikom neplánuje.
 */
export function isPortalBlocked(world: World, portal: number): boolean {
  for (let lane = 0; lane < LANES_PER_CELL; lane++) if (world.laneSlots.holderOf(portal, lane) !== null) return true;
  return false;
}

/** Znovupoužiteľné pole voľných portálov (hot path; plní sa pri každom volaní). */
const FREE_PORTALS: LandsidePortal[] = [];

/** Výber z `FREE_PORTALS`: žiadny → `NO_ACCESS`, jediný → ten (bez `Rng`), viac → `Rng.weighted` podľa `trafficShare`. */
function drawFreePortal(world: World): number {
  if (FREE_PORTALS.length === 0) return NO_ACCESS;
  if (FREE_PORTALS.length === 1) return FREE_PORTALS[0].cell;
  return world.rng.weighted(FREE_PORTALS, (portal) => portal.share).cell;
}

/**
 * Portál vjazdu pre nový kamión: voľné portály s cestou k vstupu brány (`LandsideNetwork.inPortals`); jediný voľný → ten (bez `Rng`), viac → `Rng.weighted` podľa `trafficShare`;
 * žiadny voľný → `NO_ACCESS` (kamión nevznikne, položka plánu ostane).
 */
export function pickInPortal(world: World): number {
  FREE_PORTALS.length = 0;
  for (const portal of world.landside.inPortals) if (!isPortalBlocked(world, portal.cell)) FREE_PORTALS.push(portal);
  return drawFreePortal(world);
}

/**
 * Ako `pickInPortal`, ale len z portálov, z ktorých má kamión misie `mission` k rampe `ramp` vstup (`pickGate` s miestom v ploche a bayom): pri viacerých blokoch pruhov
 * s vlastnými vjazdmi tak kamión nevznikne na portáli, z ktorého by nemal kam ísť, kým iný portál je použiteľný.
 */
export function pickInPortalFor(world: World, ramp: LoadingRamp, mission: TruckMission, truckDef: Readonly<TruckDef> | undefined): number {
  FREE_PORTALS.length = 0;
  for (const portal of world.landside.inPortals) {
    if (!isPortalBlocked(world, portal.cell) && pickGate(world, ramp, mission, portal.cell, truckDef) !== undefined) FREE_PORTALS.push(portal);
  }
  return drawFreePortal(world);
}

/** Kamióny, ktoré idú (stav `to_pre_gate`) na predbránovú plochu `buffer` a ešte na nej nie sú — držia si miesto. */
export function preGateInbound(world: World, buffer: PreGateBuffer): number {
  let count = 0;
  for (const truck of world.trucks.values()) if (truck.state === 'to_pre_gate' && truck.preGateId === buffer.id) count += 1;
  return count;
}

/** Voľné miesta plochy po odpočítaní kamiónov na ceste k nej. */
export function preGateRoom(world: World, buffer: PreGateBuffer): number {
  return buffer.freeSlots - preGateInbound(world, buffer);
}

/** Záťaž pruhu: kamióny vo fronte (aj prechádzajúci) a kamióny, ktoré k nemu idú (`to_gate` so vstupným pruhom, `to_gate_out` s výstupným pruhom). */
export function laneLoad(world: World, lane: TruckGate): number {
  let load = lane.queueLength;
  for (const truck of world.trucks.values()) {
    if ((truck.state === 'to_gate' && truck.gateId === lane.id) || (truck.state === 'to_gate_out' && truck.gateOutId === lane.id)) load += 1;
  }
  return load;
}

/** Výber vstupu: trasa a (voliteľne) predbránová plocha, cez ktorú kamión ide. */
export interface GateChoice {
  readonly route: LandsideRoute;
  readonly buffer: PreGateBuffer | null;
}

/** Cestovný čas v tickoch zo ceny cesty `cost` pri rýchlosti `speed` buniek za tick (nekonečná cena zostáva nekonečná). */
function travelTicks(cost: number, speed: number): number {
  return cost / Math.max(speed, Number.MIN_VALUE);
}

/**
 * Najlepší vstup pre kamión misie `mission` k rampe `ramp` z portálu `portal` (viď hlavička); `portal === NO_ACCESS` = bez odhadu cesty (prvá trasa, ktorá má miesto).
 * Žiadna trasa so stojiskom s voľným bayom a vstupom s miestom → `undefined`.
 */
export function pickGate(world: World, ramp: LoadingRamp, mission: TruckMission, portal: number, truckDef: Readonly<TruckDef> | undefined): GateChoice | undefined {
  const usesPickupBays = TRUCK_MISSION_USES_PICKUP_BAYS[mission];
  const speed = truckDef?.speedCellsPerTick ?? 1;
  const { preGates } = world.landsideModules;
  let best: GateChoice | undefined;
  let bestEta = Infinity;
  for (const route of world.landsideRoutes(ramp)) {
    const area = world.modules.get(route.waitingAreaId);
    if (!(area instanceof WaitingArea) || (usesPickupBays ? area.freeBays : area.freeBaysForDelivery) <= 0) continue;
    const lane = world.modules.get(route.gateId);
    if (!(lane instanceof TruckGate)) continue;
    const buffer = world.landside.preGateOf(lane, preGates) ?? null;
    let eta = 0;
    if (buffer !== null) {
      const room = preGateRoom(world, buffer);
      if (room <= 0) continue;
      if (portal !== NO_ACCESS) {
        const entry = buffer.connectors[0];
        const cell = entry === undefined ? NO_ACCESS : accessCellIndex(world.grid, entry);
        const lanes = world.landside.preGateLanes(buffer);
        let service = 0;
        for (const candidate of lanes) service += candidate.meanServiceTicks(candidate.mode);
        service /= Math.max(lanes.length, 1);
        eta = travelTicks(world.distances.distance(portal, cell), speed) + ((buffer.capacity - room) / Math.max(lanes.length, 1)) * service;
      }
    } else if (portal !== NO_ACCESS) {
      eta = travelTicks(world.distances.distance(portal, route.gateEntryCell), speed) + laneLoad(world, lane) * lane.meanServiceTicks(lane.mode);
    }
    // Vstup, na ktorý z portálu nevedie cesta (nekonečný odhad), kamión nedostane — pri plnej ploche by inak skončil v `no_path` pred nedosiahnuteľnou plochou iného bloku.
    if (!Number.isFinite(eta)) continue;
    if (best === undefined || eta < bestEta) {
      best = { route, buffer };
      bestEta = eta;
    }
  }
  return best;
}
