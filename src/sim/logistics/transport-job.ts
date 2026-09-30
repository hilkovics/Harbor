/**
 * TransportJob (ARCHITECTURE §7.3; docs/tasks/phase-03.md rozhodnutie 6 a „Spoločné rozhrania"; ADR-018) — úloha
 * previezť jednotky nákladu z jedného držiteľa k druhému vozidlom. Vo F3 len inbound `on_apron → in_storage`
 * (`JOB_ROUTES`); outbound `in_storage → at_ramp` pridá F4 ako nový riadok tabuľky.
 *
 * - Job vzniká v dispatcheri (krok 5) s rezervovaným slotom v cieli (`to = in_storage(moduleId, slot)`) a jednotkami
 *   na zdroji (`from` = ich poloha pri vzniku). Rezervácia slotu trvá, kým vozidlo jednotku neuloží.
 * - Stavy a prechody sú tabuľky `JOB_TRANSITIONS` a `JOB_STATE_TRAITS` (žiadne skryté prechody): `open → assigned`
 *   (dispatcher priradí vozidlo, `assign`) `→ picking` (vozidlo nakladá) `→ moving` (vezie) `→ dropping` (vykladá)
 *   `→ done`. Stav jobu zrkadlí FSM vozidla (ADR-019); hotový job `World` hneď odstráni (`removeJob`), takže save
 *   nerastie s každým prevozom.
 * - `fromModuleId` / `toModuleId` = držitelia `from` / `to` (moduly: berth, sklad).
 *
 * Save (`SerializedJob`) nesie len to, čo sa nedá odvodiť: id, jednotky, `from`, `to`, `createdTick`. Vozidlo jobu
 * (`vehicleId`) a stav obnova odvodí z vozidla, ktoré má job v `jobId`, a z polohy nákladu v ledgeri (ADR-018).
 */
import { holderIdOf, normalizeLocation, uniqueSlotOf, type CargoLocation, type CargoLocationKind } from '../cargo/cargo-location';
import type { EntityId } from '../core/entity-id';
import { JobError } from './job-error';

/** Stavy jobu v poradí životného cyklu. */
export const JOB_STATES = ['open', 'assigned', 'picking', 'moving', 'dropping', 'done'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Povolené prechody `from → [to…]`; `done` je konečný stav (job sa odstráni). */
export const JOB_TRANSITIONS: ReadonlyMap<JobState, readonly JobState[]> = new Map<JobState, readonly JobState[]>([
  ['open', Object.freeze(['assigned'] as const)],
  ['assigned', Object.freeze(['picking'] as const)],
  ['picking', Object.freeze(['moving'] as const)],
  ['moving', Object.freeze(['dropping'] as const)],
  ['dropping', Object.freeze(['done'] as const)],
  ['done', Object.freeze([] as const)],
]);

/** Kde leží náklad jobu v danom stave (invarianty kroku 12, obnova save). */
export type JobCargoPlace = 'source' | 'vehicle' | 'target';

/** Čo platí pre job v danom stave. */
export interface JobStateTraits {
  /** Job má vozidlo (`vehicleId !== null`). */
  readonly hasVehicle: boolean;
  /** Poloha jednotiek: na `from`, vo vozidle jobu, alebo už na `to`. */
  readonly cargoAt: JobCargoPlace;
  /** Aktívny job drží rezerváciu slotu `to` a jeho jednotky nesmú mať iný aktívny job. */
  readonly active: boolean;
}

export const JOB_STATE_TRAITS: { readonly [S in JobState]: JobStateTraits } = Object.freeze({
  open: Object.freeze({ hasVehicle: false, cargoAt: 'source', active: true }),
  assigned: Object.freeze({ hasVehicle: true, cargoAt: 'source', active: true }),
  picking: Object.freeze({ hasVehicle: true, cargoAt: 'source', active: true }),
  moving: Object.freeze({ hasVehicle: true, cargoAt: 'vehicle', active: true }),
  dropping: Object.freeze({ hasVehicle: true, cargoAt: 'vehicle', active: true }),
  done: Object.freeze({ hasVehicle: true, cargoAt: 'target', active: false }),
});

/** Dvojice druhov lokácií (zdroj → cieľ), pre ktoré smie job vzniknúť; F3 = inbound apron → sklad. */
export const JOB_ROUTES: readonly { readonly from: CargoLocationKind; readonly to: CargoLocationKind }[] = Object.freeze([
  Object.freeze({ from: 'on_apron', to: 'in_storage' } as const),
]);

/** Je prechod `from → to` v tabuľke? */
export function isJobTransitionAllowed(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS.get(from)?.includes(to) ?? false;
}

/** Je hodnota jeden zo stavov jobu? */
export function isJobState(value: unknown): value is JobState {
  return (JOB_STATES as readonly unknown[]).includes(value);
}

/** Smie job viesť z lokácie druhu `from` do druhu `to` (`JOB_ROUTES`)? */
export function isJobRoute(from: CargoLocationKind, to: CargoLocationKind): boolean {
  return JOB_ROUTES.some((route) => route.from === from && route.to === to);
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

export class TransportJob {
  readonly id: EntityId;
  /** Jednotky jobu (zmrazené); vo F3 práve jedna — cieľ je jeden jedinečný slot. */
  readonly unitIds: readonly EntityId[];
  /** Poloha jednotiek pri vzniku jobu (zdroj). */
  readonly from: CargoLocation;
  /** Cieľ s rezervovaným slotom. */
  readonly to: CargoLocation;
  /** Držiteľ `from` (berth). */
  readonly fromModuleId: EntityId;
  /** Držiteľ `to` (sklad). */
  readonly toModuleId: EntityId;
  /** Tick vzniku (`clock.tick` v kroku 5). */
  readonly createdTick: number;
  private current: JobState;
  private vehicle: EntityId | null;

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
    if (!isJobRoute(from.kind, to.kind)) {
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
    this.id = init.id;
    this.unitIds = Object.freeze([...unitIds]);
    this.from = from;
    this.to = to;
    this.fromModuleId = holderIdOf(from) as EntityId;
    this.toModuleId = holderIdOf(to) as EntityId;
    this.createdTick = init.createdTick;
    this.current = state;
    this.vehicle = vehicleId;
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
    return { id: this.id, unitIds: [...this.unitIds], from: { ...this.from }, to: { ...this.to }, createdTick: this.createdTick };
  }
}
