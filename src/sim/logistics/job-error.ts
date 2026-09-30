/**
 * Chyby transportných jobov (ARCHITECTURE §7.3; ADR-018). `JobError` znamená chybu programu alebo nekonzistentný svet
 * (neplatný vstup konštruktora `TransportJob`, nepovolený prechod stavu, `World.addJob`/`removeJob` mimo pravidiel) —
 * poškodený save hlási `WorldStateError`.
 */

export type JobErrorCode =
  /** Neplatný vstup (id, jednotky, lokácie, tick, dvojica druhov lokácií mimo `JOB_ROUTES`) alebo id mimo alokátora. */
  | 'invalid_input'
  /** Prechod stavu jobu mimo `JOB_TRANSITIONS` alebo priradenie vozidla jobu, ktorý nie je `open`. */
  | 'invalid_transition'
  /** `World.addJob`: id už vo svete má iná entita. */
  | 'duplicate_id'
  /** `World.addJob`: jednotka jobu v ledgeri nie je alebo neleží na `from`. */
  | 'unknown_unit'
  /** `World.addJob`: jednotka už má aktívny job. */
  | 'unit_busy'
  /** `World.removeJob`: job s daným id vo svete nie je. */
  | 'unknown_job'
  /** `World.removeJob`: job je ešte aktívny (nie je `done` ani `cancelled`). */
  | 'not_done';

export class JobError extends Error {
  readonly code: JobErrorCode;

  constructor(code: JobErrorCode, message: string) {
    super(message);
    this.name = 'JobError';
    this.code = code;
  }
}
