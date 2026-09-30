/**
 * Chyby modulov (ARCHITECTURE §5, §8). Všetky dedia od `ModuleError` s kódom (`code`), takže volajúci (príkazy,
 * loader save) rozlíši druh chyby bez parsovania správy. Operácie `World.addModule`/`removeModule` a `ApronBuffer`
 * sú fail-fast a atomické: pri chybe sa stav nezmení.
 *
 * Kódy nie sú `ValidationReason` príkazov — `PlaceModule`/`RemoveModule` (T02-04) validujú vopred a hráčovi vracajú
 * dôvody; `ModuleError` znamená chybu programu alebo poškodený save.
 */

export type ModuleErrorCode =
  /** Neplatný vstup (id, cena, rotácia, `spec.defId ≠ def.id`, kapacita…). */
  | 'invalid_input'
  /** Pre `kind` defu nie je v `ModuleRegistry` registrovaná trieda. */
  | 'unknown_kind'
  /** Druh je v `ModuleRegistry` už registrovaný. */
  | 'duplicate_kind'
  /** Modul s týmto id už vo svete je. */
  | 'duplicate_id'
  /** Modul s týmto id vo svete nie je. */
  | 'unknown_module'
  /** Footprint presahuje mapu. */
  | 'out_of_bounds'
  /** Bunku footprintu už zaberá iný modul. */
  | 'occupied'
  /** Na bunke footprintu je cesta alebo koľaj (ADR-006). */
  | 'road'
  /** Žeriav nestojí celý na jednom berthe (ADR-014). */
  | 'no_berth'
  /** Rotácia žeriavu sa líši od rotácie berthu (ADR-014). */
  | 'rotation_mismatch'
  /** Berth už má `maxCranes` žeriavov. */
  | 'max_cranes'
  /** Žeriav by sa prekrýval s iným žeriavom na tom istom berthe. */
  | 'crane_overlap'
  /** Berth, na ktorom stoja žeriavy, nejde odstrániť. */
  | 'has_cranes'
  /** Modul drží náklad (apron, žeriav, sklad…) alebo má rezervované miesto. */
  | 'has_cargo'
  /** Na berthe kotví (alebo je naň pridelená) loď. */
  | 'ship_docked'
  /** Žeriav je uprostred cyklu. */
  | 'busy'
  /** Slot apronu je mimo `0 … capacity − 1`. */
  | 'invalid_slot'
  /** Apron nemá voľný nerezervovaný slot. */
  | 'apron_full'
  /** Slot je už rezervovaný. */
  | 'slot_reserved'
  /** Slot je obsadený jednotkou. */
  | 'slot_occupied'
  /** `commit`/`release` na slote bez rezervácie. */
  | 'slot_not_reserved'
  /** Jednotka už na aprone je. */
  | 'unit_on_apron'
  /** Jednotka na aprone nie je. */
  | 'unit_not_on_apron'
  /** Neplatný serializovaný stav modulu (`restoreRuntimeState`). */
  | 'state'
  /** Prechod stavu žeriavu, ktorý tabuľka `CRANE_TRANSITIONS` nepovoľuje (ADR-016). */
  | 'invalid_transition';

export class ModuleError extends Error {
  readonly code: ModuleErrorCode;

  constructor(code: ModuleErrorCode, message: string) {
    super(message);
    this.name = 'ModuleError';
    this.code = code;
  }
}

/**
 * Neplatný `runtime` stav modulu v save. `path` je JSON pointer relatívny ku koreňu `runtime` — `WorldState` ho
 * predradí prefixom (`/modules/<i>/runtime`) a preloží na `WorldStateError`.
 */
export class ModuleStateError extends ModuleError {
  readonly path: string;
  readonly problem: string;

  constructor(path: string, problem: string) {
    super('state', `ModuleRuntimeState${path}: ${problem}`);
    this.name = 'ModuleStateError';
    this.path = path;
    this.problem = problem;
  }
}
