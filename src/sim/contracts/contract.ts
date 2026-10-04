/**
 * Kontrakty (ARCHITECTURE §9.1; docs/tasks/phase-05.md a phase-06a.md „Spoločné rozhrania"; ADR-026, ADR-032) — rodina
 * tried podľa pravidla 7: abstraktný `Contract` (spoločné podmienky, plán, loď, penalizácie, FSM) a jeho druhy
 * `ImportContract` (F5: náklad príde loďou a odíde po súši) a `ExportContract` (F6a booking: náklad príde po súši
 * a odpláva loďou voyage). Čo sa medzi druhmi líši (tabuľka prechodov, outbound politika dispatchera, počítadlá
 * z háčika ledgera, kontrola počítadiel, booking časť save), je polymorfné — žiadny switch podľa `kind`; obnovu zo save
 * vyberá tabuľka `CONTRACT_RESTORERS`.
 *
 * Podmienky ponuky (`ContractTerms`) sa určia pri vzniku v poole a už sa nemenia: šablóna, náklad, objem (pri exporte
 * bookované TEU), SLA v celých dňoch, odmena a XP, trieda lode, expirácia ponuky a **voyage** (`voyageId`, ADR-032 —
 * kontrakty jednej návštevy lode zdieľajú id; roundtrip = import + export booking s rovnakou voyage). Priebeh (plán
 * prijatia, loď, počítadlá jednotiek a penalizácií) menia len `ContractBook` (háčik ledgera nákladu), príkazy
 * `AcceptContract` / `DeclineContract` a `ContractSystem` (krok 2), pri exporte aj krok 8 (brána). Stav je privátny
 * s getterom — mení ho výlučne `transition` podľa tabuľky druhu (`CONTRACT_TRANSITIONS_BY_KIND`).
 *
 * Voliteľné polia (`acceptedTick?`, `shipId?`, `cutoffTick?`, …) sú `undefined`, kým ich stav nevyžaduje
 * (`CONTRACT_STATE_TRAITS`); v save sú `null`. Konštruktory držia poradie polí pevné, aby dva rovnaké kontrakty
 * (originál a obnova zo save) mali rovnaký tvar aj pri `JSON.stringify`.
 */
import type { CargoLocation } from '../cargo/cargo-location';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { ContractId, EntityId, VoyageId } from '../core/entity-id';
import type { Rng } from '../core/rng';
import { ContractError } from './contract-error';
import {
  CONTRACT_STATE_TRAITS,
  CONTRACT_TRANSITIONS_BY_KIND,
  isContractKind,
  isContractState,
  type ContractKind,
  type ContractOutbound,
  type ContractState,
  type ContractTransitions,
  type FieldPresence,
} from './contract-fsm';

/** Nemenné podmienky ponuky (spoločné pre všetky druhy). */
export interface ContractTerms {
  /** Id z vlastnej postupnosti knihy kontraktov (`ContractId`, nie `world.ids`). */
  readonly id: ContractId;
  /** Návšteva lode (voyage), ku ktorej kontrakt patrí — vlastná postupnosť knihy (`VoyageId`, ADR-032). */
  readonly voyageId: VoyageId;
  /** Šablóna z `contract_templates.json`. */
  readonly templateId: string;
  /** Typ nákladu z `cargo_types.json`. */
  readonly cargoTypeId: string;
  /** Počet jednotiek nákladu (celé ≥ 1, ≤ kapacita lode); pri exporte bookované TEU (`bookedUnits`). */
  readonly volumeUnits: number;
  /** SLA v celých dňoch od príchodu lode (zo `slaDaysRange` šablóny). */
  readonly slaDays: number;
  /**
   * Odmena v centoch (celé ≥ 1): import `⌊volume × basePricePerUnitCents × urgencyBp / 10 000⌋`; export plná odmena za
   * celý booking `⌊booked × exportPricePerUnitCents × urgencyBp / 10 000⌋` (výplata pomerne k naloženým, ADR-032 bod 13).
   */
  readonly rewardCents: number;
  /** XP za včasné dokončenie: `volume × xpPerUnit × xpMultiplier`. */
  readonly xpReward: number;
  /** Tick vzniku ponuky. */
  readonly offeredTick: number;
  /** Tick, v ktorom nevybraná ponuka expiruje (`offeredTick + offerExpiryDays × ticksPerDay`). */
  readonly offerExpiresTick: number;
  /** Trieda lode zo `ships.json` (jedna zo `shipClassIds` šablóny; rovnaká pre všetky kontrakty voyage). */
  readonly shipClassId: string;
}

