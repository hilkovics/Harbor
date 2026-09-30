/**
 * Modul (ARCHITECTURE §5, §5.3): entita postavená na mriežke podľa `ModuleDef`. Konkrétne druhy sú triedy
 * (`BerthModule`, `CraneModule`, neskôr `StorageModule`…) zaregistrované v `ModuleRegistry` podľa `def.kind`
 * (pravidlo 7 — žiadne switch-e podľa druhu).
 *
 * Geometria je nemenná: `origin` = ľavý horný roh footprintu **po** rotácii, `size` a `cells` po rotácii. Mriežku
 * (`cell.moduleId`) zapisuje až `World.addModule` — samotná inštancia svet nemení.
 */
import type { EntityId } from '../core/entity-id';
import type { ModuleDef, ModuleKind } from '../defs/types';
import type { CellCoord, Grid } from '../grid/grid';
import { isRotation, type Rotation } from '../grid/rotation';
import { ModuleError } from './module-error';
import { footprintOf } from './module-geometry';
import { checkRuntimeKeys, type ModuleRuntimeState } from './runtime-state';

/** Vstup konštruktora modulu (factory v `ModuleRegistry` ho dostane hotový). */
export interface ModuleInit {
  readonly def: Readonly<ModuleDef>;
  readonly id: EntityId;
  /** Ľavý horný roh footprintu po rotácii. */
  readonly origin: CellCoord;
  readonly rotation: Rotation;
  /** Skutočne zaplatená cena (starter moduly 0) — základ refundácie (T02-04). */
  readonly purchaseCostCents: number;
  /** Mriežka sveta, do ktorého modul patrí — len na čítanie (hranice, hĺbka, berth pod žeriavom). */
  readonly grid: Grid;
}

function isEntityId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export abstract class Module {
  readonly id: EntityId;
  readonly def: Readonly<ModuleDef>;
  readonly kind: ModuleKind;
  readonly origin: CellCoord;
  readonly rotation: Rotation;
  /** Rozmery footprintu po rotácii. */
  readonly size: { readonly w: number; readonly h: number };
  /** Bunky footprintu row-major. */
  readonly cells: readonly CellCoord[];
  readonly purchaseCostCents: number;

  /**
   * Chyby (`ModuleError`): id nie je celé ≥ 1 alebo cena nie je celé ≥ 0 alebo neplatná rotácia →
   * `invalid_input`; footprint presahuje mapu → `out_of_bounds`.
   */
  protected constructor(init: ModuleInit) {
    const { def, id, origin, rotation, purchaseCostCents, grid } = init;
    if (!isEntityId(id)) throw new ModuleError('invalid_input', `modul '${def.id}': id musí byť celé číslo ≥ 1, dostal ${String(id)}`);
    if (!Number.isSafeInteger(purchaseCostCents) || purchaseCostCents < 0) {
      throw new ModuleError('invalid_input', `modul '${def.id}': purchaseCostCents musí byť celé číslo ≥ 0, dostal ${String(purchaseCostCents)}`);
    }
    if (!isRotation(rotation)) {
      throw new ModuleError('invalid_input', `modul '${def.id}': rotácia musí byť 0, 90, 180 alebo 270, dostal ${String(rotation)}`);
    }
    const { size, cells } = footprintOf(def, origin.x, origin.y, rotation);
    if (!grid.rectInBounds({ x: origin.x, y: origin.y, w: size.w, h: size.h })) {
      throw new ModuleError(
        'out_of_bounds',
        `modul '${def.id}' #${String(id)}: footprint ${String(size.w)}×${String(size.h)} na (${String(origin.x)}, ${String(origin.y)}) presahuje mapu ${String(grid.width)}×${String(grid.height)}`,
      );
    }
    this.id = id;
    this.def = def;
    this.kind = def.kind;
    this.origin = Object.freeze({ x: origin.x, y: origin.y });
    this.rotation = rotation;
    this.size = size;
    this.cells = cells;
    this.purchaseCostCents = purchaseCostCents;
  }

  /** Leží bunka vo footprinte modulu? */
  containsCell(x: number, y: number): boolean {
    return x >= this.origin.x && y >= this.origin.y && x < this.origin.x + this.size.w && y < this.origin.y + this.size.h;
  }

  /** Popis do chybových správ: `berth_standard #3`. */
  get label(): string {
    return `${this.def.id} #${String(this.id)}`;
  }

  /**
   * Dynamický stav pre save (čistý JSON, nová kópia pri každom volaní). Základ: modul bez vlastného stavu → `{}`.
   * Podtrieda so stavom prepíše `getRuntimeState` aj `restoreRuntimeState`.
   */
  getRuntimeState(): ModuleRuntimeState {
    return {};
  }

  /**
   * Obnoví dynamický stav zo `getRuntimeState()` (aj po `JSON.parse`); volá sa na novej inštancii pred
   * `World.addModule`. Neplatný stav → `ModuleStateError` s cestou relatívnou k `runtime`. Základ: len `{}`.
   */
  restoreRuntimeState(raw: unknown): void {
    checkRuntimeKeys(raw, []);
  }
}
