/**
 * Identifikátory entít (CLAUDE.md, konvencie: branded typy). ID sa prideľujú deterministicky
 * rastúcim počítadlom; jeho stav je súčasťou save, aby obnovená hra pokračovala rovnakými ID.
 */

/** ID entity (modul, loď, vozidlo, kontrakt, jednotka nákladu…). Obyčajné číslo sa naň nekonvertuje implicitne. */
export type EntityId = number & { readonly __brand: 'EntityId' };

/** Serializovateľný stav alokátora. */
export interface EntityIdAllocatorState {
  /** ID, ktoré vráti nasledujúce `next()` (≥ 1). */
  readonly nextId: number;
}

/** Prvé pridelené ID; 0 ostáva voľné ako „žiadna entita“ v serializovaných dátach. */
const FIRST_ENTITY_ID = 1;

function assertValidNextId(nextId: number): void {
  if (!Number.isSafeInteger(nextId) || nextId < FIRST_ENTITY_ID) {
    throw new RangeError(`EntityIdAllocator: nextId musí byť celé číslo ≥ ${FIRST_ENTITY_ID}, dostal ${String(nextId)}`);
  }
}

export class EntityIdAllocator {
  private nextId: number;

  /** @param state voliteľný uložený stav; bez neho sa prideľuje od 1. */
  constructor(state: EntityIdAllocatorState = { nextId: FIRST_ENTITY_ID }) {
    assertValidNextId(state.nextId);
    this.nextId = state.nextId;
  }

  /** Obnoví alokátor z uloženého stavu (pozri `getState`). */
  static fromState(state: EntityIdAllocatorState): EntityIdAllocator {
    return new EntityIdAllocator(state);
  }

  /** Stav pre save. */
  getState(): EntityIdAllocatorState {
    return { nextId: this.nextId };
  }

  /** Pridelí nové unikátne ID (1, 2, 3, …). */
  next(): EntityId {
    if (this.nextId > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('EntityIdAllocator: vyčerpaný rozsah ID');
    }
    const id = this.nextId;
    this.nextId += 1;
    return id as EntityId;
  }
}
