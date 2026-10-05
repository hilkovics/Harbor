/**
 * Pruhové sloty ciest (ADR-037, rozhodnutia orchestrátora R1 č. 2–4): každá bunka má 2 sloty (pruh 0 a 1); `two_lane`
 * bunka s ≤ 2 jazdnými susedmi používa oba, ostatné bunky len pruh 0 (`CellLanes`). Slot drží najviac jeden nosič.
 *
 * Kľúč slotu je `cell × 2 + lane`. `LaneSlots` je odvodená cache: pravdu o tom, čo nosič drží, majú polia `body`
 * a `ahead` nosiča (idú do save); pri obnove sa sloty prepočítajú z nosičov a konflikt je chyba (`WorldStateError`).
 * Bez alokácie: jedno `Int32Array`.
 */
import type { EntityId } from '../core/entity-id';

/** Počet pruhov (slotov) na bunku. */
export const LANES_PER_CELL = 2;

/** Kľúč slotu bunky `cell` v pruhu `lane` (0 | 1). */
export function slotKey(cell: number, lane: number): number {
  return cell * LANES_PER_CELL + lane;
}

/** Bunka, ku ktorej kľúč slotu patrí. */
export function keyCell(key: number): number {
  return key >> 1;
}

/** Pruh (0 | 1) kľúča slotu. */
export function keyLane(key: number): number {
  return key & 1;
}

/** Slot v save: `[bunka, pruh]` (pruh 0 | 1). */
export type SerializedSlot = readonly [number, number];

/** Kľúče slotov → záznamy save (`[bunka, pruh]`), poradie zachované. */
export function serializeSlots(keys: readonly number[]): SerializedSlot[] {
  return keys.map((key): SerializedSlot => [keyCell(key), keyLane(key)]);
}

/** Záznam save → kľúč slotu. */
export function slotKeyOf(slot: SerializedSlot): number {
  return slotKey(slot[0], slot[1]);
}

/** Držiteľ voľného slotu v poli. */
const FREE = 0;

/** Kto smie zapisovať sloty (nosič v `Carrier`): zapíš a uvoľni pod menom držiteľa. */
export interface SlotRegistry {
  claim(key: number, holder: number): void;
  release(key: number, holder: number): void;
  /** Držiteľ slotu; 0 = voľný. */
  holderOfKey(key: number): number;
}

export class LaneSlots implements SlotRegistry {
  private readonly holders: Int32Array;
  private claimed = 0;

  /** @param cellCount počet buniek mriežky (sloty `0 … 2 × cellCount − 1`) */
  constructor(readonly cellCount: number) {
    this.holders = new Int32Array(cellCount * LANES_PER_CELL);
  }

  /** Držiteľ slotu bunky `cell` v pruhu `lane`, alebo `null`, keď je voľný. */
  holderOf(cell: number, lane: number): EntityId | null {
    const holder = this.holders[slotKey(cell, lane)];
    return holder === FREE ? null : (holder as EntityId);
  }

  /** Držiteľ slotu podľa kľúča; 0 = voľný (bez alokácie, horúca cesta). */
  holderOfKey(key: number): number {
    return this.holders[key];
  }

  /** Počet obsadených slotov (porovnanie s prepočtom z nosičov v invariante). */
  get claimedCount(): number {
    return this.claimed;
  }

  /**
   * Zaberie slot pre `holder`. Slot, ktorý už drží `holder`, ostáva (nosič môže držať slot viackrát, napr. otočka cez
   * vlastnú stopu); slot iného držiteľa → `Error` (chyba volajúceho — brána úseku overuje voľnosť vopred).
   */
  claim(key: number, holder: number): void {
    const current = this.holders[key];
    if (current === holder) return;
    if (current !== FREE) {
      throw new Error(`LaneSlots.claim: slot ${String(key)} (bunka ${String(keyCell(key))}, pruh ${String(keyLane(key))}) drží #${String(current)}, nie #${String(holder)}`);
    }
    this.holders[key] = holder;
    this.claimed += 1;
  }

  /** Uvoľní slot, ktorý drží `holder`; slot iného držiteľa alebo voľný → `Error`. */
  release(key: number, holder: number): void {
    if (this.holders[key] !== holder) {
      throw new Error(`LaneSlots.release: slot ${String(key)} drží #${String(this.holders[key])}, nie #${String(holder)}`);
    }
    this.holders[key] = FREE;
    this.claimed -= 1;
  }

  /** Je slot voľný alebo ho drží `holder`? */
  isFreeFor(key: number, holder: number): boolean {
    const current = this.holders[key];
    return current === FREE || current === holder;
  }
}
