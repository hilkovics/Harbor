/**
 * Demo BuildBar (T02-08): dva pásy so statickými dátami (žiadny bridge — komponent je čisto prezentačný).
 *  1. `BuildBarDemo` — kategória Terminál tak, ako ju vidí hráč vo F2: `berth_standard` ($400,000, 8×3) a
 *     `crane_container_gantry` ($600,000, 2×3, hotovosť nestačí), ostatné kategórie zamknuté (mimo fázy).
 *  2. `BuildBarStatesDemo` — všetky stavy položky vedľa seba (dostupná, vybraná, bez peňazí, zamknutá) a druhá
 *     povolená kategória; slúži na vizuálnu kontrolu, tooltipy sa ukážu po prejdení myšou.
 * Klikanie funguje (lokálny stav kategórie a výberu), aby šlo vyskúšať `onSelect(defId | null)`.
 */
import { useState } from 'react';
import { BuildBar, type BuildBarCategory, type BuildBarItem } from '../build-bar';
import './demo-base';

/** Rozpočet dema: berth ($400,000) je dostupný, žeriav ($600,000) nie — chýba $150,000. */
export const DEMO_CASH_CENTS = 45_000_000;

const BERTH: BuildBarItem = {
  defId: 'berth_standard',
  displayName: 'Kotvisko štandard',
  costCents: 40_000_000,
  icon: 'ic_berth',
  footprint: { w: 8, h: 3 },
  locked: false,
  affordable: true,
};

const CRANE: BuildBarItem = {
  defId: 'crane_container_gantry',
  displayName: 'Kontajnerový žeriav',
  costCents: 60_000_000,
  icon: 'ic_crane',
  footprint: { w: 2, h: 3 },
  locked: false,
  affordable: false,
  missingCents: 60_000_000 - DEMO_CASH_CENTS,
};

/** Názvy a ikony kategórií z prototypu (design/ui/game-ui.source.html); vo F2 je povolený len Terminál. */
function lockedCategory(id: string, label: string, icon: string): BuildBarCategory {
  return { id, label, icon, enabled: false, items: [] };
}

/** Kategórie F2: Terminál s dvomi položkami, ostatné vizuálne zamknuté. */
export const F2_CATEGORIES: readonly BuildBarCategory[] = [
  { id: 'terminal', label: 'Terminál', icon: 'ic_berth', enabled: true, items: [BERTH, CRANE] },
  lockedCategory('storage', 'Sklady', 'ic_yard'),
  lockedCategory('logistics', 'Logistika', 'ic_vehicle'),
  lockedCategory('landside', 'Landside', 'ic_gate'),
  lockedCategory('rail', 'Železnica', 'ic_rail'),
  lockedCategory('pipes', 'Potrubia', 'ic_pipe'),
];

/** Všetky stavy položky (kontrolný pás): dostupná, bez peňazí, zamknutá technológiou, dlhý názov. */
const STATES_CATEGORIES: readonly BuildBarCategory[] = [
  {
    id: 'terminal',
    label: 'Terminál',
    icon: 'ic_berth',
    enabled: true,
    items: [
      BERTH,
      CRANE,
      { ...BERTH, defId: 'berth_deep', displayName: 'Kotvisko hlbokovodné', costCents: 145_000_000, affordable: false, missingCents: 100_000_000 },
      {
        defId: 'arm_liquid',
        displayName: 'Rameno kvapalín',
        costCents: 9_500_000,
        icon: 'liquid',
        footprint: { w: 4, h: 2 },
        locked: true,
        affordable: true,
        lockedReason: 'Vyžaduje technológiu Kvapalné terminály · 120 XP',
      },
      {
        defId: 'crane_long_name',
        displayName: 'Kontajnerový portálový žeriav Post-Panamax',
        costCents: 98_765_400,
        icon: 'ic_crane',
        footprint: { w: 3, h: 4 },
        locked: false,
        affordable: true,
      },
    ],
  },
  {
    id: 'storage',
    label: 'Sklady',
    icon: 'ic_yard',
    enabled: true,
    items: [
      { defId: 'yard_s', displayName: 'Kontajnerový dvor S', costCents: 9_000_000, icon: 'yard', footprint: { w: 4, h: 4 }, locked: false, affordable: true },
      { defId: 'yard_l', displayName: 'Kontajnerový dvor L', costCents: 34_000_000, icon: 'yard', footprint: { w: 8, h: 8 }, locked: true, affordable: true, lockedReason: 'Vyžaduje technológiu Veľký dvor · 150 XP' },
    ],
  },
  lockedCategory('logistics', 'Logistika', 'ic_vehicle'),
  lockedCategory('landside', 'Landside', 'ic_gate'),
  lockedCategory('rail', 'Železnica', 'ic_rail'),
  lockedCategory('pipes', 'Potrubia', 'ic_pipe'),
];

interface StatefulBarProps {
  readonly categories: readonly BuildBarCategory[];
  readonly initialSelected: string | null;
  readonly idPrefix: string;
}

function StatefulBar({ categories, initialSelected, idPrefix }: StatefulBarProps) {
  const [activeCategoryId, setActiveCategoryId] = useState('terminal');
  const [selectedDefId, setSelectedDefId] = useState<string | null>(initialSelected);
  return (
    <BuildBar
      categories={categories}
      activeCategoryId={activeCategoryId}
      selectedDefId={selectedDefId}
      onSelectCategory={setActiveCategoryId}
      onSelect={setSelectedDefId}
      idPrefix={idPrefix}
    />
  );
}

/** Pás F2: Terminál, vybraté kotvisko. */
export function BuildBarDemo() {
  return <StatefulBar categories={F2_CATEGORIES} initialSelected="berth_standard" idPrefix="demo-f2" />;
}

/** Kontrolný pás všetkých stavov položky. */
export function BuildBarStatesDemo() {
  return <StatefulBar categories={STATES_CATEGORIES} initialSelected={null} idPrefix="demo-states" />;
}
