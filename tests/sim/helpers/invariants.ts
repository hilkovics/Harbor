/**
 * Invarianty, ktoré sa kontrolujú po každom ticku v scenárových testoch (ARCHITECTURE §6 krok 12, §16).
 */
import type { World } from '@sim/world';

function invariant(condition: boolean, message: () => string): void {
  if (!condition) throw new Error(`invariant porušený: ${message()}`);
}

/** Tvar, ktorý `World` získa s `CargoLedger` (fáza 2, ARCHITECTURE §6 krok 12: `cargo.assertConservation()`). */
interface WorldWithCargo {
  readonly cargo?: { assertConservation(): void };
}

/**
 * `assertCargoConservation(world)` — „každá jednotka nákladu má presne jednu lokáciu, súčet je konštantný".
 *
 * Vo fáze 1 `World` nemá `CargoLedger` (vzniká vo fáze 2), takže invariant je zatiaľ splnený triviálne:
 * neexistuje žiadny náklad, ktorý by sa mohol stratiť. Keď `world.cargo` existuje, deleguje sa na
 * `world.cargo.assertConservation()` — testy tak od fázy 2 kontrolujú skutočný ledger bez úpravy scenárov.
 */
export function assertCargoConservation(world: World): void {
  const { cargo } = world as unknown as WorldWithCargo;
  if (cargo !== undefined) cargo.assertConservation();
}

/**
 * Invarianty vrstvy ciest (ARCHITECTURE §5.1, §5.2, ADR-008) a peňazí (jedna mena v centoch, ARCHITECTURE §1).
 * Prechádza celú mriežku, preto sa volá po zmene ciest a v pravidelných intervaloch, nie po každom ticku.
 */
export function assertRoadInvariants(world: World): void {
  invariant(Number.isSafeInteger(world.cashCents), () => `cashCents nie je celé číslo: ${String(world.cashCents)}`);

  const { grid } = world;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const cell = grid.at(x, y);
      // Vo fáze 1 existuje iba vrstva 'road'; koľaje (PlaceRail) prídu vo fáze 10.
      invariant(cell.road === 'none' || cell.road === 'road', () => `(${String(x)}, ${String(y)}) má road='${cell.road}'`);
      if (cell.road === 'none') continue;

      invariant(cell.terrain === 'land' || cell.terrain === 'quay', () => `cesta na teréne ${cell.terrain} (${String(x)}, ${String(y)})`);
      invariant(cell.moduleId === null, () => `cesta pod modulom (${String(x)}, ${String(y)})`);
      if (cell.parcelId !== null) {
        const parcel = world.parcels.get(cell.parcelId);
        invariant(parcel !== undefined, () => `cesta v neznámej parcele '${cell.parcelId ?? ''}' (${String(x)}, ${String(y)})`);
        invariant(
          parcel?.ownership !== 'none',
          () => `cesta na parcele na predaj '${cell.parcelId ?? ''}' (${String(x)}, ${String(y)}), ADR-008`,
        );
      }
    }
  }
}

/** Počet buniek s cestou (vrstva `road`). */
export function countRoadCells(world: World): number {
  let count = 0;
  for (let y = 0; y < world.grid.height; y++) {
    for (let x = 0; x < world.grid.width; x++) {
      if (world.grid.at(x, y).road === 'road') count += 1;
    }
  }
  return count;
}
