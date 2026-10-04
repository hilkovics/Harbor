// Stavba modulov vo svete pre testy (T02-03): World.placeModule bez pravidiel umiestnenia §8 (tie má PlaceModule,
// T02-04). Defy s testovacími variantmi sú v module-fixtures.ts. Svet je na harbor_01 bez Root modulu (BARE_MAP),
// aby testy stavali kotvisko a žeriavy na (40, 14) samy; starter moduly testuje tests/sim/world/starter-modules.test.ts.
import type { Rotation } from '@sim/grid';
import { BerthModule, CraneModule, type Module } from '@sim/modules';
import { World } from '@sim/world';
import { BARE_MAP, SEED } from '../world/world-fixtures';
import { BERTH, CRANE, MODULE_DEFS } from './module-fixtures';

export function newWorld(defs = MODULE_DEFS): World {
  return World.create(defs, BARE_MAP, SEED);
}

/** Postaví modul cez `World.placeModule`. */
export function place(world: World, defId: string, x: number, y: number, rotation: Rotation = 0, costCents = 0): Module {
  return world.placeModule({ defId, x, y, rotation }, costCents);
}

export function placeBerth(world: World, x: number, y = 14, rotation: Rotation = 0, defId = BERTH): BerthModule {
  const module = place(world, defId, x, y, rotation);
  if (!(module instanceof BerthModule)) throw new Error(`${defId} nie je BerthModule`);
  return module;
}

export function placeCrane(world: World, x: number, y = 14, rotation: Rotation = 0, defId = CRANE): CraneModule {
  const module = place(world, defId, x, y, rotation);
  if (!(module instanceof CraneModule)) throw new Error(`${defId} nie je CraneModule`);
  return module;
}