/** Podmienky export bookingu: spoločné + cieľový prístav (zo `destinationPorts` šablóny). */
export interface ExportContractTerms extends ContractTerms {
  readonly destinationPort: string;
}

/**
 * Booking časť export kontraktu v save (`SerializedContract.booking`, WorldState v7, ADR-032); import má `null`.
 * `cutoffTick` a `arrivalPlan` vzniknú pri prijatí (v `offered` `null` a `[]`).
 */
export interface SerializedBooking {
  readonly destinationPort: string;
  /** Cut-off: `shipArrivalTick − round(cutoffHours × ticksPerHour)`; v `offered` `null`. */
  readonly cutoffTick: number | null;
  /** Zostávajúce plánované ticky spawnu kamiónov s exportom (vzostupne; spotrebúva krok 8 spredu). */
  readonly arrivalPlan: readonly number[];
  /** Jednotky, ktoré prešli bránou dnu (`ExportArrived`), kumulatívne. */
  readonly arrivedUnits: number;
  /** Jednotky naložené na loď (`in_crane → on_ship`), kumulatívne. */
  readonly loadedUnits: number;
  /** Z naložených tie, ktoré prišli po cut-off („last minute", rolled a naložené). */
  readonly lastMinuteUnits: number;
  /** Jednotky, ktoré prešli bránou po cut-off (rolled), vzostupne podľa id. */
  readonly rolledUnitIds: readonly number[];
  /** Jednotky bookingu práve v VGM hold (= jednotky s `hold !== null`; kontroluje obnova). */
  readonly heldUnits: number;
}

/** Kľúče `SerializedBooking` v poradí `toState()`. */
export const SERIALIZED_BOOKING_KEYS: readonly (keyof SerializedBooking)[] = [
  'destinationPort',
  'cutoffTick',
  'arrivalPlan',
  'arrivedUnits',
  'loadedUnits',
  'lastMinuteUnits',
  'rolledUnitIds',
  'heldUnits',
];

/** Kontrakt v save (`WorldState.contracts`, v7): druh, voyage, podmienky + priebeh (`null` = nenastavené) a booking. */
export interface SerializedContract extends Omit<ContractTerms, 'id' | 'voyageId'> {
  readonly id: number;
  readonly kind: ContractKind;
  readonly voyageId: number;
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
  /** Booking časť exportu; import `null`. */
  readonly booking: SerializedBooking | null;
}

/** Kľúče serializovaného kontraktu v poradí `toState()` (v7: `kind`, `voyageId` za `id`, `booking` na konci). */
export const SERIALIZED_CONTRACT_KEYS: readonly (keyof SerializedContract)[] = [
  'id',
  'kind',
  'voyageId',
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
  'booking',
];

/**
 * Vstup plánovania pri prijatí ponuky (`AcceptContract`, ADR-026, ADR-032): plán lode spoločný pre voyage a plán príchodov
 * exportu. `rng` je jediný `Rng` sveta (pravidlo 3), hodnoty z defov (`cutoffHours`, `arrivalWindowDays`) a hodín
 * dodáva volajúci, takže kontrakt nepozná svet.
 */
export interface AcceptContext {
  /** Tick prijatia (`clock.tick` v príkazovej fáze). */
  readonly tick: number;
  /** Príchod lode voyage (rovnaký pre všetky kontrakty skupiny). */
  readonly shipArrivalTick: number;
  readonly ticksPerDay: number;
  readonly ticksPerHour: number;
  /** `economy.cutoffHours`. */
  readonly cutoffHours: number;
  /** `logistics.exportFlow.arrivalWindowDays`. */
  readonly arrivalWindowDays: number;
  readonly rng: Pick<Rng, 'int'>;
}

/**
 * Pohľad na booking export kontraktu pre UI a systémy (`Contract.booking`; import `null`). Polia sú živé hodnoty
 * kontraktu, nie kópia.
 */
