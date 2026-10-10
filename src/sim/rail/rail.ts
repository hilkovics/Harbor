/**
 * Stav železnice sveta (R6, ADR-043): vlaky, cestovný poriadok a súčty. Poradie volania krokov je v `RailSystem` (krok 6e), tu je len stav a jeho (de)serializácia.
 *
 * **Cestovný poriadok** (`rail.json` → `timetable`): `nextArrivalTick` je plánovaný príchod najbližšieho vlaku; po vzniku vlaku sa posunie o interval (zmeškané intervaly sa preskočia a spočítajú
 * v `skippedArrivals`). **Obsadenie** (`occupancy`, odvodené, nie v save): bunka trasy → id vlaku, ktorý ju pokrýva (0 = voľná); dva vlaky sa na bunke neprekrývajú (ako vozidlá, ADR-037).
 * **Žetón pohybu:** po koľajisku jazdí naraz najviac jeden vlak (`mover`), čo vylučuje čelné stretnutie na jednej (slepej) trase; stojace vlaky v termináli ho nedržia.
 */
import type { EntityId } from '../core/entity-id';
import type { RailDef } from '../defs/types';
import { Train, type SerializedTrain } from './train';

/** Súčty a plán železnice v save (`WorldState.rail`, v15). */
export interface RailRuntimeState {
  /** Plánovaný príchod najbližšieho vlaku (tick). */
  readonly nextArrivalTick: number;
  readonly trainsSpawned: number;
  readonly trainsDeparted: number;
  /** Plánované príchody, ktoré sa nekonali, lebo prístav nemal napojený terminál (alebo ich predbehol ďalší interval). */
  readonly skippedArrivals: number;
  /** Súčet a maximum oneskorenia príchodov (`spawnedTick − scheduledTick`). */
  readonly delayTicksTotal: number;
  readonly delayTicksMax: number;
  /** Súčet a maximum doby od vzniku vlaku po odchod cez portál (obrat). */
  readonly turnaroundTicksTotal: number;
  readonly turnaroundTicksMax: number;
  /** Jednotky importu, ktoré odišli vlakom (`in_train → exported` pri odchode; podiel importu vlakom = metrika `railImportSharePct`). */
  readonly importUnitsByTrain: number;
  /** Úrovňové priecestia (ADR-043 TR6-02): indexy buniek s cestou, cez ktoré vedie aj koľaj; vzostupne. */
  readonly crossings: readonly number[];
}

/** Počítadlá bez priecestí (`Rail.counters`). */
export type RailCounters = Omit<RailRuntimeState, 'crossings'>;

/** Kľúče `RailRuntimeState` v poradí `getState()`. */
export const RAIL_RUNTIME_KEYS: readonly (keyof RailRuntimeState)[] = [
  'nextArrivalTick',
  'trainsSpawned',
  'trainsDeparted',
  'skippedArrivals',
  'delayTicksTotal',
  'delayTicksMax',
  'turnaroundTicksTotal',
  'turnaroundTicksMax',
  'importUnitsByTrain',
  'crossings',
];

/** Čas v tickoch, z ktorého `Rail` odvodzuje plán (z `SimClock`). */
export interface RailClock {
  readonly ticksPerHour: number;
  readonly ticksPerMinute: number;
}

export class Rail {
  readonly def: Readonly<RailDef>;
  /** Vlaky vzostupne podľa id (poradie vzniku). */
  readonly trains = new Map<EntityId, Train>();
  /** Bunka → id vlaku, ktorý ju pokrýva (0 = voľná); odvodené z polôh vlakov. */
  readonly occupancy: Int32Array;
  /** Interval medzi príchodmi v tickoch (`timetable.intervalHours`). */
  readonly intervalTicks: number;
  /** Plánovaný pobyt v termináli v tickoch (`timetable.dwellMinutes`). */
  readonly dwellTicks: number;
  /** Rešpitná lehota po plánovanom odchode v tickoch (`timetable.departGraceMinutes`): potom vlak odíde aj s nevyloženým nákladom z príchodu. */
  readonly departGraceTicks: number;
  /** Úrovňové priecestia: bunka s cestou (`Cell.road = 'road'`), ktorou vedie aj koľaj (vlak ju rezervuje, cestné vozidlá ju nesmú obsadiť, kým je vlak na nej alebo pred ňou). */
  readonly crossings = new Set<number>();
  /** Ticky vopred, na ktoré vlak rezervuje priecestie pred sebou (`rail.json` → `train.crossingClearTicks`). */
  readonly crossingClearTicks: number;
  private state: { -readonly [K in keyof RailCounters]: RailCounters[K] };

