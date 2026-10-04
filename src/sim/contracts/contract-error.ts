/**
 * Chyby kontraktov (ARCHITECTURE §9.1, ADR-026). `ContractError` znamená chybu programu (neplatný vstup konštruktora,
 * prechod mimo `CONTRACT_TRANSITIONS`, nekonzistentný svet počas ticku) — hráčske vstupy odmietajú
 * `AcceptContract.validate` / `DeclineContract.validate` a poškodený save `WorldStateError`.
 */

export type ContractErrorCode =
  /** Neplatný vstup (id, objem, odmena, tick, pole nezodpovedajúce stavu…). */
  | 'invalid_input'
  /** Prechod stavu, ktorý tabuľka `CONTRACT_TRANSITIONS` nepovoľuje. */
  | 'invalid_transition'
  /** `ContractBook.add`: id už v knihe je. */
  | 'duplicate_id'
  /** Kontrakt s daným id v knihe nie je. */
  | 'unknown_contract'
  /** Svet nezodpovedá stavu kontraktu (napr. chýba loď kontraktu). */
  | 'inconsistent';

export class ContractError extends Error {
  readonly code: ContractErrorCode;

  constructor(code: ContractErrorCode, message: string) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}