export interface ExportBooking {
  readonly destinationPort: string;
  /** Cut-off (po prijatí), inak `undefined`. */
  readonly cutoffTick: number | undefined;
  /** Bookované TEU (= `volumeUnits`). */
  readonly bookedUnits: number;
  /** Zostávajúce plánované príchody kamiónov (ticky vzostupne). */
  readonly arrivalPlan: readonly number[];
  readonly arrivedUnits: number;
  readonly loadedUnits: number;
  readonly lastMinuteUnits: number;
  /** Počet rolled jednotiek (`rolledUnitIds.length`). */
  readonly rolledUnits: number;
  readonly rolledUnitIds: readonly EntityId[];
  /** Jednotky vrátené odosielateľovi (opustili mapu po súši, `→ exported`) = `unitsExported` kontraktu. */
  readonly returnedUnits: number;
  readonly heldUnits: number;
}

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

/**
 * Spoločný základ kontraktov. Konštruktor (chyby `ContractError('invalid_input')`): id nie je celé ≥ 1, voyage nie je
 * celé ≥ 1, objem alebo odmena nie je celé ≥ 1, SLA nie je celé ≥ 1, XP nie je konečné ≥ 0, ticky nie sú celé ≥ 0
 * alebo expirácia nie je po vzniku.
 */
export abstract class Contract {
  readonly id: ContractId;
  readonly voyageId: VoyageId;
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
  /** Tick príchodu (spawnu) lode voyage. */
  shipArrivalTick: number | undefined;
  /** Termín: `shipArrivalTick + slaDays × ticksPerDay` (import: export po súši; export: odchod lode s nákladom). */
  slaDeadlineTick: number | undefined;
  /** Loď voyage (od `ship_en_route`; po odchode lode z mapy ostáva ako história). */
  shipId: EntityId | undefined;
  /** Začiatok státia lode pri kotvisku — od neho beží `berthAllowanceTicks`. */
  dockedTick: number | undefined;
  /** Tick uzavretia (`completed`, `failed`, `expired`). */
  closedTick: number | undefined;
  /** Import: jednotky kontraktu, ktoré opustili loď (`on_ship → …`); export: vždy 0. */
  unitsUnloaded = 0;
  /** Jednotky kontraktu, ktoré opustili mapu po súši (`→ exported`); pri exporte vrátené odosielateľovi. */
  unitsExported = 0;
  /** Priebežne nasčítané penalizácie v centoch; z hotovosti sa strhnú pri `completed`/`failed`. */
  penaltiesCents = 0;
  /** Počet celých hodín demurrage, ktoré už boli pripísané. */
  demurrageHours = 0;
  /** Počet celých dní po SLA, za ktoré už bola pripísaná late penalizácia. */
  lateDays = 0;
  private current: ContractState;

