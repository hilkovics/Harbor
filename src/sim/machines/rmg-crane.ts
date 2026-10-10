/**
 * RMG žeriav železničného terminálu (`RmgCrane extends RtgCrane`, R6, ADR-043 TR6-02; docs/TERMINAL_2.md §5) — stroj bloku `rmg_rail_block`: rám pojazduje pozdĺž koľají a bufferu (`gantry` = bay),
 * vozík naprieč (`trolley`: rad bufferu `0…rows−1`, `LANE_ROW` = pruh s TP pre ťahače, záporné `TRACK_ROW_BASE − koľaj` = koľaje) a spúšťač (`hoist`). Má rovnaký FSM a plánovanie cyklov ako RTG
 * (`machines/machine-fsm.ts`, `systems/yard-machine-system.ts`), časy z `equipment.json` (`rmg`). Navyše obsluhuje vlak: cykly s partnerom `trainId` (`MachineCycle.trainId`) majú prednosť
 * pred ťahačmi a housekeepingom (`priorities.train`). Pre VM: `poseNow()` (gantry / trolley / hoist) ako RTG, `defId` = `rmg`.
 */
import type { EntityId } from '../core/entity-id';
import type { RmgDef } from '../defs/types';
import { LANE_ROW, RtgCrane } from './rtg-crane';
import type { YardMachineInit } from './yard-machine';

/** Id defu RMG v `equipment.json` (kľúč `rmg`) a `SerializedMachine.defId`. */
export const RMG_DEF_ID = 'rmg';

/** Poloha vozíka nad koľajou `track`: pod pruhom (`LANE_ROW = −1`) idú koľaje po radoch `−2`, `−3`, … */
export function trackRow(track: number): number {
  return LANE_ROW - 1 - track;
}

export class RmgCrane extends RtgCrane {
  readonly rmgDef: Readonly<RmgDef>;

  constructor(init: YardMachineInit & { readonly def: Readonly<RmgDef> }) {
    super({ ...init, defId: RMG_DEF_ID });
    this.rmgDef = init.def;
  }

  /** Priorita práce pre vlak (menšie = skôr; `equipment.json` → `rmg.priorities.train`). */
  get trainPriority(): number {
    return this.rmgDef.priorities.train;
  }

  /** Nový stroj v bayi 0 nad pruhom, spúšťač hore (`carryTier`). */
  static override create(id: EntityId, blockId: EntityId, def: Readonly<RmgDef>, carryTier: number): RmgCrane {
    return new RmgCrane({ id, blockId, def, pose: { gantry: 0, trolley: LANE_ROW, hoist: carryTier } });
  }
}
