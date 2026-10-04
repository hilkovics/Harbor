/**
 * Migrácie `WorldState` (ARCHITECTURE §14, ADR-014): staršia verzia → aktuálna po krokoch `n → n + 1` z tabuľky
 * `WORLD_STATE_MIGRATIONS` (nie switch). Migrácia mení len tvar; hodnoty overí až `parseWorldState` nad výsledkom.
 *
 * v1 → v2: v1 nepoznal moduly, lode, náklad ani `traffic`, preto dostane prázdne `traffic`, `modules`, `cargo`
 * a `ships`. Starter moduly mapy sa do starého save **nedoplnia** (rozhodnutie 8) — hráč si ich postaví sám.
 *
 * v2 → v3 (T03-04, T03-05, docs/tasks/phase-03.md rozhodnutie 10; ADR-018): v2 nepoznal vozidlá ani joby, preto
 * dostane prázdne `vehicles` a `jobs`. Depo v2 nemá vozidlá (jeho zoznam sa odvodí z `vehicles`). V `modules` sa mení
 * len `runtime` podľa druhu modulu z defov: sklad stratí `reservedSlots` (v3 rezervácie odvodzuje z jobov a v2 žiadne
 * joby nemal — dispatcher neexistoval, takže rezervácia by nemala vlastníka) a kotvisko dostane
 * `lastNoStorageHour: null` (throttle `NoStorageAvailable`). Modul s neznámym defom prejde bez zmeny — odmietne ho
 * `parseWorldState`. Ostatné polia prejdú bez zmeny.
 *
 * v3 → v4 (T04-04, ADR-024): v3 nepoznal kamióny, preto dostane prázdne `trucks`. Rampa (`kind: 'ramp'`, v3 od T04-02
 * s `runtime` `{}`) dostane `lastNoWaitingBayHour: null` (throttle `NoWaitingBay`). Brána ukladala frontu už vo v3 —
 * bez kamiónov je prázdna (neprázdnu odmietne obnova, lebo jej kamióny neexistujú); stojisko ostáva `{}`.
 *
 * v4 → v5 (T05-02, ADR-025; T05-03, ADR-026): v4 nepoznal knihu ani kontrakty, preto dostane prázdnu `economy` (bez
 * záznamov a súhrnov, `daysNegative` 0, `gameOver` false; hotovosť ostáva v `cashCents`), prázdne `contracts`, `xp` 0,
 * `completedContracts` 0 a `nextContractId` 1. Pool doplní krok 2 v prvom ticku po načítaní ako pri štarte hry (kniha
 * ešte nepridelila žiadne id, `ContractBook.untouched`; T06-07) — obnova sama `Rng` nespotrebuje.
 *
 * v5 → v6 (T5B-02, ADR-029): lode ukladajú trasu aktuálneho stavu (`route`), lebo trasy cez prístav vznikajú A* po vode
 * pri rezervácii. v5 trasy neukladal (odvodzoval ich zo stavu), preto každá loď dostane `route: null` — obnova ju
 * odvodí podľa pravidiel pred ADR-029 (`legacyShipRoute`; potrebuje mapu a kotviská, ktoré migrácia nemá). `null`
 * prijme parser len pri save spred v6 (`savesShipRoutes`) a loď bez cieľa najprv presunie pred vstup (`arriving`,
 * ADR-029 addendum, T5B-04b).
 *
 * v6 → v7 (T6A-01, ADR-032; rozhodnutie 14, deterministicky bez `Rng`): každý v6 kontrakt bol vlastnou návštevou lode —
 * dostane `kind: 'import'`, `voyageId` = vlastné id a `booking: null`; `nextVoyageId` = `nextContractId` (žiadna voyage
 * sa s id kontraktu nezrazí). Náklad dostane `shippedCount: 0` a každá jednotka štítky importu (`voyageId` = jej
 * `contractId`, bez kontraktu `null`; `direction: 'import'`, `destinationPort: null`, `weightClass: 'medium'`
 * — `DEFAULT_WEIGHT_CLASS`) a `hold: null`. Lode `lashingTicksLeft: 0` (v6 lashing nepoznal), kamióny `mission: 'pickup'`
 * (v6 vozil len import) a žeriav v `runtime` `cycle: 'unload'`, `targetUnitId: null`, `dualUnitId: null` a nulové počítadlá
 * čakania na vozidlo `waitForVehicleTicks`, `vehicleWaitTicks` (v6 len vykladal na apron, ADR-033). Nové kľúče sa
 * pridajú k pôvodným (nič sa nezahodí — iný tvar odmietne `parseWorldState`); poradie kľúčov zjednotí až `serialize()`.
 *
 * v7 → v8 (T6C-01, ADR-034; deterministicky bez `Rng`): v7 nepoznal linky ani prázdne kontajnery, preto každý kontrakt dostane
 * `lineId` = **prvá linka z `lines.json`** a `tranship: null`; jednotka s kontraktom `lineId` = prvá linka (bez kontraktu —
 * ladiaca loď — `null`), `status: 'available'` a `repairUntilTick: null`; svet dostane prázdny `emptyFlow` (žiadny plánovaný
 * návrat ani výdaj prázdneho). Import jednotky, ktoré odišli pred migráciou, sa teda prázdne nevrátia.
 *
 * v8 → v9 (T6D-03, ADR-029 dodatok): tvar sa nemení, mení sa **význam** `anchorageIndex` a trasy lode — rejda (anchorage)
 * harbor_01 sa presunula do vyhradenej zóny na otvorenom mori a loď bez voľného kotviska k nej pláva priamo zo vstupu
 * (`arriving → waiting_anchorage`), nie po celej sea lane. Migrácia preto len zvýši verziu; lode, ktoré v save držia
 * anchorage (`inbound` / `waiting_anchorage` so starým rozložením rejdy), normalizuje parser (`parseShips`,
 * `ParseWorldStateOptions.legacyAnchorage`): presunie ich pred vstup (`arriving`) a vstup zopakujú podľa nových pravidiel.
 * Náklad ostáva `on_ship` (nič sa neteleportuje), loď pred vstupom nič nezaberá — rovnaký postup ako pri v5 (ADR-029 addendum).
 */
