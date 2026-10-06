/**
 * Prijatie exportu do skladu (F6a, ADR-032 bod 8; dispatcher krok 5): job `at_ramp → in_storage` pre jednotky exportu, ktoré
 * práve vyložil kamión s exportom na dock rampy a čakajú na vozidlo (`!isPickupCargo`, `logistics/dock-cargo.ts`).
 *
 * **Zoskupenie podľa voyage** robí `YardPlanner` (`reserveYardSlot`, ADR-039 bod 7: export podľa `(voyage, cieľový prístav, hmotnostná trieda, veľkosť)`);
 * plánovač hneď pri vzniku jobu rezervuje bunku (ako inbound), takže po sebe idúce jednotky voyage v jednom ticku sa nerozbehnú. Bez bloku job nevznikne
 * a jednotka čaká na docku (kapacitu docku drží, kamióny s exportom vtedy čakajú v stojisku — nič sa nestratí). Staré alokátory skladu bez plánovača
 * (`allocateStorage`, `allocateExportStorage`) odstránil TR2-06b — plánovač je jediná cesta do skladu.
 *
 * Poradie: rampy vzostupne podľa id, jednotky docku vo FIFO poradí ledgera (bez kópie — počas prechodu sa ledger nemení,
 * vznikajú len joby).
 *
 * **Prekládka** (F6c, ADR-034) sa ukladá rovnakým výberom (podľa kontraktu lode B): jednotky jednej prekládky z lode A ležia zoskupene v sklade
 * (zdrojom je kotvisko, nie rampa), kým ich nenaloží loď B; na rampu neprichádza (nikdy neprejde bránou), kým ju kontrakt neuzavrie predajom.
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import type { World } from '../world/world';
import { reserveYardSlot } from './yard-planner';

/** Podklady jobu: jednotka, zdroj (dock) a rezervovaný cieľ — dispatcher z toho vytvorí job (`openJob`). */
export interface IntakeJobSpec {
  readonly unitId: EntityId;
  readonly from: CargoUnit['location'];
  readonly to: { readonly kind: 'in_storage'; readonly moduleId: EntityId; readonly slot: number };
}

/**
 * Pre každú jednotku exportu na prijatie bez aktívneho jobu nájde stoh (`reserveYardSlot`), rezervuje jeho bunku
 * a odovzdá podklady jobu `open` (`openJob` dispatchera). Vracia počet vytvorených jobov.
 */
export function createExportIntakeJobs(world: World, openJob: (spec: IntakeJobSpec) => void): number {
  let created = 0;
  for (const ramp of world.landsideModules.ramps) {
    const count = world.cargo.countAt('at_ramp', ramp.id);
    for (let i = 0; i < count; i++) {
      const unitId = world.cargo.unitAtIndex('at_ramp', ramp.id, i);
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unit === undefined || unit.direction !== 'export' || world.isPickupCargo(unit) || world.jobOfUnit(unit.id) !== undefined) continue;
      const place = reserveYardSlot(world, unit, ramp);
      if (place === null) continue;
      openJob({ unitId: unit.id, from: unit.location, to: { kind: 'in_storage', moduleId: place.moduleId, slot: place.slot } });
      created += 1;
    }
  }
  return created;
}
