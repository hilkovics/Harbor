/**
 * RTG žeriav (`RtgCrane extends YardMachine`, ADR-040 bod 3; docs/TERMINAL_2.md §5.1, §5.3) — stroj jedného RTG bloku: pojazd pozdĺž bloku (`gantryCellsPerTick`, spojitá
 * poloha v bays), vozík naprieč radmi (`trolleyTicksPerRow`), zdvih (`hoistTicksPerTier`) a uchopenie (`lockTicks`). Všetky časy a priority sú v `equipment.json` (`rtg`),
 * trieda ich len prevádza na ticky fázy; stroj drží najviac jeden kontajner.
 */
import type { EntityId } from '../core/entity-id';
import type { RtgDef } from '../defs/types';
import { YardMachine, type YardMachineInit } from './yard-machine';

/** Id defu RTG v `equipment.json` (kľúč `rtg`) a `SerializedMachine.defId`. */
export const RTG_DEF_ID = 'rtg';

export class RtgCrane extends YardMachine {
  readonly defId = RTG_DEF_ID;
  readonly def: Readonly<RtgDef>;

  constructor(init: YardMachineInit & { readonly def: Readonly<RtgDef> }) {
    super(init, RTG_DEF_ID);
    this.def = init.def;
  }

  /** Ticky pojazdu žeriavu o `bays` bayov (zaokrúhlené nahor; nulová vzdialenosť = 0, fáza sa preskočí). */
  gantryTicks(bays: number): number {
    return Math.ceil(Math.abs(bays) / this.def.gantryCellsPerTick);
  }

  /** Ticky pojazdu vozíka o `rows` radov. */
  trolleyTicks(rows: number): number {
    return Math.abs(rows) * this.def.trolleyTicksPerRow;
  }

  /** Ticky zdvihu alebo spúšťania spúšťača o `tiers` vrstiev. */
  hoistTicks(tiers: number): number {
    return Math.abs(tiers) * this.def.hoistTicksPerTier;
  }

  /** Nový stroj nad začiatkom pruhu (bay 0), vozík nad pruhom, spúšťač hore (`carryTier`). */
  static create(id: EntityId, blockId: EntityId, def: Readonly<RtgDef>, carryTier: number): RtgCrane {
    return new RtgCrane({ id, blockId, def, pose: { gantry: 0, trolley: LANE_ROW, hoist: carryTier } });
  }
}

/** Poloha vozíka nad pruhom s TP (mimo radov stohu `0…rows−1`). */
export const LANE_ROW = -1;
