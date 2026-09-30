/**
 * Dáta pre BuildBar (`@ui/build-bar`) zo simu: kategórie stavby a ich položky z `defs.modules` (DESIGN_BRIEF §6.1–§6.2,
 * prototyp design/ui/game-ui.source.html).
 *
 * - Položky kategórie vyberá druh modulu (`def.kind`), nie zoznam id — nový def kotviska alebo žeriavu sa objaví sám.
 * - Logistika (F3) navyše ponúka vozidlá z `defs.vehicles` ako položky s `action: 'buy'` (okamžitý nákup bez ghostu,
 *   pred depom ako stavbou — poradie prototypu). Vozidlo je zamknuté, kým nie je kam ho kúpiť (`VehicleBuyTarget`:
 *   „Postav a pripoj depo vozidiel“ / „Depá sú plné“).
 * - `affordable = hotovosť ≥ cena`, `missingCents = cena − hotovosť`, keď hotovosť nestačí.
 * - `locked` = def vyžaduje technológiu (`techRequired`); strom technológií príde vo F8, dovtedy je taká položka zamknutá.
 * - Povolené sú kategórie Terminál, Sklady a Logistika; ostatné sú vizuálne zamknuté (mimo fázy) a bez položiek.
 *
 * Čistá funkcia bez Reactu — testuje sa v Node.
 */
import type { DefRegistry, ModuleDef, ModuleKind, VehicleDef } from '@sim/defs';
import type { BuildBarCategory, BuildBarItem } from '@ui/build-bar';
import { moduleKindIcon } from '@ui/module-inspector';
import { NO_BUY_TARGET, type VehicleBuyTarget } from './vehicle-purchase';

/** Riadok tabuľky kategórií BuildBar. */
export interface BuildCategorySpec {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** Kategória mimo aktuálnej fázy je zamknutá (bez položiek). */
  readonly enabled: boolean;
  /** Druhy modulov, ktoré do kategórie patria. */
  readonly kinds: readonly ModuleKind[];
  /** Kategória ponúka aj vozidlá z `defs.vehicles` (nákup); F3: Logistika. */
  readonly vehicles?: boolean;
}

/** Kategórie v poradí prototypu (názvy: `tabNames`); vo F3 sú povolené Terminál, Sklady a Logistika. */
export const BUILD_CATEGORIES: readonly BuildCategorySpec[] = Object.freeze([
  { id: 'terminal', label: 'Terminál', icon: 'ic_berth', enabled: true, kinds: ['berth', 'crane'] },
  { id: 'storage', label: 'Sklady', icon: 'ic_yard', enabled: true, kinds: ['storage'] },
  { id: 'logistics', label: 'Logistika', icon: 'ic_vehicle', enabled: true, kinds: ['depot'], vehicles: true },
  { id: 'landside', label: 'Landside', icon: 'ic_gate', enabled: false, kinds: ['gate', 'waiting_area', 'ramp'] },
  { id: 'rail', label: 'Železnica', icon: 'ic_rail', enabled: false, kinds: ['rail_station'] },
  { id: 'pipes', label: 'Potrubia', icon: 'ic_pipe', enabled: false, kinds: ['pipeline'] },
]);

/** Kategória zvolená pri štarte. */
export const DEFAULT_BUILD_CATEGORY_ID = 'terminal';

/** Položka BuildBar pre def modulu pri danej hotovosti. */
export function buildBarItem(def: Readonly<ModuleDef>, cashCents: number): BuildBarItem {
  const affordable = cashCents >= def.costCents;
  const { techRequired } = def;
  return {
    defId: def.id,
    displayName: def.displayName,
    costCents: def.costCents,
    icon: moduleKindIcon(def.kind),
    footprint: { w: def.footprint.w, h: def.footprint.h },
    locked: techRequired !== undefined,
    affordable,
    ...(techRequired === undefined ? {} : { lockedReason: `Vyžaduje technológiu ${techRequired}` }),
    ...(affordable ? {} : { missingCents: def.costCents - cashCents }),
  };
}

/** Ikona vozidla v BuildBar (rovnaká ako karta kategórie Logistika). */
export const VEHICLE_ITEM_ICON = 'ic_vehicle';

/**
 * Položka BuildBar pre vozidlo (`action: 'buy'`, bez rozmeru). Zamknutá technológiou (`techRequired`) alebo tým, že nie
 * je kam kúpiť (`target.depotId === null`, dôvod `target.reason`); zámok technológiou má prednosť.
 */
export function vehicleBuyItem(def: Readonly<VehicleDef>, cashCents: number, target: VehicleBuyTarget): BuildBarItem {
  const affordable = cashCents >= def.purchaseCents;
  const { techRequired } = def;
  const noDepot = target.depotId === null;
  const lockedReason = techRequired !== undefined ? `Vyžaduje technológiu ${techRequired}` : noDepot ? target.reason : null;
  return {
    defId: def.id,
    displayName: def.displayName,
    costCents: def.purchaseCents,
    icon: VEHICLE_ITEM_ICON,
    locked: techRequired !== undefined || noDepot,
    affordable,
    action: 'buy',
    ...(lockedReason === null ? {} : { lockedReason }),
    ...(affordable ? {} : { missingCents: def.purchaseCents - cashCents }),
  };
}

/**
 * Kategórie BuildBar z katalógu modulov, vozidiel a aktuálnej hotovosti (poradie položiek = poradie v `vehicles.json`
 * a `modules.json`, vozidlá pred stavbami). `buyTarget` = kam sa dá kúpiť vozidlo (`vehicleBuyTarget`); bez neho sa
 * berie, že depo nie je.
 */
export function buildBarCategories(defs: DefRegistry, cashCents: number, buyTarget: VehicleBuyTarget = NO_BUY_TARGET): BuildBarCategory[] {
  return BUILD_CATEGORIES.map((spec) => {
    const vehicles = spec.enabled && spec.vehicles === true ? defs.vehicles.items.map((def) => vehicleBuyItem(def, cashCents, buyTarget)) : [];
    const modules = spec.enabled ? defs.modules.items.filter((def) => spec.kinds.includes(def.kind)).map((def) => buildBarItem(def, cashCents)) : [];
    return { id: spec.id, label: spec.label, icon: spec.icon, enabled: spec.enabled, items: [...vehicles, ...modules] };
  });
}
