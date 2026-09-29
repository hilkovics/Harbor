/**
 * 4-súvislá interpolácia medzi dvoma bunkami (ťah myšou pri stavbe cesty).
 *
 * Myš sa medzi dvoma udalosťami môže posunúť o viac buniek; keby sme zbierali len bunky pod kurzorom, rýchly ťah by
 * v ceste nechal diery. `interpolateCells` doplní všetky bunky medzi nimi tak, aby každé dve po sebe idúce
 * susedili hranou (Manhattan vzdialenosť 1) — cesta je vždy súvislá a autotile ju vykreslí bez skokov.
 *
 * Algoritmus je Bresenham v 4-súvislej variante (Red Blob Games, „walk grid“): v každom kroku sa ide o jednu
 * bunku v osi, ktorej stred prekročenia ideálnej priamky nastane skôr. Ak nastane súčasne (presná diagonála),
 * urobí sa „L-krok“: najprv v osi x, potom v osi y. Výsledok je deterministický a nezávislý od udalostí myši.
 */
import type { CellCoord } from '@sim/grid';

/**
 * Bunky z `from` do `to` vrátane oboch krajov, v poradí od `from`. Ak sú rovnaké, vráti jednu bunku.
 * Dĺžka výsledku je vždy `|Δx| + |Δy| + 1`. Súradnice musia byť celé čísla.
 */
export function interpolateCells(from: CellCoord, to: CellCoord): CellCoord[] {
  if (!Number.isInteger(from.x) || !Number.isInteger(from.y) || !Number.isInteger(to.x) || !Number.isInteger(to.y)) {
    throw new RangeError(
      `interpolateCells: súradnice musia byť celé čísla, dostal (${String(from.x)}, ${String(from.y)}) → (${String(to.x)}, ${String(to.y)})`,
    );
  }
  const nx = Math.abs(to.x - from.x);
  const ny = Math.abs(to.y - from.y);
  const stepX = to.x >= from.x ? 1 : -1;
  const stepY = to.y >= from.y ? 1 : -1;

  let x = from.x;
  let y = from.y;
  const cells: CellCoord[] = [{ x, y }];
  let ix = 0;
  let iy = 0;
  while (ix < nx || iy < ny) {
    // Porovnanie (ix + ½)/nx ↔ (iy + ½)/ny bez delenia: záporné = x-ový priesečník je skôr.
    const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (decision < 0) {
      x += stepX;
      ix += 1;
    } else if (decision > 0) {
      y += stepY;
      iy += 1;
    } else {
      // Presná diagonála: L-krok (x, potom y) — bunka medzi nimi zaručí 4-súvislosť.
      x += stepX;
      cells.push({ x, y });
      y += stepY;
      ix += 1;
      iy += 1;
    }
    cells.push({ x, y });
  }
  return cells;
}