import { DEFAULT_WEIGHT_CLASS } from '../cargo/cargo-unit';
import type { DefRegistry } from '../defs/def-registry';
import { DEFAULT_CRANE_CYCLE } from '../modules/crane-module';
import type { ModuleKind } from '../defs/types';
import { WorldStateError, checkKeys, describeValue, isPlainObject } from './state-check';

/**
 * Verzia `WorldState` v2 (F2: `traffic`, `modules`, `cargo`, `ships`) — cieľ kroku v1 → v2. Každý krok migrácie má
 * vlastnú pomenovanú cieľovú verziu, aby sa krok nezmenil, keď `WORLD_STATE_VERSION` neskôr porastie (T02-14).
 */
export const WORLD_STATE_V2 = 2;

/** Verzia `WorldState` v3 (F3: `vehicles`, `jobs`) — cieľ kroku v2 → v3. */
export const WORLD_STATE_V3 = 3;

/** Verzia `WorldState` v4 (F4: `trucks`, runtime rampy s `lastNoWaitingBayHour`) — cieľ kroku v3 → v4. */
export const WORLD_STATE_V4 = 4;

/** Verzia `WorldState` v5 (F5: `economy` — kniha, súhrny, bankrot, ADR-025; kontrakty, XP, ADR-026) — cieľ kroku v4 → v5. */
export const WORLD_STATE_V5 = 5;

/** Verzia `WorldState` v6 (F5b: trasa lode `ships[i].route`, ADR-029) — cieľ kroku v5 → v6. */
export const WORLD_STATE_V6 = 6;

/**
 * Verzia `WorldState` v7 (F6a: export a booking — voyage, druh kontraktu a booking, štítky a `hold` jednotiek,
 * `shippedCount`, lashing lode, misia kamióna, smer cyklu žeriavu; ADR-032) — cieľ kroku v6 → v7.
 */
