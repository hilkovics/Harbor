/**
 * Chyby strojov bloku (ADR-040). `MachineError` znamená chybu programu alebo nekonzistentný svet (neplatný vstup konštruktora, `World.addMachine` mimo pravidiel,
 * stroj pri cykle bez vozidla, jobu alebo jednotky) — poškodený save hlási `WorldStateError`.
 */
export type MachineErrorCode =
  /** Neplatný vstup (id, stav, poloha, fáza, cyklus, fronta). */
  | 'invalid_input'
  /** `World.addMachine`: id už vo svete má iná entita, alebo ho nepridelil alokátor. */
  | 'duplicate_id'
  /** `World.addMachine`: blok neexistuje, nie je RTG blok, alebo už má stroj. */
  | 'unknown_block'
  /** `World.removeMachine`: stroj s daným id vo svete nie je. */
  | 'unknown_machine'
  /** `World.removeMachine`: stroj nie je `idle` alebo má rozpracovaný cyklus či frontu. */
  | 'busy'
  /** `YardMachine.transition`: prechod mimo `MACHINE_TRANSITIONS`. */
  | 'invalid_transition'
  /** `YardMachineSystem`: stroj v cykle bez vozidla, jobu, jednotky alebo stohu, ktorý cyklus predpokladá (poškodený svet). */
  | 'inconsistent';

export class MachineError extends Error {
  readonly code: MachineErrorCode;

  constructor(code: MachineErrorCode, message: string) {
    super(message);
    this.name = 'MachineError';
    this.code = code;
  }
}
