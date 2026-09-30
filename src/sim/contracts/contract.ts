/**
 * Kontrakt na prekládku (ARCHITECTURE §9.1; docs/tasks/phase-05.md „Spoločné rozhrania"; ADR-026).
 *
 * Podmienky ponuky (`ContractTerms`) sa určia pri vzniku v poole a už sa nemenia: šablóna, náklad, objem, SLA v celých
 * dňoch, odmena a XP, trieda lode a expirácia ponuky. Priebeh (plán prijatia, loď, počítadlá jednotiek a penalizácií)
 * menia len `ContractBook` (háčik ledgera nákladu), príkazy `AcceptContract` / `DeclineContract` a `ContractSystem`
 * (krok 2). Stav je privátny s getterom — mení ho výlučne `transition` podľa `CONTRACT_TRANSITIONS`.
 *
 * Voliteľné polia zo „Spoločných rozhraní" (`acceptedTick?`, `shipId?`, …) sú `undefined`, kým ich stav nevyžaduje
 * (`CONTRACT_STATE_TRAITS`); v save sú `null`. Konštruktor ich poradie drží pevné, aby dva rovnaké kontrakty
 * (originál a obnova zo save) mali rovnaký tvar aj pri `JSON.stringify`.
 */
import type { ContractId, EntityId } from '../core/entity-id';
import { ContractError } from './contract-error';
import { CONTRACT_STATE_TRAITS, CONTRACT_TRANSITIONS, isContractState, type ContractState, type FieldPresence } from './contract-fsm';

/** Nemenné podmienky ponuky. */
export interface ContractTerms {
  /** Id z vlastnej postupnosti knihy kontraktov (`ContractId`, nie `world.ids`). */
  readonly id: ContractId;
  /** Šablóna z `contract_templates.json`. */
  readonly templateId: string;
  /** Typ nákladu z `cargo_types.json`. */
  readonly cargoTypeId: string;
  /** Počet jednotiek nákladu (celé ≥ 1, ≤ kapacita lode). */
  readonly volumeUnits: number;
  /** SLA v celých dňoch od príchodu lode (zo `slaDaysRange` šablóny). */
  readonly slaDays: number;
  /** Odmena v centoch (celé ≥ 1): `⌊volume × basePricePerUnitCents × urgencyBp / 10 000⌋`. */
  readonly rewardCents: number;
  /** XP za včasné dokončenie: `volume × xpPerUnit × xpMultiplier`. */
  readonly xpReward: number;
  /** Tick vzniku ponuky. */
  readonly offeredTick: number;
  /** Tick, v ktorom nevybraná ponuka expiruje (`offeredTick + offerExpiryDays × ticksPerDay`). */
  readonly offerExpiresTick: number;
  /** Trieda lode zo `ships.json` (jedna zo `shipClassIds` šablóny). */
  readonly shipClassId: string;
}

/** Kontrakt v save (`WorldState.contracts`, v5): podmienky + priebeh; nenastavené polia sú `null`. */
export interface SerializedContract extends Omit<ContractTerms, 'id'> {
  readonly id: number;
  readonly state: ContractState;
  readonly acceptedTick: number | null;
  readonly shipArrivalTick: number | null;
  readonly slaDeadlineTick: number | null;
  readonly shipId: number | null;
  readonly dockedTick: number | null;
  readonly closedTick: number | null;
  readonly unitsUnloaded: number;
  readonly unitsExported: number;
  readonly penaltiesCents: number;
  readonly demurrageHours: number;
  readonly lateDays: number;
}

/** Kľúče serializovaného kontraktu v poradí `toState()`. */
export const SERIALIZED_CONTRACT_KEYS: readonly (keyof SerializedContract)[] = [
  'id',
  'templateId',
  'cargoTypeId',
  'volumeUnits',
  'slaDays',
  'rewardCents',
  'xpReward',
  'offeredTick',
  'offerExpiresTick',
  'shipClassId',
  'state',
  'acceptedTick',
  'shipArrivalTick',
  'slaDeadlineTick',
  'shipId',
  'dockedTick',
  'closedTick',
  'unitsUnloaded',
  'unitsExported',
  'penaltiesCents',
  'demurrageHours',
  'lateDays',
];

const isCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const isPositive = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

/** Pole `name` s hodnotou `value` zodpovedá požiadavke stavu `presence`; inak `ContractError`. */
function checkPresence(label: string, name: string, value: number | undefined, presence: FieldPresence): void {
  if (presence === 'required' && value === undefined) throw new ContractError('invalid_input', `${label}: v tomto stave musí mať ${name}`);
  if (presence === 'absent' && value !== undefined) throw new ContractError('invalid_input', `${label}: v tomto stave nesmie mať ${name}`);
  if (value !== undefined && !isCount(value)) throw new ContractError('invalid_input', `${label}: ${name} musí byť celé číslo ≥ 0, dostal ${String(value)}`);
}

