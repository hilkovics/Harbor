/**
 * Stavový automat lode (ARCHITECTURE §7.4; CLAUDE.md konvencia FSM; ADR-016, ADR-029): stavy, explicitná tabuľka
 * povolených prechodov `SHIP_TRANSITIONS` a vlastnosti stavov `SHIP_STATE_TRAITS`. Žiadne skryté prechody — stav lode
 * mení výlučne `Ship.transition(to)`, ktorý prechod overí v tabuľke.
 *
 * Životný cyklus: `arriving` (loď čaká pred vstupom na `seaLane[0]`, kým nemá cieľ s voľnou trasou — ADR-029) →
 * `inbound` (plavba po `seaLane` s rezervovaným cieľom: kotviská alebo anchorage) → na konci dráhy buď `berthing`
 * (kotviská pridelené), alebo `waiting_anchorage` (pláva na svoju anchorage a čaká) → `berthing` (cez koniec dráhy
 * a bod priblíženia pred kotviskom k polohe pri kotvisku) → `docked` (vykládka importu a nakládka exportu) →
 * `lashing` (F6a, ADR-032 bod 11: po poslednej naloženej jednotke lashing a papiere `lashingTicksPerUnit × naložené +
 * paperworkTicks`, loď drží kotvisko; loď bez naloženého exportu ho preskočí) → `undocking` (loď sa odsunie bokom
 * pred kotvisko a pláva na koniec `seaLane`; kotviská uvoľní až tam) → `outbound` (po `seaLane` k jej začiatku) →
 * `despawned` (loď opustí mapu, naložený export prejde `on_ship → shipped`, loď sa odstráni z `world.ships`).
 */

/** Stavy lode v poradí životného cyklu. */
export const SHIP_STATES = ['arriving', 'inbound', 'waiting_anchorage', 'berthing', 'docked', 'lashing', 'undocking', 'outbound', 'despawned'] as const;
export type ShipState = (typeof SHIP_STATES)[number];

/** Povolené prechody `from → [to…]` (karta T02-05, ADR-029, ADR-032 `lashing`). `despawned` je konečný stav. */
export const SHIP_TRANSITIONS: ReadonlyMap<ShipState, readonly ShipState[]> = new Map<ShipState, readonly ShipState[]>([
  ['arriving', Object.freeze(['inbound'] as const)],
  ['inbound', Object.freeze(['waiting_anchorage', 'berthing'] as const)],
  ['waiting_anchorage', Object.freeze(['berthing'] as const)],
  ['berthing', Object.freeze(['docked'] as const)],
  ['docked', Object.freeze(['undocking', 'lashing'] as const)],
  ['lashing', Object.freeze(['undocking'] as const)],
  ['undocking', Object.freeze(['outbound'] as const)],
  ['outbound', Object.freeze(['despawned'] as const)],
  ['despawned', Object.freeze([] as const)],
]);

/** Je prechod `from → to` v tabuľke? */
export function isShipTransitionAllowed(from: ShipState, to: ShipState): boolean {
  return SHIP_TRANSITIONS.get(from)?.includes(to) ?? false;
}

/** Či loď v stave niečo drží: vždy, smie (podľa rezervácie pri vstupe) alebo nikdy. */
export type ShipHolding = 'always' | 'optional' | 'never';

/** Čo platí pre loď v danom stave. */
export interface ShipStateTraits {
  /**
   * Kotviská (`berthIds`, každý berth má `dockedShipId` = loď): `berthing`/`docked` vždy, `inbound` smie (kotviská
   * rezervované pri vstupe, ADR-029), `undocking` smie (drží ich, kým nedopláva na koniec dráhy — trasa odchodu z nich
   * odvodí bod priblíženia; save spred ADR-029 ich v `undocking` nemá), ostatné nikdy.
   */
  readonly berths: ShipHolding;
  /**
   * Bunka anchorage (`anchorageIndex`): `inbound` smie (rezervovaná pri vstupe, ADR-029), `waiting_anchorage` vždy
   * (loď bez anchorage zo save v5 presunie parser pred vstup — `arriving`, ADR-029 addendum), ostatné nikdy.
   * `inbound` nedrží naraz kotviská aj anchorage a jedno z nich má vždy (cieľ trasy, `shipRouteProblem`).
   */
  readonly anchorage: ShipHolding;
  /**
   * Loď je v páse vody pred kotviskom alebo doň/z neho pláva — blokuje stavbu kotviska, ktorého pás by prekryl jej
   * obdĺžnik (`water_blocked`, ADR-016).
   */
  readonly blocksBerthWater: boolean;
  /**
   * Loď stojí pri kotvisku: presne v `dockPoint` prvého kotviska s kurzom `DOCKED_HEADING` jeho strany (trasa je
   * prázdna, loď sa nehýbe). Overuje obnova save aj invarianty (T02-14). `docked` aj `lashing` (ADR-032).
   */
  readonly moored: boolean;
  /**
   * Stav s odpočtom lashingu (`Ship.lashingTicksLeft ≥ 1`); mimo neho je odpočet 0 (save, krok 12; ADR-032 bod 11).
   */
  readonly lashes: boolean;
  /**
   * Loď je na mape a zaberá bunky svojho obdĺžnika (`shipCells`); dve lode na mape nikdy nezdieľajú bunku (ADR-029).
   * `arriving` čaká pred vstupom — nezaberá nič a prezentácia ju nekreslí.
   */
  readonly onMap: boolean;
}

function traits(spec: ShipStateTraits): ShipStateTraits {
  return Object.freeze(spec);
}

const OPEN_WATER = { blocksBerthWater: false, moored: false, onMap: true, lashes: false } as const;

export const SHIP_STATE_TRAITS: { readonly [S in ShipState]: ShipStateTraits } = Object.freeze({
  arriving: traits({ ...OPEN_WATER, berths: 'never', anchorage: 'never', onMap: false }),
  inbound: traits({ ...OPEN_WATER, berths: 'optional', anchorage: 'optional' }),
  waiting_anchorage: traits({ ...OPEN_WATER, berths: 'never', anchorage: 'always' }),
  berthing: traits({ ...OPEN_WATER, berths: 'always', anchorage: 'never', blocksBerthWater: true }),
  docked: traits({ ...OPEN_WATER, berths: 'always', anchorage: 'never', blocksBerthWater: true, moored: true }),
  lashing: traits({ ...OPEN_WATER, berths: 'always', anchorage: 'never', blocksBerthWater: true, moored: true, lashes: true }),
  undocking: traits({ ...OPEN_WATER, berths: 'optional', anchorage: 'never', blocksBerthWater: true }),
  outbound: traits({ ...OPEN_WATER, berths: 'never', anchorage: 'never' }),
  despawned: traits({ ...OPEN_WATER, berths: 'never', anchorage: 'never', onMap: false }),
});

/** Súlad počtu s pravidlom držania (`ShipHolding`): `always` ⇔ > 0, `never` ⇔ 0, `optional` čokoľvek. */
export function holdingAllows(holding: ShipHolding, count: number): boolean {
  if (holding === 'always') return count > 0;
  if (holding === 'never') return count === 0;
  return true;
}
