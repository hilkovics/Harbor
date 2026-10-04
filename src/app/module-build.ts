/**
 * Build mód modulov (T02-10, ARCHITECTURE §8, §15.2): čisté funkcie, ktoré z bunky pod kurzorom, definície modulu
 * a rotácie zostavia umiestnenie, ghost pre render a výsledok validácie. Bez DOM a bez stavu — `InputController`
 * ich volá pri každom pohybe myši, testujú sa v Node.
 *
 * - Ghost je vycentrovaný: bunka pod kurzorom je stredom footprintu po rotácii (pri párnom rozmere bunka
 *   `floor(rozmer / 2)` od ľavého horného rohu), takže po otočení `R` ghost ostáva pod kurzorom.
 * - Ghost je zelený, keď ho `PlaceModule` prijme; pri `insufficient_funds` (a žiadnom inom dôvode) je stále zelený
 *   a tooltip ukáže ikonu $ (§8 bod 6) — príkaz sa ale neodošle (`placeable === false`).
 */
import { PlaceModuleCommand, type Command, type ValidationReason, type ValidationResult } from '@sim/commands';
import type { ModuleDef } from '@sim/defs';
import { ROTATIONS, rotateFootprint, type CellCoord, type Rotation } from '@sim/grid';
import { connectorsOf } from '@sim/modules';
import type { ModuleGhostVM } from '@render/view-models';

/** Umiestnenie modulu: `x`, `y` = ľavý horný roh footprintu PO rotácii (rovnako ako `PlaceModule`). */
export interface ModulePlacement {
  readonly defId: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
}

/** Ďalšia rotácia v smere hodinových ručičiek: 0 → 90 → 180 → 270 → 0. */
export function nextRotation(rotation: Rotation): Rotation {
  const index = ROTATIONS.indexOf(rotation);
  return ROTATIONS[(index + 1) % ROTATIONS.length];
}

/** Umiestnenie, pri ktorom bunka `cell` leží v strede footprintu `def` po rotácii. */
export function placementAt(def: Readonly<ModuleDef>, cell: CellCoord, rotation: Rotation): ModulePlacement {
  const size = rotateFootprint(def.footprint.w, def.footprint.h, rotation);
  return { defId: def.id, x: cell.x - Math.floor(size.w / 2), y: cell.y - Math.floor(size.h / 2), rotation };
}

/** Príkaz `PlaceModule` pre umiestnenie. */
export function placeCommand(placement: ModulePlacement): PlaceModuleCommand {
  return new PlaceModuleCommand({ defId: placement.defId, x: placement.x, y: placement.y, rotation: placement.rotation });
}

/** Ghost modulu, výsledok validácie a odvodené príznaky pre ovládanie a tooltip. */
export interface ModulePreview {
  readonly placement: ModulePlacement;
  /** VM pre `BuildLayer.setModuleGhost` (`valid` ignoruje nedostatok peňazí, viď hlavička). */
  readonly ghost: ModuleGhostVM;
  readonly result: ValidationResult;
  /** Príkaz by prešiel — klik ho smie odoslať. */
  readonly placeable: boolean;
  /** Hráč nemá na cenu (`insufficient_funds`); ghost môže byť napriek tomu zelený. */
  readonly fundsShort: boolean;
}

/** Ghost je platný, ak `PlaceModule` neodmietol nič okrem nedostatku peňazí. */
function layoutAllowed(reasons: readonly ValidationReason[]): boolean {
  return reasons.every((reason) => reason === 'insufficient_funds');
}

/**
 * Náhľad umiestnenia modulu `def` s bunkou `cell` v strede: validuje `PlaceModule` cez `validate` (svet nemení)
 * a zloží `ModuleGhostVM` s konektormi vo svetových bunkách po rotácii.
 */
export function previewModule(
  def: Readonly<ModuleDef>,
  cell: CellCoord,
  rotation: Rotation,
  validate: (command: Command) => ValidationResult,
): ModulePreview {
  const placement = placementAt(def, cell, rotation);
  const result = validate(placeCommand(placement));
  const size = rotateFootprint(def.footprint.w, def.footprint.h, rotation);
  const ghost: ModuleGhostVM = {
    defId: def.id,
    x: placement.x,
    y: placement.y,
    rotation,
    w: size.w,
    h: size.h,
    valid: layoutAllowed(result.reasons),
    connectors: connectorsOf(def, placement.x, placement.y, rotation).map((connector) => ({ x: connector.x, y: connector.y, side: connector.side })),
  };
  return { placement, ghost, result, placeable: result.ok, fundsShort: result.reasons.includes('insufficient_funds') };
}