  protected constructor(terms: ContractTerms) {
    const label = `kontrakt #${String(terms.id)}`;
    if (!isPositive(terms.id)) throw new ContractError('invalid_input', `${label}: id musí byť celé číslo ≥ 1`);
    if (!isPositive(terms.voyageId)) throw new ContractError('invalid_input', `${label}: voyageId musí byť celé číslo ≥ 1, dostal ${String(terms.voyageId)}`);
    if (!isPositive(terms.volumeUnits)) throw new ContractError('invalid_input', `${label}: volumeUnits musí byť celé číslo ≥ 1, dostal ${String(terms.volumeUnits)}`);
    if (!isPositive(terms.slaDays)) throw new ContractError('invalid_input', `${label}: slaDays musí byť celé číslo ≥ 1, dostal ${String(terms.slaDays)}`);
    if (!isPositive(terms.rewardCents)) throw new ContractError('invalid_input', `${label}: rewardCents musí byť celé číslo ≥ 1, dostal ${String(terms.rewardCents)}`);
    if (!Number.isFinite(terms.xpReward) || terms.xpReward < 0) throw new ContractError('invalid_input', `${label}: xpReward musí byť konečné číslo ≥ 0`);
    if (!isCount(terms.offeredTick) || !isCount(terms.offerExpiresTick) || terms.offerExpiresTick <= terms.offeredTick) {
      throw new ContractError('invalid_input', `${label}: offeredTick a offerExpiresTick musia byť celé ≥ 0 a expirácia po vzniku`);
    }
    this.id = terms.id;
    this.voyageId = terms.voyageId;
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
   * Kontrakt zo save (tvar a typy overil `parseContractsState`): trieda podľa `kind` (`CONTRACT_RESTORERS`). Priebeh musí
   * zodpovedať stavu (`CONTRACT_STATE_TRAITS`: plán, loď, začiatok státia, uzavretie), `acceptedTick < shipArrivalTick
   * < slaDeadlineTick` a počítadlá druhu (`countersProblem`); booking len pri exporte. Inak `ContractError('invalid_input')`.
   */
  static fromState(state: SerializedContract): Contract {
    if (!isContractKind(state.kind)) throw new ContractError('invalid_input', `kontrakt #${String(state.id)}: neznámy druh '${String(state.kind)}'`);
    return CONTRACT_RESTORERS[state.kind](state);
  }

  /** Druh kontraktu (podľa triedy). */
  abstract get kind(): ContractKind;

  /** Povolené prechody druhu kontraktu (`CONTRACT_TRANSITIONS_BY_KIND`). */
  get transitions(): ContractTransitions {
    return CONTRACT_TRANSITIONS_BY_KIND[this.kind];
  }

  /** Smú uskladnené jednotky kontraktu na rampu a s akou prioritou (dispatcher krok 5, ADR-027); import podľa stavu. */
  get outbound(): ContractOutbound {
    return CONTRACT_STATE_TRAITS[this.current].outbound;
  }

  /**
   * Kontrakt práve vlastní náklad na palube svojej lode (krok 12, obnova: jednotky `on_ship` lode patria jemu): import
   * v `ship_en_route` a `unloading`; export nikdy (naložený export je jeho, ale loď nesie aj import voyage).
   */
  get carriesShipCargo(): boolean {
    return false;
  }

  /** Pripisuje sa demurrage, kým loď kontraktu stojí pri kotvisku (import `unloading`; export `exporting`, ADR-032). */
  get accruesDemurrage(): boolean {
    return CONTRACT_STATE_TRAITS[this.current].demurrage;
  }

  /** Booking export kontraktu (živý pohľad), import `null`. */
  get booking(): ExportBooking | null {
    return null;
  }

  /** Aktuálny stav FSM (mení ho len `transition`). */
  get state(): ContractState {
    return this.current;
  }

  /** Jednotky, s ktorými sa pri spawne lode voyage vytvorí loď tohto kontraktu: import `volumeUnits`, export 0 (náklad príde po súši). */
  get spawnUnits(): number {
    return this.volumeUnits;
  }

  /**
   * Plán po prijatí ponuky (`AcceptContract`): `acceptedTick`, `shipArrivalTick` a `slaDeadlineTick = shipArrivalTick +
   * slaDays × ticksPerDay`, potom plán špecifický pre druh (`planBooking`: export cut-off a plán príchodov z `rng`).
   * Stav `offered → accepted` mení volajúci cez `ContractBook.changeState`. Kontrakt mimo `offered` →
   * `ContractError('invalid_transition')` bez zmeny.
   */
  accept(context: AcceptContext): void {
    if (this.current !== 'offered') {
      throw new ContractError('invalid_transition', `${this.label}: prijať sa dá len ponuka (stav ${this.current})`);
    }
    this.acceptedTick = context.tick;
    this.shipArrivalTick = context.shipArrivalTick;
    this.slaDeadlineTick = context.shipArrivalTick + this.slaDays * context.ticksPerDay;
    this.planBooking(context);
  }

  /** Najbližší plánovaný príchod kamióna s exportom (tick), alebo `undefined` (import, vyčerpaný plán). */
  get nextArrivalTick(): number | undefined {
    return undefined;
  }

  /** Kamión podľa plánu vznikol: odstráni najbližší plánovaný príchod (export); import nič. */
  consumeArrival(): void {
    // Import nemá plán príchodov.
  }

  /**
   * Brána prijala jednotku kontraktu (krok 8): export `arrivedUnits += 1` a pri `rolled` (po cut-off) zaradí jednotku do
   * `rolledUnitIds`; import nič.
   */
  recordArrival(unitId: EntityId, rolled: boolean): void {
    void unitId;
    void rolled;
  }

  /** Zmena počtu zadržaných (VGM hold) jednotiek kontraktu: `+1` hold začal, `−1` sa uvoľnil; import nič. */
  recordHold(delta: 1 | -1): void {
    void delta;
  }

  /** Plán špecifický pre druh po prijatí; import nemá nič naplánovať. */
  protected planBooking(context: AcceptContext): void {
    void context;
  }

  get label(): string {
    return `kontrakt #${String(this.id)} (${this.templateId})`;
  }

  /**
   * Háčik `CargoLedger.move` cez `ContractBook.cargoMoved` (po presune, `unit` = jednotka pred presunom, patrí tomuto
   * kontraktu): O(1) počítadlá druhu. Nesmie vyhodiť (presun je atomický a už hotový).
   */
  abstract cargoMoved(unit: CargoUnit, to: CargoLocation): void;

  /** Porušenie pravidiel počítadiel druhu (krok 12, obnova), alebo `undefined`. */
  abstract countersProblem(): string | undefined;

  /**
   * Prechod podľa tabuľky druhu; do konečného stavu zapíše `closedTick = tick`. Nepovolený prechod →
   * `ContractError('invalid_transition')` bez zmeny. Udalosť `ContractStateChanged` emituje `ContractBook.changeState`.
   */
  transition(to: ContractState, tick: number): void {
    const allowed = this.transitions[this.current];
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
      kind: this.kind,
      voyageId: this.voyageId,
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
      booking: this.bookingState(),
    };
  }

