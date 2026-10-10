/**
 * `SetCraneGang { craneId, mode, tractorsPerSts }` — hráč prepne prideľovanie ťahačov žeriavu STS (ADR-040 bod 7; TR3-02):
 * - `pool`: žeriav dostane najbližší voľný ťahač z bazéna (ťahače, ktoré nepatria do gangu žiadneho žeriava),
 * - `gang`: žeriav má pevnú skupinu `tractorsPerSts` ťahačov (`logistics/gang-roster.ts`), ktoré obsluhujú len jeho joby.
 * Rozpracované joby sa nemenia; zmena platí pre ďalšie priradenia dispatcherom.
 *
 * `validate` (`cells = []`, `costCents` 0):
 * - `unknown_module` — modul s daným id nie je žeriav;
 * - `invalid_gang` — `mode` nie je `pool` / `gang`, alebo `tractorsPerSts` nie je celé číslo v `equipment.json` `tractors.minPerSts … maxPerSts`.
 */
import type { EntityId } from '../core/entity-id';
import { CRANE_GANG_MODES, type CraneGangMode } from '../defs/types';
import type { CellCoord } from '../grid/grid';
import { CraneModule } from '../modules/crane-module';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { checkFiniteNumber, checkInteger, checkString, readPayload } from './payload';
import { SimCommand } from './sim-command';
import { orderReasons, type ValidationReason, type ValidationResult } from './validation';

const SET_CRANE_GANG_KEYS: readonly string[] = ['type', 'craneId', 'mode', 'tractorsPerSts'];
const NO_CELLS: readonly CellCoord[] = Object.freeze([]);

const isMode = (value: string): value is CraneGangMode => (CRANE_GANG_MODES as readonly string[]).includes(value);

export class SetCraneGangCommand extends SimCommand {
  static readonly TYPE = 'SetCraneGang';

  readonly type = SetCraneGangCommand.TYPE;
  readonly craneId: EntityId;
  /** `pool` alebo `gang`; či je platný, overí `validate`. */
  readonly mode: string;
  readonly tractorsPerSts: number;

  constructor(craneId: number, mode: string, tractorsPerSts: number) {
    super();
    this.craneId = checkInteger(craneId, SetCraneGangCommand.TYPE, '/craneId') as EntityId;
    this.mode = checkString(mode, SetCraneGangCommand.TYPE, '/mode');
    this.tractorsPerSts = checkFiniteNumber(tractorsPerSts, SetCraneGangCommand.TYPE, '/tractorsPerSts');
  }

  static fromJSON(json: SerializedCommand): SetCraneGangCommand {
    const raw = readPayload(json, SetCraneGangCommand.TYPE, SET_CRANE_GANG_KEYS);
    return new SetCraneGangCommand(
      checkInteger(raw['craneId'], SetCraneGangCommand.TYPE, '/craneId'),
      checkString(raw['mode'], SetCraneGangCommand.TYPE, '/mode'),
      checkFiniteNumber(raw['tractorsPerSts'], SetCraneGangCommand.TYPE, '/tractorsPerSts'),
    );
  }

  protected check(world: World): ValidationResult {
    const found = new Set<ValidationReason>();
    if (!(world.modules.get(this.craneId) instanceof CraneModule)) found.add('unknown_module');
    const { minPerSts, maxPerSts } = world.defs.equipment.tractors;
    if (!isMode(this.mode) || !Number.isInteger(this.tractorsPerSts) || this.tractorsPerSts < minPerSts || this.tractorsPerSts > maxPerSts) found.add('invalid_gang');
    return Object.freeze({ ok: found.size === 0, reasons: orderReasons(found), cells: NO_CELLS, costCents: 0 });
  }

  apply(world: World): void {
    const result = this.validate(world);
    const crane = world.modules.get(this.craneId);
    if (!result.ok || !isMode(this.mode) || !(crane instanceof CraneModule)) {
      throw new Error(`${this.type}.apply: príkaz nie je platný (${result.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    }
    crane.gangMode = this.mode;
    crane.tractorsPerSts = this.tractorsPerSts;
  }

  toJSON(): SerializedCommand {
    return { type: this.type, craneId: this.craneId, mode: this.mode, tractorsPerSts: this.tractorsPerSts };
  }
}
