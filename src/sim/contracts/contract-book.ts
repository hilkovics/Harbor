/**
 * Kniha kontraktov sveta (ARCHITECTURE §9.1, §10; ADR-026): všetky kontrakty okrem expirovaných (ponuky, prebiehajúce,
 * dokončené a zlyhané) vzostupne podľa id, XP a počet dokončených kontraktov (z neho `tier`).
 *
 * - Expirovaný kontrakt (`offered → expired`, timeout aj `DeclineContract`) kniha po prechode **zabudne**, aby save
 *   nerástol s každou nevybranou ponukou; udalosti `ContractStateChanged` a `ContractExpired` nesú všetko, čo potrebuje
 *   prezentácia. Dokončené a zlyhané kontrakty ostávajú (história hráča, nimi je kniha ohraničená).
 * - `cargoMoved` je háčik `CargoLedger.move` (`CargoLedgerDeps.observer`): jednotka s `contractId` zvýši kontraktu
 *   `unitsUnloaded` pri opustení lode (`on_ship → …`) a `unitsExported` pri `→ exported` — O(1) na presun, žiadne skeny
 *   ledgera v ticku. Počíta sa v každom stave kontraktu (aj po `failed`), aby počítadlá zodpovedali nákladu.
 * - Stav mení `changeState` (tabuľka `CONTRACT_TRANSITIONS` + `ContractStateChanged`); prebiehajúce kontrakty
 *   (`CONTRACT_STATE_TRAITS.terminal === false`) vedie kniha zvlášť, aby krok 2 neprechádzal históriu.
 */
import type { CargoLocation } from '../cargo/cargo-location';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { ContractId } from '../core/entity-id';
import type { ContractStateChangedEvent } from '../events/sim-event';
import { Contract, type SerializedContract } from './contract';
import { ContractError } from './contract-error';
import { CONTRACT_STATE_TRAITS, type ContractState } from './contract-fsm';

/** Stav knihy v save (`WorldState.contracts`, `xp`, `completedContracts`; v5). */
export interface ContractBookState {
  /** Kontrakty vzostupne podľa id (bez expirovaných). */
  readonly contracts: readonly SerializedContract[];
  readonly xp: number;
  readonly completedContracts: number;
  /** Id, ktoré dostane ďalší kontrakt (≥ 1, väčšie ako id každého uloženého kontraktu). */
  readonly nextContractId: number;
}

/** Závislosti knihy od sveta (`world.events`, `world.clock`). */
export interface ContractBookEnv {
  readonly events: { emit(event: ContractStateChangedEvent): void };
  readonly clock: { readonly tick: number };
}

/** Prvé id kontraktu (0 ostáva voľné ako „žiadny kontrakt“). */
const FIRST_CONTRACT_ID = 1;

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

  constructor(env: ContractBookEnv) {
    this.env = env;
  }

  /**
   * Kniha zo save (tvar overil `parseContractsState`): kontrakty cez `Contract.fromState` vzostupne podľa id, XP a počet
   * dokončených (celé ≥ 0). Chyby: `ContractError` (nekonzistentný kontrakt, id nie vzostupne).
   */
  static fromState(env: ContractBookEnv, state: ContractBookState): ContractBook {
    const book = new ContractBook(env);
    for (const serialized of state.contracts) {
      if (serialized.id >= state.nextContractId) {
        throw new ContractError('invalid_input', `ContractBook.fromState: kontrakt #${String(serialized.id)} nie je menší ako nextContractId ${String(state.nextContractId)}`);
      }
      book.add(Contract.fromState(serialized));
    }
    book.xpTotal = state.xp;
    book.completedTotal = state.completedContracts;
    book.nextContractId = state.nextContractId;
    return book;
  }

  /**
   * Kniha ešte nepridelila žiadne id kontraktu — pool sa nikdy neplnil (nová hra pred prvým tickom, save spred
   * kontraktov v1–v4 po migrácii; T06-07). Odvodené zo stavu v save (`nextContractId`), takže prežije save aj load.
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

  /** Počet ponúk v poole (`offered`). */
  get offeredCount(): number {
    let count = 0;
    for (const contract of this.open.values()) if (CONTRACT_STATE_TRAITS[contract.state].offer) count += 1;
    return count;
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
    if (!CONTRACT_STATE_TRAITS[contract.state].terminal) this.open.set(contract.id, contract);
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
    if (to === 'expired') this.all.delete(contract.id);
  }

  /** Pripíše dokončenie: `completedContracts += 1`, `xp += gain` (celé ≥ 0). */
  recordCompletion(xpGain: number): void {
    if (!Number.isSafeInteger(xpGain) || xpGain < 0) throw new ContractError('invalid_input', `ContractBook.recordCompletion: XP musí byť celé ≥ 0, dostal ${String(xpGain)}`);
    this.completedTotal += 1;
    this.xpTotal += xpGain;
  }

  /**
   * Háčik `CargoLedger.move` (po presune, `unit` = jednotka pred presunom): jednotka kontraktu, ktorá opustila loď,
   * zvýši `unitsUnloaded`, jednotka, ktorá opustila mapu, `unitsExported`. Jednotka bez kontraktu (`null`) alebo
   * s kontraktom mimo knihy (nekonzistenciu odmietne obnova save) sa ignoruje — háčik nesmie vyhodiť (presun je atomický).
   */
  cargoMoved(unit: CargoUnit, to: CargoLocation): void {
    if (unit.contractId === null) return;
    const contract = this.all.get(unit.contractId);
    if (contract === undefined) return;
    if (unit.location.kind === 'on_ship' && contract.unitsUnloaded < contract.volumeUnits) contract.unitsUnloaded += 1;
    if (to.kind === 'exported' && contract.unitsExported < contract.unitsUnloaded) contract.unitsExported += 1;
  }

  /** Čistý JSON stav pre save (nová kópia). */
  getState(): ContractBookState {
    return {
      contracts: [...this.all.values()].map((contract) => contract.toState()),
      xp: this.xpTotal,
      completedContracts: this.completedTotal,
      nextContractId: this.nextContractId,
    };
  }
}
