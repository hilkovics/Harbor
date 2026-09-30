/**
 * Spoločný základ príkazov nad ponukou kontraktu (`AcceptContract`, `DeclineContract`; ARCHITECTURE §9.1, §12.2;
 * ADR-026): payload `{ contractId }` (celé číslo), presný tvar JSON a validácia ponuky.
 *
 * `validate` (nemení svet, nespotrebuje `Rng`, `cells = []`, `costCents = 0`) vráti práve jeden dôvod:
 * - `game_over` — hra skončila bankrotom (`World.gameOver`; spoločne pre všetky príkazy v `SimCommand`, ADR-027);
 * - `unknown_contract` — kontrakt s daným id vo `world.contracts` nie je (neznáme id, expirovaná ponuka);
 * - `contract_not_offered` — kontrakt nie je ponuka (`CONTRACT_STATE_TRAITS.offer`).
 */
import type { CellCoord } from '../grid/grid';
import type { Contract } from '../contracts/contract';
import { CONTRACT_STATE_TRAITS } from '../contracts/contract-fsm';
import type { ContractId } from '../core/entity-id';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { checkInteger, readPayload } from './payload';
import { SimCommand } from './sim-command';
import type { ValidationReason, ValidationResult } from './validation';

const NO_CELLS: readonly CellCoord[] = Object.freeze([]);

function result(reason: ValidationReason | null): ValidationResult {
  return Object.freeze({ ok: reason === null, reasons: Object.freeze(reason === null ? [] : [reason]), cells: NO_CELLS, costCents: 0 });
}

const VALID = result(null);
const UNKNOWN_CONTRACT = result('unknown_contract');
const NOT_OFFERED = result('contract_not_offered');

/** Kľúče serializovaného tvaru v poradí `toJSON`. */
const CONTRACT_COMMAND_KEYS: readonly string[] = ['type', 'contractId'];

/** `contractId` z JSON payloadu príkazu typu `type` (presný tvar `{ type, contractId }`); inak `CommandError`. */
export function readContractId(json: SerializedCommand, type: string): number {
  const raw = readPayload(json, type, CONTRACT_COMMAND_KEYS);
  return checkInteger(raw['contractId'], type, '/contractId');
}

export abstract class ContractOfferCommand extends SimCommand {
  abstract readonly type: string;
  /** Id kontraktu (celé číslo; či existuje, hlási `validate`). */
  readonly contractId: number;

  /** @param contractId celé číslo, inak `CommandError`. */
  protected constructor(type: string, contractId: number) {
    super();
    this.contractId = checkInteger(contractId, type, '/contractId');
  }

  /** Viď hlavička súboru (`game_over` dopĺňa `SimCommand.validate`). */
  protected check(world: World): ValidationResult {
    const contract = world.contracts.get(this.contractId as ContractId);
    if (contract === undefined) return UNKNOWN_CONTRACT;
    return CONTRACT_STATE_TRAITS[contract.state].offer ? VALID : NOT_OFFERED;
  }

  /** Vykoná príkaz; svet ho volá len po úspešnom `validate` nad tým istým stavom (inak `Error`, nič nezmení). */
  apply(world: World): void {
    const verdict = this.validate(world);
    if (!verdict.ok) {
      throw new Error(`${this.type}.apply: príkaz nie je platný (${verdict.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    }
    this.applyTo(world, world.contracts.get(this.contractId as ContractId) as Contract);
  }

  /** Účinok nad overenou ponukou. */
  protected abstract applyTo(world: World, offer: Contract): void;

  toJSON(): SerializedCommand {
    return { type: this.type, contractId: this.contractId };
  }
}
