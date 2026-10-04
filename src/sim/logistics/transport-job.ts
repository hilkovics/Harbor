/**
 * TransportJob (ARCHITECTURE §7.3; docs/tasks/phase-03.md rozhodnutie 6 a „Spoločné rozhrania"; ADR-018, ADR-023) —
 * úloha previezť jednotky nákladu z jedného držiteľa k druhému vozidlom. Povolené dvojice lokácií sú tabuľka
 * `JOB_ROUTES`: inbound `on_apron → in_storage` (F3), outbound `in_storage → at_ramp` (F4, T04-03) a prijatie exportu
 * `at_ramp → in_storage` (F6a, ADR-032).
 *
 * - Job vzniká v dispatcheri (krok 5) s rezervovaným miestom v cieli (`to` = `in_storage(moduleId, slot)` alebo
 *   `at_ramp(rampId, dock)`) a jednotkami na zdroji (`from` = ich poloha pri vzniku). Rezervácia trvá, kým vozidlo
 *   jednotku neuloží (celý život jobu).
 * - Stavy a prechody sú tabuľky `JOB_TRANSITIONS` a `JOB_STATE_TRAITS` (žiadne skryté prechody): `open → assigned`
 *   (dispatcher priradí vozidlo, `assign`) `→ picking` (vozidlo nakladá) `→ moving` (vezie) `→ dropping` (vykladá)
 *   `→ done`; `open → cancelled` (dispatcher zruší job bez vozidla, keď cieľ prestal byť použiteľný — rampa stratila
 *   prevádzkovosť, ADR-023). Stav jobu zrkadlí FSM vozidla (ADR-019); ukončený job (`done`, `cancelled`) `World` hneď
 *   odstráni (`removeJob`), takže save nerastie s každým prevozom.
 * - Priorita priradenia vozidla je v `JOB_ROUTES` (`priority`, menšie = skôr): inbound pred outbound — uvoľnenie apronu
 *   chráni žeriav pred blokovaním (rozhodnutie orchestrátora F4 č. 4).
 * - `fromModuleId` / `toModuleId` = držitelia `from` / `to` (moduly: berth, sklad, rampa).
 *
 * Save (`SerializedJob`) nesie len to, čo sa nedá odvodiť: id, jednotky, `from`, `to`, `createdTick`. Vozidlo jobu
 * (`vehicleId`) a stav obnova odvodí z vozidla, ktoré má job v `jobId`, a z polohy nákladu v ledgeri (ADR-018).
 */
import { holderIdOf, normalizeLocation, uniqueSlotOf, type CargoLocation, type CargoLocationKind } from '../cargo/cargo-location';
import type { EntityId } from '../core/entity-id';
import { JobError } from './job-error';

