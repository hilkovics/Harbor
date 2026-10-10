/**
 * Reach stacker (`ReachStacker extends RtgCrane`, R5, ADR-042 TR5-02; docs/TERMINAL_2.md §4.1, §6.8) — stroj OOG plochy (`acceptsOog`). Má rovnaký FSM a plánovanie cyklov ako RTG
 * (`machines/machine-fsm.ts`, `systems/yard-machine-system.ts`), ale mobilný v uličke plochy: **pojazd** (`gantry`) je poloha v bays pozdĺž uličky, **výložník** (`trolley`, rad od
 * uličky) a **zdvih** (`hoist`, vrstva). Časy sú z `equipment.json` (`reachStacker`). Pre VM: `aislePos` (bay), `boom` 0…1 (0 = zasunutý nad uličkou, 1 = vysunutý na najvzdialenejší rad)
 * a nesený náklad (`cycle.unitId` počas `in_handler`).
 */
import type { EntityId } from '../core/entity-id';
import type { RtgDef } from '../defs/types';
import { LANE_ROW, RtgCrane } from './rtg-crane';
import type { YardMachineInit } from './yard-machine';

/** Id defu reach stackera v `equipment.json` (kľúč `reachStacker` v kóde, `SerializedMachine.defId` v save). */
export const REACH_STACKER_DEF_ID = 'reach_stacker';

export class ReachStacker extends RtgCrane {
  constructor(init: YardMachineInit & { readonly def: Readonly<RtgDef> }) {
    super({ ...init, defId: REACH_STACKER_DEF_ID });
  }

  /** Poloha pozdĺž uličky (bays, spojitá) — VM `MachineVM` pose. */
  aislePos(): number {
    return this.poseNow().gantry;
  }

  /** Výložník 0…1 pre `rows` radov plochy: 0 nad uličkou (`LANE_ROW`), 1 na najvzdialenejšom rade; spojitý počas fázy. */
  boom(rows: number): number {
    const reach = Math.max(1, rows);
    return Math.min(1, Math.max(0, (this.poseNow().trolley - LANE_ROW) / reach));
  }

  /** Nový stroj v bayi 0 s výložníkom zasunutým a spúšťačom hore (`carryTier`). */
  static override create(id: EntityId, blockId: EntityId, def: Readonly<RtgDef>, carryTier: number): ReachStacker {
    return new ReachStacker({ id, blockId, def, pose: { gantry: 0, trolley: LANE_ROW, hoist: carryTier } });
  }
}