  /** Booking časť save (export), inak `null`. */
  protected bookingState(): SerializedBooking | null {
    return null;
  }

  /**
   * Obnoví spoločný priebeh zo save (volá `restore` triedy hneď po konštruktore): stav, plán, loď, státie, uzavretie
   * a počítadlá s kontrolami presence podľa `CONTRACT_STATE_TRAITS`. Chyby `ContractError('invalid_input')`.
   */
  protected restoreProgress(state: SerializedContract): void {
    const label = `kontrakt #${String(state.id)}`;
    if (!isContractState(state.state)) throw new ContractError('invalid_input', `${label}: neznámy stav '${String(state.state)}'`);
    if (state.state !== 'offered' && !this.transitionsReach(state.state)) {
      throw new ContractError('invalid_input', `${label}: stav '${state.state}' druh '${this.kind}' nepozná`);
    }
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
    this.acceptedTick = acceptedTick;
    this.shipArrivalTick = arrival;
    this.slaDeadlineTick = deadline;
    this.shipId = orUndefined(state.shipId) as EntityId | undefined;
    this.dockedTick = orUndefined(state.dockedTick);
    this.closedTick = orUndefined(state.closedTick);
    this.unitsUnloaded = state.unitsUnloaded;
    this.unitsExported = state.unitsExported;
    this.penaltiesCents = state.penaltiesCents;
    this.demurrageHours = state.demurrageHours;
    this.lateDays = state.lateDays;
    this.current = state.state;
  }

  /** Overí počítadlá druhu po obnove (`countersProblem`). */
  protected assertCounters(): void {
    const problem = this.countersProblem();
    if (problem !== undefined) throw new ContractError('invalid_input', `${this.label}: ${problem}`);
  }

