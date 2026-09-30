/**
 * BuildBar pripojený na simuláciu (`@ui/build-bar` je čisto prezentačný): kategórie a položky z `defs.modules`,
 * vozidiel, `affordable` z hotovosti v snapshote (throttle 100 ms) a výber položky v `BuildSelection`.
 *
 * Výber položky s `action: 'build'` nastaví `selectedDefId` a build mód (ghost, umiestnenie) ho odoberá cez `selection`.
 * Položka s `action: 'buy'` (vozidlo, T03-10) nakúpi hneď: `BuyVehicle` do pripojeného depa s voľným státím s najmenším
 * id (`buyVehicleFromBuildBar`, validácia pred `dispatch`); bez takého depa je položka zamknutá s dôvodom.
 * Aktívna kategória je lokálny stav UI (nie herný stav).
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { BuildBar } from '@ui/build-bar';
import { DEFAULT_BUILD_CATEGORY_ID, buildBarCategories } from './build-bar-data';
import type { BuildSelection } from './build-selection';
import { useSimBridge, useSimSnapshot } from './use-sim-snapshot';
import { buyVehicleFromBuildBar, sameBuyTarget, vehicleBuyTarget } from './vehicle-purchase';

export interface ConnectedBuildBarProps {
  readonly selection: BuildSelection;
}

export function ConnectedBuildBar({ selection }: ConnectedBuildBarProps) {
  const bridge = useSimBridge();
  const cashCents = useSimSnapshot((snapshot) => snapshot.cashCents);
  const selectedDefId = useSyncExternalStore(selection.subscribe, selection.get, selection.get);
  const [activeCategoryId, setActiveCategoryId] = useState(DEFAULT_BUILD_CATEGORY_ID);
  const buyTarget = useSimSnapshot(() => vehicleBuyTarget(bridge.world), undefined, sameBuyTarget);
  const categories = useMemo(() => buildBarCategories(bridge.defs, cashCents, buyTarget), [bridge, cashCents, buyTarget]);
  const buy = useCallback(
    (defId: string) => {
      buyVehicleFromBuildBar(bridge, defId);
    },
    [bridge],
  );
  return (
    <BuildBar
      categories={categories}
      activeCategoryId={activeCategoryId}
      selectedDefId={selectedDefId}
      onSelectCategory={setActiveCategoryId}
      onSelect={selection.select}
      onBuy={buy}
    />
  );
}
