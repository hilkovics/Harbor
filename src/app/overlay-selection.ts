/**
 * Otvorený overlay (T06-03b): `settings` (Nastavenia) alebo `saves` (Uložiť a načítať hru), alebo žiadny (`null`).
 * Overlay je modálny (zásterka cez celú hru), preto je to samostatný stav a nie súčasť `PanelSelection`: panel je pravý
 * bočný panel, ktorý sa delí o okraj s inšpektorom (`bindPanelExclusion`), kým overlay inšpektor ani panel nemení — po
 * zatvorení je všetko tak, ako bolo. Rovnaký vzor ako `PanelSelection` (`SelectionCell`): stav žije mimo Reactu, takže ho
 * zdieľa HUD (ikony), `App` (dialógy) a `attachDomInput` (kým je overlay otvorený, herné klávesy sa nespracúvajú).
 */
import { SelectionCell } from './selection-cell';

/** Overlaye, ktoré vie HUD otvoriť. */
export type OverlayId = 'settings' | 'saves';

export function isOverlayId(id: string): id is OverlayId {
  return id === 'settings' || id === 'saves';
}

export class OverlaySelection extends SelectionCell<OverlayId> {
  /** Otvorí `id` (otvorený iný overlay nahradí). */
  readonly open = (id: OverlayId): void => {
    this.select(id);
  };

  readonly close = (): void => {
    this.select(null);
  };

  /** Je niektorý overlay otvorený? (kým je, herné klávesy patria dialógu) */
  readonly isOpen = (): boolean => this.get() !== null;
}
