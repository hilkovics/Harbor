/**
 * Interné vozidlo (ARCHITECTURE §4.4, §5, §7.3; docs/tasks/phase-03.md rozhodnutia 1, 4, 7 a „Spoločné rozhrania")
 * — straddle carrier a ďalšie vozidlá z `vehicles.json`, ktoré vozia náklad medzi apronom, skladmi a rampami.
 * Jednotky vo vozidle vedie výlučne `CargoLedger` (`in_vehicle`, pravidlo 2); vozidlo si ich neeviduje.
 *
 * - Vozidlo patrí depu (`depotId`, `VehicleDepot.vehicleIds`); kúpi sa cez `BuyVehicle` a stojí `idle` na vonkajšej
 *   bunke konektora depa. Voľné vozidlo ostáva tam, kde skončilo (návrat do depa je v backlogu).
 * - Poloha `x`, `y` = stred vozidla v bunkách (float); stred bunky (cx, cy) = (cx + 0.5, cy + 0.5).
 * - `heading` = kardinálny kurz (0 = sever, v smere hodinových ručičiek) — nikdy nie uhol z trigonometrie.
 * - `jobId` = aktívny `TransportJob` (T03-05); `idle` vozidlo job nemá (`VEHICLE_STATE_TRAITS.hasJob`).
 * - `purchaseCostCents` = skutočne zaplatená cena — základ refundácie pri `SellVehicle` (ako `Module`).
 *
 * Stav je privátny s getterom `state` (vzor `Ship`, `CraneModule`); tabuľku prechodov a pohyb doplní T03-06
 * (`vehicle-fsm.ts`, `VehicleSystem`). V T03-04 existuje len `idle`.
 */
import type { EntityId } from '../core/entity-id';
import type { VehicleDef } from '../defs/types';
import { isRotation, type Rotation } from '../grid/rotation';
import { VehicleError } from './vehicle-error';
import { VEHICLE_TRANSITIONS, isVehicleState, isVehicleTransitionAllowed, type VehicleState } from './vehicle-fsm';

/** Vozidlo v save (`WorldState.vehicles[i]`, T03-04) — čistý JSON; poradie v save = vzostupne podľa id (poradie nákupu). */
export interface SerializedVehicle {
  readonly id: number;
  readonly defId: string;
  readonly depotId: number;
  readonly state: VehicleState;
  readonly x: number;
  readonly y: number;
  readonly heading: Rotation;
  readonly jobId: number | null;
  readonly purchaseCostCents: number;
}

/** Kľúče `SerializedVehicle` v poradí `toState()`. */
export const SERIALIZED_VEHICLE_KEYS: readonly (keyof SerializedVehicle)[] = [
  'id',
  'defId',
  'depotId',
  'state',
  'x',
  'y',
  'heading',
  'jobId',
  'purchaseCostCents',
];

/** Vstup konštruktora vozidla (nákup aj obnova zo save). */
export interface VehicleInit {
  readonly id: EntityId;
  readonly def: Readonly<VehicleDef>;
  readonly depotId: EntityId;
  readonly state: VehicleState;
  readonly x: number;
  readonly y: number;
  readonly heading: Rotation;
  /** Predvolene `null`. */
  readonly jobId?: EntityId | null;
  /** Zaplatená cena v centoch (celé ≥ 0). */
  readonly purchaseCostCents: number;
}

function isPositiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export class Vehicle {
  readonly id: EntityId;
  readonly def: Readonly<VehicleDef>;
  /** Id defu (`def.id`). */
  readonly defId: string;
  /** Depo, ktorému vozidlo patrí. */
  readonly depotId: EntityId;
  /** Skutočne zaplatená cena (základ refundácie). */
  readonly purchaseCostCents: number;
  x: number;
  y: number;
  heading: Rotation;
  jobId: EntityId | null;
  private current: VehicleState;

  /**
   * Chyby (`VehicleError('invalid_input')`): id alebo `depotId` nie je celé ≥ 1, poloha nie je konečné číslo, neplatný
   * kurz alebo stav, `jobId` nie je `null` ani celé ≥ 1, cena nie je celé ≥ 0. Vzťahy k svetu (depo existuje, job
   * zodpovedá stavu, náklad sedí s kapacitou) overuje `World` a loader save.
   */
  constructor(init: VehicleInit) {
    const { id, def, depotId, state, x, y, heading, purchaseCostCents } = init;
    const jobId = init.jobId ?? null;
    const label = `vozidlo '${def.id}' #${String(id)}`;
    if (!isPositiveId(id)) throw new VehicleError('invalid_input', `${label}: id musí byť celé číslo ≥ 1`);
    if (!isPositiveId(depotId)) throw new VehicleError('invalid_input', `${label}: depotId musí byť celé číslo ≥ 1, dostal ${String(depotId)}`);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new VehicleError('invalid_input', `${label}: poloha (${String(x)}, ${String(y)}) musí byť konečné čísla`);
    if (!isRotation(heading)) throw new VehicleError('invalid_input', `${label}: kurz musí byť 0, 90, 180 alebo 270, dostal ${String(heading)}`);
    if (!isVehicleState(state)) throw new VehicleError('invalid_input', `${label}: neznámy stav '${String(state)}'`);
    if (jobId !== null && !isPositiveId(jobId)) throw new VehicleError('invalid_input', `${label}: jobId musí byť null alebo celé číslo ≥ 1`);
    if (!Number.isSafeInteger(purchaseCostCents) || purchaseCostCents < 0) {
      throw new VehicleError('invalid_input', `${label}: purchaseCostCents musí byť celé číslo ≥ 0, dostal ${String(purchaseCostCents)}`);
    }
    this.id = id;
    this.def = def;
    this.defId = def.id;
    this.depotId = depotId;
    this.purchaseCostCents = purchaseCostCents;
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.jobId = jobId;
    this.current = state;
  }

  /** Aktuálny stav FSM (mení ho len `transition`). */
  get state(): VehicleState {
    return this.current;
  }

  /**
   * Prechod podľa `VEHICLE_TRANSITIONS` (dispatcher, `VehicleSystem`); udalosť `VehicleStateChanged` emituje volajúci.
   * Nepovolený prechod → `VehicleError('invalid_transition')`, vozidlo sa nezmení.
   */
  transition(to: VehicleState): void {
    if (!isVehicleTransitionAllowed(this.current, to)) {
      const allowed = VEHICLE_TRANSITIONS.get(this.current) ?? [];
      throw new VehicleError('invalid_transition', `${this.label}: prechod ${this.current} → ${to} nie je povolený (povolené: ${allowed.join(', ') || '–'})`);
    }
    this.current = to;
  }

  /** Popis do chybových správ: `straddle_carrier #7`. */
  get label(): string {
    return `${this.defId} #${String(this.id)}`;
  }

  /** Čistý JSON stav pre save (nová kópia pri každom volaní). */
  toState(): SerializedVehicle {
    return {
      id: this.id,
      defId: this.defId,
      depotId: this.depotId,
      state: this.current,
      x: this.x,
      y: this.y,
      heading: this.heading,
      jobId: this.jobId,
      purchaseCostCents: this.purchaseCostCents,
    };
  }
}
