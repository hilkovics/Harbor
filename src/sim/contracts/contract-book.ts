/**
 * Kniha kontraktov sveta (ARCHITECTURE §9.1, §10; ADR-026): všetky kontrakty okrem expirovaných (ponuky, prebiehajúce,
 * dokončené a zlyhané) vzostupne podľa id, XP a počet dokončených kontraktov (z neho `tier`).
 *
 * - Expirovaný kontrakt (`offered → expired`, timeout aj `DeclineContract`) kniha po prechode **zabudne**, aby save
 *   nerástol s každou nevybranou ponukou; udalosti `ContractStateChanged` a `ContractExpired` nesú všetko, čo potrebuje
 *   prezentácia. Dokončené a zlyhané kontrakty ostávajú (história hráča, nimi je kniha ohraničená).
 * - `cargoMoved` je háčik `CargoLedger.move` (`CargoLedgerDeps.observer`): jednotku s `contractId` odovzdá jej
 *   kontraktu (`Contract.cargoMoved`, polymorfné podľa druhu — import `unitsUnloaded` / `unitsExported`, export
 *   `loadedUnits` / vrátené, ADR-032) — O(1) na presun, žiadne skeny ledgera v ticku. Počíta sa v každom stave
 *   kontraktu (aj po `failed`), aby počítadlá zodpovedali nákladu.
 * - **Voyage** (ADR-032): kniha prideľuje aj id návštev lode (`allocateVoyageId`, vlastná postupnosť, `nextVoyageId`
 *   v save) a vedie odvodený index voyage → kontrakty (vzostupne podľa id; nie je v save). Voyage nemá vlastný záznam —
 *   jej údaje (trieda lode, príchod, loď, cieľový prístav, cut-off) nesú jej kontrakty (`voyage()` ich zloží). Prekládka
 *   (ADR-034) je v indexe pod voyage lode A aj lode B (`Contract.voyageIds`).
 * - Stav mení `changeState` (tabuľka `CONTRACT_TRANSITIONS` + `ContractStateChanged`); prebiehajúce kontrakty
 *   (`CONTRACT_STATE_TRAITS.terminal === false`) vedie kniha zvlášť, aby krok 2 neprechádzal históriu.
 */
import type { CargoLocation } from '../cargo/cargo-location';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { ContractId, EntityId, VoyageId } from '../core/entity-id';
import type { ContractStateChangedEvent } from '../events/sim-event';
import { Contract, TranshipContract, type SerializedContract } from './contract';
import { ContractError } from './contract-error';
import { CONTRACT_KIND_TRAITS, CONTRACT_STATE_TRAITS, OFFER_GROUPS, type ContractState, type OfferGroup } from './contract-fsm';

/** Stav knihy v save (`WorldState.contracts`, `xp`, `completedContracts`, `nextContractId` — v5; `nextVoyageId` — v7). */
export interface ContractBookState {
  /** Kontrakty vzostupne podľa id (bez expirovaných). */
  readonly contracts: readonly SerializedContract[];
  readonly xp: number;
  readonly completedContracts: number;
  /** Id, ktoré dostane ďalší kontrakt (≥ 1, väčšie ako id každého uloženého kontraktu). */
  readonly nextContractId: number;
  /** Id, ktoré dostane ďalšia voyage (≥ 1, väčšie ako `voyageId` každého uloženého kontraktu; v7, ADR-032). */
  readonly nextVoyageId: number;
}

/**
 * Odvodený pohľad na voyage (návštevu lode, ADR-032) zo všetkých jej kontraktov v knihe — pre UI a systémy mimo hot
 * path (nová kópia pri každom volaní). Údaje lode berie z prvého kontraktu (kontrakty voyage sa na nich zhodujú —
 * overuje obnova save).
 */
export interface VoyageView {
  readonly id: VoyageId;
  /** Kontrakty voyage vzostupne podľa id (import, export booking). */
  readonly contracts: readonly Contract[];
  readonly shipClassId: string;
  /** Plánovaný príchod lode (od prijatia), inak `undefined`. */
  readonly arrivalTick: number | undefined;
  /** Loď voyage (od spawnu), inak `undefined`. */
  readonly shipId: EntityId | undefined;
  /** Cieľový prístav exportu voyage (prvý export booking), bez exportu `null`. */
  readonly destinationPort: string | null;
  /** Najskorší cut-off exportu voyage, bez neho `undefined`. */
  readonly cutoffTick: number | undefined;
}

