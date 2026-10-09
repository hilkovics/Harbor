/**
 * Prístup vozidiel k modulom po ceste (ARCHITECTURE §7.3, §7.4; rozhodnutia orchestrátora F3 č. 2, 3 a 6; ADR-017,
 * ADR-018). Vozidlo vchádza do modulu na **vonkajšej bunke** cestného konektora (`connectorOutside`); použiteľná je len
 * vonkajšia bunka v mape s `road === 'road'` — tá istá podmienka ako `World.isConnected`, takže nepripojený modul nemá
 * žiadnu prístupovú bunku a dispatcher ho ignoruje.
 *
 * Vzdialenosti idú cez `DistanceMatrix` (lazy memo nad cestami z `PathCache`, zneplatnené cez `roadVersion`); pri
 * viacerých konektoroch sa berie najlacnejšia dvojica, pri zhode prvý konektor v poradí defu. Funkcie nealokujú okrem
 * cesty pri prvom dotaze na dvojicu (dispatcher ich volá každý tick) a svet nemenia.
 */
import type { Grid } from '../grid/grid';
import type { Module } from '../modules/module';
import { SIDE_STEPS, connectorAllows, type PlacedConnector } from '../modules/module-geometry';
import type { DistanceMatrix } from './distance-matrix';

/** Časť sveta, ktorú prístup k modulom číta (`World` ju spĺňa). */
export interface ModuleAccessEnv {
  readonly grid: Grid;
  readonly distances: DistanceMatrix;
}

/** Index bunky „bez prístupu". */
export const NO_ACCESS = -1;

/** Index vonkajšej bunky cestného konektora, ak leží v mape a má cestu; inak `NO_ACCESS`. */
export function accessCellIndex(grid: Grid, connector: PlacedConnector): number {
  if (connector.type !== 'road') return NO_ACCESS;
  const { dx, dy } = SIDE_STEPS[connector.side];
  const x = connector.x + dx;
  const y = connector.y + dy;
  if (!grid.inBounds(x, y)) return NO_ACCESS;
  const index = grid.index(x, y);
  return grid.atIndex(index).road === 'road' ? index : NO_ACCESS;
}

/** Je bunka `index` prístupovou bunkou modulu (vonkajšia bunka cestného konektora s cestou)? */
export function isAccessCell(grid: Grid, module: Module, index: number): boolean {
  for (const connector of module.connectors) {
    if (accessCellIndex(grid, connector) === index) return true;
  }
  return false;
}

/**
 * Prístupová bunka modulu najbližšia k bunke `from` podľa ceny cesty (pri zhode prvý konektor v poradí defu);
 * `NO_ACCESS`, ak je modul nepripojený alebo žiadna jeho prístupová bunka nie je z `from` dosiahnuteľná.
 */
export function nearestAccessCell(env: ModuleAccessEnv, from: number, module: Module): number {
  let best = NO_ACCESS;
  let bestCost = Infinity;
  for (const connector of module.connectors) {
    if (!connectorAllows(connector, 'in')) continue;
    const access = accessCellIndex(env.grid, connector);
    if (access === NO_ACCESS) continue;
    const cost = env.distances.distance(from, access);
    if (cost < bestCost) {
      best = access;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * Cena cesty z bunky `from` k najbližšej prístupovej bunke modulu (= cena bunky z `nearestAccessCell`, jeden dotaz do
 * matice na konektor); `Infinity` bez prístupu alebo bez cesty.
 */
export function distanceToModule(env: ModuleAccessEnv, from: number, module: Module): number {
  let best = Infinity;
  for (const connector of module.connectors) {
    if (!connectorAllows(connector, 'in')) continue;
    const access = accessCellIndex(env.grid, connector);
    if (access === NO_ACCESS) continue;
    const cost = env.distances.distance(from, access);
    if (cost < best) best = cost;
  }
  return best;
}

/**
 * Cestná vzdialenosť medzi modulmi = najlacnejšia dvojica prístupových buniek (výjazd `from` → vjazd `to`, ADR-041 bod 8); `Infinity`, ak niektorý
 * nie je pripojený alebo medzi nimi nevedie cesta.
 */
export function distanceBetweenModules(env: ModuleAccessEnv, from: Module, to: Module): number {
  let best = Infinity;
  for (const connector of from.connectors) {
    if (!connectorAllows(connector, 'out')) continue;
    const access = accessCellIndex(env.grid, connector);
    if (access === NO_ACCESS) continue;
    const cost = distanceToModule(env, access, to);
    if (cost < best) best = cost;
  }
  return best;
}
