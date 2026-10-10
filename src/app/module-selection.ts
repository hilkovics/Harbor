/**
 * Výber modulu na mape (T02-10): klik v `idle` móde na bunku modulu ho vyberie → `ModuleInspector` v pravom paneli
 * a obrys `selection_ring` okolo modulu. Malý pozorovateľný stav rovnakého tvaru ako `BuildSelection`; hodnota je
 * id modulu (`EntityId`).
 *
 * `bindSelectionRing` drží obrys v súlade s výberom a zruší výber, keď vybraný modul zanikne (`ModuleRemoved`).
 */
import type { SelectionRingView } from '@render/build-layer';
import type { EntityId } from '@sim/core';
import type { SimBridge } from './sim-bridge';
import { SelectionCell, type SelectionSource } from './selection-cell';

/** Vybraný modul (id z `world.modules`), alebo `null` = nič nie je vybrané. */
export class ModuleSelection extends SelectionCell<EntityId> {}

/** Časť `SimBridge`, ktorú obrys výberu používa. */
export type SelectionRingBridge = Pick<SimBridge, 'world' | 'onEvents'>;

/**
 * Prepojí výber modulu s obrysom: pri zmene výberu nastaví obdĺžnik footprintu modulu (alebo obrys skryje) a po
 * udalosti `ModuleRemoved` vybraného modulu výber zruší. Hneď po zavolaní sa obrys zosúladí s aktuálnym výberom.
 * @returns funkcia, ktorá odber zruší
 */
export function bindSelectionRing(selection: SelectionSource<EntityId>, bridge: SelectionRingBridge, view: SelectionRingView): () => void {
  const sync = (): void => {
    const id = selection.get();
    const module = id === null ? undefined : bridge.world.modules.get(id);
    view.setSelectionRing(module === undefined ? null : { x: module.origin.x, y: module.origin.y, w: module.size.w, h: module.size.h });
  };
  const stopSelection = selection.subscribe(sync);
  const stopEvents = bridge.onEvents((events) => {
    const selected = selection.get();
    if (selected === null) return;
    for (const event of events) {
      if (event.type === 'ModuleRemoved' && event.moduleId === selected) {
        selection.select(null);
        return;
      }
    }
  });
  sync();
  return () => {
    stopSelection();
    stopEvents();
  };
}
