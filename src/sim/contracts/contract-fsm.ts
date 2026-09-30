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

/**
 * Outbound jednotiek kontraktu v danom stave (dispatcher krok 5, rozhodnutie 9, ADR-027 vrátane dodatku T05-11):
 * - `sla` — smú na rampu ako prvé, kontrakty v poradí `slaDeadlineTick` ↑, potom id ↑ (`unloading` aj `exporting`:
 *   uskladnené jednotky smú odísť už počas vykládky — inak by objem nad voľnú kapacitu skladov zaplnil sklad aj apron,
 *   loď by blokovala kotvisko a kontrakt by nikdy neprišiel do `exporting`);
 * - `free` — smú na rampu po všetkých `sla`, kontrakty v poradí id ↑, za nimi jednotky bez kontraktu (`failed`:
 *   náklad už kontraktu nepomôže, ale nesmie navždy zaberať sklad);
 * - `held` — zostávajú v sklade (stavy, ktoré uskladnené jednotky nemajú; `completed` už nemá čo exportovať).
 */
export type ContractOutbound = 'sla' | 'free' | 'held';

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
  /** Smú uskladnené jednotky kontraktu na rampu a s akou prioritou (dispatcher, `ContractOutbound`, ADR-027). */
  readonly outbound: ContractOutbound;
}

const traits = (value: ContractStateTraits): ContractStateTraits => Object.freeze(value);

export const CONTRACT_STATE_TRAITS: { readonly [S in ContractState]: ContractStateTraits } = Object.freeze({
  offered: traits({ terminal: false, offer: true, plan: 'absent', ship: 'absent', docked: 'absent', slaRunning: false, demurrage: false, outbound: 'held' }),
  accepted: traits({ terminal: false, offer: false, plan: 'required', ship: 'absent', docked: 'absent', slaRunning: false, demurrage: false, outbound: 'held' }),
  ship_en_route: traits({ terminal: false, offer: false, plan: 'required', ship: 'required', docked: 'absent', slaRunning: true, demurrage: false, outbound: 'held' }),
  unloading: traits({ terminal: false, offer: false, plan: 'required', ship: 'required', docked: 'required', slaRunning: true, demurrage: true, outbound: 'sla' }),
  exporting: traits({ terminal: false, offer: false, plan: 'required', ship: 'required', docked: 'required', slaRunning: true, demurrage: false, outbound: 'sla' }),
  completed: traits({ terminal: true, offer: false, plan: 'required', ship: 'required', docked: 'required', slaRunning: false, demurrage: false, outbound: 'held' }),
  failed: traits({ terminal: true, offer: false, plan: 'required', ship: 'required', docked: 'optional', slaRunning: false, demurrage: false, outbound: 'free' }),
  expired: traits({ terminal: true, offer: false, plan: 'absent', ship: 'absent', docked: 'absent', slaRunning: false, demurrage: false, outbound: 'held' }),
});

/** Je hodnota známy stav kontraktu (parsovanie save)? */
export function isContractState(value: unknown): value is ContractState {
  return typeof value === 'string' && (CONTRACT_STATES as readonly string[]).includes(value);
}