const NO_CONTRACTS: readonly Contract[] = Object.freeze([]);

/**
 * Počet ponúk v poole po skupinách voyage (`ContractBook.offeredGroups`, ADR-034): kľúč je `OfferGroup` — `import` (F5),
 * `booking` (šablóny `export` a `roundtrip`), `repositioning` (voyage s `empty_repositioning`) a `tranship`.
 */
export type OfferedGroups = { readonly [G in OfferGroup]: number };

/** Závislosti knihy od sveta (`world.events`, `world.clock`). */
export interface ContractBookEnv {
  readonly events: { emit(event: ContractStateChangedEvent): void };
  readonly clock: { readonly tick: number };
}

/** Prvé id kontraktu (0 ostáva voľné ako „žiadny kontrakt“). */
const FIRST_CONTRACT_ID = 1;
/** Prvé id voyage (0 ostáva voľné ako „žiadna voyage“). */
const FIRST_VOYAGE_ID = 1;

export class ContractBook {
  private readonly env: ContractBookEnv;
  private readonly all = new Map<ContractId, Contract>();
  private readonly open = new Map<ContractId, Contract>();
  private xpTotal = 0;
  private completedTotal = 0;
  /** Najväčšie id, aké kniha kedy mala (aj expirované) — nové kontrakty musia mať väčšie. */
  private lastId: ContractId | undefined;
  /** Id, ktoré dostane ďalší kontrakt (vlastná postupnosť, `nextContractId` v save). */
  private nextContractId = FIRST_CONTRACT_ID;
  /** Id, ktoré dostane ďalšia voyage (vlastná postupnosť, `nextVoyageId` v save, ADR-032). */
  private nextVoyageId = FIRST_VOYAGE_ID;
  /** Voyage → jej kontrakty v knihe vzostupne podľa id (odvodený index, nie je v save). */
  private readonly voyageIndex = new Map<VoyageId, Contract[]>();
  /**
   * Počet neukončených kontraktov s bookingom (export, repositioning, prekládka; aj ponuky) — rýchla cesta pre systémy, keď nakládka nie je
   * v hre (odvodené, nie v save).
   */
  private openExportCount = 0;

  constructor(env: ContractBookEnv) {
    this.env = env;
  }

  /**
   * Kniha zo save (tvar overil `parseContractsState`): kontrakty cez `Contract.fromState` vzostupne podľa id, XP a počet
   * dokončených (celé ≥ 0), postupnosti id kontraktov aj voyage. Chyby: `ContractError` (nekonzistentný kontrakt, id
   * nie vzostupne, id kontraktu ≥ `nextContractId`, voyage ≥ `nextVoyageId`).
   */
  static fromState(env: ContractBookEnv, state: ContractBookState): ContractBook {
    const book = new ContractBook(env);
    for (const serialized of state.contracts) {
      if (serialized.id >= state.nextContractId) {
        throw new ContractError('invalid_input', `ContractBook.fromState: kontrakt #${String(serialized.id)} nie je menší ako nextContractId ${String(state.nextContractId)}`);
      }
      if (serialized.voyageId >= state.nextVoyageId) {
        throw new ContractError('invalid_input', `ContractBook.fromState: kontrakt #${String(serialized.id)} má voyage ${String(serialized.voyageId)}, ktorú kniha nepridelila (nextVoyageId ${String(state.nextVoyageId)})`);
      }
      const contract = Contract.fromState(serialized);
      const unknownVoyage = contract.voyageIds.find((voyageId) => voyageId >= state.nextVoyageId);
      if (unknownVoyage !== undefined) {
        throw new ContractError('invalid_input', `ContractBook.fromState: kontrakt #${String(serialized.id)} má voyage ${String(unknownVoyage)}, ktorú kniha nepridelila (nextVoyageId ${String(state.nextVoyageId)})`);
      }
      book.add(contract);
    }
    book.xpTotal = state.xp;
    book.completedTotal = state.completedContracts;
    book.nextContractId = state.nextContractId;
    book.nextVoyageId = state.nextVoyageId;
    return book;
  }

  /**
   * Kniha ešte nepridelila žiadne id kontraktu — pool sa nikdy neplnil (nová hra alebo save uložený pred
   * prvým tickom; T06-07). Odvodené zo stavu v save (`nextContractId`), takže prežije save aj load.
   */
  get untouched(): boolean {
    return this.nextContractId === FIRST_CONTRACT_ID;
  }

