/**
 * BuildBar pripojený na simuláciu (`@ui/build-bar` je čisto prezentačný): kategórie a položky z `defs.modules`,
 * vozidiel, `affordable` z hotovosti v snapshote (throttle 100 ms) a výber položky v `BuildSelection`.
 *
 * Výber položky s `action: 'build'` nastaví `selectedDefId` a build mód (ghost, umiestnenie) ho odoberá cez `selection`.
 * Položka s `action: 'buy'` (vozidlo, T03-10) nakúpi hneď: `BuyVehicle` do pripojeného depa s voľným státím s najmenším
 * id (`buyVehicleFromBuildBar`, validácia pred `dispatch`); bez takého depa je položka zamknutá s dôvodom.
 * Položka s `action: 'road'` (typ cesty, Landside, T03-20) nastaví `RoadSelection` na jej typ; opakovaný klik výber zruší
 * (ovládanie mapy potom mód ciest vypne). Svieti presne vtedy, keď je mód ciest zapnutý s týmto typom — aj po `B`/Esc.
 * Aktívna kategória je lokálny stav UI (nie herný stav).
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { BuildBar } from '@ui/build-bar';
import { DEFAULT_BUILD_CATEGORY_ID, buildBarCategories } from './build-bar-data';
import type { BuildSelection } from './build-selection';
import { roadKindOfItem, roadToolItemId } from './road-build';
import { RoadSelection } from './road-selection';
import { useSimBridge, useSimSnapshot } from './use-sim-snapshot';
import { buyVehicleFromBuildBar, sameBuyTarget, vehicleBuyTarget } from './vehicle-purchase';

export interface ConnectedBuildBarProps {
  readonly selection: BuildSelection;
  /** Výber typu cesty zdieľaný s ovládaním mapy; bez neho si komponent vedie vlastný (testy, demo). */
  readonly roadSelection?: RoadSelection;
}

export function ConnectedBuildBar({ selection, roadSelection }: ConnectedBuildBarProps) {
  const bridge = useSimBridge();
  const cashCents = useSimSnapshot((snapshot) => snapshot.cashCents);
  const selectedDefId = useSyncExternalStore(selection.subscribe, selection.get, selection.get);
  const [ownRoadSelection] = useState(() => new RoadSelection());
  const roads = roadSelection ?? ownRoadSelection;
  const selectedRoadKind = useSyncExternalStore(roads.subscribe, roads.get, roads.get);
  const [activeCategoryId, setActiveCategoryId] = useState(DEFAULT_BUILD_CATEGORY_ID);
  const buyTarget = useSimSnapshot(() => vehicleBuyTarget(bridge.world), undefined, sameBuyTarget);
  const categories = useMemo(() => buildBarCategories(bridge.defs, cashCents, buyTarget), [bridge, cashCents, buyTarget]);
  const buy = useCallback(
    (defId: string) => {
      buyVehicleFromBuildBar(bridge, defId);
    },
    [bridge],
  );
  const selectRoad = useCallback(
    (defId: string | null) => {
      roads.select(defId === null ? null : roadKindOfItem(defId));
    },
    [roads],
  );
  return (
    <BuildBar
      categories={categories}
      activeCategoryId={activeCategoryId}
      selectedDefId={selectedDefId}
      onSelectCategory={setActiveCategoryId}
      onSelect={selection.select}
      onBuy={buy}
      selectedRoadDefId={selectedRoadKind === null ? null : roadToolItemId(selectedRoadKind)}
      onSelectRoad={selectRoad}
    />
  );
}
