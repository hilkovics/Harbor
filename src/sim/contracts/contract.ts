/**
 * Kontrakty (ARCHITECTURE §9.1; docs/tasks/phase-05.md a phase-06a.md „Spoločné rozhrania"; ADR-026, ADR-032, ADR-034) — rodina
 * tried podľa pravidla 7: abstraktný `Contract` (spoločné podmienky, plán, loď, penalizácie, FSM) a jeho druhy
 * `ImportContract` (F5: náklad príde loďou a odíde po súši), `ExportContract` (F6a booking: náklad príde po súši
 * a odpláva loďou voyage) a od F6c `EmptyRepositioningContract` (booking prázdnych kontajnerov linky z depa na loď voyage)
 * a `TranshipContract` (loď A privezie jednotky, loď B ich odvezie; obe sú export booking s vlastnými doplnkami). Čo sa
 * medzi druhmi líši (tabuľka prechodov, outbound politika dispatchera, počítadlá z háčika ledgera, kontrola počítadiel,
 * booking časť save), je polymorfné — žiadny switch podľa `kind`; obnovu zo save vyberá tabuľka `CONTRACT_RESTORERS`.
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
import { DEFAULT_WEIGHT_CLASS, IMPORT_LABELS, type CargoUnit, type CargoUnitLabels } from '../cargo/cargo-unit';
import type { ContractId, EntityId, VoyageId } from '../core/entity-id';
import type { Rng } from '../core/rng';
import { ContractError } from './contract-error';
import {
  CONTRACT_KIND_TRAITS,
  CONTRACT_STATE_TRAITS,
  CONTRACT_TRANSITIONS_BY_KIND,
  isContractKind,
  isContractState,
  type ContractKind,
  type ContractOutbound,
  type ContractState,
  type ContractTransitions,
  type FieldPresence,
  type OfferGroup,
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
  /**
   * Linka z `lines.json` (ADR-034): odosielateľ voyage a vlastník kontajnerov jednotiek kontraktu (`CargoUnit.lineId`).
   * Kontrakty jednej voyage majú rovnakú linku; prázdne kontajnery sa vracajú a nalodia v rámci linky.
   */
  readonly lineId: string;
}

/** Podmienky export bookingu: spoločné + cieľový prístav (zo `destinationPorts` šablóny). */
export interface ExportContractTerms extends ContractTerms {
  readonly destinationPort: string;
}

/** Podmienky prekládky: export booking (výstupná noha — cieľový prístav lode B) + voyage lode B (pridelila ju kniha pri vzniku ponuky). */
export interface TranshipContractTerms extends ExportContractTerms {
  readonly outVoyageId: VoyageId;
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

/**
 * Plán lode B prekládky v save (`SerializedContract.tranship`, WorldState v8, ADR-034); mimo kontraktu `tranship` `null`.
 * `outArrivalTick` a `outShipId` vznikajú postupne (príchod od prijatia, loď od jej spawnu).
 */
export interface SerializedTranship {
  /** Voyage lode B (odvezie prekládku); pri záchrane zmeškanej prekládky sa preadresuje na ďalšiu voyage linky. */
  readonly outVoyageId: number;
  /** Plánovaný príchod lode B: `shipArrivalTick + max(1, round(gap × ticksPerDay))`, `gap` z `economy.transhipGapDaysRange`; v `offered` `null`. */
  readonly outArrivalTick: number | null;
  /** Loď B (od spawnu), inak `null`. */
  readonly outShipId: number | null;
  /** Tick, do ktorého zmeškaná prekládka čaká na záchranu (`economy.transhipRescueDays`); inak `null`. */
  readonly rescueDeadlineTick: number | null;
}

/** Kľúče `SerializedTranship` v poradí `toState()`. */
export const SERIALIZED_TRANSHIP_KEYS: readonly (keyof SerializedTranship)[] = ['outVoyageId', 'outArrivalTick', 'outShipId', 'rescueDeadlineTick'];

/** Kontrakt v save (`WorldState.contracts`, v8): druh, voyage, linka, podmienky + priebeh (`null` = nenastavené), booking a plán prekládky. */
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
  /** Booking časť export-podobných kontraktov (export, repositioning, tranship); import `null`. */
  readonly booking: SerializedBooking | null;
  /** Plán lode B prekládky; mimo kontraktu `tranship` `null` (v8, ADR-034). */
  readonly tranship: SerializedTranship | null;
}

