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
 * Povolené prechody `from → [to…]`; `done` a `cancelled` sú konečné stavy (job sa odstráni). Zrušiť sa dá job bez vozidla (`open`)
 * a job vozidla, ktoré pri zdroji nenašlo cieľ rehandlingu (`picking → cancelled`, dodatok TR2-06b); inak vozidlo job dokončí (ADR-023).
 */
export const JOB_TRANSITIONS: ReadonlyMap<JobState, readonly JobState[]> = new Map<JobState, readonly JobState[]>([
  ['open', Object.freeze(['assigned', 'cancelled'] as const)],
  ['assigned', Object.freeze(['picking'] as const)],
  // Rehandling bez cieľa v bloku (R2, dodatok TR2-06b): vozidlo čaká v `picking` na kontajnery nad jednotkou; po `rehandleGiveUpTicks` sa job zruší a vozidlo uvoľní.
  ['picking', Object.freeze(['moving', 'cancelled'] as const)],
  ['moving', Object.freeze(['dropping'] as const)],
  ['dropping', Object.freeze(['done'] as const)],
  ['done', Object.freeze([] as const)],
  ['cancelled', Object.freeze([] as const)],
]);

/**
 * Prečo dispatcher zrušil job bez vozidla (`JobCancelled`, ADR-023): cieľová rampa nie je prevádzková (ADR-022), alebo
 * k nej zo zdroja nevedie cesta. Oboje sú podmienky vzniku outbound jobu — `open` job, ktorý by už nevznikol, sa zruší.
 * `loading_stopped` (T6C-07b): nakládka bookingu sa zastavila (`loadingStopped`) a job nakládky ešte nemá vozidlo.
 * `rehandle_stalled` (TR2-06b): vozidlo pri zdroji v bloku so stohmi nenašlo cieľ pre kontajnery nad jednotkou (alebo jednotku pri príchode nemožno vybrať)
 * a po `rehandleGiveUpTicks` job zrušilo — jednotka ostáva v sklade a dispatcher jej vytvorí job znova, až keď je pre kontajnery nad ňou miesto.
 */
export const JOB_CANCEL_REASONS = ['ramp_inoperative', 'ramp_unreachable', 'loading_stopped', 'rehandle_stalled'] as const;
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
  private target: CargoLocation;

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
    this.target = to;
    this.fromModuleId = fromModuleId;
    this.toModuleId = toModuleId;
    this.priority = route.priority;
    this.createdTick = init.createdTick;
    this.current = state;
    this.vehicle = vehicleId;
  }

  /**
   * Cieľ s rezervovaným miestom (slot skladu, dock rampy, slot apronu); pri `in_crane` hák žeriava bez rezervácie. Mení ho len `rebindTarget`
   * (nakládka pod hákom, k háku nevedie cesta — vozidlo jednotku odloží na apron).
   */
  get to(): CargoLocation {
    return this.target;
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

  /**
   * Presmeruje cieľ jobu z háku žeriava (`in_crane`, nakládka pod hákom) na slot apronu toho istého kotviska (`toModuleId`) — vozidlo s jednotkou
   * k háku nedôjde (`no_path`), preto ju odloží na apron a žeriav ju zdvihne odtiaľ (ADR-033 dodatok T6D-05b). Povolené len pre job `moving`
   * (jednotka je vo vozidle) alebo `assigned` (dispatcher presmeruje nakládku s nedosiahnuteľným hákom už pri priradení, TR3-02b) s cieľom `in_crane`; slot musí byť už rezervovaný volajúcim. Inak `JobError`, job sa nezmení.
   */
  rebindTarget(to: CargoLocation): void {
    const target = checkLocation(to, this.label, 'to');
    if (this.target.kind !== 'in_crane' || (this.current !== 'moving' && this.current !== 'assigned')) {
      throw new JobError('invalid_transition', `${this.label}: cieľ sa presmeruje len pri jobe moving s cieľom in_crane (cieľ ${this.target.kind}, stav ${this.current})`);
    }
    if (target.kind !== 'on_apron' || holderIdOf(target) !== this.toModuleId || !isJobRoute(this.source.kind, target.kind)) {
      throw new JobError('invalid_input', `${this.label}: nový cieľ ${target.kind} nie je apron kotviska #${String(this.toModuleId)} s povolenou trasou z ${this.source.kind}`);
    }
    this.target = target;
  }

  /**
   * Zmení slot skladu v zdroji (`in_storage`) toho istého skladu — rehandling presunul jednotku jobu v bloku so stohmi (ADR-039 bod 6), aby sa dalo
   * vybrať iný kontajner. Povolené len pre job so zdrojom `in_storage` pred nakládkou (`open`, `assigned`, `picking`); inak `JobError`, job sa nezmení.
   */
  rebindStorageSource(slot: number): void {
    const { source } = this;
    if (source.kind !== 'in_storage' || (this.current !== 'open' && this.current !== 'assigned' && this.current !== 'picking')) {
      throw new JobError('invalid_transition', `${this.label}: slot zdroja sa mení len pri jobe zo skladu pred nakládkou (zdroj ${source.kind}, stav ${this.current})`);
    }
    this.source = checkLocation({ kind: 'in_storage', moduleId: source.moduleId, slot }, this.label, 'from');
  }

  /**
   * Zmení slot skladu v cieli (`in_storage`) toho istého skladu — pri vykládke sa rezervácie bunky jedného stohu vymenia podľa skutočnej výšky
   * (`YardBlock.settleReservation`). Povolené len pre job s cieľom `in_storage`; inak `JobError`, job sa nezmení.
   */
  rebindStorageTarget(slot: number): void {
    const { target } = this;
    if (target.kind !== 'in_storage') throw new JobError('invalid_transition', `${this.label}: slot cieľa sa mení len pri cieli in_storage (cieľ ${target.kind})`);
    this.target = checkLocation({ kind: 'in_storage', moduleId: target.moduleId, slot }, this.label, 'to');
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
   * Výmena vozidiel medzi dvoma jobmi pod hákom jedného žeriava (ADR-040): žeriav drží jednotku jobu s vozidlom na ceste (`assigned`), no pod hákom už čaká vozidlo iného jobu
   * (`picking`) — ťahač nezdvihne nič z apronu a pod hákom sa dvaja nevyhnú, takže sa vozidlá vymenia: tento job (`assigned`) dostane čakajúce vozidlo a stane sa `picking`,
   * `other` (`picking`) dostane vozidlo na ceste a stane sa `assigned`. Explicitná operácia mimo `JOB_TRANSITIONS`; iné stavy → `JobError`, nič sa nezmení.
   */
  exchangeVehicle(other: TransportJob): void {
    if (this.current !== 'assigned' || other.current !== 'picking' || this.vehicle === null || other.vehicle === null) {
      throw new JobError('invalid_transition', `${this.label}: výmena vozidla vyžaduje job assigned a druhý picking s vozidlami (${this.current}, ${other.label} ${other.current})`);
    }
    const waiting = other.vehicle;
    other.vehicle = this.vehicle;
    other.current = 'assigned';
    this.vehicle = waiting;
    this.current = 'picking';
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