  /** Pridelí id novému kontraktu (1, 2, 3, … — vlastná postupnosť knihy, ADR-026). */
  allocateId(): ContractId {
    const id = this.nextContractId;
    this.nextContractId += 1;
    return id as ContractId;
  }

  /**
   * Pridelí id novej voyage (1, 2, 3, … — vlastná postupnosť knihy, ADR-032). Pool ho volá pri vzniku ponuky (roundtrip:
   * jedno id pre import aj export booking), takže pri samých import ponukách sú id voyage a kontraktov zhodné.
   */
  allocateVoyageId(): VoyageId {
    const id = this.nextVoyageId;
    this.nextVoyageId += 1;
    return id as VoyageId;
  }

  /** Kontrakty voyage v knihe vzostupne podľa id (živé pole, bez alokácie); neznáma voyage → prázdne. */
  voyageContracts(voyageId: VoyageId): readonly Contract[] {
    return this.voyageIndex.get(voyageId) ?? NO_CONTRACTS;
  }

  /**
   * Voyage lode `shipId` (neukončený kontrakt s touto loďou, prvý podľa id), alebo `undefined` (ladiaca loď, loď bez
   * kontraktu). O(neukončené kontrakty), bez alokácie.
   */
  voyageIdOfShip(shipId: EntityId): VoyageId | undefined {
    for (const contract of this.open.values()) {
      const voyageId = contract.voyageOfShip(shipId);
      if (voyageId !== undefined) return voyageId;
    }
    return undefined;
  }

  /** Odvodený pohľad na voyage (`VoyageView`), alebo `undefined`, ak v knihe nemá kontrakt. Nová kópia — nie hot path. */
  voyage(voyageId: VoyageId): VoyageView | undefined {
    const contracts = this.voyageIndex.get(voyageId);
    if (contracts === undefined || contracts.length === 0) return undefined;
    // Údaje lode berie z kontraktu, ktorému voyage patrí (prekládka zachránená na cudziu voyage je v jej indexe len ako pasažier; voyage lode B
    // prekládky nemá vlastný kontrakt — vtedy z prvého kontraktu).
    const first = contracts.find((contract) => contract.voyageId === voyageId) ?? contracts[0];
    let destinationPort: string | null = null;
    let cutoffTick: number | undefined;
    for (const contract of contracts) {
      const { booking } = contract;
      if (booking === null) continue;
      destinationPort ??= booking.destinationPort;
      if (booking.cutoffTick !== undefined && (cutoffTick === undefined || booking.cutoffTick < cutoffTick)) cutoffTick = booking.cutoffTick;
    }
    return {
      id: voyageId,
      contracts: [...contracts],
      shipClassId: first.shipClassId,
      arrivalTick: first.arrivalOnVoyage(voyageId),
      shipId: first.shipOnVoyage(voyageId),
      destinationPort,
      cutoffTick,
    };
  }

  /**
   * Je v knihe neukončený kontrakt s bookingom (export, repositioning alebo prekládka; aj ponuka)? O(1); bez neho systémy (žeriav,
   * dispatcher, loď) nakládku nepočítajú — import-only svet ostáva bitovo aj výkonovo rovnaký ako vo F5 (ADR-032, ADR-033, ADR-034).
   */
  get hasOpenExports(): boolean {
    return this.openExportCount > 0;
  }

  /** Všetky kontrakty okrem expirovaných vzostupne podľa id (živá mapa len na čítanie). */
  get contracts(): ReadonlyMap<ContractId, Contract> {
    return this.all;
  }

  /** Neukončené kontrakty (ponuky a prebiehajúce) vzostupne podľa id. */
  get openContracts(): ReadonlyMap<ContractId, Contract> {
    return this.open;
  }

  /** Nazbierané XP (§10; míňa ich až tech strom vo F8). */
  get xp(): number {
    return this.xpTotal;
  }

  /** Počet dokončených kontraktov za hru. */
  get completedContracts(): number {
    return this.completedTotal;
  }

  /** `tier = ⌊completedContracts / contractsPerTier⌋` (rozhodnutie 7). */
  tier(contractsPerTier: number): number {
    return Math.floor(this.completedTotal / contractsPerTier);
  }

  /** Počet ponúk v poole (`offered`) — kontraktov; roundtrip sa počíta dvakrát (pozri `offeredGroups`). */
  get offeredCount(): number {
    let count = 0;
    for (const contract of this.open.values()) if (CONTRACT_STATE_TRAITS[contract.state].offer) count += 1;
    return count;
  }

