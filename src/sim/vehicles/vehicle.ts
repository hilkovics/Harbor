/**
 * Interné vozidlo (ARCHITECTURE §4.4, §5, §7.3, §7.6; docs/tasks/phase-03.md rozhodnutia 1, 2, 4, 7 a „Spoločné
 * rozhrania"; ADR-019) — straddle carrier a ďalšie vozidlá z `vehicles.json`, ktoré vozia náklad medzi apronom, skladmi
 * a rampami. Jednotky vo vozidle vedie výlučne `CargoLedger` (`in_vehicle`, pravidlo 2); vozidlo si ich neeviduje.
 *
 * - Vozidlo patrí depu (`depotId`, `VehicleDepot.vehicleIds`); kúpi sa cez `BuyVehicle` a stojí `idle` na vonkajšej
 *   bunke konektora depa. Voľné vozidlo ostáva tam, kde skončilo (návrat do depa je v backlogu).
 * - **Trasa** (`route`) = indexy buniek cesty: prvá je bunka, na ktorej vozidlo stojí alebo z ktorej práve vyšlo
 *   (`cell`), ďalšie sú cieľové bunky v poradí jazdy. **Progres** (`progress`, `[0, 1)`) je podiel úseku `cell →
 *   nextCell`; stojace vozidlo má trasu `[cell]` a progres 0. Pohyb (`advance`) ide po úsekoch rýchlosťou
 *   `speedCellsPerTick × speedFactor` typu cieľovej bunky úseku (ADR-020), zvyšok kroku sa prenáša do ďalšieho úseku
 *   (rozhodnutie orchestrátora 1).
 * - **Šum progresu** (review T03-13, ADR-021): progres je vždy 0 alebo `> PROGRESS_NOISE` (`isValidProgress`) — zvyšok
 *   kroku v double po prechode stredom bunky sa zahodí, takže obrat `1 − progress` nikdy nevyjde 1.
 * - Poloha `x`, `y` = stred vozidla v bunkách (float): stred `cell` (`+ 0,5`) posunutý o `progress` smerom k `nextCell`;
 *   prepočíta ju každý pohyb (a overuje krok 12 aj obnova save).
 * - `heading` = kardinálny kurz úseku (0 = sever, v smere hodinových ručičiek) — nikdy nie uhol z trigonometrie; stojace
 *   vozidlo si ponechá kurz posledného úseku, rozbehnuté má vždy kurz svojho úseku (krok 12, ADR-021).
 * - `waitTicks` = odpočet stavu s čakaním (`VEHICLE_STATE_TRAITS.waits`): pobyt pri module (`loading`/`unloading`)
 *   alebo čas do ďalšieho pokusu o cestu (`no_path`).
 * - `replanPending` = od naplánovania trasy sa zmenila cestná sieť (`World.markRoadsChanged`); `VehicleSystem` pred
 *   ďalším pohybom preplánuje z aktuálnej bunky (pri pohybe medzi bunkami z `nextCell`).
 * - `jobId` = aktívny `TransportJob` (T03-05); `idle` vozidlo job nemá (`VEHICLE_STATE_TRAITS.hasJob`).
 * - `purchaseCostCents` = skutočne zaplatená cena — základ refundácie pri `SellVehicle` (ako `Module`).
 *
 * Stav je privátny s getterom `state` (vzor `Ship`, `CraneModule`) a mení ho len `transition` podľa
 * `VEHICLE_TRANSITIONS`; trasu len `followRoute`, `halt` a `advance`.
 */
import type { EntityId } from '../core/entity-id';
import type { VehicleDef } from '../defs/types';
import { isRotation, type Rotation } from '../grid/rotation';
import { UNIT_SPEED_FACTOR, type SpeedFactorFn } from '../logistics/road-speed';
import { CELL_CENTER_OFFSET, cardinalHeading } from '../ships/ship-route';
import { VehicleError } from './vehicle-error';
import { VEHICLE_TRANSITIONS, isVehicleState, isVehicleTransitionAllowed, type VehicleState } from './vehicle-fsm';

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

