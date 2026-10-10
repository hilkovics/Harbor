/**
 * `SetGateLaneMode { laneId, mode }` — hráč prepne režim pruhu brány v inšpektore (ADR-041 bod 1; TR4-01). Režim je `standard`, `express` alebo `trouble`
 * (`GATE_MODES`); platí od nasledujúceho kamióna (prebiehajúci prechod sa nemení).
 *
 * `validate` (`cells = []`, `costCents` 0):
 * - `unknown_module` — modul s daným id nie je pruh brány;
 * - `invalid_gate_mode` — `mode` nie je režim pruhu.
 */
import type { EntityId } from '../core/entity-id';
import { GATE_MODES, type GateMode } from '../defs/types';
import type { CellCoord } from '../grid/grid';
import { TruckGate } from '../modules/truck-gate';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { checkInteger, checkString, readPayload } from './payload';
import { SimCommand } from './sim-command';
import { orderReasons, type ValidationReason, type ValidationResult } from './validation';

const SET_GATE_LANE_MODE_KEYS: readonly string[] = ['type', 'laneId', 'mode'];
const NO_CELLS: readonly CellCoord[] = Object.freeze([]);

const isMode = (value: string): value is GateMode => (GATE_MODES as readonly string[]).includes(value);

export class SetGateLaneModeCommand extends SimCommand {
  static readonly TYPE = 'SetGateLaneMode';

  readonly type = SetGateLaneModeCommand.TYPE;
  readonly laneId: EntityId;
  /** Režim pruhu (viď hlavička); či je platný, overí `validate`. */
  readonly mode: string;

  constructor(laneId: number, mode: string) {
    super();
    this.laneId = checkInteger(laneId, SetGateLaneModeCommand.TYPE, '/laneId') as EntityId;
    this.mode = checkString(mode, SetGateLaneModeCommand.TYPE, '/mode');
  }

  static fromJSON(json: SerializedCommand): SetGateLaneModeCommand {
    const raw = readPayload(json, SetGateLaneModeCommand.TYPE, SET_GATE_LANE_MODE_KEYS);
    return new SetGateLaneModeCommand(checkInteger(raw['laneId'], SetGateLaneModeCommand.TYPE, '/laneId'), checkString(raw['mode'], SetGateLaneModeCommand.TYPE, '/mode'));
  }

  protected check(world: World): ValidationResult {
    const found = new Set<ValidationReason>();
    if (!(world.modules.get(this.laneId) instanceof TruckGate)) found.add('unknown_module');
    if (!isMode(this.mode)) found.add('invalid_gate_mode');
    return Object.freeze({ ok: found.size === 0, reasons: orderReasons(found), cells: NO_CELLS, costCents: 0 });
  }

  apply(world: World): void {
    const result = this.validate(world);
    const lane = world.modules.get(this.laneId);
    if (!result.ok || !isMode(this.mode) || !(lane instanceof TruckGate)) throw new Error(`${this.type}.apply: príkaz nie je platný (${result.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    lane.setMode(this.mode);
  }

  toJSON(): SerializedCommand {
    return { type: this.type, laneId: this.laneId, mode: this.mode };
  }
}
