/**
 * Odvodený index obsadenia kamiónov (R4 review TR4-06b) — držitelia TP a státí odstavných plôch a počty kamiónov mieriacich k bráne / predbránovej ploche. **Nie je v save**: zostaví sa
 * lenivo z `World.trucks` a zneplatní sa pri každej zmene polí, z ktorých vzniká (`Truck.watchChanges`, `World.addTruck` / `removeTruck`). Dotazy `tpHolder`, `stallHolder`, `freeStalls`,
 * `laneLoad` a `preGateInbound` tak namiesto skenu všetkých kamiónov pre každý riadok / pruh / státie stoja O(1); jedno prebudovanie je O(kamióny).
 *
 * Pri dvoch držiteľoch toho istého TP / státia (nemá nastať, `World.addTruck` to odmietne) platí prvý podľa poradia kamiónov — ako pri skene.
 */
import type { EntityId } from '../core/entity-id';
import type { Truck } from './truck';

export class TruckIndex {
  private dirty = true;
  private readonly tpHolders = new Map<number, Truck>();
  private readonly stalls = new Map<number, Map<number, Truck>>();
  private readonly stallCounts = new Map<number, number>();
  private readonly inboundToGate = new Map<number, number>();
  private readonly inboundToGateOut = new Map<number, number>();
  private readonly inboundToPreGate = new Map<number, number>();
  private readonly holdingByBlock = new Map<number, Truck[]>();

  constructor(private readonly trucks: ReadonlyMap<EntityId, Truck>) {}

  /** Zneplatní index (zmena kamióna alebo ich množiny). */
  invalidate(): void {
    this.dirty = true;
  }

  /** Kamión držiaci TP `cell`, alebo `undefined`. */
  tpHolder(cell: number): Truck | undefined {
    this.refresh();
    return this.tpHolders.get(cell);
  }

  /** Kamión držiaci státie `stall` odstavnej plochy `holdingId`, alebo `undefined`. */
  stallHolder(holdingId: number, stall: number): Truck | undefined {
    this.refresh();
    return this.stalls.get(holdingId)?.get(stall);
  }

  /** Počet obsadených státí odstavnej plochy `holdingId`. */
  usedStalls(holdingId: number): number {
    this.refresh();
    return this.stallCounts.get(holdingId) ?? 0;
  }

  /** Kamióny v stave `to_gate` k vstupnému pruhu `gateId`. */
  inboundToGateOf(gateId: number): number {
    this.refresh();
    return this.inboundToGate.get(gateId) ?? 0;
  }

  /** Kamióny v stave `to_gate_out` k výstupnému pruhu `gateOutId`. */
  inboundToGateOutOf(gateOutId: number): number {
    this.refresh();
    return this.inboundToGateOut.get(gateOutId) ?? 0;
  }

  /** Kamióny v stave `to_pre_gate` k predbránovej ploche `preGateId`. */
  inboundToPreGateOf(preGateId: number): number {
    this.refresh();
    return this.inboundToPreGate.get(preGateId) ?? 0;
  }

  /** Kamióny v stave `holding` (čakajú v odstavnej ploche na TP) so zastávkou v bloku `blockId`, v poradí id. */
  holdingFor(blockId: number): readonly Truck[] {
    this.refresh();
    return this.holdingByBlock.get(blockId) ?? NONE;
  }

  private refresh(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.tpHolders.clear();
    this.stalls.clear();
    this.stallCounts.clear();
    this.inboundToGate.clear();
    this.inboundToGateOut.clear();
    this.inboundToPreGate.clear();
    this.holdingByBlock.clear();
    for (const truck of this.trucks.values()) {
      if (truck.tpCell !== null && !this.tpHolders.has(truck.tpCell)) this.tpHolders.set(truck.tpCell, truck);
      if (truck.holdingId !== null) {
        this.stallCounts.set(truck.holdingId, (this.stallCounts.get(truck.holdingId) ?? 0) + 1);
        let byStall = this.stalls.get(truck.holdingId);
        if (byStall === undefined) this.stalls.set(truck.holdingId, (byStall = new Map()));
        if (truck.stall !== null && !byStall.has(truck.stall)) byStall.set(truck.stall, truck);
      }
      if (truck.state === 'holding') {
        const list = this.holdingByBlock.get(truck.blockId);
        if (list === undefined) this.holdingByBlock.set(truck.blockId, [truck]);
        else list.push(truck);
      }
      if (truck.state === 'to_gate') bump(this.inboundToGate, truck.gateId);
      else if (truck.state === 'to_gate_out' && truck.gateOutId !== null) bump(this.inboundToGateOut, truck.gateOutId);
      else if (truck.state === 'to_pre_gate' && truck.preGateId !== null) bump(this.inboundToPreGate, truck.preGateId);
    }
  }
}

const NONE: readonly Truck[] = [];

function bump(counts: Map<number, number>, key: number): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
