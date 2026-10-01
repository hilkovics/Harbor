// Testovacie pomôcky pre hotovosť (ADR-025): `World.cashCents` je len na čítanie, zmena ide výlučne cez `Economy.post`.
import type { World } from '@sim/world';

/**
 * Nastaví hotovosť sveta na `cents` jedným `economy.post` (kategória podľa znamienka: `module_sale` / `module_capex`)
 * a zahodí jeho `MoneyChanged`, aby fixtúra nemenila udalosti testovaného kroku. Vyžaduje prázdnu zbernicu udalostí
 * (inak by `flush` zahodil aj cudzie udalosti).
 */
export function setCash(world: World, cents: number): void {
  if (world.events.pending > 0) throw new Error(`setCash: zbernica má ${String(world.events.pending)} neprečítaných udalostí`);
  const delta = cents - world.cashCents;
  if (delta === 0) return;
  world.economy.post(delta, delta > 0 ? 'module_sale' : 'module_capex');
  world.events.flush();
}
