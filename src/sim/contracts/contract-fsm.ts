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

/** Stavy kontraktu v poradí životného cyklu (spoločné pre všetky druhy kontraktov; ADR-032 nové stavy nepridal). */
export const CONTRACT_STATES = ['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting', 'completed', 'failed', 'expired'] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

/**
 * Druhy kontraktu (ADR-032 bod 1, ADR-034): `import` (náklad príde loďou a odíde po súši — F5), `export` (booking: náklad
 * príde po súši a odpláva loďou voyage), `empty_repositioning` (linka nalodí N dostupných prázdnych kontajnerov na loď
 * voyage) a `tranship` (loď A privezie jednotky, loď B ich odvezie, bez prechodu bránou). Druh určuje trieda
 * (`ImportContract`, `ExportContract`, `EmptyRepositioningContract`, `TranshipContract`), nie switch.
 */
export const CONTRACT_KINDS = ['import', 'export', 'empty_repositioning', 'tranship'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

/**
 * Skupiny ponúk v poole (`ContractBook.offeredGroups`, ADR-034): `import` (voyage bez bookingu), `booking` (export,
 * roundtrip), `repositioning` (voyage s kontraktom `empty_repositioning`) a `tranship`. Poradie = priorita: skupina patrí
 * najvyššej skupine svojich kontraktov (roundtrip → `booking`, export + repositioning → `repositioning`).
 */
export const OFFER_GROUPS = ['import', 'booking', 'repositioning', 'tranship'] as const;
export type OfferGroup = (typeof OFFER_GROUPS)[number];

/**
 * Vlastnosti druhu kontraktu (ADR-034; tabuľka, nie switch): či save nesie `booking` (export-podobné kontrakty: export,
 * repositioning, tranship — počítadlá jednotiek a cieľový prístav) a `tranship` (plán lode B), a do ktorej skupiny poolu
 * patrí ponuka (`OfferGroup`).
 */
export interface ContractKindTraits {
  readonly booking: boolean;
  readonly tranship: boolean;
  readonly offerGroup: OfferGroup;
}

export const CONTRACT_KIND_TRAITS: { readonly [K in ContractKind]: ContractKindTraits } = Object.freeze({
  import: Object.freeze({ booking: false, tranship: false, offerGroup: 'import' }),
  export: Object.freeze({ booking: true, tranship: false, offerGroup: 'booking' }),
  empty_repositioning: Object.freeze({ booking: true, tranship: false, offerGroup: 'repositioning' }),
  tranship: Object.freeze({ booking: true, tranship: true, offerGroup: 'tranship' }),
});

/** Je hodnota druh kontraktu (parsovanie save)? */
export function isContractKind(value: unknown): value is ContractKind {
  return (CONTRACT_KINDS as readonly unknown[]).includes(value);
}

/** Tabuľka povolených prechodov jedného druhu kontraktu. */
export type ContractTransitions = { readonly [S in ContractState]: readonly ContractState[] };

/** Povolené prechody **import** kontraktu `from → [to…]` (rozhodnutie 4 F5). `completed`, `failed` a `expired` sú konečné. */
export const CONTRACT_TRANSITIONS: ContractTransitions = Object.freeze({
  offered: Object.freeze(['accepted', 'expired'] as const),
  accepted: Object.freeze(['ship_en_route'] as const),
  ship_en_route: Object.freeze(['unloading', 'failed'] as const),
  unloading: Object.freeze(['exporting', 'failed'] as const),
  exporting: Object.freeze(['completed', 'failed'] as const),
  completed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  expired: Object.freeze([] as const),
});

/**
 * Povolené prechody **export** bookingu (ADR-032 bod 1): `offered → accepted | expired`, `accepted` (kamióny s exportom
 * prichádzajú podľa plánu) `→ ship_en_route` (loď voyage vznikla), `ship_en_route → exporting` (loď pri kotvisku:
 * nakládka a lashing — „Exportuje sa") `| failed`, `exporting → completed` (loď odplávala s aspoň jednou naloženou
 * jednotkou) `| failed` (SLA, alebo loď odplávala bez exportu). `unloading` export nepoužíva.
 */
export const EXPORT_CONTRACT_TRANSITIONS: ContractTransitions = Object.freeze({
  offered: Object.freeze(['accepted', 'expired'] as const),
  accepted: Object.freeze(['ship_en_route'] as const),
  ship_en_route: Object.freeze(['exporting', 'failed'] as const),
  unloading: Object.freeze([] as const),
  exporting: Object.freeze(['completed', 'failed'] as const),
  completed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  expired: Object.freeze([] as const),
});

/**
 * Prechody podľa druhu kontraktu (dáta; trieda kontraktu si berie svoj riadok): `empty_repositioning` ako export booking
 * (loď voyage nakladá prázdne: `exporting`), `tranship` ako import (loď A sa vykladá: `unloading`; po vykládke `exporting` =
 * prekládka čaká na loď B a nakladá sa na ňu; ADR-034).
 */
export const CONTRACT_TRANSITIONS_BY_KIND: { readonly [K in ContractKind]: ContractTransitions } = Object.freeze({
  import: CONTRACT_TRANSITIONS,
  export: EXPORT_CONTRACT_TRANSITIONS,
  empty_repositioning: EXPORT_CONTRACT_TRANSITIONS,
  tranship: CONTRACT_TRANSITIONS,
});

/** Je prechod `from → to` v tabuľke druhu `kind` (predvolene import)? */
export function isContractTransitionAllowed(from: ContractState, to: ContractState, kind: ContractKind = 'import'): boolean {
  return CONTRACT_TRANSITIONS_BY_KIND[kind][from].includes(to);
}

/**
 * Outbound jednotiek **import** kontraktu v danom stave (dispatcher krok 5, rozhodnutie 9, ADR-027 vrátane dodatku
 * T05-11); export booking má vlastné pravidlo (`ExportContract.outbound`, ADR-032):
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
