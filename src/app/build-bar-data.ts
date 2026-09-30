/**
 * Dáta pre BuildBar (`@ui/build-bar`) zo simu: kategórie stavby a ich položky z `defs.modules` (DESIGN_BRIEF §6.1–§6.2,
 * prototyp design/ui/game-ui.source.html).
 *
 * - Položky kategórie vyberá druh modulu (`def.kind`), nie zoznam id — nový def kotviska alebo žeriavu sa objaví sám.
 * - `affordable = hotovosť ≥ cena`, `missingCents = cena − hotovosť`, keď hotovosť nestačí.
 * - `locked` = def vyžaduje technológiu (`techRequired`); strom technológií príde vo F8, dovtedy je taká položka zamknutá.
 * - Vo F2 je povolená len kategória Terminál; ostatné sú vizuálne zamknuté (mimo fázy) a bez položiek.
 *
 * Čistá funkcia bez Reactu — testuje sa v Node.
 */
import type { DefRegistry, ModuleDef, ModuleKind } from '@sim/defs';
import type { BuildBarCategory, BuildBarItem } from '@ui/build-bar';
import { moduleKindIcon } from '@ui/module-inspector';

/** Riadok tabuľky kategórií BuildBar. */
export interface BuildCategorySpec {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** Kategória mimo aktuálnej fázy je zamknutá (bez položiek). */
  readonly enabled: boolean;
  /** Druhy modulov, ktoré do kategórie patria. */
  readonly kinds: readonly ModuleKind[];
}

/** Kategórie v poradí prototypu (názvy: `tabNames`); vo F2 je povolený len Terminál. */
export const BUILD_CATEGORIES: readonly BuildCategorySpec[] = Object.freeze([
  { id: 'terminal', label: 'Terminál', icon: 'ic_berth', enabled: true, kinds: ['berth', 'crane'] },
  { id: 'storage', label: 'Sklady', icon: 'ic_yard', enabled: false, kinds: ['storage'] },
  { id: 'logistics', label: 'Logistika', icon: 'ic_vehicle', enabled: false, kinds: ['depot'] },
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

/** Kategórie BuildBar z katalógu modulov a aktuálnej hotovosti (poradie položiek = poradie v `modules.json`). */
export function buildBarCategories(defs: DefRegistry, cashCents: number): BuildBarCategory[] {
  return BUILD_CATEGORIES.map((spec) => ({
    id: spec.id,
    label: spec.label,
    icon: spec.icon,
    enabled: spec.enabled,
    items: spec.enabled ? defs.modules.items.filter((def) => spec.kinds.includes(def.kind)).map((def) => buildBarItem(def, cashCents)) : [],
  }));
}