/** Kľúče serializovaného kontraktu v poradí `toState()` (v7: `kind`, `voyageId` za `id`, `booking`; v8: `lineId` za `voyageId`, `tranship` na konci). */
export const SERIALIZED_CONTRACT_KEYS: readonly (keyof SerializedContract)[] = [
  'id',
  'kind',
  'voyageId',
  'lineId',
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
  'tranship',
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
  /** `economy.transhipGapDaysRange` (rozstup príchodov lodí A a B prekládky, dni; ADR-034). */
  readonly transhipGapDaysRange: readonly [number, number];
  readonly rng: Pick<Rng, 'int' | 'range'>;
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

/**
 * Pohľad na plán lode B prekládky (`Contract.tranship`; mimo kontraktu `tranship` `null`, ADR-034). Polia sú živé hodnoty
 * kontraktu, nie kópia.
 */
export interface TranshipLeg {
  /** Voyage lode B (odvezie prekládku); pri záchrane sa preadresuje na ďalšiu voyage linky. */
  readonly outVoyageId: VoyageId;
  /** Plánovaný príchod lode B (od prijatia), inak `undefined`. */
  readonly outArrivalTick: number | undefined;
  /** Loď B (od spawnu), inak `undefined`. */
  readonly outShipId: EntityId | undefined;
  /** Tick, do ktorého zmeškaná prekládka čaká na záchranu, inak `undefined`. */
  readonly rescueDeadlineTick: number | undefined;
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
 * celé ≥ 1, linka nie je neprázdny reťazec, objem alebo odmena nie je celé ≥ 1, SLA nie je celé ≥ 1, XP nie je konečné ≥ 0, ticky nie sú celé ≥ 0
 * alebo expirácia nie je po vzniku.
 */
export abstract class Contract {
  readonly id: ContractId;
  readonly voyageId: VoyageId;
  readonly lineId: string;
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
    if (typeof terms.lineId !== 'string' || terms.lineId.length === 0) throw new ContractError('invalid_input', `${label}: lineId musí byť neprázdny reťazec, dostal ${String(terms.lineId)}`);
    if (!isPositive(terms.volumeUnits)) throw new ContractError('invalid_input', `${label}: volumeUnits musí byť celé číslo ≥ 1, dostal ${String(terms.volumeUnits)}`);
    if (!isPositive(terms.slaDays)) throw new ContractError('invalid_input', `${label}: slaDays musí byť celé číslo ≥ 1, dostal ${String(terms.slaDays)}`);
    if (!isPositive(terms.rewardCents)) throw new ContractError('invalid_input', `${label}: rewardCents musí byť celé číslo ≥ 1, dostal ${String(terms.rewardCents)}`);
    if (!Number.isFinite(terms.xpReward) || terms.xpReward < 0) throw new ContractError('invalid_input', `${label}: xpReward musí byť konečné číslo ≥ 0`);
    if (!isCount(terms.offeredTick) || !isCount(terms.offerExpiresTick) || terms.offerExpiresTick <= terms.offeredTick) {
      throw new ContractError('invalid_input', `${label}: offeredTick a offerExpiresTick musia byť celé ≥ 0 a expirácia po vzniku`);
    }
    this.id = terms.id;
    this.voyageId = terms.voyageId;
    this.lineId = terms.lineId;
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

  /** Booking export-podobného kontraktu (export, repositioning, tranship; živý pohľad), import `null`. */
  get booking(): ExportBooking | null {
    return null;
  }

  /** Plán lode B prekládky (živý pohľad), mimo kontraktu `tranship` `null` (ADR-034). */
  get tranship(): TranshipLeg | null {
    return null;
  }

  /** Skupina poolu, do ktorej ponuka patrí (`CONTRACT_KIND_TRAITS`; ADR-034). */
  get offerGroup(): OfferGroup {
    return CONTRACT_KIND_TRAITS[this.kind].offerGroup;
  }

  /** Voyage, ktoré kontrakt používa: vlastná; prekládka aj voyage lode B (kniha ho indexuje pod všetkými; ADR-034). */
  get voyageIds(): readonly VoyageId[] {
    return [this.voyageId];
  }

  /** Loď voyage `voyageId` tohto kontraktu (od spawnu), alebo `undefined`; prekládka pozná aj loď B. */
  shipOnVoyage(voyageId: VoyageId): EntityId | undefined {
    return voyageId === this.voyageId ? this.shipId : undefined;
  }

  /** Plánovaný príchod lode voyage `voyageId` (od prijatia), alebo `undefined`. */
  arrivalOnVoyage(voyageId: VoyageId): number | undefined {
    return voyageId === this.voyageId ? this.shipArrivalTick : undefined;
  }

  /** Voyage lode `shipId` z pohľadu tohto kontraktu, alebo `undefined`, ak loď nie je jeho. */
  voyageOfShip(shipId: EntityId): VoyageId | undefined {
    return this.shipId === shipId ? this.voyageId : undefined;
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
   * Štítky jednotiek, ktoré loď kontraktu privezie (`spawnShip`): import — smer `import` s voyage a linkou kontraktu (hmotnostná
   * trieda `DEFAULT_WEIGHT_CLASS` bez `Rng`, ADR-032 odchýlka 1); prekládka — smer `tranship` s cieľovým prístavom (ADR-034).
   */
  get spawnLabels(): CargoUnitLabels {
    return { ...IMPORT_LABELS, voyageId: this.voyageId, lineId: this.lineId };
  }

  /**
   * Loď, na ktorú kontrakt nakladá (od jej spawnu): export a repositioning loď voyage (`shipId`), prekládka loď B (`outShipId`); import nenakladá
   * (`undefined`). Podľa nej `openLoadBookings` nájde bookingy lode a ledger priradí naložené prázdne repositioningu (ADR-034).
   */
  get loadShipId(): EntityId | undefined {
    return undefined;
  }

  /** Smie sa pre kontrakt teraz nakladať (stav kontraktu; loď musí byť navyše dokovaná)? Import nikdy. */
  get acceptsLoading(): boolean {
    return false;
  }

  /** Patrí jednotka medzi náklad, ktorý kontrakt nakladá na loď (export: jeho jednotky, prekládka: jej jednotky, repositioning: prázdne jeho linky)? */
  loadsUnit(unit: CargoUnit): boolean {
    void unit;
    return false;
  }

  /**
   * Jednotka `unit` bola pridelená nakládke (dispatcher jej otvoril job `→ in_crane`): repositioning ju započíta do `arrivedUnits`
   * (prázdne nechodia bránou, prideľuje ich depo); export a prekládka majú jednotky započítané inde (brána, vykládka lode A).
   */
  assignLoad(unit: CargoUnit): void {
    void unit;
  }

  /** Najviac toľko ďalších jednotiek smie dispatcher kontraktu prideliť nakládke (`assignLoad`); bez obmedzenia `Infinity` (export, prekládka). */
  get loadsToAssign(): number {
    return Infinity;
  }

  /**
   * Nakladá sa kontrakt až po plných jednotkách lode (stowage plán: prázdne po plných, ADR-034 bod 10)? Dispatcher mu nepridelí nakládku, kým má
   * loď prijaté a nenaložené jednotky bookingov, ktoré to nemajú (export, prekládka). Repositioning áno.
   */
  get loadsAfterFullUnits(): boolean {
    return false;
  }

  /** Jednotky, za ktoré sa pri uzavretí účtuje penalizácia „rolled“ (prijaté a nenaložené); prekládka a repositioning ich nemajú (ADR-034). */
  get rolledAtClose(): number {
    return 0;
  }

  /** Má kontrakt cut-off a plán príchodov kamiónov (export)? Podľa toho pool volí rozsah príchodu lode (`exportArrivalDaysRange`, ADR-032). */
  get hasCutoff(): boolean {
    return false;
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
      lineId: this.lineId,
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
      tranship: this.transhipState(),
    };
  }

  /** Booking časť save (export-podobné kontrakty), inak `null`. */
  protected bookingState(): SerializedBooking | null {
    return null;
  }

  /** Plán lode B prekládky v save, inak `null`. */
  protected transhipState(): SerializedTranship | null {
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
    if (state.tranship !== null) throw new ContractError('invalid_input', `${contract.label}: import kontrakt nemá plán prekládky`);
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
 * Podmienky export-podobného kontraktu zo save (`booking` povinný, cieľový prístav z neho); `what` pomenúva druh v chybe.
 * Spoločné pre `ExportContract.restore` a z neho odvodené druhy.
 */
function exportTermsOf(state: SerializedContract, what: string): ExportContractTerms {
  const { booking } = state;
  if (booking === null) throw new ContractError('invalid_input', `kontrakt #${String(state.id)}: ${what} musí mať booking`);
  return { ...state, id: state.id as ContractId, voyageId: state.voyageId as VoyageId, destinationPort: booking.destinationPort };
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
    const contract = new ExportContract(exportTermsOf(state, 'export kontrakt'));
    if (state.tranship !== null) throw new ContractError('invalid_input', `${contract.label}: export kontrakt nemá plán prekládky`);
    contract.restoreBooking(state, 'by_state');
    return contract;
  }

  /**
   * Obnoví priebeh a booking časť zo save (spoločné pre export a z neho odvodené druhy; `state.booking` je overený volajúcim)
   * a skontroluje počítadlá druhu. `cutoff`: `by_state` — `cutoffTick` práve od prijatia (export), `absent` — nikdy (repositioning
   * a tranship nemajú cut-off ani plán príchodov kamiónov).
   */
  protected restoreBooking(state: SerializedContract, cutoff: 'by_state' | 'absent'): void {
    const booking = state.booking as SerializedBooking;
    this.restoreProgress(state);
    const label = this.label;
    const planned = CONTRACT_STATE_TRAITS[state.state].plan;
    checkPresence(label, 'booking.cutoffTick', orUndefined(booking.cutoffTick), cutoff === 'absent' || planned === 'absent' ? 'absent' : 'required');
    if (booking.cutoffTick !== null && state.shipArrivalTick !== null && booking.cutoffTick >= state.shipArrivalTick) {
      throw new ContractError('invalid_input', `${label}: cut-off ${String(booking.cutoffTick)} musí byť pred príchodom lode ${String(state.shipArrivalTick)}`);
    }
    if (planned === 'absent' && booking.arrivalPlan.length > 0) throw new ContractError('invalid_input', `${label}: ponuka nemá plán príchodov`);
    if (!isAscending(booking.arrivalPlan, 0, false)) throw new ContractError('invalid_input', `${label}: plán príchodov musí byť neklesajúci zoznam celých tickov ≥ 0`);
    if (!isAscending(booking.rolledUnitIds, 1, true)) throw new ContractError('invalid_input', `${label}: rolledUnitIds musí byť ostro rastúci zoznam id ≥ 1`);
    const counters = [booking.arrivedUnits, booking.loadedUnits, booking.lastMinuteUnits, booking.heldUnits];
    if (!counters.every(isCount)) throw new ContractError('invalid_input', `${label}: počítadlá bookingu musia byť celé čísla ≥ 0`);
    this.cutoffTick = orUndefined(booking.cutoffTick);
    this.arrivalPlan = [...booking.arrivalPlan];
    this.arrivedUnits = booking.arrivedUnits;
    this.loadedUnits = booking.loadedUnits;
    this.lastMinuteUnits = booking.lastMinuteUnits;
    this.rolledUnitIds = booking.rolledUnitIds.map((id) => id as EntityId);
    this.heldUnits = booking.heldUnits;
    this.assertCounters();
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

  override get loadShipId(): EntityId | undefined {
    return this.shipId;
  }

  /** Export sa nakladá na loď voyage, kým je booking v `exporting` (loď pri kotvisku). */
  override get acceptsLoading(): boolean {
    return this.state === 'exporting';
  }

  override loadsUnit(unit: CargoUnit): boolean {
    return unit.direction === 'export' && unit.contractId === this.id;
  }

  /** Export: prijaté a nenaložené jednotky (vrátené odosielateľovi po uzavretí sú odpočítané počítadlom `unitsExported`). */
  override get rolledAtClose(): number {
    return Math.max(0, this.arrivedUnits - this.loadedUnits);
  }

  override get hasCutoff(): boolean {
    return true;
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

/**
 * Repositioning prázdnych kontajnerov linky (F6c, ADR-034): booking `volumeUnits` prázdnych kontajnerov linky kontraktu na loď
 * voyage s cieľovým prístavom — export booking, ktorého jednotky nepridú kamióny, ale depo prázdnych. Bez cut-off a plánu
 * príchodov (`planBooking` nič neplánuje). Počítadlá bookingu: `arrivedUnits` = prázdne pridelené bookingu (vybrané z depa
 * pre nakládku), `loadedUnits` = naložené na loď (hook ledgera podľa lode voyage a linky — prázdny kontajner nemá `contractId`),
 * `rolledUnitIds`, `lastMinuteUnits` a `heldUnits` sú vždy prázdne / 0. Odmena `⌊N × repositioningPricePerUnitCents × urgency⌋`
 * pomerne k naloženým, nesplnený booking ako export (`bookingFulfilmentShare`); stowage ich radí po plných jednotkách.
 */
export class EmptyRepositioningContract extends ExportContract {
  /** Repositioning zo save: booking povinný, bez cut-off a plánu príchodov, bez plánu prekládky. */
  static override restore(state: SerializedContract): EmptyRepositioningContract {
    const contract = new EmptyRepositioningContract(exportTermsOf(state, 'repositioning kontrakt'));
    if (state.tranship !== null) throw new ContractError('invalid_input', `${contract.label}: repositioning nemá plán prekládky`);
    contract.restoreBooking(state, 'absent');
    return contract;
  }

  override get kind(): ContractKind {
    return 'empty_repositioning';
  }

  /** Repositioning nemá cut-off ani plán príchodov kamiónov — prázdne berie depo. */
  protected override planBooking(context: AcceptContext): void {
    void context;
  }

  override get hasCutoff(): boolean {
    return false;
  }

  /** Prázdny kontajner nemá `contractId` — nakladá sa ako náklad bookingu, ak je to prázdny linky kontraktu (a loď má tento booking, rozhoduje `openLoadBookings`). */
  override loadsUnit(unit: CargoUnit): boolean {
    return unit.direction === 'empty' && unit.lineId === this.lineId;
  }

  /** Pridelená prázdna jednotka sa počíta ako „prijatá“ (`arrivedUnits`): z nej loď vie, koľko prázdnych ešte čaká na nakládku. */
  override assignLoad(unit: CargoUnit): void {
    void unit;
    this.arrivedUnits += 1;
  }

  /** Dispatcher pridelí nakládke najviac toľko prázdnych, koľko je bookovaných (`volumeUnits − arrivedUnits`). */
  override get loadsToAssign(): number {
    return Math.max(0, this.volumeUnits - this.arrivedUnits);
  }

  override get loadsAfterFullUnits(): boolean {
    return true;
  }

  /** Repositioning netrestá „rolled“ jednotky — nepridelené / nenaložené prázdne rieši penalizácia za nesplnený booking. */
  override get rolledAtClose(): number {
    return 0;
  }

  override countersProblem(): string | undefined {
    const base = super.countersProblem();
    if (base !== undefined) return base;
    if (this.arrivalPlan.length > 0 || this.rolledUnits > 0 || this.lastMinuteUnits > 0 || this.heldUnits > 0) {
      return 'repositioning nemá plán príchodov, rolled, last minute ani hold';
    }
    return undefined;
  }
}

/** Najmenší rozstup príchodov lodí A a B prekládky v tickoch (loď B nikdy nepríde v ticku príchodu lode A). */
const MIN_TRANSHIP_GAP_TICKS = 1;

/**
 * Prekládka loď → loď (F6c, ADR-034): loď A (voyage kontraktu) privezie `volumeUnits` jednotiek `direction: 'tranship'`,
 * vyložia sa, uložia a naložia na loď B (voyage `outVoyageId`, ktorá príde `transhipGapDaysRange` neskôr); jednotky **nikdy
 * neprejdú bránou**. Je to export booking s doplnkami: `arrivedUnits` = `unitsUnloaded` = jednotky vyložené z lode A,
 * `loadedUnits` = naložené na loď B, `unitsExported` (vrátené) = jednotky, ktoré po uzavretí odišli kamiónom ako „predané“
 * (zmeškaná prekládka bez záchrany); bez cut-off a plánu príchodov. Stavy ako import (`ship_en_route → unloading` pri lodi A),
 * `exporting` = jednotky čakajú na loď B / nakladajú sa. Odmena `⌊N × transhipPricePerUnitCents × urgency⌋` pomerne k naloženým.
 * Plán lode B (`outArrivalTick`, `outShipId`, `rescueDeadlineTick`) je v save časti `tranship`.
 */
export class TranshipContract extends ExportContract implements TranshipLeg {
  /** Voyage lode B; mení ju len záchrana zmeškanej prekládky (`redirect`, `ContractBook.redirectTranship`). */
  outVoyageId: VoyageId;
  outArrivalTick: number | undefined;
  outShipId: EntityId | undefined;
  rescueDeadlineTick: number | undefined;

  /** Chyby ako `ExportContract` a navyše `outVoyageId` nie je celé ≥ 1 alebo sa rovná voyage lode A (`ContractError('invalid_input')`). */
  constructor(terms: TranshipContractTerms) {
    super(terms);
    if (!isPositive(terms.outVoyageId) || terms.outVoyageId === terms.voyageId) {
      throw new ContractError('invalid_input', `${this.label}: outVoyageId musí byť celé číslo ≥ 1 a iné ako voyage lode A, dostal ${String(terms.outVoyageId)}`);
    }
    this.outVoyageId = terms.outVoyageId;
    this.outArrivalTick = undefined;
    this.outShipId = undefined;
    this.rescueDeadlineTick = undefined;
  }

  /**
   * Prekládka zo save: booking aj plán lode B povinné; `outArrivalTick` práve od prijatia a po príchode lode A, `outShipId`
   * len s plánom príchodu B, `rescueDeadlineTick` len po spawne B.
   */
  static override restore(state: SerializedContract): TranshipContract {
    const { tranship } = state;
    if (tranship === null) throw new ContractError('invalid_input', `kontrakt #${String(state.id)}: prekládka musí mať plán lode B (tranship)`);
    const contract = new TranshipContract({ ...exportTermsOf(state, 'prekládka'), outVoyageId: tranship.outVoyageId as VoyageId });
    contract.restoreBooking(state, 'absent');
    const label = contract.label;
    const planned = CONTRACT_STATE_TRAITS[state.state].plan;
    checkPresence(label, 'tranship.outArrivalTick', orUndefined(tranship.outArrivalTick), planned === 'absent' ? 'absent' : 'required');
    checkPresence(label, 'tranship.outShipId', orUndefined(tranship.outShipId), 'optional');
    checkPresence(label, 'tranship.rescueDeadlineTick', orUndefined(tranship.rescueDeadlineTick), 'optional');
    if (tranship.outArrivalTick !== null && state.shipArrivalTick !== null && tranship.outArrivalTick <= state.shipArrivalTick) {
      throw new ContractError('invalid_input', `${label}: príchod lode B ${String(tranship.outArrivalTick)} musí byť po príchode lode A ${String(state.shipArrivalTick)}`);
    }
    if (tranship.outShipId !== null && (!isPositive(tranship.outShipId) || tranship.outArrivalTick === null)) {
      throw new ContractError('invalid_input', `${label}: loď B (outShipId) musí byť id ≥ 1 a má ju len prijatá prekládka`);
    }
    if (tranship.rescueDeadlineTick !== null && tranship.outShipId === null) {
      throw new ContractError('invalid_input', `${label}: rescueDeadlineTick má len prekládka, ktorej loď B už vznikla`);
    }
    contract.outArrivalTick = orUndefined(tranship.outArrivalTick);
    contract.outShipId = orUndefined(tranship.outShipId) as EntityId | undefined;
    contract.rescueDeadlineTick = orUndefined(tranship.rescueDeadlineTick);
    return contract;
  }

  override get kind(): ContractKind {
    return 'tranship';
  }

  override get tranship(): TranshipLeg {
    return this;
  }

  /** Voyage lode A aj lode B (kniha ich indexuje obe). */
  override get voyageIds(): readonly VoyageId[] {
    return [this.voyageId, this.outVoyageId];
  }

  override shipOnVoyage(voyageId: VoyageId): EntityId | undefined {
    return voyageId === this.outVoyageId ? this.outShipId : super.shipOnVoyage(voyageId);
  }

  override arrivalOnVoyage(voyageId: VoyageId): number | undefined {
    return voyageId === this.outVoyageId ? this.outArrivalTick : super.arrivalOnVoyage(voyageId);
  }

  override voyageOfShip(shipId: EntityId): VoyageId | undefined {
    return this.outShipId === shipId ? this.outVoyageId : super.voyageOfShip(shipId);
  }

  /** Loď A privezie všetky jednotky prekládky (ako import), náklad nakladá loď B. */
  override get spawnUnits(): number {
    return this.volumeUnits;
  }

  /** Prekládku nakladá loď B (od jej spawnu; po záchrane zmeškanej prekládky ďalšia loď linky). */
  override get loadShipId(): EntityId | undefined {
    return this.outShipId;
  }

  /** Prekládka sa nakladá na loď B, keď už má vyložené jednotky (`unloading` — vykládka z A ešte beží — alebo `exporting`). */
  override get acceptsLoading(): boolean {
    return this.state === 'unloading' || this.state === 'exporting';
  }

  override loadsUnit(unit: CargoUnit): boolean {
    return unit.direction === 'tranship' && unit.contractId === this.id;
  }

  override get hasCutoff(): boolean {
    return false;
  }

  /** Zmeškané jednotky sa penalizujú hneď pri zmeškaní lode B (`TranshipMissed`), pri uzavretí sa „rolled“ neúčtuje druhýkrát. */
  override get rolledAtClose(): number {
    return 0;
  }

  /**
   * Záchrana zmeškanej prekládky (ADR-034): preadresuje ju na voyage `outVoyageId` ďalšej lode linky — jej plánovaný príchod
   * `outArrivalTick` a loď `outShipId` (ak už vznikla); záchranná lehota zaniká. Index voyage v knihe prepíše `ContractBook.redirectTranship`.
   */
  redirect(outVoyageId: VoyageId, outArrivalTick: number, outShipId: EntityId | undefined): void {
    this.outVoyageId = outVoyageId;
    this.outArrivalTick = outArrivalTick;
    this.outShipId = outShipId;
    this.rescueDeadlineTick = undefined;
  }

  /** Jednotky prekládky: smer `tranship`, voyage lode A (kontraktu), linka a cieľový prístav lode B. */
  override get spawnLabels(): CargoUnitLabels {
    return { direction: 'tranship', voyageId: this.voyageId, lineId: this.lineId, destinationPort: this.destinationPort, weightClass: DEFAULT_WEIGHT_CLASS };
  }

  /** Náklad na palube lode A patrí kontraktu v `ship_en_route` a `unloading` (ako import). */
  override get carriesShipCargo(): boolean {
    return this.state === 'ship_en_route' || this.state === 'unloading';
  }

  /** Demurrage lode A beží v `unloading` (`CONTRACT_STATE_TRAITS`); demurrage lode B rieši T6C-03. */
  override get accruesDemurrage(): boolean {
    return CONTRACT_STATE_TRAITS[this.state].demurrage;
  }

  /**
   * Plán po prijatí (ADR-034): príchod lode B = `shipArrivalTick + max(1, round(gap × ticksPerDay))`, `gap` = jeden ťah
   * `rng.range(transhipGapDaysRange)`. Bez cut-off a plánu príchodov kamiónov.
   */
  protected override planBooking(context: AcceptContext): void {
    const [minDays, maxDays] = context.transhipGapDaysRange;
    const gapTicks = Math.max(MIN_TRANSHIP_GAP_TICKS, Math.round(context.rng.range(minDays, maxDays) * context.ticksPerDay));
    this.outArrivalTick = context.shipArrivalTick + gapTicks;
  }

  /**
   * Jednotka, ktorá opustila loď A (`on_ship → …`, nie `shipped`), zvýši `unitsUnloaded` aj `arrivedUnits`; naloženie na loď B
   * (`→ on_ship`) a vrátenie (`→ exported`) počíta `ExportContract.cargoMoved` (`loadedUnits`, `unitsExported`).
   */
  override cargoMoved(unit: CargoUnit, to: CargoLocation): void {
    if (unit.location.kind === 'on_ship' && to.kind !== 'shipped' && this.unitsUnloaded < this.volumeUnits) {
      this.unitsUnloaded += 1;
      this.arrivedUnits += 1;
    }
    super.cargoMoved(unit, to);
  }

  /**
   * `unitsUnloaded = arrivedUnits ≤ booked`; `loaded + vrátené ≤ arrived`; bez plánu príchodov, rolled, last minute a hold;
   * `exporting` má vyložený celý objem, `completed` aspoň jednu naloženú jednotku.
   */
  override countersProblem(): string | undefined {
    const { arrivedUnits, loadedUnits, unitsExported, unitsUnloaded, volumeUnits } = this;
    if (unitsUnloaded !== arrivedUnits || unitsUnloaded > volumeUnits) {
      return `vyložené ${String(unitsUnloaded)} musí byť rovné prijatým ${String(arrivedUnits)} a nie viac ako ${String(volumeUnits)}`;
    }
    if (loadedUnits + unitsExported > arrivedUnits) return `naložené ${String(loadedUnits)} + vrátené ${String(unitsExported)} > vyložené ${String(arrivedUnits)}`;
    if (this.arrivalPlan.length > 0 || this.rolledUnits > 0 || this.lastMinuteUnits > 0 || this.heldUnits > 0) {
      return 'prekládka nemá plán príchodov, rolled, last minute ani hold';
    }
    if (this.state === 'exporting' && unitsUnloaded !== volumeUnits) return 'exporting bez vyloženého celého objemu';
    if (this.state === 'completed' && loadedUnits === 0) return 'completed bez naloženej jednotky';
    return undefined;
  }

  protected override transhipState(): SerializedTranship {
    return {
      outVoyageId: this.outVoyageId,
      outArrivalTick: orNull(this.outArrivalTick),
      outShipId: orNull(this.outShipId),
      rescueDeadlineTick: orNull(this.rescueDeadlineTick),
    };
  }
}

/** Obnova kontraktu zo save podľa druhu (tabuľka, nie switch — nový druh = nový riadok a trieda). */
const CONTRACT_RESTORERS: { readonly [K in ContractKind]: (state: SerializedContract) => Contract } = Object.freeze({
  import: (state: SerializedContract) => ImportContract.restore(state),
  export: (state: SerializedContract) => ExportContract.restore(state),
  empty_repositioning: (state: SerializedContract) => EmptyRepositioningContract.restore(state),
  tranship: (state: SerializedContract) => TranshipContract.restore(state),
});
