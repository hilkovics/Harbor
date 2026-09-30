/**
 * Výber typu cesty (T03-20) — pozorovateľný stav zdieľaný medzi BuildBarom (položky Landside „Cesta …“) a ovládaním
 * mapy (`InputController`). Hodnota je typ cesty, kým je zapnutý build mód ciest, inak `null`:
 *
 * - klik na cestnú položku v BuildBare nastaví typ → ovládanie prepne do build módu ciest s týmto typom; opakovaný klik
 *   (`select(null)`) mód ukončí;
 * - klávesa `B` a Esc menia mód v ovládaní, ktoré výber zrkadlí späť (`select(kind)` / `select(null)`), takže položka
 *   v BuildBare svieti presne vtedy, keď je mód zapnutý.
 * Naposledy použitý typ si pamätá ovládanie (`InputController.roadKind`), nie tento výber.
 */
import type { RoadKind } from '@sim/grid';
import { SelectionCell } from './selection-cell';

/** Vybraný typ cesty v build móde ciest, alebo `null` = mód ciest je vypnutý. */
export class RoadSelection extends SelectionCell<RoadKind> {}
