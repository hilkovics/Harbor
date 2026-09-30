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
  | 'inconsistent'
  /** `World.addShip`: id už vo svete má loď alebo modul. */
  | 'duplicate_id'
  /** `World.removeShip`: loď s daným id vo svete nie je. */
  | 'unknown_ship'
  /** `World.removeShip`: loď má na palube náklad (`on_ship`) — jednotky by stratili držiteľa. */
  | 'has_cargo'
  /** `World.removeShip`: loď drží kotviská (`berthIds`). */
  | 'holds_berths';

export class ShipError extends Error {
  readonly code: ShipErrorCode;

  constructor(code: ShipErrorCode, message: string) {
    super(message);
    this.name = 'ShipError';
    this.code = code;
  }
}