  /** Je stav `target` dosiahnuteľný z `offered` podľa tabuľky druhu (save s cudzím stavom druhu sa odmietne)? */
  private transitionsReach(target: ContractState): boolean {
    const seen = new Set<ContractState>(['offered']);
    const queue: ContractState[] = ['offered'];
    while (queue.length > 0) {
      const from = queue.shift() as ContractState;
      for (const to of this.transitions[from]) {
        if (to === target) return true;
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    return false;
  }
}

/** Import kontrakt (F5, ADR-026): náklad príde loďou voyage, vyloží sa a odíde po súši. */
export class ImportContract extends Contract {
  constructor(terms: ContractTerms) {
    super(terms);
  }

  /** Import kontrakt zo save (`Contract.fromState` cez `CONTRACT_RESTORERS`); `booking` musí byť `null`. */
  static restore(state: SerializedContract): ImportContract {
    const contract = new ImportContract({ ...state, id: state.id as ContractId, voyageId: state.voyageId as VoyageId });
    if (state.booking !== null) throw new ContractError('invalid_input', `${contract.label}: import kontrakt nemá booking`);
    contract.restoreProgress(state);
    contract.assertCounters();
    return contract;
  }

  get kind(): ContractKind {
    return 'import';
  }

  override get carriesShipCargo(): boolean {
    return this.state === 'ship_en_route' || this.state === 'unloading';
  }

  /** Jednotka, ktorá opustila loď, zvýši `unitsUnloaded`; jednotka, ktorá opustila mapu po súši, `unitsExported` (ADR-026). */
  cargoMoved(unit: CargoUnit, to: CargoLocation): void {
    if (unit.location.kind === 'on_ship' && this.unitsUnloaded < this.volumeUnits) this.unitsUnloaded += 1;
    if (to.kind === 'exported' && this.unitsExported < this.unitsUnloaded) this.unitsExported += 1;
  }

  /** `unitsExported ≤ unitsUnloaded ≤ volumeUnits`; `exporting` má vyložený celý objem, `completed` aj exportovaný. */
  countersProblem(): string | undefined {
    if (!(this.unitsExported <= this.unitsUnloaded && this.unitsUnloaded <= this.volumeUnits)) {
      return `počítadlá exported ${String(this.unitsExported)} ≤ unloaded ${String(this.unitsUnloaded)} ≤ volume ${String(this.volumeUnits)} neplatia`;
    }
    if (this.state === 'exporting' && this.unitsUnloaded !== this.volumeUnits) return 'exporting bez vyloženého celého objemu';
    if (this.state === 'completed' && this.unitsExported !== this.volumeUnits) return 'completed bez exportovaného celého objemu';
    return undefined;
  }
}

/** Je zoznam celých čísel ≥ `min` ostro rastúci (`strict`) alebo neklesajúci? */
function isAscending(values: readonly number[], min: number, strict: boolean): boolean {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isSafeInteger(value) || value < min) return false;
    if (i > 0 && (strict ? value <= values[i - 1] : value < values[i - 1])) return false;
  }
  return true;
}

/**
 * Export booking (F6a, ADR-032): `volumeUnits` TEU na voyage s cieľovým prístavom a cut-off. Kamióny s exportom
 * prichádzajú podľa `arrivalPlan` (vzniká pri prijatí z jediného `Rng`), brána ich prijme (`recordArrival`; po cut-off
 * rolled), jednotky sa uskladnia, naložia na loď voyage (`loadedUnits`) a odplávajú (`shipped`); nenaložené sa vrátia
 * odosielateľovi po súši (`unitsExported`). Výplata pri uzavretí pomerne k naloženým (ADR-032 bod 13).
 */
export class ExportContract extends Contract implements ExportBooking {
  readonly destinationPort: string;
  /** Cut-off (od prijatia), inak `undefined`. */
  cutoffTick: number | undefined;
  /** Zostávajúce plánované ticky spawnu kamiónov s exportom, vzostupne (krok 8 ich spotrebúva spredu). */
  arrivalPlan: number[];
  arrivedUnits = 0;
  loadedUnits = 0;
  lastMinuteUnits = 0;
  /** Rolled jednotky (brána po cut-off) vzostupne podľa id. */
  rolledUnitIds: EntityId[];
  /** Jednotky bookingu práve v VGM hold. */
  heldUnits = 0;

  /** Chyby ako `Contract` a navyše prázdny `destinationPort` (`ContractError('invalid_input')`). */
  constructor(terms: ExportContractTerms) {
    super(terms);
    if (typeof terms.destinationPort !== 'string' || terms.destinationPort.length === 0) {
      throw new ContractError('invalid_input', `${this.label}: destinationPort musí byť neprázdny reťazec`);
    }
    this.destinationPort = terms.destinationPort;
    this.cutoffTick = undefined;
    this.arrivalPlan = [];
    this.rolledUnitIds = [];
  }