  constructor(def: Readonly<RailDef>, clock: RailClock, cellCount: number, state?: RailRuntimeState) {
    this.def = def;
    this.occupancy = new Int32Array(cellCount);
    this.intervalTicks = Math.max(1, Math.round(def.timetable.intervalHours * clock.ticksPerHour));
    this.dwellTicks = def.timetable.dwellMinutes * clock.ticksPerMinute;
    this.departGraceTicks = def.timetable.departGraceMinutes * clock.ticksPerMinute;
    this.crossingClearTicks = def.crossingClearTicks;
    for (const index of state?.crossings ?? []) this.crossings.add(index);
    this.state =
      state === undefined
        ? { nextArrivalTick: def.timetable.firstArrivalHour * clock.ticksPerHour, trainsSpawned: 0, trainsDeparted: 0, skippedArrivals: 0, delayTicksTotal: 0, delayTicksMax: 0, turnaroundTicksTotal: 0, turnaroundTicksMax: 0, importUnitsByTrain: 0 }
        : { nextArrivalTick: state.nextArrivalTick, trainsSpawned: state.trainsSpawned, trainsDeparted: state.trainsDeparted, skippedArrivals: state.skippedArrivals, delayTicksTotal: state.delayTicksTotal, delayTicksMax: state.delayTicksMax, turnaroundTicksTotal: state.turnaroundTicksTotal, turnaroundTicksMax: state.turnaroundTicksMax, importUnitsByTrain: state.importUnitsByTrain };
  }

  get nextArrivalTick(): number {
    return this.state.nextArrivalTick;
  }

  get counters(): Readonly<RailCounters> {
    return this.state;
  }

  getState(): RailRuntimeState {
    return { ...this.state, crossings: [...this.crossings].sort((a, b) => a - b) };
  }

  /** Je bunka priecestím? */
  isCrossing(index: number): boolean {
    return this.crossings.has(index);
  }

  /** Uplynula po plánovanom odchode rešpitná lehota (`departGraceMinutes`)? Vlak potom nezačína nové cykly RMG (`planTrainCycle`) a odíde aj s nevyloženým nákladom. */
  isOverdue(train: Train, tick: number): boolean {
    return train.departAtTick !== null && tick >= train.departAtTick + this.departGraceTicks;
  }

  /** Vlak, ktorý práve jazdí (drží žetón pohybu), alebo `undefined`. */
  mover(): Train | undefined {
    for (const train of this.trains.values()) if (train.moving) return train;
    return undefined;
  }

  /** Leží bunka mapy na trase niektorého vlaku? (`RemoveRail` ju vtedy odmietne.) */
  cellInUse(index: number): boolean {
    for (const train of this.trains.values()) if (train.route.includes(index)) return true;
    return false;
  }

  /** Je koľaj `track` terminálu `terminalId` obsadená vlakom? */
  trackTaken(terminalId: EntityId, track: number): boolean {
    for (const train of this.trains.values()) if (train.terminalId === terminalId && train.track === track) return true;
    return false;
  }

  /** Pridá vlak (nový alebo obnovený) a zapíše jeho obsadenie. Rovnaké id dvakrát → `Error`. */
  addTrain(train: Train): void {
    if (this.trains.has(train.id)) throw new Error(`Rail.addTrain: ${train.label} už vo svete je`);
    this.trains.set(train.id, train);
    this.refreshOccupancy(train);
  }

  /** Odstráni vlak a uvoľní jeho bunky. */
  removeTrain(train: Train): void {
    this.clearOccupancy(train);
    this.trains.delete(train.id);
  }

  /** Prepíše obsadenie vlaku podľa jeho aktuálnej polohy. */
  refreshOccupancy(train: Train): void {
    this.clearOccupancy(train);
    const { lo, hi } = train.occupiedRangeAt(train.posMilli);
    for (let i = lo; i <= hi; i++) this.occupancy[train.route[i]] = train.id;
    train.occLo = lo;
    train.occHi = hi;
  }

  private clearOccupancy(train: Train): void {
    for (let i = train.occLo; i <= train.occHi; i++) if (this.occupancy[train.route[i]] === train.id) this.occupancy[train.route[i]] = 0;
    train.occLo = 0;
    train.occHi = -1;
  }

  /** Posunie plán o interval za `scheduledTick` (aj za `tick`: zmeškané intervaly sa preskočia a započítajú). */
  advanceSchedule(tick: number): void {
    this.state.nextArrivalTick += this.intervalTicks;
    while (this.state.nextArrivalTick <= tick) {
      this.state.nextArrivalTick += this.intervalTicks;
      this.state.skippedArrivals += 1;
    }
  }

  /** Plánovaný príchod bez napojeného terminálu sa nekoná: posunie plán za `tick` a spočíta ho. */
  skipArrivals(tick: number): void {
    while (this.state.nextArrivalTick <= tick) {
      this.state.nextArrivalTick += this.intervalTicks;
      this.state.skippedArrivals += 1;
    }
  }

  recordSpawn(delayTicks: number): void {
    this.state.trainsSpawned += 1;
    this.state.delayTicksTotal += delayTicks;
    this.state.delayTicksMax = Math.max(this.state.delayTicksMax, delayTicks);
  }

  recordDeparture(turnaroundTicks: number, importUnits: number): void {
    this.state.trainsDeparted += 1;
    this.state.importUnitsByTrain += importUnits;
    this.state.turnaroundTicksTotal += turnaroundTicks;
    this.state.turnaroundTicksMax = Math.max(this.state.turnaroundTicksMax, turnaroundTicks);
  }

  /** Obnova trénov zo save (`WorldState.trains`) vzostupne podľa id. */
  restoreTrains(entries: readonly SerializedTrain[]): void {
    for (const entry of entries) this.addTrain(new Train({ ...entry, def: this.def.train }));
  }
}
