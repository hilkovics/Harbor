/**
 * Chyby lodí (ARCHITECTURE §7.4, ADR-016). `ShipError` znamená chybu programu (neplatný vstup konštruktora,
 * prechod mimo `SHIP_TRANSITIONS`, nekonzistentný svet počas ticku) — hráčske vstupy odmieta `SpawnShipDebug.validate`
 * a poškodený save `WorldStateError`.
 */

export type ShipErrorCode =
  /** Neplatný vstup (id, poloha, kurz, náklad mimo kategórií triedy, index…). */
  | 'invalid_input'
  /** Prechod stavu, ktorý tabuľka `SHIP_TRANSITIONS` nepovoľuje. */
  | 'invalid_transition'
  /** Svet nezodpovedá stavu lode (napr. chýba kotvisko z `berthIds`). */
  | 'inconsistent';

export class ShipError extends Error {
  readonly code: ShipErrorCode;

  constructor(code: ShipErrorCode, message: string) {
    super(message);
    this.name = 'ShipError';
    this.code = code;
  }
}