  /**
   * Export kontrakt zo save: booking povinný, `cutoffTick` práve od prijatia (plán prítomný) a pred príchodom lode,
   * plán príchodov neklesajúci (ticky ≥ 0), rolled id ostro rastúce, počítadlá (`countersProblem`). Chyby `ContractError`.
   */
  static restore(state: SerializedContract): ExportContract {
    const { booking } = state;
    if (booking === null) throw new ContractError('invalid_input', `kontrakt #${String(state.id)}: export kontrakt musí mať booking`);
    const contract = new ExportContract({ ...state, id: state.id as ContractId, voyageId: state.voyageId as VoyageId, destinationPort: booking.destinationPort });
    contract.restoreProgress(state);
    const label = contract.label;
    const planned = CONTRACT_STATE_TRAITS[state.state].plan;
    checkPresence(label, 'booking.cutoffTick', orUndefined(booking.cutoffTick), planned === 'absent' ? 'absent' : 'required');
    if (booking.cutoffTick !== null && state.shipArrivalTick !== null && booking.cutoffTick >= state.shipArrivalTick) {
      throw new ContractError('invalid_input', `${label}: cut-off ${String(booking.cutoffTick)} musí byť pred príchodom lode ${String(state.shipArrivalTick)}`);
    }
    if (planned === 'absent' && booking.arrivalPlan.length > 0) throw new ContractError('invalid_input', `${label}: ponuka nemá plán príchodov`);
    if (!isAscending(booking.arrivalPlan, 0, false)) throw new ContractError('invalid_input', `${label}: plán príchodov musí byť neklesajúci zoznam celých tickov ≥ 0`);
    if (!isAscending(booking.rolledUnitIds, 1, true)) throw new ContractError('invalid_input', `${label}: rolledUnitIds musí byť ostro rastúci zoznam id ≥ 1`);
    const counters = [booking.arrivedUnits, booking.loadedUnits, booking.lastMinuteUnits, booking.heldUnits];
    if (!counters.every(isCount)) throw new ContractError('invalid_input', `${label}: počítadlá bookingu musia byť celé čísla ≥ 0`);
    contract.cutoffTick = orUndefined(booking.cutoffTick);
    contract.arrivalPlan = [...booking.arrivalPlan];
    contract.arrivedUnits = booking.arrivedUnits;
    contract.loadedUnits = booking.loadedUnits;
    contract.lastMinuteUnits = booking.lastMinuteUnits;
    contract.rolledUnitIds = booking.rolledUnitIds.map((id) => id as EntityId);
    contract.heldUnits = booking.heldUnits;
    contract.assertCounters();
    return contract;
  }

  get kind(): ContractKind {
    return 'export';
  }

  /** Export: nenaložené jednotky smú na rampu (vrátenie odosielateľovi) až po uzavretí bookingu; dovtedy čakajú na loď. */
  override get outbound(): ContractOutbound {
    return CONTRACT_STATE_TRAITS[this.state].terminal ? 'free' : 'held';
  }

  /** Demurrage exportu beží v `exporting` (loď pri kotvisku nakladá a lashuje), ADR-032 bod 13. */
  override get accruesDemurrage(): boolean {
    return this.state === 'exporting';
  }

  override get booking(): ExportBooking {
    return this;
  }

  override get nextArrivalTick(): number | undefined {
    return this.arrivalPlan[0];
  }

  override consumeArrival(): void {
    this.arrivalPlan.shift();
  }

  /** `heldUnits` sleduje jednotky v hold: hold sa začal (`+1`) alebo uvoľnil (`−1`, nie pod 0). */
  override recordHold(delta: 1 | -1): void {
    this.heldUnits = Math.max(0, this.heldUnits + delta);
  }

  /** Export nevytvára jednotky na lodi — kamióny ich privezú po súši (`spawnShip` s 0 jednotkami alebo loď roundtripu). */
  override get spawnUnits(): number {
    return 0;
  }

  /**
   * Cut-off a plán príchodov (ADR-032 bod 6): `cutoffTick = shipArrivalTick − round(cutoffHours × ticksPerHour)`; pre
   * každú bookovanú jednotku jeden ťah `rng.int(windowStart, cutoffTick)`, `windowStart = max(acceptedTick + 1,
   * shipArrivalTick − round(arrivalWindowDays × ticksPerDay))`; plán sa zoradí neklesajúco. `DefRegistry` zaručuje
   * `windowStart ≤ cutoffTick` (min × 24 > cutoffHours a okno > cutoffHours).
   */
  protected override planBooking(context: AcceptContext): void {
    const cutoff = context.shipArrivalTick - Math.round(context.cutoffHours * context.ticksPerHour);
    const windowStart = Math.max(context.tick + 1, context.shipArrivalTick - Math.round(context.arrivalWindowDays * context.ticksPerDay));
    const plan: number[] = [];
    for (let i = 0; i < this.volumeUnits; i++) plan.push(context.rng.int(windowStart, cutoff));
    plan.sort((a, b) => a - b);
    this.cutoffTick = cutoff;
    this.arrivalPlan = plan;
  }

  get bookedUnits(): number {
    return this.volumeUnits;
  }

  get rolledUnits(): number {
    return this.rolledUnitIds.length;
  }

  get returnedUnits(): number {
    return this.unitsExported;
  }

