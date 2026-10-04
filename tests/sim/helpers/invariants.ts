/**
 * Invarianty, ktoré sa kontrolujú po každom ticku v scenárových testoch (ARCHITECTURE §6 krok 12, §16).
 */
import type { World } from '@sim/world';

function invariant(condition: boolean, message: () => string): void {
  if (!condition) throw new Error(`invariant porušený: ${message()}`);
}

/**
 * `assertCargoConservation(world)` — „každá jednotka nákladu má presne jednu lokáciu, súčet je konštantný"
 * (ARCHITECTURE §6 krok 12, §16). Deleguje na `world.cargo.assertConservation()`: každá jednotka v práve jednom
 * indexe zodpovedajúcom jej lokácii, žiadne miesto obsadené dvakrát, `createdCount = živé + exported`.
 * Porušenie → `CargoConservationError` so správou, ktorá pomenuje jednotku aj lokácie.
 */
export function assertCargoConservation(world: World): void {
  world.cargo.assertConservation();
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