export const WORLD_STATE_V7 = 7;

/**
 * Verzia `WorldState` v8 (F6c: linka kontraktu a jednotky, stav kvality prázdneho, plán prekládky kontraktu a plán toku
 * prázdnych kontajnerov `emptyFlow`; ADR-034) — cieľ kroku v7 → v8.
 */
export const WORLD_STATE_V8 = 8;

/**
 * Verzia `WorldState` v9 (F6d: rejda — vyhradená zóna anchorage a priamy vstup lode bez voľného kotviska, jednotný kurz
 * lodí na kotve; ADR-029 dodatok T6D-03). Tvar ako v8 — cieľ kroku v8 → v9 mení význam `anchorageIndex` a trás lodí.
 */
export const WORLD_STATE_V9 = 9;

/** Aktuálna verzia `WorldState` — `serialize()` vždy vracia ju. */
export const WORLD_STATE_VERSION = WORLD_STATE_V9;

/** Kľúče `WorldState` v1 v poradí `serialize()` (F1, ADR-013). */
export const WORLD_STATE_V1_KEYS = ['version', 'mapId', 'seed', 'rng', 'clock', 'ids', 'cashCents', 'roads', 'parcels'] as const;

/** Kľúče `WorldState` v2 v poradí `serialize()` (F2, ADR-014): v1 + `traffic`, `modules`, `cargo`, `ships`. */
export const WORLD_STATE_V2_KEYS = [...WORLD_STATE_V1_KEYS, 'traffic', 'modules', 'cargo', 'ships'] as const;

/** Kľúče `WorldState` v3 v poradí `serialize()` (F3, T03-04): v2 + `vehicles`, `jobs`. */
export const WORLD_STATE_V3_KEYS = [...WORLD_STATE_V2_KEYS, 'vehicles', 'jobs'] as const;

/** Kľúče `WorldState` v4 v poradí `serialize()` (F4, T04-04): v3 + `trucks`. */
export const WORLD_STATE_V4_KEYS = [...WORLD_STATE_V3_KEYS, 'trucks'] as const;

/**
 * Kľúče `WorldState` v5 v poradí `serialize()` (F5): v4 + `economy` (T05-02, ADR-025) + `contracts`, `xp`,
 * `completedContracts`, `nextContractId` (T05-03, ADR-026).
 */
export const WORLD_STATE_V5_KEYS = [...WORLD_STATE_V4_KEYS, 'economy', 'contracts', 'xp', 'completedContracts', 'nextContractId'] as const;

/** Kľúče `WorldState` v6 (F5b, ADR-029) — ako v5; zmenil sa len tvar lode (`ships[i].route`). */
export const WORLD_STATE_V6_KEYS = WORLD_STATE_V5_KEYS;

/** Kľúče `WorldState` v7 v poradí `serialize()` (F6a, ADR-032): v6 + `nextVoyageId`. */
export const WORLD_STATE_V7_KEYS = [...WORLD_STATE_V6_KEYS, 'nextVoyageId'] as const;

/** Kľúče `WorldState` v8 v poradí `serialize()` (F6c, ADR-034): v7 + `emptyFlow`. */
export const WORLD_STATE_V8_KEYS = [...WORLD_STATE_V7_KEYS, 'emptyFlow'] as const;

/** Presné kľúče `WorldState` v9 — rovnaké ako v8 (T6D-03 mení len význam `anchorageIndex` a trás lodí). */
export const WORLD_STATE_V9_KEYS = WORLD_STATE_V8_KEYS;

type RawState = Record<string, unknown>;
type Migration = (state: RawState, defs: DefRegistry) => RawState;

/** Prázdny náklad v tvare v2 … v6 (`shippedCount` pribudol až vo v7). */
const EMPTY_CARGO = { createdCount: 0, exportedCount: 0, units: [] } as const;

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

