// Spoločné pomôcky pre testy modulov (T02-03): defy s testovacími variantmi, syntetická mriežka a inštancie modulov
// cez ModuleRegistry bez sveta. Stavbu modulov vo svete (World.placeModule) majú harbor-fixtures.ts.
//
// Mapa harbor_01: nábrežie (Q) y 14–16, x 10–85; hĺbka nábrežia x 10–29 → 2, x 30–57 → 1, x 58–59 → 1 (mimo zón),
// x 60–85 → 3. Pevnina y ≥ 17, voda y ≤ 13.
import { APRON_MODULES as modulesJson } from '../helpers/apron-modules';
import { CargoLedger } from '@sim/cargo';
import { EntityIdAllocator, EventBus, type EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { Grid, type CellCoord, type Rect, type Rotation } from '@sim/grid';
import { BerthModule, CraneModule, moduleRegistry } from '@sim/modules';
import { RAW_DEFS } from '../world/world-fixtures';

export const BERTH = 'berth_standard';
export const CRANE = 'crane_container_gantry';
/** Hlboké testovacie kotvisko: `depthClass 3`, 6 slotov apronu. */
export const DEEP_BERTH = 'berth_deep_test';
/** Testovací žeriav 1×3 (užší než štandardný 2×3). */
export const NARROW_CRANE = 'crane_narrow_test';

const [berthJson, craneJson] = modulesJson.items;

/** Bundled defy + testovacie varianty kotviska a žeriavu. */
export const MODULE_DEFS: DefRegistry = DefRegistry.fromRaw({
  ...RAW_DEFS,
  modules: {
    ...modulesJson,
    items: [
      ...modulesJson.items,
      { ...berthJson, id: DEEP_BERTH, params: { ...berthJson.params, depthClass: 3, apronSlots: 6 } },
      { ...craneJson, id: NARROW_CRANE, footprint: { w: 1, h: 3 } },
    ],
  },
});

export const id = (value: number): EntityId => value as EntityId;

/**
 * Prázdny ledger pre moduly mimo sveta (T03-02): moduly so slotmi čítajú obsadenie z ledgera (ADR-017), preto ho
 * `ModuleEnv` vyžaduje aj tam, kde náklad nie je.
 */
export function emptyCargo(defs: DefRegistry = MODULE_DEFS): CargoLedger {
  return new CargoLedger({ cargoTypes: defs.cargoTypes, containerTypes: defs.containerTypes, ids: new EntityIdAllocator(), events: new EventBus<SimEvent>(), clock: { tick: 0 } });
}

/** Syntetická mriežka `w×h` celá z nábrežia s jednou hĺbkou (skupiny kotvísk vo všetkých rotáciách). */
export function quayGrid(w: number, h: number, depthClass: 1 | 2 | 3 = 3): Grid {
  return new Grid(w, h, () => ({ terrain: 'quay', depthClass }));
}

/** BerthModule na ľubovoľnej mriežke cez predvolený ModuleRegistry (id priamo, bez sveta). */
export function berthOn(grid: Grid, moduleId: number, origin: CellCoord, rotation: Rotation = 0, defId = BERTH, cargo = emptyCargo()): BerthModule {
  const module = moduleRegistry.create(MODULE_DEFS.modules.get(defId), { defId, x: origin.x, y: origin.y, rotation }, id(moduleId), 0, { grid, cargo });
  if (!(module instanceof BerthModule)) throw new Error(`${defId} nie je BerthModule`);
  return module;
}

/** Zapíše `moduleId` do buniek obdĺžnika (berth pod žeriavom bez sveta). */
export function markCells(grid: Grid, moduleId: number, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) grid.at(x, y).moduleId = id(moduleId);
  }
}

/** CraneModule na ľubovoľnej mriežke (pod ľavým horným rohom musí byť `moduleId` berthu). */
export function craneOn(grid: Grid, moduleId: number, origin: CellCoord, rotation: Rotation = 0, defId = CRANE, cargo = emptyCargo()): CraneModule {
  const module = moduleRegistry.create(MODULE_DEFS.modules.get(defId), { defId, x: origin.x, y: origin.y, rotation }, id(moduleId), 0, { grid, cargo });
  if (!(module instanceof CraneModule)) throw new Error(`${defId} nie je CraneModule`);
  return module;
}
