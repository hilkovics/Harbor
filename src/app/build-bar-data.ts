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
 * - Landside (T03-20) ponúka typy ciest (`action: 'road'`, cena za bunku z `infrastructure.roadKinds`, text `$2,000 / bunka`)
 *   a od F4 (T04-08) moduly brána, stojisko a rampa z defov (`kind` gate / waiting_area / ramp) — bez zástupných položiek.
 *   Cesta je `affordable`, ak hotovosť stačí aspoň na jednu bunku.
 * - Povolené sú kategórie Terminál, Sklady, Logistika a Landside; ostatné sú vizuálne zamknuté (mimo fázy) a bez položiek.
 *
 * Čistá funkcia bez Reactu — testuje sa v Node.
 */
import type { DefRegistry, ModuleDef, ModuleKind, VehicleDef } from '@sim/defs';
import type { RoadKind } from '@sim/grid';
import type { BuildBarCategory, BuildBarItem } from '@ui/build-bar';
import { formatMoney } from '@ui/format';
import { moduleKindIcon } from '@ui/module-inspector';
import { RAIL_LABEL, RAIL_TOOL, ROAD_KIND_LABEL, roadItemId, roadToolItemId } from './road-build';
import { NO_BUY_TARGET, type VehicleBuyTarget } from './vehicle-purchase';

/** Def železničného terminálu (R6): patrí do Železnice, nie do Skladov. */
export const RAIL_TERMINAL_DEF_ID = 'rmg_rail_block';

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
  /** Kategória ponúka typy ciest z `defs.infrastructure.roadKinds` (`action: 'road'`); F3: Landside. */
  readonly roads?: boolean;
  /** Kategória ponúka nástroj koľaje (`action: 'road'`, cena z `infrastructure.rail`, R6). */
  readonly rail?: boolean;
  /** Id modulov, ktoré kategória berie navyše (bez ohľadu na `kinds`), a ktoré iná kategória nemá. */
  readonly moduleIds?: readonly string[];
}

/** Jednotka ceny cesty: platí sa za bunku. */
export const ROAD_PRICE_UNIT = '/ bunka';

/** Ikona cestných položiek (sprite má jednu ikonu cesty pre všetky typy). */
export const ROAD_ITEM_ICON = 'ic_road';

/** Kategórie v poradí prototypu (názvy: `tabNames`); vo F4 sú povolené Terminál, Sklady, Logistika a Landside. */
export const BUILD_CATEGORIES: readonly BuildCategorySpec[] = Object.freeze([
  { id: 'terminal', label: 'Terminál', icon: 'ic_berth', enabled: true, kinds: ['berth', 'crane'] },
  { id: 'storage', label: 'Sklady', icon: 'ic_yard', enabled: true, kinds: ['storage'] },
  { id: 'logistics', label: 'Logistika', icon: 'ic_vehicle', enabled: true, kinds: ['depot'], vehicles: true },
  {
    id: 'landside',
    label: 'Landside',
    icon: 'ic_gate',
    enabled: true,
    kinds: ['gate', 'pre_gate', 'holding'],
    roads: true,
  },
  { id: 'rail', label: 'Železnica', icon: 'ic_rail', enabled: true, kinds: [], rail: true, moduleIds: [RAIL_TERMINAL_DEF_ID] },
  { id: 'pipes', label: 'Potrubia', icon: 'ic_pipe', enabled: false, kinds: ['pipeline'] },
]);

/** Moduly, ktoré majú vlastnú kategóriu (`moduleIds`) a v kategórii podľa `kinds` sa neopakujú. */
const EXTRA_MODULE_IDS: ReadonlySet<string> = new Set(BUILD_CATEGORIES.flatMap((spec) => spec.moduleIds ?? []));

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
 * Položka BuildBar pre typ cesty (`action: 'road'`, bez rozmeru). Cena je za bunku (`costPerCellCents` typu z defov),
 * text ceny `$2,000 / bunka`. Cesty nevyžadujú technológiu ani depo, takže nie sú nikdy zamknuté.
 */
export function roadKindItem(defs: DefRegistry, kind: RoadKind, cashCents: number): BuildBarItem {
  const costCents = defs.infrastructure.roadKinds[kind].costPerCellCents;
  const affordable = cashCents >= costCents;
  return {
    defId: roadItemId(kind),
    displayName: ROAD_KIND_LABEL[kind],
    costCents,
    priceText: `${formatMoney(costCents)} ${ROAD_PRICE_UNIT}`,
    icon: ROAD_ITEM_ICON,
    locked: false,
    affordable,
    action: 'road',
    ...(affordable ? {} : { missingCents: costCents - cashCents }),
  };
}

/** Položka nástroja koľaje (`action: 'road'`, cena za bunku z `infrastructure.rail.costPerCellCents`). */
export function railToolItem(defs: DefRegistry, cashCents: number): BuildBarItem {
  const costCents = defs.infrastructure.rail.costPerCellCents;
  const affordable = cashCents >= costCents;
  return {
    defId: roadToolItemId(RAIL_TOOL),
    displayName: RAIL_LABEL,
    costCents,
    priceText: `${formatMoney(costCents)} ${ROAD_PRICE_UNIT}`,
    icon: 'ic_rail',
    locked: false,
    affordable,
    action: 'road',
    ...(affordable ? {} : { missingCents: costCents - cashCents }),
  };
}

/**
 * Kategórie BuildBar z katalógu modulov, vozidiel a aktuálnej hotovosti (poradie položiek = poradie v `vehicles.json`
 * a `modules.json`, vozidlá pred stavbami). `buyTarget` = kam sa dá kúpiť vozidlo (`vehicleBuyTarget`); bez neho sa
 * berie, že depo nie je. Cesty ponúka len jednosmerku (R1: ADR-037 bod 12).
 */
export function buildBarCategories(defs: DefRegistry, cashCents: number, buyTarget: VehicleBuyTarget = NO_BUY_TARGET): BuildBarCategory[] {
  return BUILD_CATEGORIES.map((spec) => {
    const vehicles = spec.enabled && spec.vehicles === true ? defs.vehicles.items.map((def) => vehicleBuyItem(def, cashCents, buyTarget)) : [];
    const roads = spec.enabled && spec.roads === true ? ['one_way'].map((kind) => roadKindItem(defs, kind as RoadKind, cashCents)) : [];
    const rails = spec.enabled && spec.rail === true ? [railToolItem(defs, cashCents)] : [];
    const modules = spec.enabled
      ? defs.modules.items
          .filter((def) => (spec.kinds.includes(def.kind) && !EXTRA_MODULE_IDS.has(def.id)) || spec.moduleIds?.includes(def.id) === true)
          .map((def) => buildBarItem(def, cashCents))
      : [];
    return { id: spec.id, label: spec.label, icon: spec.icon, enabled: spec.enabled, items: [...vehicles, ...roads, ...rails, ...modules] };
  });
}