/** Úprava `runtime` modulu v2 → v3 podľa druhu (tabuľka, nie switch); druhy mimo tabuľky ostanú bez zmeny. */
const RUNTIME_V2_TO_V3: Partial<Record<ModuleKind, (runtime: RawState) => RawState>> = {
  storage: (runtime) => {
    const next: RawState = { ...runtime };
    delete next['reservedSlots'];
    return next;
  },
  berth: (runtime) => ({ ...runtime, lastNoStorageHour: null }),
};

/** Úprava `runtime` modulu v3 → v4 podľa druhu (tabuľka); druhy mimo tabuľky ostanú bez zmeny. */
const RUNTIME_V3_TO_V4: Partial<Record<ModuleKind, (runtime: RawState) => RawState>> = {
  ramp: (runtime) => ({ ...runtime, lastNoWaitingBayHour: null }),
};

/**
 * Moduly: nové objekty s `runtime` upraveným podľa tabuľky druhov (vstup sa nemení); iný tvar nechá na
 * `parseWorldState`, modul s neznámym defom prejde bez zmeny.
 */
function migrateModuleRuntimes(modules: unknown, defs: DefRegistry, upgrades: Partial<Record<ModuleKind, (runtime: RawState) => RawState>>): unknown {
  if (!Array.isArray(modules)) return modules;
  return modules.map((entry: unknown) => {
    if (!isPlainObject(entry) || !isPlainObject(entry['runtime'])) return entry;
    const defId = entry['defId'];
    const kind = typeof defId === 'string' && defs.modules.has(defId) ? defs.modules.get(defId).kind : undefined;
    const upgrade = kind === undefined ? undefined : upgrades[kind];
    return upgrade === undefined ? entry : { ...entry, runtime: upgrade(entry['runtime']) };
  });
}

/** v2 (presne kľúče v2) → v3: pôvodné polia + `runtime` modulov podľa druhu + prázdne `vehicles` a `jobs`. */
function migrateV2ToV3(state: RawState, defs: DefRegistry): RawState {
  checkKeys(state, WORLD_STATE_V2_KEYS, '');
  const migrated: RawState = {};
  for (const key of WORLD_STATE_V2_KEYS) migrated[key] = state[key];
  migrated['version'] = WORLD_STATE_V3;
  migrated['modules'] = migrateModuleRuntimes(state['modules'], defs, RUNTIME_V2_TO_V3);
  migrated['vehicles'] = [];
  migrated['jobs'] = [];
  return migrated;
}

/** v3 (presne kľúče v3) → v4: pôvodné polia + `runtime` rampy s `lastNoWaitingBayHour` + prázdne `trucks`. */
function migrateV3ToV4(state: RawState, defs: DefRegistry): RawState {
  checkKeys(state, WORLD_STATE_V3_KEYS, '');
  const migrated: RawState = {};
  for (const key of WORLD_STATE_V3_KEYS) migrated[key] = state[key];
  migrated['version'] = WORLD_STATE_V4;
  migrated['modules'] = migrateModuleRuntimes(state['modules'], defs, RUNTIME_V3_TO_V4);
  migrated['trucks'] = [];
  return migrated;
}

/**
 * Prázdna ekonomika pre save bez knihy (v4 → v5): hotovosť ostáva v `cashCents`, kniha, súhrny a bankrotové počítadlo
 * začínajú od nuly (dni so zápornou hotovosťou pred načítaním sa nezapočítajú).
 */
function emptyEconomyState(): RawState {
  return { entries: [], today: { incomeCents: {}, expenseCents: {} }, daily: [], monthly: [], daysNegative: 0, gameOver: false };
}

/**
 * v4 (presne kľúče v4) → v5: pôvodné polia + prázdna `economy` + prázdna kniha kontraktov (žiadne ponuky ani
 * kontrakty, XP 0, 0 dokončených — pool doplní najbližší `DayClosed`, ADR-026).
 */
function migrateV4ToV5(state: RawState): RawState {
  checkKeys(state, WORLD_STATE_V4_KEYS, '');
  const migrated: RawState = {};
  for (const key of WORLD_STATE_V4_KEYS) migrated[key] = state[key];
  migrated['version'] = WORLD_STATE_V5;
  migrated['economy'] = emptyEconomyState();
  migrated['contracts'] = [];
  migrated['xp'] = 0;
  migrated['completedContracts'] = 0;
  migrated['nextContractId'] = 1;
  return migrated;
}

