/**
 * `SetBlockPriority { blockId, order }` — hráč povýši druh úlohy, ktorý RTG blok obsluhuje ako prvý (ADR-040 bod 6; TR3-02). `order` je druh z `YARD_PRIORITY_KINDS`
 * (`ship`, `truck`, `housekeeping`); ostatné druhy nasledujú vo východiskovom poradí z `equipment.json` (loď > kamión > housekeeping). Poradie vo fronte stroja
 * je `(priorita, createdTick, id vozidla)`, takže zmena sa prejaví pri najbližšom výbere ďalšieho cyklu; rozpracovaný cyklus sa nepreruší.
 *
 * `validate` (`cells = []`, `costCents` 0):
 * - `unknown_module` — modul s daným id nie je RTG blok so strojom;
 * - `invalid_priority` — `order` nie je druh úlohy.
 */
import type { EntityId } from '../core/entity-id';
import { YARD_PRIORITY_KINDS, type YardPriorityKind } from '../defs/types';
import type { CellCoord } from '../grid/grid';
import { RtgBlock } from '../modules/rtg-block';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { checkInteger, checkString, readPayload } from './payload';
import { SimCommand } from './sim-command';
import { orderReasons, type ValidationReason, type ValidationResult } from './validation';

const SET_BLOCK_PRIORITY_KEYS: readonly string[] = ['type', 'blockId', 'order'];
const NO_CELLS: readonly CellCoord[] = Object.freeze([]);

const isKind = (value: string): value is YardPriorityKind => (YARD_PRIORITY_KINDS as readonly string[]).includes(value);

export class SetBlockPriorityCommand extends SimCommand {
  static readonly TYPE = 'SetBlockPriority';

  readonly type = SetBlockPriorityCommand.TYPE;
  readonly blockId: EntityId;
  /** Druh úlohy obsluhovaný ako prvý (viď hlavička); či je platný, overí `validate`. */
  readonly order: string;

  constructor(blockId: number, order: string) {
    super();
    this.blockId = checkInteger(blockId, SetBlockPriorityCommand.TYPE, '/blockId') as EntityId;
    this.order = checkString(order, SetBlockPriorityCommand.TYPE, '/order');
  }

  static fromJSON(json: SerializedCommand): SetBlockPriorityCommand {
    const raw = readPayload(json, SetBlockPriorityCommand.TYPE, SET_BLOCK_PRIORITY_KEYS);
    return new SetBlockPriorityCommand(checkInteger(raw['blockId'], SetBlockPriorityCommand.TYPE, '/blockId'), checkString(raw['order'], SetBlockPriorityCommand.TYPE, '/order'));
  }

  protected check(world: World): ValidationResult {
    const found = new Set<ValidationReason>();
    const block = world.modules.get(this.blockId);
    if (!(block instanceof RtgBlock) || world.machineOfBlock(block.id) === undefined) found.add('unknown_module');
    if (!isKind(this.order)) found.add('invalid_priority');
    return Object.freeze({ ok: found.size === 0, reasons: orderReasons(found), cells: NO_CELLS, costCents: 0 });
  }

  apply(world: World): void {
    const result = this.validate(world);
    if (!result.ok || !isKind(this.order)) throw new Error(`${this.type}.apply: príkaz nie je platný (${result.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    const machine = world.machineOfBlock(this.blockId);
    if (machine === undefined) throw new Error(`${this.type}.apply: blok #${String(this.blockId)} nemá stroj`);
    machine.setFirstPriority(this.order);
  }

  toJSON(): SerializedCommand {
    return { type: this.type, blockId: this.blockId, order: this.order };
  }
}
