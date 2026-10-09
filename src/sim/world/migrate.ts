/**
 * Verzia `WorldState` (ARCHITECTURE §14, ADR-014, ADR-036): aktuálna je v12 a **migrácie nie sú**. Hra nie je vydaná
 * a prestavba Terminál 2.0 (fázy R1–R6) mení tvar sveta tak, že staré savy (v1–v9) sa nenačítajú (clean break,
 * ADR-036 bod 2): `World.deserialize` aj `parseWorldState` pri inej verzii vyhodia `UnsupportedSaveVersionError`
 * s pointerom `/version`, ktorú vie aplikácia rozpoznať (hláška „Uložená hra je zo staršej verzie…“).
 *
 * Počas R1–R6 každá fáza zmení tvar v11 bez migrácie a bez zvýšenia verzie; migračný reťazec sa obnoví od vydania (F13).
 * Súbor ostáva domovom verzie, aby sa ten reťazec mal kam vrátiť.
 *
 * Tvar v13 (R4, TR4-02, ADR-041 dodatok) = v12 + kamión s lístkom (`blockId`, `jobId`, `unitId`, `tpCell`, `holdingId`, `stall`, `phase`, `gateInTick`; bez `rampId`, `dock`, `waitingAreaId`, `bay`), joby
 * `in_storage ↔ in_truck`, cyklus stroja s kamiónom (`truck`) a TTT v `hinterland.truckTurn`; moduly `loading_ramp_*` a `truck_waiting_area` zanikli (clean break ADR-036 bod 2).
 * Tvar v12 (R4, ADR-041) = v11 + pruhy brány s plánom prechodu a režimom (`runtime` modulu `gate`), predbránová plocha (`pre_gate`, rady kamiónov) a kamióny so stavmi `to_pre_gate` / `pre_gate` a poliami `gateOutId`,
 * `preGateId`, `row` (clean break ADR-036 bod 2, rovnako ako v11).
 * Tvar v11 = v10 + kľúč `machines` (R3, ADR-040 dodatok) = tvar v9 (F6d) + `machines`: kľúče `WORLD_STATE_KEYS` (world-state.ts) v poradí `serialize()`.
 */
import { WorldStateError, describeValue, isPlainObject } from './state-check';

/** Aktuálna verzia `WorldState` — `serialize()` vždy vracia ju. */
export const WORLD_STATE_VERSION = 13;

/** Najstaršia verzia, ktorú vie `World.deserialize` načítať (bez migrácií rovná aktuálnej, ADR-036). */
export const OLDEST_WORLD_STATE_VERSION = 13;

/**
 * Save s verziou sveta, ktorú táto verzia hry nenačíta (`version` je celé číslo iné než `WORLD_STATE_VERSION`). Väčšinou ide
 * o starý save (v1–v11, ADR-036 bod 2); `version < WORLD_STATE_VERSION` ho odlíši od savu z novšej hry (`isOlder`).
 * Chybná alebo chýbajúca verzia (nie celé číslo) je obyčajná `WorldStateError('/version')`.
 */
export class UnsupportedSaveVersionError extends WorldStateError {
  /** Verzia sveta zo save. */
  readonly version: number;

  constructor(version: number) {
    super('/version', `nepodporovaná verzia ${String(version)} (podporovaná ${String(WORLD_STATE_VERSION)})`);
    this.name = 'UnsupportedSaveVersionError';
    this.version = version;
  }

  /** Save je zo staršej verzie hry (nie z novšej). */
  get isOlder(): boolean {
    return this.version < WORLD_STATE_VERSION;
  }
}

/**
 * Overí, že `raw` je objekt s podporovanou verziou sveta; inak vyhodí chybu (`WorldStateError`: nie objekt → `''`,
 * chýbajúca alebo neceločíselná verzia → `/version`, `UnsupportedSaveVersionError`: iná verzia → `/version`). Tvar a hodnoty
 * overí až `parseWorldState`. Vráti `raw` bez zmeny.
 */
export function assertSupportedWorldVersion(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new WorldStateError('', `musí byť objekt, dostal ${describeValue(raw)}`);
  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new WorldStateError('/version', `verzia musí byť celé číslo, dostal ${describeValue(version)}`);
  }
  if (version !== WORLD_STATE_VERSION) throw new UnsupportedSaveVersionError(version);
  return raw;
}