/**
 * v5 (presne kľúče v5) → v6: pôvodné polia, každá loď (objekt) dostane `route: null` — trasu odvodí obnova podľa
 * pravidiel pred ADR-029. Iný tvar lodí nechá bez zmeny (odmietne ho `parseWorldState`).
 */
function migrateV5ToV6(state: RawState): RawState {
  checkKeys(state, WORLD_STATE_V5_KEYS, '');
  const migrated: RawState = {};
  for (const key of WORLD_STATE_V5_KEYS) migrated[key] = state[key];
  migrated['version'] = WORLD_STATE_V6;
  const ships = state['ships'];
  migrated['ships'] = Array.isArray(ships) ? ships.map((ship: unknown) => (isPlainObject(ship) ? { ...ship, route: null } : ship)) : ships;
  return migrated;
}

/** Úprava `runtime` modulu v6 → v7 podľa druhu (tabuľka): žeriav v6 poznal len vykládku. */
const RUNTIME_V6_TO_V7: Partial<Record<ModuleKind, (runtime: RawState) => RawState>> = {
  crane: (runtime) => ({ ...runtime, cycle: DEFAULT_CRANE_CYCLE, targetUnitId: null, dualUnitId: null, waitForVehicleTicks: 0, vehicleWaitTicks: 0 }),
};

/** Každý objekt poľa `value` doplnený funkciou `extend`; iný tvar nechá bez zmeny (odmietne ho `parseWorldState`). */
function extendEach(value: unknown, extend: (entry: RawState) => RawState): unknown {
  return Array.isArray(value) ? value.map((entry: unknown) => (isPlainObject(entry) ? extend(entry) : entry)) : value;
}

/** Štítky importu pre jednotku v6 (`voyageId` = `contractId` — v6 kontrakt = vlastná voyage). */
function importUnitV7(unit: RawState): RawState {
  const contractId = unit['contractId'];
  return { ...unit, voyageId: contractId ?? null, direction: 'import', destinationPort: null, weightClass: DEFAULT_WEIGHT_CLASS, hold: null };
}

/**
 * v6 (presne kľúče v6) → v7: pôvodné polia + `nextVoyageId`; kontrakty, náklad, lode, kamióny a žeriavy doplnené podľa
 * hlavičky súboru (rozhodnutie 14, bez `Rng`).
 */
function migrateV6ToV7(state: RawState, defs: DefRegistry): RawState {
  checkKeys(state, WORLD_STATE_V6_KEYS, '');
  const migrated: RawState = {};
  for (const key of WORLD_STATE_V6_KEYS) migrated[key] = state[key];
  migrated['version'] = WORLD_STATE_V7;
  migrated['contracts'] = extendEach(state['contracts'], (contract) => ({ ...contract, kind: 'import', voyageId: contract['id'], booking: null }));
  migrated['nextVoyageId'] = state['nextContractId'];
  const cargo = state['cargo'];
  migrated['cargo'] = isPlainObject(cargo) ? { ...cargo, shippedCount: 0, units: extendEach(cargo['units'], importUnitV7) } : cargo;
  migrated['ships'] = extendEach(state['ships'], (ship) => ({ ...ship, lashingTicksLeft: 0 }));
  migrated['trucks'] = extendEach(state['trucks'], (truck) => ({ ...truck, mission: 'pickup' }));
  migrated['modules'] = migrateModuleRuntimes(state['modules'], defs, RUNTIME_V6_TO_V7);
  return migrated;
}

/**
 * v7 (presne kľúče v7) → v8: pôvodné polia + `emptyFlow`; kontrakty a jednotky doplnené podľa hlavičky súboru (prvá linka
 * z `lines.json`, bez `Rng`).
 */