const orUndefined = (value: number | null): number | undefined => (value === null ? undefined : value);
const orNull = (value: number | undefined): number | null => (value === undefined ? null : value);

export class Contract {
  readonly id: ContractId;
  readonly templateId: string;
  readonly cargoTypeId: string;
  readonly volumeUnits: number;
  readonly slaDays: number;
  readonly rewardCents: number;
  readonly xpReward: number;
  readonly offeredTick: number;
  readonly offerExpiresTick: number;
  readonly shipClassId: string;
  /** Tick prijatia (`AcceptContract`, `clock.tick` v príkazovej fáze). */
  acceptedTick: number | undefined;
  /** Tick príchodu (spawnu) lode kontraktu. */
  shipArrivalTick: number | undefined;
  /** Termín exportu: `shipArrivalTick + slaDays × ticksPerDay`. */
  slaDeadlineTick: number | undefined;
  /** Loď kontraktu (od `ship_en_route`; po odchode lode z mapy ostáva ako história). */
  shipId: EntityId | undefined;
  /** Začiatok státia lode pri kotvisku (`ship_en_route → unloading`) — od neho beží `berthAllowanceTicks`. */
  dockedTick: number | undefined;
  /** Tick uzavretia (`completed`, `failed`, `expired`). */
  closedTick: number | undefined;
  /** Jednotky kontraktu, ktoré opustili loď (`on_ship → …`). */
  unitsUnloaded = 0;
  /** Jednotky kontraktu, ktoré opustili mapu (`→ exported`). */
  unitsExported = 0;
  /** Priebežne nasčítané penalizácie (demurrage + late) v centoch; z hotovosti sa strhnú pri `completed`/`failed`. */
  penaltiesCents = 0;
  /** Počet celých hodín demurrage, ktoré už boli pripísané. */
  demurrageHours = 0;
  /** Počet celých dní po SLA, za ktoré už bola pripísaná late penalizácia. */
  lateDays = 0;
  private current: ContractState;

  /**
   * Nová ponuka (`offered`) s podmienkami `terms`. Chyby (`ContractError('invalid_input')`): id nie je celé ≥ 1,
   * objem alebo odmena nie je celé ≥ 1, SLA nie je celé ≥ 1, XP nie je konečné ≥ 0, ticky nie sú celé ≥ 0 alebo
   * expirácia nie je po vzniku.
   */
  constructor(terms: ContractTerms) {
    const label = `kontrakt #${String(terms.id)}`;
    if (!isPositive(terms.id)) throw new ContractError('invalid_input', `${label}: id musí byť celé číslo ≥ 1`);
    if (!isPositive(terms.volumeUnits)) throw new ContractError('invalid_input', `${label}: volumeUnits musí byť celé číslo ≥ 1, dostal ${String(terms.volumeUnits)}`);
    if (!isPositive(terms.slaDays)) throw new ContractError('invalid_input', `${label}: slaDays musí byť celé číslo ≥ 1, dostal ${String(terms.slaDays)}`);
    if (!isPositive(terms.rewardCents)) throw new ContractError('invalid_input', `${label}: rewardCents musí byť celé číslo ≥ 1, dostal ${String(terms.rewardCents)}`);
    if (!Number.isFinite(terms.xpReward) || terms.xpReward < 0) throw new ContractError('invalid_input', `${label}: xpReward musí byť konečné číslo ≥ 0`);
    if (!isCount(terms.offeredTick) || !isCount(terms.offerExpiresTick) || terms.offerExpiresTick <= terms.offeredTick) {
      throw new ContractError('invalid_input', `${label}: offeredTick a offerExpiresTick musia byť celé ≥ 0 a expirácia po vzniku`);
    }
    this.id = terms.id;
    this.templateId = terms.templateId;
    this.cargoTypeId = terms.cargoTypeId;
    this.volumeUnits = terms.volumeUnits;
    this.slaDays = terms.slaDays;
    this.rewardCents = terms.rewardCents;
    this.xpReward = terms.xpReward;
    this.offeredTick = terms.offeredTick;
    this.offerExpiresTick = terms.offerExpiresTick;
    this.shipClassId = terms.shipClassId;
    this.acceptedTick = undefined;
    this.shipArrivalTick = undefined;
    this.slaDeadlineTick = undefined;
    this.shipId = undefined;
    this.dockedTick = undefined;
    this.closedTick = undefined;
    this.current = 'offered';
  }

