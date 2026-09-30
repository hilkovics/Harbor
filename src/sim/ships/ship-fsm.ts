/**
 * Stavový automat lode (ARCHITECTURE §7.4; CLAUDE.md konvencia FSM; ADR-016): stavy, explicitná tabuľka povolených
 * prechodov `SHIP_TRANSITIONS` a vlastnosti stavov `SHIP_STATE_TRAITS`. Žiadne skryté prechody — stav lode mení
 * výlučne `Ship.transition(to)`, ktorý prechod overí v tabuľke.
 *
 * Životný cyklus: `inbound` (plavba po `seaLane`) → na konci dráhy buď `berthing` (kotviská pridelené), alebo
 * `waiting_anchorage` (čaká na anchorage) → `berthing` (priama úsečka k polohe pri kotvisku) → `docked` (vykládka)
 * → `undocking` (kotviská uvoľnené, loď pláva späť na koniec `seaLane`) → `outbound` (po `seaLane` k jej začiatku)
 * → `despawned` (loď opustí mapu, odstráni sa z `world.ships`).
 */

/** Stavy lode v poradí životného cyklu. */
export const SHIP_STATES = ['inbound', 'waiting_anchorage', 'berthing', 'docked', 'undocking', 'outbound', 'despawned'] as const;
export type ShipState = (typeof SHIP_STATES)[number];

/** Povolené prechody `from → [to…]` (karta T02-05). `despawned` je konečný stav. */
export const SHIP_TRANSITIONS: ReadonlyMap<ShipState, readonly ShipState[]> = new Map<ShipState, readonly ShipState[]>([
  ['inbound', Object.freeze(['waiting_anchorage', 'berthing'] as const)],
  ['waiting_anchorage', Object.freeze(['berthing'] as const)],
  ['berthing', Object.freeze(['docked'] as const)],
  ['docked', Object.freeze(['undocking'] as const)],
  ['undocking', Object.freeze(['outbound'] as const)],
  ['outbound', Object.freeze(['despawned'] as const)],
  ['despawned', Object.freeze([] as const)],
]);

/** Je prechod `from → to` v tabuľke? */
export function isShipTransitionAllowed(from: ShipState, to: ShipState): boolean {
  return SHIP_TRANSITIONS.get(from)?.includes(to) ?? false;
}

/** Čo platí pre loď v danom stave. */
export interface ShipStateTraits {
  /** Loď drží kotviská: `berthIds` je neprázdne a každý z nich má `dockedShipId` = loď (rezervácia od `berthing`). */
  readonly holdsBerths: boolean;
  /** Smie mať pridelenú bunku anchorage (`anchorageIndex`) — čaká na kotvisko. */
  readonly waitsForBerth: boolean;
  /**
   * Loď je v páse vody pred kotviskom alebo doň/z neho pláva — blokuje stavbu kotviska, ktorého pás by prekryl jej
   * obdĺžnik (`water_blocked`, ADR-016).
   */
  readonly blocksBerthWater: boolean;
  /**
   * Loď stojí pri kotvisku: presne v `dockPoint` prvého kotviska s kurzom `DOCKED_HEADING` jeho strany (trasa je
   * prázdna, loď sa nehýbe). Overuje obnova save aj invarianty (T02-14).
   */
  readonly moored: boolean;
}

export const SHIP_STATE_TRAITS: { readonly [S in ShipState]: ShipStateTraits } = Object.freeze({
  inbound: Object.freeze({ holdsBerths: false, waitsForBerth: false, blocksBerthWater: false, moored: false }),
  waiting_anchorage: Object.freeze({ holdsBerths: false, waitsForBerth: true, blocksBerthWater: false, moored: false }),
  berthing: Object.freeze({ holdsBerths: true, waitsForBerth: false, blocksBerthWater: true, moored: false }),
  docked: Object.freeze({ holdsBerths: true, waitsForBerth: false, blocksBerthWater: true, moored: true }),
  undocking: Object.freeze({ holdsBerths: false, waitsForBerth: false, blocksBerthWater: true, moored: false }),
  outbound: Object.freeze({ holdsBerths: false, waitsForBerth: false, blocksBerthWater: false, moored: false }),
  despawned: Object.freeze({ holdsBerths: false, waitsForBerth: false, blocksBerthWater: false, moored: false }),
});
