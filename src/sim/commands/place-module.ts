/**
 * `PlaceModule { defId, x, y, rotation }` — stavba modulu (ARCHITECTURE §8 body 1–4, 6, 7; ADR-014, ADR-015).
 * `x`, `y` = ľavý horný roh footprintu **po** rotácii.
 *
 * `validate` vráti všetky platné dôvody naraz (bez duplicít, v poradí `VALIDATION_REASONS`):
 * - `unknown_def` (def nie je v `modules.json`), `invalid_rotation` (mimo 0/90/180/270) — bez nich sa footprint
 *   nedá určiť, preto sa pravidlá umiestnenia vtedy nevyhodnocujú;
 * - pravidlá umiestnenia z `findPlacementViolations` (jediný opis, zdieľaný so starter modulmi a `World.addModule`)
 *   preložené tabuľkou `PLACEMENT_REASON` (cesta vo footprinte a prekryv žeriavov = `occupied`);
 * - `insufficient_funds` len pri `costCents > 0 && costCents > cashCents` (ADR-013).
 * `cells` = footprint po rotácii (row-major, aj bunky mimo mapy — ghost), `costCents` = `def.costCents` (známy def).
 *
 * `apply`: modul cez `world.placeModule` (`ModuleRegistry`, `purchaseCostCents` = zaplatená cena; `ModuleError` je
 * druhá poistka), hotovosť −= cena, `ModulePlaced` a pri nenulovej cene `MoneyChanged(module_capex)`; skupiny
 * kotvísk prepočíta `World`.
 */
import type { ModuleDef } from '../defs/types';
import type { CellCoord } from '../grid/grid';
import { isRotation } from '../grid/rotation';
import { footprintOf } from '../modules/module-geometry';
import { findPlacementViolations, type PlacementRule } from '../world/module-rules';
import type { World } from '../world/world';
import type { Command, SerializedCommand } from './command';
import { CommandError } from './command-error';
import { checkCoordinate, checkFiniteNumber, checkString, readPayload } from './payload';
import { orderReasons, type ValidationReason, type ValidationResult } from './validation';

/** Kľúče serializovaného tvaru v poradí `toJSON`. */
const PLACE_MODULE_KEYS: readonly string[] = ['type', 'defId', 'x', 'y', 'rotation'];

/** Pravidlo umiestnenia → dôvod pre hráča. */
export const PLACEMENT_REASON: { readonly [R in PlacementRule]: ValidationReason } = Object.freeze({
  out_of_bounds: 'out_of_bounds',
  terrain: 'terrain',
  occupied: 'occupied',
  road: 'occupied',
  parcel_not_owned: 'parcel_not_owned',
  no_water_side: 'no_water_side',
  water_blocked: 'water_blocked',
  no_berth: 'no_berth',
  rotation_mismatch: 'rotation_mismatch',
  max_cranes: 'max_cranes',
  crane_overlap: 'occupied',
});

/** Vstup konštruktora (rovnaké polia ako JSON bez `type`). */
export interface PlaceModuleInput {
  readonly defId: string;
  readonly x: number;
  readonly y: number;
  /** Stupne v smere hodinových ručičiek; hodnotu mimo 0/90/180/270 odmietne `validate` (`invalid_rotation`). */
  readonly rotation: number;
}

const NO_CELLS: readonly CellCoord[] = Object.freeze([]);

export class PlaceModuleCommand implements Command {
  static readonly TYPE = 'PlaceModule';

  readonly type = PlaceModuleCommand.TYPE;
  readonly defId: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;

  /**
   * @param input `defId` reťazec, `x`, `y` bezpečné celé čísla (aj mimo mapy — to hlási `validate`), `rotation`
   *   konečné číslo; inak `CommandError`.
   */
  constructor(input: PlaceModuleInput) {
    const type = PlaceModuleCommand.TYPE;
    if (typeof input !== 'object' || input === null) throw new CommandError(`${type}: vstup musí byť objekt { defId, x, y, rotation }`);
    this.defId = checkString(input.defId, type, '/defId');
    this.x = checkCoordinate(input.x, type, '/x');
    this.y = checkCoordinate(input.y, type, '/y');
    this.rotation = checkFiniteNumber(input.rotation, type, '/rotation');
  }

  /** Príkaz z tvaru `{ type: 'PlaceModule', defId, x, y, rotation }`; iný tvar alebo typ poľa → `CommandError`. */
  static fromJSON(json: SerializedCommand): PlaceModuleCommand {
    const raw = readPayload(json, PlaceModuleCommand.TYPE, PLACE_MODULE_KEYS);
    return new PlaceModuleCommand({
      defId: checkString(raw['defId'], PlaceModuleCommand.TYPE, '/defId'),
      x: checkCoordinate(raw['x'], PlaceModuleCommand.TYPE, '/x'),
      y: checkCoordinate(raw['y'], PlaceModuleCommand.TYPE, '/y'),
      rotation: checkFiniteNumber(raw['rotation'], PlaceModuleCommand.TYPE, '/rotation'),
    });
  }

  /** Viď hlavička súboru. Svet sa nemení, `Rng` sa nepoužije (UI volá pri každom pohybe ghostu). */
  validate(world: World): ValidationResult {
    const found = new Set<ValidationReason>();
    const def: Readonly<ModuleDef> | undefined = world.defs.modules.has(this.defId) ? world.defs.modules.get(this.defId) : undefined;
    if (def === undefined) found.add('unknown_def');
    const rotation = isRotation(this.rotation) ? this.rotation : undefined;
    if (rotation === undefined) found.add('invalid_rotation');

    let cells = NO_CELLS;
    if (def !== undefined && rotation !== undefined) {
      cells = footprintOf(def, this.x, this.y, rotation).cells;
      for (const { rule } of findPlacementViolations(world, def, { x: this.x, y: this.y, rotation })) found.add(PLACEMENT_REASON[rule]);
    }
    const costCents = def?.costCents ?? 0;
    if (costCents > 0 && costCents > world.cashCents) found.add('insufficient_funds');
    return Object.freeze({ ok: found.size === 0, reasons: orderReasons(found), cells, costCents });
  }

  /** Vykoná príkaz; svet ho volá len po úspešnom `validate` nad tým istým stavom (inak `Error`, nič nezmení). */
  apply(world: World): void {
    const result = this.validate(world);
    const rotation = this.rotation;
    if (!result.ok || !isRotation(rotation)) {
      throw new Error(`${this.type}.apply: príkaz nie je platný (${result.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    }
    const module = world.placeModule({ defId: this.defId, x: this.x, y: this.y, rotation }, result.costCents);
    const deltaCents = 0 - result.costCents;
    world.cashCents += deltaCents;
    world.events.emit({
      type: 'ModulePlaced',
      moduleId: module.id,
      defId: module.def.id,
      x: module.origin.x,
      y: module.origin.y,
      rotation: module.rotation,
      cells: module.cells,
    });
    if (deltaCents !== 0) world.events.emit({ type: 'MoneyChanged', cashCents: world.cashCents, deltaCents, reason: 'module_capex' });
  }

  toJSON(): SerializedCommand {
    return { type: this.type, defId: this.defId, x: this.x, y: this.y, rotation: this.rotation };
  }
}
