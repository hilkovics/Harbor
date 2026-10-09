/**
 * Odstavná plocha kamiónov (R4, ADR-041 bod 5; GDD 8.4) — parkovisko so státiami 1 × 3 mimo pruhov za vstupnou bránou pre kamióny, ktoré prišli pred termínom alebo čakajú na kontajner
 * či voľné TP. Kamión sem prejde (`to_holding → holding`, abstraktne v module, mimo cesty) a TOS ho zavolá k TP (`holding → to_tp`), keď je jeho jednotka pripravená a TP voľné
 * (`systems/landside-system.ts`, `trucks/holding.ts`). Plocha nedrží stav: obsadenie státí je odvodené z kamiónov (`Truck.holdingId` + `Truck.stall`), `runtime` v save je `{}`.
 *
 * Geometria (def `truck_holding`, footprint 6 × 5): státie `i` leží v stĺpci `i mod w`, v pásme `⌊i / w⌋` (3 riadky na pásmo); zvyšné riadky sú ulička s konektormi. Vjazd je prvý
 * konektor defu (`access: in`), výjazd druhý (`access: out`).
 */
import { holdingParams } from '../defs/module-def';
import type { HoldingParams } from '../defs/types';
import { rotateLocalCell } from '../grid/rotation';
import { LandExportModule, type LandsideRole, type LandsideRoster } from './land-export-module';
import type { ModuleInit } from './module';

/** Dĺžka státia v bunkách (1 × 3, ADR-041 bod 5). */
export const STALL_LENGTH_CELLS = 3;

/** Bunka státia vo svete pre VM `holdingSlots` (stredná bunka státia). */
export interface StallCell {
  readonly x: number;
  readonly y: number;
}

export class TruckHolding extends LandExportModule {
  /** Typované `params` defu (`holdingParams`). */
  readonly params: HoldingParams;

  /** Def iného druhu než `holding` → `DefError`. */
  constructor(init: ModuleInit) {
    super(init);
    this.params = holdingParams(init.def);
  }

  override get landsideRole(): LandsideRole {
    return 'holding';
  }

  override get internalTicks(): number | undefined {
    return undefined;
  }

  override enlist(roster: LandsideRoster): void {
    roster.holdings.push(this);
  }

  /** Počet státí (`params.stalls`). */
  get stalls(): number {
    return this.params.stalls;
  }

  /** Stredná bunka státia `stall` vo svete (po rotácii modulu); mimo `0 … stalls − 1` → `RangeError`. */
  stallCell(stall: number): StallCell {
    if (!Number.isInteger(stall) || stall < 0 || stall >= this.stalls) throw new RangeError(`${this.label}.stallCell: státie ${String(stall)} mimo 0…${String(this.stalls - 1)}`);
    const { w, h } = this.def.footprint;
    const local = rotateLocalCell(stall % w, Math.floor(stall / w) * STALL_LENGTH_CELLS + 1, w, h, this.rotation);
    return { x: this.origin.x + local.x, y: this.origin.y + local.y };
  }

  /** Bunky všetkých státí (poradie = index státia). */
  stallCells(): readonly StallCell[] {
    return Array.from({ length: this.stalls }, (_, stall) => this.stallCell(stall));
  }
}
