/**
 * Otvorený pravý panel (T05-07): dnes len `contracts` (ContractsPanel), ďalšie (financie, štatistiky, tech) prídu neskôr.
 * Rovnaký vzor ako `BuildSelection` / `ModuleSelection` (`SelectionCell`): stav žije mimo Reactu, takže ho zdieľa HUD
 * (ikona panelu), klávesnica, toasty (akcia „Zobraziť“) a `App`.
 *
 * Pravý okraj obsadzuje aj inšpektor modulu; panel a inšpektor sa vylučujú (`bindPanelExclusion`): otvorený panel
 * má prednosť (výber modulu sa zruší), výber modulu na mape panel zavrie.
 */
import type { ModuleSelection } from './module-selection';
import { SelectionCell } from './selection-cell';

/** Panely, ktoré vie HUD otvoriť. */
export type PanelId = 'contracts';

/** Je `id` z HUD tlačidla panel, ktorý už existuje? */
export function isPanelId(id: string): id is PanelId {
  return id === 'contracts';
}

export class PanelSelection extends SelectionCell<PanelId> {
  /** Otvorí `id`, alebo ho zavrie, ak je už otvorený. */
  readonly toggle = (id: PanelId): void => {
    this.select(this.get() === id ? null : id);
  };
}

/**
 * Vzájomné vylúčenie panelu a inšpektora: otvorenie panelu zruší výber modulu (zmizne inšpektor aj obrys), výber modulu
 * zavrie panel. @returns funkcia, ktorá odber zruší
 */
export function bindPanelExclusion(panels: PanelSelection, moduleSelection: ModuleSelection): () => void {
  const stopPanels = panels.subscribe(() => {
    if (panels.get() !== null) moduleSelection.select(null);
  });
  const stopModules = moduleSelection.subscribe(() => {
    if (moduleSelection.get() !== null) panels.select(null);
  });
  return () => {
    stopPanels();
    stopModules();
  };
}