  /**
   * Počet ponúk v poole po **skupinách** (ADR-032 bod 1): skupina = ponuka jednej voyage (import ponuka 1 kontrakt, export
   * booking 1, roundtrip import + export 2). `booking` skupiny majú export kontrakt, `import` skupiny nie; pool dopĺňa
   * každý druh zvlášť (`economy.offersPerDay`, `economy.bookingOffersPerDay`). Kontrakty skupiny vznikajú za sebou
   * (po sebe idúce id), preto stačí jeden prechod bez alokácie okrem výsledku.
   */
  offeredGroups(): OfferedGroups {
    const counts: { [G in OfferGroup]: number } = { import: 0, booking: 0, repositioning: 0, tranship: 0 };
    let voyage: VoyageId | undefined;
    let rank = -1;
    const close = (): void => {
      if (voyage !== undefined) counts[OFFER_GROUPS[rank]] += 1;
    };
    for (const contract of this.open.values()) {
      if (!CONTRACT_STATE_TRAITS[contract.state].offer) continue;
      if (contract.voyageId !== voyage) {
        close();
        voyage = contract.voyageId;
        rank = -1;
      }
      rank = Math.max(rank, OFFER_GROUPS.indexOf(contract.offerGroup));
    }
    close();
    return counts;
  }

  /**
   * Ponuky (`offered`) voyage `voyageId` vzostupne podľa id — kontrakty skupiny, ktoré `AcceptContract` / `DeclineContract`
   * prijmú alebo odmietnu spolu. **Nová kópia** (prechod do `expired` kontrakt z knihy zabúda); neznáma voyage → prázdne.
   */
  offeredOfVoyage(voyageId: VoyageId): Contract[] {
    return this.voyageContracts(voyageId).filter((contract) => CONTRACT_STATE_TRAITS[contract.state].offer);
  }

  /** Kontrakt podľa id, alebo `undefined`. */
  get(id: ContractId): Contract | undefined {
    return this.all.get(id);
  }

  /**
   * Pridá kontrakt (nová ponuka poolu, obnova zo save). Chyby (`ContractError`, kniha sa nezmení): id už v knihe
   * (`duplicate_id`), id nie väčšie ako posledný pridaný kontrakt, aj expirovaný — poradie id = poradie vzniku a id sa
   * nepoužije dvakrát (`invalid_input`).
   */
  add(contract: Contract): void {
    if (this.all.has(contract.id)) throw new ContractError('duplicate_id', `ContractBook.add: ${contract.label} už v knihe je`);
    const last = this.lastId;
    if (last !== undefined && contract.id <= last) throw new ContractError('invalid_input', `ContractBook.add: ${contract.label} nemá väčšie id ako posledný kontrakt #${String(last)}`);
    this.all.set(contract.id, contract);
    this.lastId = contract.id;
    if (!CONTRACT_STATE_TRAITS[contract.state].terminal) {
      this.open.set(contract.id, contract);
      if (CONTRACT_KIND_TRAITS[contract.kind].booking) this.openExportCount += 1;
    }
    for (const voyageId of contract.voyageIds) {
      const voyage = this.voyageIndex.get(voyageId);
      if (voyage === undefined) this.voyageIndex.set(voyageId, [contract]);
      else voyage.push(contract);
    }
  }

  /**
   * Prechod kontraktu `contract.transition(to, clock.tick)` a udalosť `ContractStateChanged { contractId, from, to }`.
   * Konečný stav vypadne z prebiehajúcich; `expired` aj z knihy. Nepovolený prechod → `ContractError` bez zmeny.
   */
  changeState(contract: Contract, to: ContractState): void {
    if (this.all.get(contract.id) !== contract) throw new ContractError('unknown_contract', `ContractBook.changeState: ${contract.label} nie je v knihe`);
    const from = contract.state;
    contract.transition(to, this.env.clock.tick);
    this.env.events.emit({ type: 'ContractStateChanged', contractId: contract.id, from, to });
    if (!CONTRACT_STATE_TRAITS[to].terminal) return;
    this.open.delete(contract.id);
    if (CONTRACT_KIND_TRAITS[contract.kind].booking) this.openExportCount -= 1;
    if (to === 'expired') this.forget(contract);
  }