  /**
   * Kontrakt zo save (tvar a typy overil `parseContractsState`). Priebeh musí zodpovedať stavu
   * (`CONTRACT_STATE_TRAITS`: plán, loď, začiatok státia, uzavretie) a počítadlá platiť
   * `0 ≤ unitsExported ≤ unitsUnloaded ≤ volumeUnits` (v `exporting` vyložené všetko, v `completed` aj exportované);
   * inak `ContractError('invalid_input')`.
   */
  static fromState(state: SerializedContract): Contract {
    const contract = new Contract({ ...state, id: state.id as ContractId });
    const label = `kontrakt #${String(state.id)}`;
    if (!isContractState(state.state)) throw new ContractError('invalid_input', `${label}: neznámy stav '${String(state.state)}'`);
    const traits = CONTRACT_STATE_TRAITS[state.state];
    const plan = [state.acceptedTick, state.shipArrivalTick, state.slaDeadlineTick].map(orUndefined);
    for (const [index, name] of ['acceptedTick', 'shipArrivalTick', 'slaDeadlineTick'].entries()) checkPresence(label, name, plan[index], traits.plan);
    checkPresence(label, 'shipId', orUndefined(state.shipId), traits.ship);
    checkPresence(label, 'dockedTick', orUndefined(state.dockedTick), traits.docked);
    checkPresence(label, 'closedTick', orUndefined(state.closedTick), traits.terminal ? 'required' : 'absent');
    const [acceptedTick, arrival, deadline] = plan;
    if (acceptedTick !== undefined && arrival !== undefined && deadline !== undefined && !(acceptedTick < arrival && arrival < deadline)) {
      throw new ContractError('invalid_input', `${label}: musí platiť acceptedTick < shipArrivalTick < slaDeadlineTick`);
    }
    if (state.shipId !== null && !isPositive(state.shipId)) throw new ContractError('invalid_input', `${label}: shipId musí byť celé číslo ≥ 1`);
    const counters = [state.unitsUnloaded, state.unitsExported, state.penaltiesCents, state.demurrageHours, state.lateDays];
    if (!counters.every(isCount)) throw new ContractError('invalid_input', `${label}: počítadlá musia byť celé čísla ≥ 0`);
    if (!(state.unitsExported <= state.unitsUnloaded && state.unitsUnloaded <= state.volumeUnits)) {
      throw new ContractError('invalid_input', `${label}: musí platiť unitsExported ≤ unitsUnloaded ≤ volumeUnits`);
    }
    if (state.state === 'exporting' && state.unitsUnloaded !== state.volumeUnits) throw new ContractError('invalid_input', `${label}: exporting bez vyloženého celého objemu`);
    if (state.state === 'completed' && state.unitsExported !== state.volumeUnits) throw new ContractError('invalid_input', `${label}: completed bez exportovaného celého objemu`);
    contract.acceptedTick = acceptedTick;
    contract.shipArrivalTick = arrival;
    contract.slaDeadlineTick = deadline;
    contract.shipId = orUndefined(state.shipId) as EntityId | undefined;
    contract.dockedTick = orUndefined(state.dockedTick);
    contract.closedTick = orUndefined(state.closedTick);
    contract.unitsUnloaded = state.unitsUnloaded;
    contract.unitsExported = state.unitsExported;
    contract.penaltiesCents = state.penaltiesCents;
    contract.demurrageHours = state.demurrageHours;
    contract.lateDays = state.lateDays;
    contract.current = state.state;
    return contract;
  }

  /** Aktuálny stav FSM (mení ho len `transition`). */
  get state(): ContractState {
    return this.current;
  }

  get label(): string {
    return `kontrakt #${String(this.id)} (${this.templateId})`;
  }

  /**
   * Prechod podľa `CONTRACT_TRANSITIONS`; do konečného stavu zapíše `closedTick = tick`. Nepovolený prechod →
   * `ContractError('invalid_transition')` bez zmeny. Udalosť `ContractStateChanged` emituje `ContractBook.changeState`.
   */
  transition(to: ContractState, tick: number): void {
    const allowed = CONTRACT_TRANSITIONS[this.current];
    if (!allowed.includes(to)) {
      throw new ContractError('invalid_transition', `${this.label}: prechod ${this.current} → ${to} nie je povolený (povolené: ${allowed.join(', ') || '–'})`);
    }
    this.current = to;
    if (CONTRACT_STATE_TRAITS[to].terminal) this.closedTick = tick;
  }

  /** Čistý JSON stav pre save (nová kópia pri každom volaní). */
  toState(): SerializedContract {
    return {
      id: this.id,
      templateId: this.templateId,
      cargoTypeId: this.cargoTypeId,
      volumeUnits: this.volumeUnits,
      slaDays: this.slaDays,
      rewardCents: this.rewardCents,
      xpReward: this.xpReward,
      offeredTick: this.offeredTick,
      offerExpiresTick: this.offerExpiresTick,
      shipClassId: this.shipClassId,
      state: this.current,
      acceptedTick: orNull(this.acceptedTick),
      shipArrivalTick: orNull(this.shipArrivalTick),
      slaDeadlineTick: orNull(this.slaDeadlineTick),
      shipId: orNull(this.shipId),
      dockedTick: orNull(this.dockedTick),
      closedTick: orNull(this.closedTick),
      unitsUnloaded: this.unitsUnloaded,
      unitsExported: this.unitsExported,
      penaltiesCents: this.penaltiesCents,
      demurrageHours: this.demurrageHours,
      lateDays: this.lateDays,
    };
  }
}
