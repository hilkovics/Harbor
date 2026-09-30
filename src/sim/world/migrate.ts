/**
 * Migrácie `WorldState` (ARCHITECTURE §14, ADR-014): staršia verzia → aktuálna po krokoch `n → n + 1` z tabuľky
 * `WORLD_STATE_MIGRATIONS` (nie switch). Migrácia mení len tvar; hodnoty overí až `parseWorldState` nad výsledkom.
 *
 * v1 → v2: v1 nepoznal moduly, lode, náklad ani `traffic`, preto dostane prázdne `traffic`, `modules`, `cargo`
 * a `ships`. Starter moduly mapy sa do starého save **nedoplnia** (rozhodnutie 8) — hráč si ich postaví sám.
 *
 * v2 → v3 (T03-04, docs/tasks/phase-03.md rozhodnutie 10): v2 nepoznal vozidlá ani joby, preto dostane prázdne
 * `vehicles` a `jobs`; ostatné polia prejdú bez zmeny. Depo v2 nemá vozidlá (jeho zoznam sa odvodí z `vehicles`)
 * a sklad v2 nemá rezervácie od jobov (dispatcher vo v2 neexistoval), takže `modules` sa neupravujú.
 */
import type { CargoLedgerState } from '../cargo/cargo-ledger-state';
import { WorldStateError, checkKeys, describeValue, isPlainObject } from './state-check';

/**
 * Verzia `WorldState` v2 (F2: `traffic`, `modules`, `cargo`, `ships`) — cieľ kroku v1 → v2. Každý krok migrácie má
 * vlastnú pomenovanú cieľovú verziu, aby sa krok nezmenil, keď `WORLD_STATE_VERSION` neskôr porastie (T02-14).
 */
export const WORLD_STATE_V2 = 2;

/** Verzia `WorldState` v3 (F3: `vehicles`, `jobs`) — cieľ kroku v2 → v3. */
export const WORLD_STATE_V3 = 3;

/** Aktuálna verzia `WorldState` — `serialize()` vždy vracia ju. */
export const WORLD_STATE_VERSION = WORLD_STATE_V3;

/** Kľúče `WorldState` v1 v poradí `serialize()` (F1, ADR-013). */
export const WORLD_STATE_V1_KEYS = ['version', 'mapId', 'seed', 'rng', 'clock', 'ids', 'cashCents', 'roads', 'parcels'] as const;

/** Kľúče `WorldState` v2 v poradí `serialize()` (F2, ADR-014): v1 + `traffic`, `modules`, `cargo`, `ships`. */
export const WORLD_STATE_V2_KEYS = [...WORLD_STATE_V1_KEYS, 'traffic', 'modules', 'cargo', 'ships'] as const;

/** Kľúče `WorldState` v3 v poradí `serialize()` (F3, T03-04): v2 + `vehicles`, `jobs`. */
export const WORLD_STATE_V3_KEYS = [...WORLD_STATE_V2_KEYS, 'vehicles', 'jobs'] as const;

type RawState = Record<string, unknown>;
type Migration = (state: RawState) => RawState;

const EMPTY_CARGO: CargoLedgerState = { createdCount: 0, exportedCount: 0, units: [] };

/** v1 (presne kľúče v1) → v2: pôvodné polia bez zmeny + prázdne `traffic`, `modules`, `cargo`, `ships`. */
function migrateV1ToV2(state: RawState): RawState {
  checkKeys(state, WORLD_STATE_V1_KEYS, '');
  const migrated: RawState = {};
  for (const key of WORLD_STATE_V1_KEYS) migrated[key] = state[key];
  migrated['version'] = WORLD_STATE_V2;
  migrated['traffic'] = [];
  migrated['modules'] = [];
  migrated['cargo'] = { ...EMPTY_CARGO, units: [] };
  migrated['ships'] = [];
  return migrated;
}

/** v2 (presne kľúče v2) → v3: pôvodné polia bez zmeny + prázdne `vehicles` a `jobs`. */
function migrateV2ToV3(state: RawState): RawState {
  checkKeys(state, WORLD_STATE_V2_KEYS, '');
  const migrated: RawState = {};
  for (const key of WORLD_STATE_V2_KEYS) migrated[key] = state[key];
  migrated['version'] = WORLD_STATE_V3;
  migrated['vehicles'] = [];
  migrated['jobs'] = [];
  return migrated;
}

/** Verzia `n` → migrácia na `n + 1` (migrácia zapíše cieľovú verziu kroku, napr. `WORLD_STATE_V2`). */
const WORLD_STATE_MIGRATIONS: ReadonlyMap<number, Migration> = new Map([
  [1, migrateV1ToV2],
  [2, migrateV2ToV3],
]);

/** Najstaršia verzia, ktorú vie `migrateWorldState` načítať. */
export const OLDEST_WORLD_STATE_VERSION = 1;

/**
 * Stav ľubovoľnej podporovanej verzie → tvar aktuálnej verzie (`WORLD_STATE_VERSION`). Aktuálnu verziu vráti bez
 * zmeny (tú istú referenciu); staršiu migruje po krokoch do **nového** objektu (vstup nemení). Chyby
 * (`WorldStateError`): nie objekt → `''`, neznáma verzia → `/version`, tvar staršej verzie → cesta v nej.
 */
export function migrateWorldState(raw: unknown): unknown {
  if (!isPlainObject(raw)) throw new WorldStateError('', `musí byť objekt, dostal ${describeValue(raw)}`);
  let state: RawState = raw;
  let version = state['version'];
  while (version !== WORLD_STATE_VERSION) {
    const migration = typeof version === 'number' ? WORLD_STATE_MIGRATIONS.get(version) : undefined;
    if (migration === undefined) {
      throw new WorldStateError(
        '/version',
        `nepodporovaná verzia ${describeValue(version)} (podporované ${String(OLDEST_WORLD_STATE_VERSION)}…${String(WORLD_STATE_VERSION)})`,
      );
    }
    state = migration(state);
    version = state['version'];
  }
  return state;
}
