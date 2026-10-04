/**
 * Interné vozidlo (ARCHITECTURE §4.4, §5, §7.3, §7.6; docs/tasks/phase-03.md rozhodnutia 1, 2, 4, 7 a „Spoločné
 * rozhrania"; ADR-019, ADR-024) — straddle carrier a ďalšie vozidlá z `vehicles.json`, ktoré vozia náklad medzi apronom,
 * skladmi a rampami. Jednotky vo vozidle vedie výlučne `CargoLedger` (`in_vehicle`, pravidlo 2); vozidlo si ich neeviduje.
 *
 * - Vozidlo patrí depu (`depotId`, `VehicleDepot.vehicleIds`); kúpi sa cez `BuyVehicle` a stojí `idle` na vonkajšej
 *   bunke konektora depa. Voľné vozidlo ostáva tam, kde skončilo (návrat do depa je v backlogu).
 * - **Pohyb** (trasa, progres, poloha, kurz, `waitTicks`, `replanPending`) dedí zo zdieľaného `Carrier`
 *   (`src/sim/movement`, ADR-024) — ten istý kód používajú kamióny.
 * - `waitTicks` = odpočet stavu s čakaním (`VEHICLE_STATE_TRAITS.waits`): pobyt pri module (`loading`/`unloading`)
 *   alebo čas do ďalšieho pokusu o cestu (`no_path`).
 * - `jobId` = aktívny `TransportJob` (T03-05); `idle` vozidlo job nemá (`VEHICLE_STATE_TRAITS.hasJob`).
 * - `purchaseCostCents` = skutočne zaplatená cena — základ refundácie pri `SellVehicle` (ako `Module`).
 *
 * Stav je privátny s getterom `state` (vzor `Ship`, `CraneModule`) a mení ho len `transition` podľa
 * `VEHICLE_TRANSITIONS`; trasu len metódy `Carrier`.
 */
import type { EntityId } from '../core/entity-id';
import type { VehicleDef } from '../defs/types';
import type { Rotation } from '../grid/rotation';
import { Carrier, carrierPoseProblem, carrierPosition, carrierRouteProblem, type CarrierPosition } from '../movement/carrier';
import { VehicleError } from './vehicle-error';
import { VEHICLE_TRANSITIONS, isVehicleState, isVehicleTransitionAllowed, type VehicleState } from './vehicle-fsm';

export { PROGRESS_NOISE, isValidProgress } from '../movement/carrier';

/** Vozidlo v save (`WorldState.vehicles[i]`, T03-04, ADR-019) — čistý JSON; poradie v save = vzostupne podľa id. */
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
  /** Zvyšok trasy: `[cell, …cieľové bunky]` (indexy buniek); obnova neplánuje znova (ADR-019). */
  readonly route: readonly number[];
  /** Progres úseku `route[0] → route[1]` v `[0, 1)`. */
  readonly progress: number;
  readonly waitTicks: number;
  /** Trasa čaká na preplánovanie (cesty sa zmenili po naplánovaní a vozidlo sa odvtedy nehlo). */
  readonly replan: boolean;
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
  'route',
  'progress',
  'waitTicks',
  'replan',
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
  /** Trasa `[cell, …]` — indexy buniek (celé ≥ 0), aspoň bunka vozidla. Susednosť a súlad s `x`, `y` overuje svet. */
  readonly route: readonly number[];
  /** Predvolene 0; `> 0` len s ďalšou bunkou na trase. */
  readonly progress?: number;
  /** Predvolene 0. */
  readonly waitTicks?: number;
  /** Predvolene `false`. */
  readonly replanPending?: boolean;
}

/** Poloha vozidla (stred v bunkách) — tvar zdieľaného `CarrierPosition`. */
export type VehiclePosition = CarrierPosition;

/**
 * Poloha na úseku: stred bunky `cell` (`+ 0,5`) posunutý o `progress` smerom k `next` — zdieľaná `carrierPosition`
 * (bitovo zhodná s `Carrier.place`); krok 12 a obnova save ňou overujú `x`, `y`.
 */