/**
 * Šum progresu úseku (review T03-13, ADR-021). Keď vozidlo v `advance` prejde stredom bunky, zvyšok kroku
 * `budget − remaining / factor` môže v double vyjsť rádovo 1e-17 namiesto presnej 0 a stať sa progresom ďalšieho úseku.
 * Taký progres vozidlo reálne nepohne (posun ≪ 1 ulp polohy), ale obrat `turnAround` (`1 − p`) z neho pre `p ≤ 2^-54`
 * spraví presne 1 — neplatný progres, ktorý obnova save odmietne. Progres ≤ `PROGRESS_NOISE` sa preto zahodí (vozidlo
 * ostane v strede bunky), takže platí `progress === 0 || progress > PROGRESS_NOISE` a `1 − progress < 1`. Hranica je
 * technická (presnosť double v rozsahu `[0, 1)`), nie laditeľná hodnota — preto konštanta v kóde, nie def.
 */
export const PROGRESS_NOISE = Number.EPSILON;

/** Je progres úseku platný: presne 0 (stred bunky) alebo v (`PROGRESS_NOISE`, 1)? `NaN`/`Infinity` → `false`. */
export function isValidProgress(progress: number): boolean {
  return progress === 0 || (progress > PROGRESS_NOISE && progress < 1);
}

/** Poloha vozidla (stred v bunkách). */
export interface VehiclePosition {
  readonly x: number;
  readonly y: number;
}

/**
 * Poloha na úseku: stred bunky `cell` (`+ 0,5`) posunutý o `progress` smerom k `next` (bez ďalšej bunky alebo pri
 * progrese 0 stred `cell`). Rovnaké poradie operácií ako `Vehicle.place`, takže výsledok je bitovo zhodný — krok 12
 * a obnova save ním overujú `x`, `y`.
 */
export function vehiclePosition(cell: number, next: number | undefined, progress: number, width: number): VehiclePosition {
  const cx = cell % width;
  const cy = (cell - cx) / width;
  let x = cx + CELL_CENTER_OFFSET;
  let y = cy + CELL_CENTER_OFFSET;
  if (next !== undefined && progress !== 0) {
    const nx = next % width;
    const ny = (next - nx) / width;
    x += (nx - cx) * progress;
    y += (ny - cy) * progress;
  }
  return { x, y };
}

function isPositiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function isCellIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
  /** Odpočet stavu s čakaním (pobyt v module, nový pokus v `no_path`); mení ho `VehicleSystem`. */
  waitTicks: number;
  /** Cestná sieť sa zmenila po naplánovaní trasy (`World.markRoadsChanged`); preplánuje `VehicleSystem`. */
  replanPending: boolean;
  private current: VehicleState;
  private route: readonly number[];
  private routeIndex = 0;
  private segmentProgress: number;

  /**
   * Chyby (`VehicleError('invalid_input')`): id alebo `depotId` nie je celé ≥ 1, poloha nie je konečné číslo, neplatný
   * kurz alebo stav, `jobId` nie je `null` ani celé ≥ 1, cena nie je celé ≥ 0, trasa nie je neprázdny zoznam indexov
   * buniek, progres mimo `[0, 1)` alebo `> 0` bez ďalšej bunky, `waitTicks` nie je celé ≥ 0. Vzťahy k svetu (depo,
   * job, náklad, susednosť buniek trasy, súlad polohy a kurzu s trasou, šum progresu `≤ PROGRESS_NOISE`) overuje
   * `World` a loader save (`vehicleMotionProblem`).
   */
  constructor(init: VehicleInit) {
    const { id, def, depotId, state, x, y, heading, purchaseCostCents, route } = init;
    const jobId = init.jobId ?? null;
    const progress = init.progress ?? 0;
    const waitTicks = init.waitTicks ?? 0;
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
    if (!Array.isArray(route) || route.length === 0 || !route.every(isCellIndex)) {
      throw new VehicleError('invalid_input', `${label}: trasa musí byť neprázdny zoznam indexov buniek (celé ≥ 0)`);
    }
    if (!Number.isFinite(progress) || progress < 0 || progress >= 1) throw new VehicleError('invalid_input', `${label}: progres musí byť v [0, 1), dostal ${String(progress)}`);
    if (progress > 0 && route.length < 2) throw new VehicleError('invalid_input', `${label}: progres ${String(progress)} bez ďalšej bunky na trase`);
    if (!Number.isSafeInteger(waitTicks) || waitTicks < 0) throw new VehicleError('invalid_input', `${label}: waitTicks musí byť celé číslo ≥ 0, dostal ${String(waitTicks)}`);
    this.id = id;
    this.def = def;
    this.defId = def.id;
    this.depotId = depotId;
    this.purchaseCostCents = purchaseCostCents;
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.jobId = jobId;
    this.waitTicks = waitTicks;
    this.replanPending = init.replanPending ?? false;
    this.current = state;
    this.route = Object.freeze([...route]);
    this.segmentProgress = progress;
  }

  /** Aktuálny stav FSM (mení ho len `transition`). */
  get state(): VehicleState {
    return this.current;
  }

  /** Popis do chybových správ: `straddle_carrier #7`. */
  get label(): string {
    return `${this.defId} #${String(this.id)}`;
  }

  /** Bunka, na ktorej vozidlo stojí, alebo z ktorej práve vyšlo (začiatok aktuálneho úseku). */
  get cell(): number {
    return this.route[this.routeIndex];
  }

  /** Cieľová bunka aktuálneho úseku; `undefined`, keď vozidlo nemá ďalší cieľ. */
  get nextCell(): number | undefined {
    return this.route[this.routeIndex + 1];
  }

  /** Progres aktuálneho úseku v `[0, 1)`; 0 = vozidlo stojí v strede `cell`. */
  get progress(): number {
    return this.segmentProgress;
  }

  /** Počet cieľových buniek pred vozidlom (0 = koniec trasy — vozidlo stojí v strede `cell`). */
  get cellsAhead(): number {
    return this.route.length - 1 - this.routeIndex;
  }

  /** Zvyšok trasy `[cell, …]` (nová kópia — save, ladenie; nie hot path). */
  remainingRoute(): readonly number[] {
    return this.route.slice(this.routeIndex);
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

  /**
   * Nová trasa (plánovanie): `route[0]` musí byť `cell` a pri pohybe medzi bunkami `route[1]` = `nextCell` (vozidlo
   * dokončí rozbehnutý úsek). Progres ostáva, príznak preplánovania zaniká. Pole sa uloží bez kópie — volajúci ho
   * nesmie meniť (cesty z `PathCache` sú zmrazené). Iný začiatok → `VehicleError('invalid_input')`, vozidlo sa nezmení.
   */
  followRoute(route: readonly number[]): void {
    const between = this.segmentProgress > 0;
    if (route[0] !== this.cell || (between && route[1] !== this.nextCell)) {
      throw new VehicleError(
        'invalid_input',
        `${this.label}.followRoute: trasa musí začínať bunkou ${String(this.cell)}${between ? ` a pokračovať bunkou ${String(this.nextCell)}` : ''}, začína [${route.slice(0, 2).join(', ')}]`,
      );
    }
    this.route = route;
    this.routeIndex = 0;
    this.replanPending = false;
  }

  /**
   * Obrat uprostred úseku (preplánovanie, ktorého cesta z `nextCell` vedie hneď späť do `cell`): vozidlo ostane na mieste,
   * úsek sa otočí (`route[0]` = doterajšia `nextCell`, `route[1]` = doterajšia `cell`, progres `1 − progress`), prepočíta
   * sa poloha a kurz (`width` = šírka mriežky). Bez obratu by vozidlo dorazilo do `nextCell` a vrátilo sa — v ticku by sa
   * reálne nepohlo. Vozidlo bližšie k `nextCell` než `PROGRESS_NOISE` (`1 − progress ≤ PROGRESS_NOISE`) stojí v jej strede:
   * šum sa zahodí ako v `advance` (progres 0, poloha sa posunie najviac o `PROGRESS_NOISE`).
   * Chyby (`VehicleError('invalid_input')`, vozidlo sa nezmení): vozidlo nie je medzi bunkami, iný začiatok trasy, alebo
   * poistka proti šumu — progres taký malý, že `1 − progress` vyjde 1 (neplatný progres; `advance` ho už nevytvorí,
   * ADR-021).
   */
  turnAround(route: readonly number[], width: number): void {
    const next = this.nextCell;
    if (this.segmentProgress === 0 || next === undefined || route[0] !== next || route[1] !== this.cell) {
      throw new VehicleError(
        'invalid_input',
        `${this.label}.turnAround: obrat vyžaduje pohyb medzi bunkami a trasu [${String(next)}, ${String(this.cell)}, …], dostal [${route.slice(0, 2).join(', ')}]`,
      );
    }
    const turned = 1 - this.segmentProgress;
    if (!(turned < 1)) {
      throw new VehicleError(
        'invalid_input',
        `${this.label}.turnAround: progres ${String(this.segmentProgress)} je šum pod PROGRESS_NOISE — obrat by dal neplatný progres ${String(turned)}`,
      );
    }
    this.route = route;
    this.routeIndex = 0;
    this.segmentProgress = turned > PROGRESS_NOISE ? turned : 0;
    this.replanPending = false;
    this.place(width);
  }

  /** Zahodí zvyšok trasy (bez cesty, `no_path`): ostane `[cell]`, pri pohybe medzi bunkami `[cell, nextCell]`. */
  halt(): void {
    const next = this.nextCell;
    this.route = this.segmentProgress > 0 && next !== undefined ? Object.freeze([this.cell, next]) : Object.freeze([this.cell]);
    this.routeIndex = 0;
    this.replanPending = false;
  }

  /**
   * Posunie vozidlo po trase o `distance` buniek pri faktore 1 (zvyšok kroku prechádza do ďalšieho úseku; na konci trasy
   * vozidlo zastane v strede poslednej bunky a zvyšok prepadne), prepočíta `x`, `y` a kurz. `width` = šírka mriežky
   * (index → súradnice). Úsek `cell → nextCell` ide rýchlosťou `distance × speedFactor(nextCell)` (typ cieľovej bunky,
   * ADR-020): zvyšok kroku sa meria v bunkách pri faktore 1, takže úsek s faktorom `f` spotrebuje `zvyšok / f`. Pri
   * faktore 1 je výpočet bitovo rovnaký ako bez typov ciest. Progres `≤ PROGRESS_NOISE` (zvyšok kroku po prechode stredom
   * bunky) sa zahodí — vozidlo ostane v strede bunky (ADR-021). Vráti `true`, keď vozidlo stojí na konci trasy. Bez
   * alokácie.
   */
  advance(distance: number, width: number, speedFactor: SpeedFactorFn = UNIT_SPEED_FACTOR): boolean {
    let budget = distance;
    while (budget > 0 && this.routeIndex + 1 < this.route.length) {
      this.heading = this.segmentHeading(width);
      const factor = speedFactor(this.route[this.routeIndex + 1]);
      const remaining = 1 - this.segmentProgress;
      const step = budget * factor;
      if (step < remaining) {
        budget = 0;
        const progressed = this.segmentProgress + step;
        if (progressed < 1) {
          // Šum pod PROGRESS_NOISE nastane len na začiatku úseku (progres 0) — vozidlo ostane v strede bunky.
          if (progressed > PROGRESS_NOISE) this.segmentProgress = progressed;
          continue;
        }
        // Zaokrúhlenie by dalo progres 1 — vozidlo dorazí do stredu ďalšej bunky, zvyšok (< 1 ulp) prepadne.
      } else {
        budget -= remaining / factor;
      }
      this.routeIndex += 1;
      this.segmentProgress = 0;
    }
    this.place(width);
    return this.cellsAhead === 0;
  }

  /** Prepočíta `x`, `y` (a kurz pri pohybe medzi bunkami) z `cell`, `nextCell` a progresu. */
  place(width: number): void {
    const cell = this.cell;
    const cx = cell % width;
    const cy = (cell - cx) / width;
    this.x = cx + CELL_CENTER_OFFSET;
    this.y = cy + CELL_CENTER_OFFSET;
    const next = this.nextCell;
    if (next === undefined || this.segmentProgress === 0) return;
    const nx = next % width;
    const ny = (next - nx) / width;
    this.heading = this.segmentHeading(width);
    this.x += (nx - cx) * this.segmentProgress;
    this.y += (ny - cy) * this.segmentProgress;
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
      progress: this.segmentProgress,
      waitTicks: this.waitTicks,
      replan: this.replanPending,
    };
  }

  /** Kurz aktuálneho úseku `cell → nextCell`; bez ďalšej bunky doterajší kurz. */
  private segmentHeading(width: number): Rotation {
    const next = this.nextCell;
    if (next === undefined) return this.heading;
    const cell = this.cell;
    const dx = (next % width) - (cell % width);
    const dy = (next - (next % width)) / width - (cell - (cell % width)) / width;
    return cardinalHeading(dx, dy) ?? this.heading;
  }
}
