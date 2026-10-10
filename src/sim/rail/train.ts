/**
 * Vlak (R6, ADR-043; docs/TERMINAL_2.md §6.9) — dlhé vozidlo jazdiace po koľaji: lokomotíva + `wagons` vagónov (60′ = `wagonTeu` TEU). Poloha je **jedno číslo**: `posMilli` = poloha
 * predku lokomotívy na trase v tisícinách bunky (`route[i]` pokrýva `[i·1000, (i+1)·1000)`); vozne idú za ňou (vagón `k` zaberá `[pos − offset_k − dĺžka, pos − offset_k]`). Trasa vedie od portálu
 * (`route[0]`) cez koľaj mapy až po koniec koľaje terminálu a vlak po nej jazdí tam aj späť — pri odchode ide lokomotíva stále na konci trasy (reverzná jazda), takže poradie vozňov sa nemení
 * a vagón 0 (od lokomotívy) je stále prvý v plnení. Celé čísla (milli-bunky) držia pohyb deterministický a save presný.
 *
 * Vlak je držiteľom nákladu `in_train { trainId, slot }` (slot = poradie TEU miesta od lokomotívy, vagón = `⌊slot / wagonTeu⌋`); ledger drží jednotky, vlak len ich miesta počíta
 * (`train-cargo.ts`). Pohyb a pobyt riadi `RailSystem` (krok 6e).
 */
import type { EntityId } from '../core/entity-id';
import type { RailTrainDef } from '../defs/types';
import { TRAIN_MOVING, isTrainTransitionAllowed, type TrainState } from './train-fsm';

/** Tisícin bunky v jednej bunke (jednotka `posMilli`). */
export const MILLI_PER_CELL = 1000;

/** Uložený stav vlaku (`WorldState.trains`, v15): bez odvodených polí (obsadené bunky). */
export interface SerializedTrain {
  readonly id: number;
  readonly state: TrainState;
  /** Indexy buniek trasy od portálu po koniec koľaje terminálu. */
  readonly route: readonly number[];
  readonly posMilli: number;
  readonly terminalId: number;
  readonly track: number;
  readonly wagons: number;
  /** Tick plánovaného príchodu (cestovný poriadok); oneskorenie = `spawnedTick − scheduledTick`. */
  readonly scheduledTick: number;
  readonly spawnedTick: number;
  /** Tick zastavenia na koľaji terminálu; `null` kým vlak ešte jazdí. */
  readonly stoppedTick: number | null;
  /** Plánovaný odchod (`stoppedTick + dwell`); `null` kým vlak ešte jazdí. */
  readonly departAtTick: number | null;
}

/** Kľúče `SerializedTrain` v poradí `toState()`. */
export const SERIALIZED_TRAIN_KEYS: readonly (keyof SerializedTrain)[] = [
  'id',
  'state',
  'route',
  'posMilli',
  'terminalId',
  'track',
  'wagons',
  'scheduledTick',
  'spawnedTick',
  'stoppedTick',
  'departAtTick',
];

export interface TrainInit extends SerializedTrain {
  readonly def: Readonly<RailTrainDef>;
}

/** Jeden vozeň vlaku pre prezentáciu: druh, číslo vagónu (−1 = lokomotíva) a poloha stredu v milli-bunkách na trase. */
export interface TrainCarSpan {
  readonly kind: 'loco' | 'wagon';
  /** Číslo vagónu od lokomotívy (0, 1, …); lokomotíva −1. */
  readonly wagon: number;
  /** Stred vozňa na trase v milli-bunkách (môže byť < 0 — vozeň ešte nevošiel na mapu). */
  readonly centerMilli: number;
  readonly lengthCells: number;
}

export class Train {
  readonly id: EntityId;
  readonly route: readonly number[];
  readonly terminalId: EntityId;
  readonly track: number;
  readonly wagons: number;
  readonly scheduledTick: number;
  readonly spawnedTick: number;
  readonly def: Readonly<RailTrainDef>;
  state: TrainState;
  posMilli: number;
  stoppedTick: number | null;
  departAtTick: number | null;
  /** Odvodené (nie v save): obsadené bunky trasy `[occLo, occHi]` (indexy do `route`), `occHi < occLo` = nič. `Rail` ich udržiava v `occupancy`. */
  occLo = 0;
  occHi = -1;

