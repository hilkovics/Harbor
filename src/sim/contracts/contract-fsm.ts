/**
 * Stavový automat kontraktu (ARCHITECTURE §9.1; docs/tasks/phase-05.md rozhodnutie 4; ADR-026): stavy, explicitná
 * tabuľka povolených prechodov `CONTRACT_TRANSITIONS` a vlastnosti stavov `CONTRACT_STATE_TRAITS`. Žiadne skryté
 * prechody — stav kontraktu mení výlučne `Contract.transition(to)` (volá ho `ContractBook.changeState`, ktorý emituje
 * `ContractStateChanged`).
 *
 * Hlavná vetva: `offered →(AcceptContract) accepted →(spawn lode) ship_en_route →(loď zakotvila) unloading
 * →(vyložený celý objem) exporting →(exportovaný celý objem) completed`. Odbočky: `offered → expired` (uplynul
 * `offerExpiresTick` alebo `DeclineContract` — dôvod nesie `ContractExpired`, nový stav nevzniká) a `failed` zo stavov
 * s bežiacim SLA, keď meškanie presiahne `failAfterDaysLate` dní.
 */

/** Stavy kontraktu v poradí životného cyklu. */
export const CONTRACT_STATES = ['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting', 'completed', 'failed', 'expired'] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

/** Povolené prechody `from → [to…]` (rozhodnutie 4). `completed`, `failed` a `expired` sú konečné. */
export const CONTRACT_TRANSITIONS: { readonly [S in ContractState]: readonly ContractState[] } = Object.freeze({
  offered: Object.freeze(['accepted', 'expired'] as const),
  accepted: Object.freeze(['ship_en_route'] as const),
  ship_en_route: Object.freeze(['unloading', 'failed'] as const),
  unloading: Object.freeze(['exporting', 'failed'] as const),
  exporting: Object.freeze(['completed', 'failed'] as const),
  completed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  expired: Object.freeze([] as const),
});

/** Je prechod `from → to` v tabuľke? */
export function isContractTransitionAllowed(from: ContractState, to: ContractState): boolean {
  return CONTRACT_TRANSITIONS[from].includes(to);
}

/** Či pole kontraktu v danom stave musí byť nastavené (`required`), nesmie (`absent`) alebo môže (`optional`). */
export type FieldPresence = 'required' | 'absent' | 'optional';

/** Čo platí pre kontrakt v danom stave (kontroluje obnova save aj krok 12). */
export interface ContractStateTraits {
  /** Konečný stav — kontrakt už nemení stav ani počítadlá penalizácií; `closedTick` je nastavený. */
  readonly terminal: boolean;
  /** Kontrakt je v poole ponúk (počíta sa do `offersPerDay`). */
  readonly offer: boolean;
  /** Plán prijatia: `acceptedTick`, `shipArrivalTick`, `slaDeadlineTick`. */
  readonly plan: FieldPresence;
  /** Loď kontraktu (`shipId`) — vzniká pri `accepted → ship_en_route`. */
  readonly ship: FieldPresence;
  /** Začiatok státia lode pri kotvisku (`dockedTick`) — od `ship_en_route → unloading`. */
  readonly docked: FieldPresence;
  /** Beží SLA hodiny: pripisujú sa late penalizácie a hrozí `failed`. */
  readonly slaRunning: boolean;
  /** Kontrakt s bežiacim demurrage: loď kontraktu stojí pri kotvisku. */
  readonly demurrage: boolean;
}

const traits = (value: ContractStateTraits): ContractStateTraits => Object.freeze(value);

export const CONTRACT_STATE_TRAITS: { readonly [S in ContractState]: ContractStateTraits } = Object.freeze({
  offered: traits({ terminal: false, offer: true, plan: 'absent', ship: 'absent', docked: 'absent', slaRunning: false, demurrage: false }),
  accepted: traits({ terminal: false, offer: false, plan: 'required', ship: 'absent', docked: 'absent', slaRunning: false, demurrage: false }),
  ship_en_route: traits({ terminal: false, offer: false, plan: 'required', ship: 'required', docked: 'absent', slaRunning: true, demurrage: false }),
  unloading: traits({ terminal: false, offer: false, plan: 'required', ship: 'required', docked: 'required', slaRunning: true, demurrage: true }),
  exporting: traits({ terminal: false, offer: false, plan: 'required', ship: 'required', docked: 'required', slaRunning: true, demurrage: false }),
  completed: traits({ terminal: true, offer: false, plan: 'required', ship: 'required', docked: 'required', slaRunning: false, demurrage: false }),
  failed: traits({ terminal: true, offer: false, plan: 'required', ship: 'required', docked: 'optional', slaRunning: false, demurrage: false }),
  expired: traits({ terminal: true, offer: false, plan: 'absent', ship: 'absent', docked: 'absent', slaRunning: false, demurrage: false }),
});

/** Je hodnota známy stav kontraktu (parsovanie save)? */
export function isContractState(value: unknown): value is ContractState {
  return typeof value === 'string' && (CONTRACT_STATES as readonly string[]).includes(value);
}
