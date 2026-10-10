/**
 * Lashing lode v prezentácii (F6a, ADR-032 bod 11, 12): celková doba lashingu a papierov, ktorú potrebuje progres
 * (`ShipVM.lashing.ticksTotal`, `LashingData.totalTicks` inšpektora).
 *
 * - `lashingTotalTicks` = `lashingTicksPerUnit × naložený export + paperworkTicks` z defu triedy lode (typovaný prístup,
 *   rovnaký vzorec ako sim pri `docked → lashing`).
 * - `LashingTracker` si z udalosti `ShipLashingStarted` pamätá skutočný `ticks` lode (zdroj pravdy simu; chráni pred
 *   rozdielom, ak by sa vzorec v sime upravil) a zabudne ho po odsune lode od kotviska (`ShipUndocked`) alebo odchode
 *   z mapy (`ShipDeparted`). Bez záznamu (napr. po načítaní save uprostred lashingu, keď udalosť už nepríde) sa použije
 *   vzorec z defu. Stav je čisto prezentačný — nejde do save a nemení sa tok nákladu.
 */
import type { EntityId } from '@sim/core';
import type { ShipClassDef } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { Ship } from '@sim/ships';

/** Celková doba lashingu lode (ticky): `lashingTicksPerUnit × naložený export + paperworkTicks` (ADR-032 bod 12). */
export function lashingTotalTicks(def: Pick<ShipClassDef, 'lashingTicksPerUnit' | 'paperworkTicks'>, exportOnBoard: number): number {
  return def.lashingTicksPerUnit * exportOnBoard + def.paperworkTicks;
}

/** Zapamätané celkové doby lashingu podľa `id` lode. */
export type LashingTotals = ReadonlyMap<EntityId, number>;

/**
 * Zostávajúce a celkové ticky lashingu lode (len v stave `lashing`, inak `undefined`): celková doba je zapamätaná zo simu,
 * bez záznamu zo vzorca defu; nikdy menej než zostávajúce ticky, aby progres neklesol pod 0.
 */
export function lashingTicks(ship: Ship, exportOnBoard: number, totals: LashingTotals): { ticksLeft: number; ticksTotal: number } | undefined {
  if (ship.state !== 'lashing') return undefined;
  const total = totals.get(ship.id) ?? lashingTotalTicks(ship.def, exportOnBoard);
  return { ticksLeft: ship.lashingTicksLeft, ticksTotal: Math.max(total, ship.lashingTicksLeft) };
}

export class LashingTracker {
  private readonly totals = new Map<EntityId, number>();

  /** Celkové doby podľa lode; referencia je stabilná (obsah sa mení cez `record`). */
  get view(): LashingTotals {
    return this.totals;
  }

  /** Spracuje udalosti frameu v poradí vzniku: `ShipLashingStarted` zapíše dobu, `ShipUndocked` / `ShipDeparted` ju zabudnú. */
  record(events: readonly SimEvent[]): void {
    for (const event of events) {
      if (event.type === 'ShipLashingStarted') this.totals.set(event.shipId, event.ticks);
      else if (event.type === 'ShipUndocked' || event.type === 'ShipDeparted') this.totals.delete(event.shipId);
    }
  }
}