  constructor(init: TrainInit) {
    this.id = init.id as EntityId;
    this.state = init.state;
    this.route = Object.freeze([...init.route]);
    this.posMilli = init.posMilli;
    this.terminalId = init.terminalId as EntityId;
    this.track = init.track;
    this.wagons = init.wagons;
    this.scheduledTick = init.scheduledTick;
    this.spawnedTick = init.spawnedTick;
    this.stoppedTick = init.stoppedTick;
    this.departAtTick = init.departAtTick;
    this.def = init.def;
  }

  get label(): string {
    return `vlak #${String(this.id)}`;
  }

  /** Dĺžka celého vlaku v milli-bunkách (lokomotíva + vagóny). */
  get lengthMilli(): number {
    return (this.def.locoLengthCells + this.wagons * this.def.wagonLengthCells) * MILLI_PER_CELL;
  }

  /** Poloha predku lokomotívy, v ktorej vlak v termináli zastaví (koniec trasy). */
  get stopMilli(): number {
    return this.route.length * MILLI_PER_CELL;
  }

  /** Počet TEU miest vlaku (`wagons × wagonTeu`). */
  get slotCount(): number {
    return this.wagons * this.def.wagonTeu;
  }

  /** Vagón, v ktorom je miesto `slot`. */
  wagonOfSlot(slot: number): number {
    return Math.floor(slot / this.def.wagonTeu);
  }

  get moving(): boolean {
    return TRAIN_MOVING[this.state];
  }

  /** Prechod stavu podľa tabuľky (`train-fsm.ts`); nepovolený → `Error`. */
  transition(to: TrainState): void {
    if (!isTrainTransitionAllowed(this.state, to)) throw new Error(`${this.label}: prechod ${this.state} → ${to} nie je povolený`);
    this.state = to;
  }

  /** Bunky trasy `[lo, hi]`, ktoré vlak v polohe `posMilli` pokrýva; `hi < lo` = vlak ešte nevošiel na mapu. */
  occupiedRangeAt(posMilli: number): { readonly lo: number; readonly hi: number } {
    if (posMilli <= 0) return { lo: 0, hi: -1 };
    const hi = Math.min(this.route.length - 1, Math.ceil(posMilli / MILLI_PER_CELL) - 1);
    const lo = Math.floor(Math.max(0, posMilli - this.lengthMilli) / MILLI_PER_CELL);
    return { lo, hi };
  }

  /** Vozne od lokomotívy: stred každého vozňa na trase (pre `RailVM` — render z nich dopočíta x, y, uhol, `railPoseAt`). */
  cars(): readonly TrainCarSpan[] {
    const spans: TrainCarSpan[] = [];
    const { locoLengthCells, wagonLengthCells } = this.def;
    let offsetCells = 0;
    spans.push({ kind: 'loco', wagon: -1, centerMilli: this.posMilli - (offsetCells + locoLengthCells / 2) * MILLI_PER_CELL, lengthCells: locoLengthCells });
    offsetCells += locoLengthCells;
    for (let wagon = 0; wagon < this.wagons; wagon++) {
      spans.push({ kind: 'wagon', wagon, centerMilli: this.posMilli - (offsetCells + wagonLengthCells / 2) * MILLI_PER_CELL, lengthCells: wagonLengthCells });
      offsetCells += wagonLengthCells;
    }
    return spans;
  }

  toState(): SerializedTrain {
    return {
      id: this.id,
      state: this.state,
      route: [...this.route],
      posMilli: this.posMilli,
      terminalId: this.terminalId,
      track: this.track,
      wagons: this.wagons,
      scheduledTick: this.scheduledTick,
      spawnedTick: this.spawnedTick,
      stoppedTick: this.stoppedTick,
      departAtTick: this.departAtTick,
    };
  }
}
