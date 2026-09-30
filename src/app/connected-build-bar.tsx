/**
 * BuildBar pripojený na simuláciu (`@ui/build-bar` je čisto prezentačný): kategórie a položky z `defs.modules`,
 * `affordable` z hotovosti v snapshote (throttle 100 ms) a výber položky v `BuildSelection`.
 *
 * Výber zatiaľ len nastaví `selectedDefId`; build mód (ghost, umiestnenie) pripojí T02-10 odberom `selection`.
 * Aktívna kategória je lokálny stav UI (nie herný stav).
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { BuildBar } from '@ui/build-bar';
import { DEFAULT_BUILD_CATEGORY_ID, buildBarCategories } from './build-bar-data';
import type { BuildSelection } from './build-selection';
import { useSimBridge, useSimSnapshot } from './use-sim-snapshot';

export interface ConnectedBuildBarProps {
  readonly selection: BuildSelection;
}

export function ConnectedBuildBar({ selection }: ConnectedBuildBarProps) {
  const bridge = useSimBridge();
  const cashCents = useSimSnapshot((snapshot) => snapshot.cashCents);
  const selectedDefId = useSyncExternalStore(selection.subscribe, selection.get, selection.get);
  const [activeCategoryId, setActiveCategoryId] = useState(DEFAULT_BUILD_CATEGORY_ID);
  const categories = useMemo(() => buildBarCategories(bridge.defs, cashCents), [bridge, cashCents]);
  return (
    <BuildBar
      categories={categories}
      activeCategoryId={activeCategoryId}
      selectedDefId={selectedDefId}
      onSelectCategory={setActiveCategoryId}
      onSelect={selection.select}
    />
  );
}
