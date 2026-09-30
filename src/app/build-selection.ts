/**
 * Výber položky v BuildBar (`selectedDefId`) — malý pozorovateľný stav zdieľaný medzi Reactom (BuildBar) a ovládaním
 * mapy (`InputController`, build mód modulov T02-10): výber prepne ovládanie do módu `build_module`, Esc alebo pravý
 * klik ho zruší cez `select(null)`.
 */
import { SelectionCell } from './selection-cell';

export type { SelectionListener } from './selection-cell';

/** Vybraná definícia modulu (`berth_standard`), alebo `null` = nič nie je vybrané. */
export class BuildSelection extends SelectionCell<string> {}
