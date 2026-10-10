/**
 * EconomySystem — krok 9 ticku (ARCHITECTURE §6, §9.2; ADR-025). Beží len v ticku, v ktorom krok 1 uzavrel herný deň
 * (`DayClosed`); inak nerobí nič a nealokuje.
 *
 * Pri `DayClosed` v tomto poradí:
 * 1. **údržba** — Σ `def.maintenancePerDayCents` všetkých postavených modulov (aj starter modulov, žeriavov) vzostupne
 *    podľa id → jeden `post(−údržba, 'maintenance')`, ak je súčet > 0;
 * 2. **mzdy** — Σ `def.wagePerDayCents` vozidiel + Σ `Module.dailyWageCents()` modulov (žeriav: `params.wagePerDayCents`)
 *    → jeden `post(−mzdy, 'wages')`, ak je súčet > 0;
 * 3. `DaySummary` uzavretého dňa (`clock.gameDay − 1`) a udalosť `DayClosedSummary`;
 * 4. pri `MonthClosed` `MonthSummary` uzavretého mesiaca a udalosť `MonthlyReport`;
 * 5. bankrotové počítadlo (`economy.bankruptcyDays` dní za sebou s hotovosťou < 0) → pri dosiahnutí `GameOver`.
 * Poradie v rámci kroku: údržba → mzdy (vozidlá, moduly vrátane žeriavov a pruhov brány, stroje RTG/RMG/RS) → nájomné parciel
 * (`parcel_lease`, F7, ADR-044) → súhrny. Energia reeferov sa účtuje priebežne (ReeferSystem, R5).
 */
import { DAYS_PER_MONTH, type ClockBoundaries } from '../core/sim-clock';
import { totalLeasePerDayCents } from '../economy/parcel-lease';
import type { World } from '../world/world';

export class EconomySystem {
  /** Krok 9: pri uzavretí dňa údržba, mzdy, súhrny a bankrot; inak nič. */
  tick(world: World, closed: ClockBoundaries): void {
    if (!closed.dayClosed) return;
    const { economy, events, clock } = world;

    let maintenanceCents = 0;
    let wagesCents = 0;
    for (const module of world.modules.values()) {
      maintenanceCents += module.def.maintenancePerDayCents;
      wagesCents += module.dailyWageCents();
    }
    for (const vehicle of world.vehicles.values()) wagesCents += vehicle.def.wagePerDayCents;
    for (const machine of world.machines.values()) wagesCents += machine.dailyWageCents();
    if (maintenanceCents > 0) economy.post(-maintenanceCents, 'maintenance');
    if (wagesCents > 0) economy.post(-wagesCents, 'wages');
    const leaseCents = totalLeasePerDayCents(world.parcels.values(), world.defs.economy.leaseMonthlyRateOfPrice);
    if (leaseCents > 0) economy.post(-leaseCents, 'parcel_lease');

    const day = clock.gameDay - 1;
    events.emit({ type: 'DayClosedSummary', day, summary: economy.closeDay(day) });

    if (closed.monthClosed) {
      const month = clock.gameMonth - 1;
      const firstDay = month * DAYS_PER_MONTH;
      events.emit({ type: 'MonthlyReport', month, summary: economy.closeMonth(month, firstDay, firstDay + DAYS_PER_MONTH - 1) });
    }

    if (economy.recordSolvency(world.defs.economy.bankruptcyDays)) events.emit({ type: 'GameOver', reason: 'bankruptcy', day });
  }
}
