/**
 * Plánovanie toku prázdnych kontajnerov (F6c, ADR-034 bod 5, 6, 8 + dodatok T6C-02) — jediné miesta, kde sa z `Rng` losuje, či a kedy
 * sa prázdny kontajner vráti alebo vydá. Výsledok ide do `World.emptyFlow` (save), spotrebuje ho krok 8 (`empty-trucks.ts`).
 *
 * - **Návrat** (`planEmptyReturn`, krok 8, kamión s importom opustil mapu `in_truck → exported`): `Rng.chance(emptyReturnRate)`; ak vyjde,
 *   `Rng.range(hinterlandDaysRange)` dní → `returnPlan { dueTick = tick + max(1, round(dni × ticksPerDay)), lineId, sizeFt }` (veľkosť zdedená od importu, ADR-039).
 * - **Výdaj** (`planEmptyPickups`, `AcceptContract` export bookingu po jeho plánoch príchodov): pre každý plánovaný príchod naloženej
 *   jednotky `Rng.chance(emptyPickupRate)`; ak vyjde, `Rng.range(emptyPickupLeadHoursRange)` hodín pred príchodom →
 *   `pickupPlan { dueTick = max(tick + 1, príchod − round(hodiny × ticksPerHour)), lineId bookingu, contractId }`.
 *
 * Obe sa plánujú **len v prístave s depom prázdnych** (`hasEmptyDepot`, dodatok T6C-02, odchýlka 7): prázdny, ktorý nemá kam ísť, by sa
 * hromadil v dvore bez východu, a svet bez depa tak ostáva bitovo rovnaký ako vo F6a (žiadny ťah `Rng` navyše).
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import type { Contract } from '../contracts/contract';
import { hasEmptyDepot } from '../logistics/empty-stock';
import type { World } from '../world/world';

/** Najkratší odstup návratu od odchodu importu (tick) — prázdny nikdy nepríde v ticku, keď import odišiel. */
const MIN_RETURN_TICKS = 1;

/**
 * Jednotka importu `unit` práve opustila mapu kamiónom: naplánuje návrat prázdneho kontajnera jej linky (viď hlavička). Jednotka iného
 * smeru, bez linky, alebo prístav bez depa → nič (a `Rng` sa nespotrebuje).
 */
export function planEmptyReturn(world: World, unit: CargoUnit): void {
  if (unit.direction !== 'import' || unit.lineId === null || !hasEmptyDepot(world)) return;
  const { emptyReturnRate, hinterlandDaysRange } = world.defs.logistics.emptyFlow;
  if (!world.rng.chance(emptyReturnRate)) return;
  const { tick, ticksPerDay } = world.clock;
  const delay = Math.max(MIN_RETURN_TICKS, Math.round(world.rng.range(hinterlandDaysRange[0], hinterlandDaysRange[1]) * ticksPerDay));
  world.emptyFlow.scheduleReturn(tick + delay, unit.lineId, unit.sizeFt);
}

/**
 * Export booking `contract` práve prijatý (jeho plán príchodov je naplánovaný): pre časť jednotiek naplánuje výdaj prázdneho
 * kontajnera linky bookingu pred príchodom naloženého exportu (viď hlavička). Kontrakt iného druhu než `export` (repositioning,
 * prekládka), bez bookingu alebo prístav bez depa → nič.
 */
export function planEmptyPickups(world: World, contract: Contract): void {
  const booking = contract.booking;
  if (contract.kind !== 'export' || booking === null || !hasEmptyDepot(world)) return;
  const { emptyPickupRate, emptyPickupLeadHoursRange } = world.defs.logistics.emptyFlow;
  const { tick, ticksPerHour } = world.clock;
  for (const arrival of booking.arrivalPlan) {
    if (!world.rng.chance(emptyPickupRate)) continue;
    const lead = Math.round(world.rng.range(emptyPickupLeadHoursRange[0], emptyPickupLeadHoursRange[1]) * ticksPerHour);
    world.emptyFlow.schedulePickup(Math.max(tick + 1, arrival - lead), contract.lineId, contract.id);
  }
}