  /**
   * Záchrana zmeškanej prekládky (ADR-034): preadresuje `contract` na voyage `outVoyageId` ďalšej lode linky (jej plánovaný príchod
   * `outArrivalTick`, loď `outShipId` ak už vznikla) a prepíše index voyage — kontrakt z pôvodnej voyage lode B zmizne a zaradí sa
   * (vzostupne podľa id) pod novú. Voyage musí existovať (pridelila ju kniha), inak `ContractError('invalid_input')`.
   */
  redirectTranship(contract: TranshipContract, outVoyageId: VoyageId, outArrivalTick: number, outShipId: EntityId | undefined): void {
    if (this.all.get(contract.id) !== contract) throw new ContractError('unknown_contract', `ContractBook.redirectTranship: ${contract.label} nie je v knihe`);
    if (outVoyageId >= this.nextVoyageId || outVoyageId === contract.voyageId) {
      throw new ContractError('invalid_input', `ContractBook.redirectTranship: ${contract.label} nemožno preadresovať na voyage ${String(outVoyageId)}`);
    }
    const previous = this.voyageIndex.get(contract.outVoyageId);
    const at = previous === undefined ? -1 : previous.indexOf(contract);
    if (previous !== undefined && at >= 0) {
      previous.splice(at, 1);
      if (previous.length === 0) this.voyageIndex.delete(contract.outVoyageId);
    }
    contract.redirect(outVoyageId, outArrivalTick, outShipId);
    const voyage = this.voyageIndex.get(outVoyageId);
    if (voyage === undefined) {
      this.voyageIndex.set(outVoyageId, [contract]);
      return;
    }
    let position = voyage.length;
    while (position > 0 && voyage[position - 1].id > contract.id) position -= 1;
    voyage.splice(position, 0, contract);
  }

  /** Expirovaný kontrakt kniha zabudne — aj z indexu voyage (prázdna voyage zanikne). */
  private forget(contract: Contract): void {
    this.all.delete(contract.id);
    for (const voyageId of contract.voyageIds) {
      const voyage = this.voyageIndex.get(voyageId);
      if (voyage === undefined) continue;
      const at = voyage.indexOf(contract);
      if (at >= 0) voyage.splice(at, 1);
      if (voyage.length === 0) this.voyageIndex.delete(voyageId);
    }
  }

  /** Pripíše dokončenie: `completedContracts += 1`, `xp += gain` (celé ≥ 0). */
  recordCompletion(xpGain: number): void {
    if (!Number.isSafeInteger(xpGain) || xpGain < 0) throw new ContractError('invalid_input', `ContractBook.recordCompletion: XP musí byť celé ≥ 0, dostal ${String(xpGain)}`);
    this.completedTotal += 1;
    this.xpTotal += xpGain;
  }

  /**
   * Háčik `CargoLedger.move` (po presune, `unit` = jednotka pred presunom): presun jednotky kontraktu spracuje jej
   * kontrakt (`Contract.cargoMoved`, podľa druhu). Jednotka bez kontraktu (`null`) alebo s kontraktom mimo knihy
   * (nekonzistenciu odmietne obnova save) sa ignoruje — háčik nesmie vyhodiť (presun je atomický).
   */
  cargoMoved(unit: CargoUnit, to: CargoLocation): void {
    if (unit.contractId === null) {
      if (unit.direction === 'empty' && to.kind === 'on_ship') this.emptyLoaded(unit, to.shipId);
      return;
    }
    this.all.get(unit.contractId)?.cargoMoved(unit, to);
  }

  /**
   * Prázdny kontajner (bez `contractId`) naložený na loď `shipId` (ADR-034): počíta ho booking repositioningu, ktorý nakladá na túto loď
   * a ktorého linka je linka jednotky (`Contract.loadsUnit`); naložený prázdny bez takého bookingu sa nepočíta. Zriedkavá udalosť —
   * prechádza neukončené kontrakty.
   */
  private emptyLoaded(unit: CargoUnit, shipId: EntityId): void {
    for (const contract of this.open.values()) {
      if (contract.loadShipId !== shipId || !contract.loadsUnit(unit)) continue;
      contract.cargoMoved(unit, { kind: 'on_ship', shipId });
      return;
    }
  }

  /** Čistý JSON stav pre save (nová kópia). */
  getState(): ContractBookState {
    return {
      contracts: [...this.all.values()].map((contract) => contract.toState()),
      xp: this.xpTotal,
      completedContracts: this.completedTotal,
      nextContractId: this.nextContractId,
      nextVoyageId: this.nextVoyageId,
    };
  }
}
