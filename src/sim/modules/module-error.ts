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
  /** Depo, ktorému patria vozidlá, nejde odstrániť (T03-02, vozidlá od T03-04). */
  | 'has_vehicles'
  /** Bránu, stojisko alebo rampu používa kamión (T04-04) — nejde odstrániť. */
  | 'has_trucks'
  /** Na berthe kotví (alebo je naň pridelená) loď. */
  | 'ship_docked'
  /** Žeriav je uprostred cyklu. */
  | 'busy'
  /** Slot (apron, sklad), bay stojiska alebo dock rampy je mimo rozsahu `0 … n − 1`. */
  | 'invalid_slot'
  /** Porušenie pravidiel stohu (ADR-039): bunka nie je na vrchu stohu, 40′ mimo páru bays, zlá veľkosť pod kontajnerom, nad `maxTier`. */
  | 'stack_rule'
  /** Brať sa dá len vrchný kontajner stohu (ADR-039). */
  | 'not_top'
  /** Apron, sklad alebo dock rampy nemá miesto, ktoré nie je obsadené ani rezervované (T03-02; pôvodne `apron_full`). */
  | 'no_free_slot'
  /** Slot je už rezervovaný (bay stojiska už drží iný kamión). */
  | 'slot_reserved'
  /** Slot je obsadený jednotkou (bay už obsadil kamión). */
  | 'slot_occupied'
  /** `commit`/`release` na slote (docku, bayi) bez rezervácie. */
  | 'slot_not_reserved'
  /** `commit` po presune: ledger nemá jednotku na tomto slote (docku) držiteľa (presun neprebehol alebo inam). */
  | 'unit_not_at_slot'
  /** `recordTaken`: jednotka podľa ledgera stále leží v module. */
  | 'unit_still_held'
  /** Depo nemá voľné státie (`params.capacity`). */
  | 'depot_full'
  /** Stojisko kamiónov nemá voľný bay (`params.bays`, T04-02). */
  | 'no_free_bay'
  /** Fronta brány kamiónov je prázdna (`TruckGate.dequeue`, T04-02). */
  | 'queue_empty'
  /** Vozidlo k depu nepatrí. */
  | 'unknown_vehicle'
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
