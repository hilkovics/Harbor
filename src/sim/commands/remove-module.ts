/**
 * `RemoveModule { moduleId }` — odstránenie modulu (ARCHITECTURE §8 bod 8; ADR-014, ADR-015).
 *
 * `validate`: neznáme id → `unknown_module` (bez buniek a ceny); inak všetky porušenia z `findRemovalViolations`
 * (rovnaká funkcia stráži `World.removeModule`): `has_cargo` (náklad v module, obsadený/rezervovaný slot apronu),
 * `has_cranes`, `ship_docked` (kotvisko alebo žeriav na kotvisku, ktoré drží loď), `busy` (žeriav mimo
 * `idle`/`blocked`). `cells` = footprint modulu, `costCents` =
 * −refundácia (záporná = príjem, ADR-013).
 *
 * Refundácia (rozhodnutie 2) = `refundCents(purchaseCostCents, economy.removalRefundRate)` zo **zaplatenej** ceny,
 * nie z ceny v defe — starter moduly (`purchaseCostCents 0`) nevrátia nič. `apply`: `world.removeModule` (uvoľní
 * bunky, prepočíta skupiny; `ModuleError` je druhá poistka), hotovosť += refundácia, `ModuleRemoved` a len pri
 * refundácii > 0 `MoneyChanged(module_sale)`.
 */
import type { EntityId } from '../core/entity-id';
import type { CellCoord } from '../grid/grid';
import { findRemovalViolations } from '../world/module-rules';
import type { World } from '../world/world';
import type { Command, SerializedCommand } from './command';
import { checkInteger, readPayload } from './payload';
import { refundCents } from './refund';
import { orderReasons, type ValidationReason, type ValidationResult } from './validation';

/** Kľúče serializovaného tvaru `{ type, moduleId }`. */
const REMOVE_MODULE_KEYS: readonly string[] = ['type', 'moduleId'];

const UNKNOWN_MODULE: ValidationResult = Object.freeze({
  ok: false,
  reasons: Object.freeze(['unknown_module'] as const),
  cells: Object.freeze([] as CellCoord[]),
  costCents: 0,
});

export class RemoveModuleCommand implements Command {
  static readonly TYPE = 'RemoveModule';

  readonly type = RemoveModuleCommand.TYPE;
  readonly moduleId: EntityId;

  /** @param moduleId bezpečné celé číslo (inak `CommandError`); či modul existuje, overí `validate`. */
  constructor(moduleId: number) {
    this.moduleId = checkInteger(moduleId, RemoveModuleCommand.TYPE, '/moduleId') as EntityId;
  }

  /** Príkaz z tvaru `{ type: 'RemoveModule', moduleId }`; iný tvar → `CommandError`. */
  static fromJSON(json: SerializedCommand): RemoveModuleCommand {
    const raw = readPayload(json, RemoveModuleCommand.TYPE, REMOVE_MODULE_KEYS);
    return new RemoveModuleCommand(checkInteger(raw['moduleId'], RemoveModuleCommand.TYPE, '/moduleId'));
  }

  /** Viď hlavička súboru. Svet sa nemení, `Rng` sa nepoužije. */
  validate(world: World): ValidationResult {
    const module = world.modules.get(this.moduleId);
    if (module === undefined) return UNKNOWN_MODULE;
    const found = new Set<ValidationReason>(findRemovalViolations(world, module).map((violation) => violation.rule));
    const refund = refundCents(module.purchaseCostCents, world.defs.economy.removalRefundRate);
    return Object.freeze({ ok: found.size === 0, reasons: orderReasons(found), cells: module.cells, costCents: 0 - refund });
  }

  /** Vykoná príkaz; svet ho volá len po úspešnom `validate` nad tým istým stavom (inak `Error`, nič nezmení). */
  apply(world: World): void {
    const result = this.validate(world);
    if (!result.ok) {
      throw new Error(`${this.type}.apply: príkaz nie je platný (${result.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    }
    const module = world.removeModule(this.moduleId);
    const deltaCents = 0 - result.costCents;
    world.cashCents += deltaCents;
    world.events.emit({ type: 'ModuleRemoved', moduleId: module.id, defId: module.def.id, cells: module.cells });
    if (deltaCents > 0) world.events.emit({ type: 'MoneyChanged', cashCents: world.cashCents, deltaCents, reason: 'module_sale' });
  }

  toJSON(): SerializedCommand {
    return { type: this.type, moduleId: this.moduleId };
  }
}