function migrateV7ToV8(state: RawState, defs: DefRegistry): RawState {
  checkKeys(state, WORLD_STATE_V7_KEYS, '');
  const lineId = defs.lines.items[0].id;
  const migrated: RawState = {};
  for (const key of WORLD_STATE_V7_KEYS) migrated[key] = state[key];
  migrated['version'] = WORLD_STATE_V8;
  migrated['contracts'] = extendEach(state['contracts'], (contract) => ({ ...contract, lineId, tranship: null }));
  const cargo = state['cargo'];
  migrated['cargo'] = isPlainObject(cargo)
    ? { ...cargo, units: extendEach(cargo['units'], (unit) => ({ ...unit, lineId: unit['contractId'] === null ? null : lineId, status: 'available', repairUntilTick: null })) }
    : cargo;
  migrated['emptyFlow'] = { returnPlan: [], pickupPlan: [], errands: [] };
  return migrated;
}

/** v8 (presne kľúče v8) → v9: len nová verzia, tvar sa nemení (viď hlavička súboru; lode s rejdou normalizuje parser). */
function migrateV8ToV9(state: RawState): RawState {
  checkKeys(state, WORLD_STATE_V8_KEYS, '');
  const migrated: RawState = {};
  for (const key of WORLD_STATE_V8_KEYS) migrated[key] = state[key];
  migrated['version'] = WORLD_STATE_V9;
  return migrated;
}

/** Verzia `n` → migrácia na `n + 1` (migrácia zapíše cieľovú verziu kroku, napr. `WORLD_STATE_V2`). */
const WORLD_STATE_MIGRATIONS: ReadonlyMap<number, Migration> = new Map([
  [1, migrateV1ToV2],
  [2, migrateV2ToV3],
  [3, migrateV3ToV4],
  [4, migrateV4ToV5],
  [5, migrateV5ToV6],
  [6, migrateV6ToV7],
  [7, migrateV7ToV8],
  [8, migrateV8ToV9],
]);

/**
 * Ukladal save trasy lodí (verzia ≥ v6)? Save spred v6 (aj neplatný vstup — ten odmietne migrácia) trasy neukladal:
 * migrácia im dá `route: null` a parser ich prijme len s voľbou `legacyShipRoutes` (ADR-029 addendum, review T5B-04b).
 */
export function savesShipRoutes(raw: unknown): boolean {
  if (!isPlainObject(raw)) return true;
  const version = raw['version'];
  return typeof version !== 'number' || version >= WORLD_STATE_V6;
}

/**
 * Zapisoval save lode na rejdu podľa pravidiel od v9 (priamy vstup na rejdu, jednotný kurz; T6D-03)? Save spred v9 (aj
 * neplatný vstup — ten odmietne migrácia) držal anchorage podľa starého rozloženia rejdy: parser lode s anchorage
 * normalizuje na `arriving` (`ParseWorldStateOptions.legacyAnchorage`, `parseShips`).
 */
export function savesDirectAnchorage(raw: unknown): boolean {
  if (!isPlainObject(raw)) return true;
  const version = raw['version'];
  return typeof version !== 'number' || version >= WORLD_STATE_V9;
}

/** Najstaršia verzia, ktorú vie `migrateWorldState` načítať. */
export const OLDEST_WORLD_STATE_VERSION = 1;

/**
 * Stav ľubovoľnej podporovanej verzie → tvar aktuálnej verzie (`WORLD_STATE_VERSION`). Aktuálnu verziu vráti bez
 * zmeny (tú istú referenciu); staršiu migruje po krokoch do **nového** objektu (vstup nemení). `defs` určia druh
 * modulu podľa `defId` (kroky v2 → v3, v3 → v4 a v6 → v7); `defs.lines` určia prvú linku (krok v7 → v8). Chyby (`WorldStateError`): nie objekt → `''`, neznáma verzia → `/version`,
 * tvar staršej verzie → cesta v nej.
 */
export function migrateWorldState(raw: unknown, defs: DefRegistry): unknown {
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
    state = migration(state, defs);
    version = state['version'];
  }
  return state;
}