  /**
   * Brána prijala jednotku bookingu (krok 8): `arrivedUnits += 1`; po cut-off (`rolled`) aj zaradenie do `rolledUnitIds`
   * (vzostupne). Udalosti (`ExportArrived`, `UnitRolled`) emituje volajúci.
   */
  override recordArrival(unitId: EntityId, rolled: boolean): void {
    this.arrivedUnits += 1;
    if (!rolled) return;
    let at = this.rolledUnitIds.length;
    while (at > 0 && this.rolledUnitIds[at - 1] > unitId) at -= 1;
    this.rolledUnitIds.splice(at, 0, unitId);
  }

  /**
   * Jednotka naložená na loď (`in_crane → on_ship`) zvýši `loadedUnits` (rolled aj `lastMinuteUnits`); jednotka, ktorá
   * opustila mapu po súši (vrátená odosielateľovi), `unitsExported`. Počítadlá nepresiahnu prijaté jednotky.
   */
  cargoMoved(unit: CargoUnit, to: CargoLocation): void {
    const settled = this.loadedUnits + this.unitsExported;
    if (to.kind === 'on_ship' && settled < this.arrivedUnits) {
      this.loadedUnits += 1;
      if (this.rolledUnitIds.includes(unit.id)) this.lastMinuteUnits += 1;
    }
    if (to.kind === 'exported' && settled < this.arrivedUnits) this.unitsExported += 1;
    // Zadržaná jednotka, ktorá opustila mapu (vrátenie odosielateľovi po uzavretí bookingu), už nie je v hold.
    if (unit.hold !== null && (to.kind === 'exported' || to.kind === 'shipped')) this.heldUnits = Math.max(0, this.heldUnits - 1);
  }

  /**
   * Import počítadlo `unitsUnloaded` je 0; `arrivedUnits + plán ≤ booked`; `loaded + vrátené ≤ arrived`;
   * `lastMinute ≤ min(loaded, rolled)`; `rolled ≤ arrived`; `held ≤ arrived − loaded − vrátené`; `completed` má aspoň
   * jednu naloženú jednotku.
   */
  countersProblem(): string | undefined {
    const { arrivedUnits, loadedUnits, lastMinuteUnits, heldUnits, unitsExported, volumeUnits } = this;
    if (this.unitsUnloaded !== 0) return `export booking má unitsUnloaded ${String(this.unitsUnloaded)} (musí byť 0)`;
    if (arrivedUnits + this.arrivalPlan.length > volumeUnits) {
      return `prijaté ${String(arrivedUnits)} + plánované ${String(this.arrivalPlan.length)} > bookované ${String(volumeUnits)}`;
    }
    if (loadedUnits + unitsExported > arrivedUnits) return `naložené ${String(loadedUnits)} + vrátené ${String(unitsExported)} > prijaté ${String(arrivedUnits)}`;
    if (lastMinuteUnits > loadedUnits || lastMinuteUnits > this.rolledUnits) return `last minute ${String(lastMinuteUnits)} > naložené alebo rolled`;
    if (this.rolledUnits > arrivedUnits) return `rolled ${String(this.rolledUnits)} > prijaté ${String(arrivedUnits)}`;
    if (heldUnits > arrivedUnits - loadedUnits - unitsExported) return `v hold ${String(heldUnits)} > jednotky na termináli`;
    if (this.state === 'completed' && loadedUnits === 0) return 'completed bez naloženej jednotky';
    return undefined;
  }

  protected override bookingState(): SerializedBooking {
    return {
      destinationPort: this.destinationPort,
      cutoffTick: orNull(this.cutoffTick),
      arrivalPlan: [...this.arrivalPlan],
      arrivedUnits: this.arrivedUnits,
      loadedUnits: this.loadedUnits,
      lastMinuteUnits: this.lastMinuteUnits,
      rolledUnitIds: [...this.rolledUnitIds],
      heldUnits: this.heldUnits,
    };
  }
}

/** Obnova kontraktu zo save podľa druhu (tabuľka, nie switch — nový druh = nový riadok a trieda). */
const CONTRACT_RESTORERS: { readonly [K in ContractKind]: (state: SerializedContract) => Contract } = Object.freeze({
  import: (state: SerializedContract) => ImportContract.restore(state),
  export: (state: SerializedContract) => ExportContract.restore(state),
});