export function vehiclePosition(cell: number, next: number | undefined, progress: number, width: number): VehiclePosition {
  return carrierPosition(cell, next, progress, width);
}

function isPositiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export class Vehicle extends Carrier {
  readonly id: EntityId;
  readonly def: Readonly<VehicleDef>;
  /** Id defu (`def.id`). */
  readonly defId: string;
  /** Depo, ktorému vozidlo patrí. */
  readonly depotId: EntityId;
  /** Skutočne zaplatená cena (základ refundácie). */
  readonly purchaseCostCents: number;
  jobId: EntityId | null;
  private current: VehicleState;

  /**
   * Chyby (`VehicleError('invalid_input')`): id alebo `depotId` nie je celé ≥ 1, poloha nie je konečné číslo, neplatný
   * kurz alebo stav, `jobId` nie je `null` ani celé ≥ 1, cena nie je celé ≥ 0, trasa nie je neprázdny zoznam indexov
   * buniek, progres mimo `[0, 1)` alebo `> 0` bez ďalšej bunky, `waitTicks` nie je celé ≥ 0. Vzťahy k svetu (depo,
   * job, náklad, susednosť buniek trasy, súlad polohy a kurzu s trasou, šum progresu `≤ PROGRESS_NOISE`) overuje
   * `World` a loader save (`vehicleMotionProblem`).
   */
  constructor(init: VehicleInit) {
    const { id, def, depotId, state, purchaseCostCents } = init;
    const jobId = init.jobId ?? null;
    const label = `vozidlo '${def.id}' #${String(id)}`;
    if (!isPositiveId(id)) throw new VehicleError('invalid_input', `${label}: id musí byť celé číslo ≥ 1`);
    if (!isPositiveId(depotId)) throw new VehicleError('invalid_input', `${label}: depotId musí byť celé číslo ≥ 1, dostal ${String(depotId)}`);
    const pose = carrierPoseProblem(label, init);
    if (pose !== undefined) throw new VehicleError('invalid_input', pose);
    if (!isVehicleState(state)) throw new VehicleError('invalid_input', `${label}: neznámy stav '${String(state)}'`);
    if (jobId !== null && !isPositiveId(jobId)) throw new VehicleError('invalid_input', `${label}: jobId musí byť null alebo celé číslo ≥ 1`);
    if (!Number.isSafeInteger(purchaseCostCents) || purchaseCostCents < 0) {
      throw new VehicleError('invalid_input', `${label}: purchaseCostCents musí byť celé číslo ≥ 0, dostal ${String(purchaseCostCents)}`);
    }
    const route = carrierRouteProblem(label, init);
    if (route !== undefined) throw new VehicleError('invalid_input', route);
    super(init);
    this.id = id;
    this.def = def;
    this.defId = def.id;
    this.depotId = depotId;
    this.purchaseCostCents = purchaseCostCents;
    this.jobId = jobId;
    this.current = state;
  }

  /** Aktuálny stav FSM (mení ho len `transition`). */
  get state(): VehicleState {
    return this.current;
  }

  /** Popis do chybových správ: `straddle_carrier #7`. */
  get label(): string {
    return `${this.defId} #${String(this.id)}`;
  }

  /**
   * Prechod podľa `VEHICLE_TRANSITIONS` (dispatcher, `VehicleSystem`); udalosť `VehicleStateChanged` emituje volajúci
   * (`changeVehicleState`). Nepovolený prechod → `VehicleError('invalid_transition')`, vozidlo sa nezmení.
   */
  transition(to: VehicleState): void {
    if (!isVehicleTransitionAllowed(this.current, to)) {
      const allowed = VEHICLE_TRANSITIONS.get(this.current) ?? [];
      throw new VehicleError('invalid_transition', `${this.label}: prechod ${this.current} → ${to} nie je povolený (povolené: ${allowed.join(', ') || '–'})`);
    }
    this.current = to;
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
      route: this.remainingRoute(),
      progress: this.progress,
      waitTicks: this.waitTicks,
      replan: this.replanPending,
    };
  }

  protected invalidInput(message: string): Error {
    return new VehicleError('invalid_input', message);
  }
}