/** Stavy jobu v poradí životného cyklu. */
export const JOB_STATES = ['open', 'assigned', 'picking', 'moving', 'dropping', 'done', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

/**
 * Povolené prechody `from → [to…]`; `done` a `cancelled` sú konečné stavy (job sa odstráni). Zrušiť sa dá len job bez
 * vozidla (`open`) — vozidlo, ktoré job už má, ho dokončí (ADR-023).
 */
export const JOB_TRANSITIONS: ReadonlyMap<JobState, readonly JobState[]> = new Map<JobState, readonly JobState[]>([
  ['open', Object.freeze(['assigned', 'cancelled'] as const)],
  ['assigned', Object.freeze(['picking'] as const)],
  ['picking', Object.freeze(['moving'] as const)],
  ['moving', Object.freeze(['dropping'] as const)],
  ['dropping', Object.freeze(['done'] as const)],
  ['done', Object.freeze([] as const)],
  ['cancelled', Object.freeze([] as const)],
]);

/**
 * Prečo dispatcher zrušil job bez vozidla (`JobCancelled`, ADR-023): cieľová rampa nie je prevádzková (ADR-022), alebo
 * k nej zo zdroja nevedie cesta. Oboje sú podmienky vzniku outbound jobu — `open` job, ktorý by už nevznikol, sa zruší.
 */
export const JOB_CANCEL_REASONS = ['ramp_inoperative', 'ramp_unreachable'] as const;
export type JobCancelReason = (typeof JOB_CANCEL_REASONS)[number];

/** Kde leží náklad jobu v danom stave (invarianty kroku 12, obnova save). */
export type JobCargoPlace = 'source' | 'vehicle' | 'target';

/** Čo platí pre job v danom stave. */
export interface JobStateTraits {
  /** Job má vozidlo (`vehicleId !== null`). */
  readonly hasVehicle: boolean;
  /** Poloha jednotiek: na `from`, vo vozidle jobu, alebo už na `to`. */
  readonly cargoAt: JobCargoPlace;
  /** Aktívny job drží rezerváciu miesta `to` a jeho jednotky nesmú mať iný aktívny job; neaktívny sa hneď odstráni. */
  readonly active: boolean;
}

export const JOB_STATE_TRAITS: { readonly [S in JobState]: JobStateTraits } = Object.freeze({
  open: Object.freeze({ hasVehicle: false, cargoAt: 'source', active: true }),
  assigned: Object.freeze({ hasVehicle: true, cargoAt: 'source', active: true }),
  picking: Object.freeze({ hasVehicle: true, cargoAt: 'source', active: true }),
  moving: Object.freeze({ hasVehicle: true, cargoAt: 'vehicle', active: true }),
  dropping: Object.freeze({ hasVehicle: true, cargoAt: 'vehicle', active: true }),
  done: Object.freeze({ hasVehicle: true, cargoAt: 'target', active: false }),
  cancelled: Object.freeze({ hasVehicle: false, cargoAt: 'source', active: false }),
});

/** Dvojica druhov lokácií (zdroj → cieľ), pre ktorú smie job vzniknúť, s prioritou priradenia vozidla. */
export interface JobRoute {
  readonly from: CargoLocationKind;
  readonly to: CargoLocationKind;
  /**
   * Poradie priradenia vozidla (menšie = skôr, `0 … JOB_PRIORITY_LEVELS − 1`): dispatcher prejde najprv všetky `open`
   * joby priority 0 v poradí vzniku, potom priority 1 atď. (§7.3 bod 3, ADR-023). Štrukturálne poradie, nie balans.
   */
  readonly priority: number;
}

/**
 * Povolené joby: inbound apron → sklad (F3) s prednosťou pred outbound sklad → rampa (F4, T04-03) — uvoľnenie apronu
 * chráni žeriav pred blokovaním (rozhodnutie orchestrátora F4 č. 4). F6a (ADR-032, ADR-033) pridáva prijatie exportu
 * rampa → sklad, nakládku sklad → apron a odovzdávanie pod hákom (`in_crane ↔ sklad`, koncový bod je hák žeriava).
 */
export const JOB_ROUTES: readonly JobRoute[] = Object.freeze([
  Object.freeze({ from: 'on_apron', to: 'in_storage', priority: 0 } as const),
  Object.freeze({ from: 'in_storage', to: 'at_ramp', priority: 1 } as const),
  // Prijatie exportu (F6a, ADR-032 bod 8): jednotku vyloženú kamiónom na docku odvezie vozidlo do skladu; uvoľňuje dock.
  Object.freeze({ from: 'at_ramp', to: 'in_storage', priority: 1 } as const),
  // Nakládka exportu na apron (F6a, ADR-032 bod 9): vozidlo vezie jednotku zo skladu na rezervovaný slot apronu. Priorita 1 ako
  // outbound: vykládka lode (inbound a hák, priorita 0) má prednosť, takže import nikdy nečaká za frontou nakládky.
  Object.freeze({ from: 'in_storage', to: 'on_apron', priority: 1 } as const),
  // Odovzdávanie pod hákom (F6a, ADR-033): vykládka — vozidlo vezme jednotku priamo od žeriava; nakládka — vozidlo s jednotkou čaká
  // pod hákom, kým ju žeriav zdvihne. Obe priorita 0: kým loď vykladá, dispatcher drží najviac jeden job nakládky na žeriav
  // (`logistics/export-load.ts`), takže export a import sa v obehu párujú (dual cycle) a nakládka nevyčerpá vozidlá.
  Object.freeze({ from: 'in_crane', to: 'in_storage', priority: 0 } as const),
  Object.freeze({ from: 'in_storage', to: 'in_crane', priority: 0 } as const),
]);

/** Počet úrovní priority (`max(priority) + 1`) — koľko prechodov jobmi robí priradenie vozidiel. */
export const JOB_PRIORITY_LEVELS: number = JOB_ROUTES.reduce((levels, route) => Math.max(levels, route.priority + 1), 0);

/** Je prechod `from → to` v tabuľke? */
export function isJobTransitionAllowed(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS.get(from)?.includes(to) ?? false;
}

/** Je hodnota jeden zo stavov jobu? */
export function isJobState(value: unknown): value is JobState {
  return (JOB_STATES as readonly unknown[]).includes(value);
}

/** Riadok `JOB_ROUTES` pre dvojicu druhov lokácií; mimo tabuľky `undefined`. */
export function jobRouteOf(from: CargoLocationKind, to: CargoLocationKind): JobRoute | undefined {
  return JOB_ROUTES.find((route) => route.from === from && route.to === to);
}

/** Smie job viesť z lokácie druhu `from` do druhu `to` (`JOB_ROUTES`)? */
export function isJobRoute(from: CargoLocationKind, to: CargoLocationKind): boolean {
  return jobRouteOf(from, to) !== undefined;
}

/** Job v save (`WorldState.jobs[i]`, ADR-018) — čistý JSON; poradie v save = vzostupne podľa id (poradie vzniku). */
export interface SerializedJob {
  readonly id: number;
  readonly unitIds: readonly number[];
  readonly from: CargoLocation;
  readonly to: CargoLocation;
  readonly createdTick: number;
}

/** Kľúče `SerializedJob` v poradí `toState()`. */
export const SERIALIZED_JOB_KEYS: readonly (keyof SerializedJob)[] = ['id', 'unitIds', 'from', 'to', 'createdTick'];

/** Vstup konštruktora jobu (dispatcher aj obnova zo save). */
export interface TransportJobInit {
  readonly id: EntityId;
  readonly unitIds: readonly EntityId[];
  readonly from: CargoLocation;
  readonly to: CargoLocation;
  readonly createdTick: number;
  /**
   * Modul zdroja, ku ktorému vozidlo jazdí (ADR-033). Predvolene držiteľ `from`; pre koncový bod `in_crane` (hák žeriava)
   * je povinný — žeriav nemá prístupovú bunku, vozidlo ide ku kotvisku žeriava.
   */
  readonly fromModuleId?: EntityId;
  /** Modul cieľa (viď `fromModuleId`); predvolene držiteľ `to`, pre `in_crane` povinný. */
  readonly toModuleId?: EntityId;
  /** Predvolene `open`. */
  readonly state?: JobState;
  /** Predvolene `null`; musí zodpovedať stavu (`JOB_STATE_TRAITS.hasVehicle`). */
  readonly vehicleId?: EntityId | null;
}

function isPositiveId(value: unknown): value is EntityId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Lokácia s držiteľom (modul) v kanonickom tvare; inak `JobError('invalid_input')`. */
function checkLocation(raw: CargoLocation, label: string, field: string): CargoLocation {
  const normalized = normalizeLocation(raw);
  if (!normalized.ok) throw new JobError('invalid_input', `${label}: ${field}${normalized.path}: ${normalized.problem}`);
  if (holderIdOf(normalized.location) === null) throw new JobError('invalid_input', `${label}: ${field} '${normalized.location.kind}' nemá držiteľa`);
  return normalized.location;
}

/** Modul koncového bodu: explicitný (`in_crane` ho vyžaduje — kotvisko žeriava), inak držiteľ lokácie. */
function endpointModule(label: string, field: string, location: CargoLocation, explicit: EntityId | undefined): EntityId {
  const holder = holderIdOf(location) as EntityId;
  if (explicit === undefined) {
    if (location.kind === 'in_crane') throw new JobError('invalid_input', `${label}: ${field} 'in_crane' (hák žeriava) vyžaduje modul ${field}ModuleId (kotvisko žeriava)`);
    return holder;
  }
  if (!isPositiveId(explicit)) throw new JobError('invalid_input', `${label}: ${field}ModuleId musí byť celé číslo ≥ 1, dostal ${String(explicit)}`);
  if (location.kind !== 'in_crane' && explicit !== holder) {
    throw new JobError('invalid_input', `${label}: ${field}ModuleId ${String(explicit)} sa líši od držiteľa ${location.kind} #${String(holder)}`);
  }
  return explicit;
}

export class TransportJob {
  readonly id: EntityId;
  /** Jednotky jobu (zmrazené); dispatcher vytvára joby s práve jednou jednotkou (inbound: cieľ je jedinečný slot). */
  readonly unitIds: readonly EntityId[];
  /** Cieľ s rezervovaným miestom (slot skladu, dock rampy, slot apronu); pri `in_crane` hák žeriava bez rezervácie. */
  readonly to: CargoLocation;
  /**
   * Modul zdroja, ku ktorému vozidlo jazdí (sklad, berth, rampa; pri háku žeriava jeho kotvisko — ADR-033). Pri
   * `in_crane` sa líši od držiteľa `from` (žeriav).
   */
  readonly fromModuleId: EntityId;
  /** Modul cieľa (sklad, rampa, berth; pri háku žeriava jeho kotvisko). */
  readonly toModuleId: EntityId;
  /** Priorita priradenia vozidla z `JOB_ROUTES` (menšie = skôr). */
  readonly priority: number;
  /** Tick vzniku (`clock.tick` v kroku 5). */
  readonly createdTick: number;
  private current: JobState;
  private vehicle: EntityId | null;
  private source: CargoLocation;

  /**
   * Chyby (`JobError('invalid_input')`): id nie je celé ≥ 1, jednotky nie sú neprázdny zoznam jedinečných id, `from`/`to`
   * nie sú lokácie s držiteľom, dvojica ich druhov nie je v `JOB_ROUTES`, cieľ s jedinečným slotom a viac jednotiek,
   * `createdTick` nie je celé ≥ 0, neznámy stav, `vehicleId` nezodpovedá stavu. Vzťahy k svetu overuje `World`.
   */
  constructor(init: TransportJobInit) {
    const label = `job #${String(init.id)}`;
    if (!isPositiveId(init.id)) throw new JobError('invalid_input', `${label}: id musí byť celé číslo ≥ 1`);
    const { unitIds } = init;
    if (!Array.isArray(unitIds) || unitIds.length === 0) throw new JobError('invalid_input', `${label}: unitIds musí byť neprázdne pole`);
    const seen = new Set<number>();
    for (const unitId of unitIds) {
      if (!isPositiveId(unitId)) throw new JobError('invalid_input', `${label}: id jednotky musí byť celé číslo ≥ 1, dostal ${String(unitId)}`);
      if (seen.has(unitId)) throw new JobError('invalid_input', `${label}: jednotka #${String(unitId)} je v jobe dvakrát`);
      seen.add(unitId);
    }
    const from = checkLocation(init.from, label, 'from');
    const to = checkLocation(init.to, label, 'to');
    const route = jobRouteOf(from.kind, to.kind);
    if (route === undefined) {
      throw new JobError('invalid_input', `${label}: job ${from.kind} → ${to.kind} nie je povolený (JOB_ROUTES)`);
    }
    if (uniqueSlotOf(to) !== null && unitIds.length !== 1) {
      throw new JobError('invalid_input', `${label}: cieľ ${to.kind} je jeden jedinečný slot, job má ${String(unitIds.length)} jednotiek`);
    }
    if (!Number.isSafeInteger(init.createdTick) || init.createdTick < 0) {
      throw new JobError('invalid_input', `${label}: createdTick musí byť celé číslo ≥ 0, dostal ${String(init.createdTick)}`);
    }
    const state = init.state ?? 'open';
    if (!isJobState(state)) throw new JobError('invalid_input', `${label}: neznámy stav '${String(state)}'`);
    const vehicleId = init.vehicleId ?? null;
    if (vehicleId !== null && !isPositiveId(vehicleId)) throw new JobError('invalid_input', `${label}: vehicleId musí byť null alebo celé číslo ≥ 1`);
    if (JOB_STATE_TRAITS[state].hasVehicle !== (vehicleId !== null)) {
      throw new JobError('invalid_input', `${label}: stav '${state}' ${JOB_STATE_TRAITS[state].hasVehicle ? 'vyžaduje vozidlo' : 'nesmie mať vozidlo'}`);
    }
    const fromModuleId = endpointModule(label, 'from', from, init.fromModuleId);
    const toModuleId = endpointModule(label, 'to', to, init.toModuleId);
    this.id = init.id;
    this.unitIds = Object.freeze([...unitIds]);
    this.source = from;
    this.to = to;
    this.fromModuleId = fromModuleId;
    this.toModuleId = toModuleId;
    this.priority = route.priority;
    this.createdTick = init.createdTick;
    this.current = state;
    this.vehicle = vehicleId;
  }

  /** Poloha jednotiek pri vzniku jobu (zdroj); mení ju len `rebindSource` (žeriav pod hákom odloží jednotku na buffer). */
  get from(): CargoLocation {
    return this.source;
  }

  /**
   * Presmeruje zdroj jobu z háku žeriava (`in_crane`) na slot apronu toho istého kotviska — žeriav odložil jednotku na buffer,
   * lebo pod hákom nečakalo vozidlo (ADR-033). Povolené len pre job `open` / `assigned` so zdrojom `in_crane` a cieľ
   * `on_apron` toho istého modulu (`fromModuleId`); inak `JobError`, job sa nezmení.
   */
  rebindSource(from: CargoLocation): void {
    const target = checkLocation(from, this.label, 'from');
    if (this.source.kind !== 'in_crane' || (this.current !== 'open' && this.current !== 'assigned')) {
      throw new JobError('invalid_transition', `${this.label}: zdroj sa presmeruje len pri jobe open/assigned zo háku žeriava (zdroj ${this.source.kind}, stav ${this.current})`);
    }
    if (target.kind !== 'on_apron' || holderIdOf(target) !== this.fromModuleId || !isJobRoute(target.kind, this.to.kind)) {
      throw new JobError('invalid_input', `${this.label}: nový zdroj ${target.kind} nie je apron kotviska #${String(this.fromModuleId)} s povolenou trasou do ${this.to.kind}`);
    }
    this.source = target;
  }

  /** Aktuálny stav (mení ho len `assign` / `transition`). */
  get state(): JobState {
    return this.current;
  }

  /** Priradené vozidlo; `null` v stave `open`. */
  get vehicleId(): EntityId | null {
    return this.vehicle;
  }

  /** Popis do chybových správ: `job #12`. */
  get label(): string {
    return `job #${String(this.id)}`;
  }

  /** Priradí vozidlo (`open → assigned`, dispatcher). Iný stav alebo neplatné id → `JobError`, job sa nezmení. */
  assign(vehicleId: EntityId): void {
    if (this.current !== 'open') throw new JobError('invalid_transition', `${this.label}: vozidlo sa priraďuje len jobu v stave open (je ${this.current})`);
    if (!isPositiveId(vehicleId)) throw new JobError('invalid_input', `${this.label}: vehicleId musí byť celé číslo ≥ 1`);
    this.vehicle = vehicleId;
    this.current = 'assigned';
  }

  /**
   * Prechod podľa `JOB_TRANSITIONS` (okrem `→ assigned`, ktorý robí `assign`). Nepovolený prechod →
   * `JobError('invalid_transition')`, job sa nezmení.
   */
  transition(to: JobState): void {
    if (to === 'assigned' || !isJobTransitionAllowed(this.current, to)) {
      const allowed = JOB_TRANSITIONS.get(this.current) ?? [];
      throw new JobError('invalid_transition', `${this.label}: prechod ${this.current} → ${to} nie je povolený (povolené: ${allowed.join(', ') || '–'})`);
    }
    this.current = to;
  }

  /** Čistý JSON stav pre save (nová kópia pri každom volaní). */
  toState(): SerializedJob {
    return { id: this.id, unitIds: [...this.unitIds], from: { ...this.source }, to: { ...this.to }, createdTick: this.createdTick };
  }
}
