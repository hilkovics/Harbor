/**
 * Úrovňové priecestia (ADR-043 dodatok TR6-02): bunka s cestou (`Cell.road = 'road'`), ktorou vedie aj koľaj (`Rail.crossings`). Vlak a cestné vozidlá sa na priecestí **nikdy neprekrývajú**
 * a vzájomné čakanie nemá cyklus:
 *
 * - **Závora = pruhové sloty** (ADR-037): vlak drží oba pruhové sloty bunky priecestia (`LaneSlots`, držiteľ = id vlaku), kým ho má pred sebou do `rail.crossingClearTicks` jazdy
 *   (`speedMilliCellsPerTick × crossingClearTicks` milli-buniek vopred) a kým naň zasahuje telo vlaku. Cestné vozidlo si slot v rezervovanom priecestí nezoženie (`TrafficSystem` ho berie ako
 *   obsadený slot), takže pred ním stojí — žiadna osobitná vetva v premávke. Vlak nezíska slot, ktorý drží vozidlo (je na priecestí): drží si voľné sloty a získa zvyšok, keď vozidlo odíde.
 * - **Vlak čaká na vozidlo:** do bunky priecestia vlak vstúpi, len keď drží oba sloty (`crossingsHeld`); inak stojí pred ňou. Vozidlo na priecestí nečaká na vlak (závora mu už nebráni
 *   odísť), takže cyklus čakania vlak ↔ vozidlo nevznikne.
 * - Stav slotov je odvodený z polôh vlakov (`syncCrossings` na konci kroku 6e a pri obnove save): po obnove sa rovná stavu pôvodného behu.
 */
import type { EntityId } from '../core/entity-id';
import type { World } from '../world/world';
import { LANES_PER_CELL, slotKey } from '../traffic/lane-slots';
import { MILLI_PER_CELL, type Train } from './train';

/** Rozsah indexov trasy, ktoré vlak drží (telo + rezervácia vpredu v smere jazdy); `hi < lo` = nič. */
function wantedRange(world: World, train: Train): { readonly lo: number; readonly hi: number } {
  const { lo, hi } = train.occupiedRangeAt(train.posMilli);
  const ahead = world.rail.def.train.speedMilliCellsPerTick * world.rail.crossingClearTicks;
  if (train.state === 'arriving') return { lo, hi: Math.min(train.route.length - 1, Math.ceil((train.posMilli + ahead) / MILLI_PER_CELL) - 1) };
  if (train.state === 'departing') return { lo: Math.floor(Math.max(0, train.posMilli - train.lengthMilli - ahead) / MILLI_PER_CELL), hi };
  return { lo, hi };
}

/** Zosúladí sloty priecestí trasy vlaku s jeho polohou: voľné sloty v rozsahu získa, sloty mimo rozsahu uvoľní (viď hlavička). */
export function syncCrossings(world: World, train: Train): void {
  const { rail, laneSlots } = world;
  if (rail.crossings.size === 0) return;
  const { lo, hi } = wantedRange(world, train);
  for (let i = 0; i < train.route.length; i++) {
    const cell = train.route[i];
    if (!rail.crossings.has(cell)) continue;
    const wanted = i >= lo && i <= hi;
    for (let lane = 0; lane < LANES_PER_CELL; lane++) {
      const key = slotKey(cell, lane);
      const holder = laneSlots.holderOfKey(key);
      if (wanted && holder === 0) laneSlots.claim(key, train.id);
      else if (!wanted && holder === train.id) laneSlots.release(key, train.id);
    }
  }
}

/** Uvoľní všetky sloty priecestí, ktoré vlak drží (zánik vlaka). */
export function releaseCrossings(world: World, train: Train): void {
  const { rail, laneSlots } = world;
  if (rail.crossings.size === 0) return;
  for (const cell of train.route) {
    if (!rail.crossings.has(cell)) continue;
    for (let lane = 0; lane < LANES_PER_CELL; lane++) {
      const key = slotKey(cell, lane);
      if (laneSlots.holderOfKey(key) === train.id) laneSlots.release(key, train.id);
    }
  }
}

/** Drží vlak oba sloty všetkých priecestí na indexoch trasy `from … to` (vrátane)? Vstup do bunky priecestia je povolený len vtedy. */
export function crossingsHeld(world: World, train: Train, from: number, to: number): boolean {
  const { rail, laneSlots } = world;
  if (rail.crossings.size === 0) return true;
  for (let i = Math.max(0, from); i <= Math.min(train.route.length - 1, to); i++) {
    const cell = train.route[i];
    if (!rail.crossings.has(cell)) continue;
    for (let lane = 0; lane < LANES_PER_CELL; lane++) if (laneSlots.holderOfKey(slotKey(cell, lane)) !== train.id) return false;
  }
  return true;
}

/** Stav závory priecestia pre VM: `closed`, keď niektorý jeho pruhový slot drží vlak; inak `open`. */
export function crossingBarrier(world: World, cell: number): 'open' | 'closed' {
  for (let lane = 0; lane < LANES_PER_CELL; lane++) {
    if (world.rail.trains.has(world.laneSlots.holderOfKey(slotKey(cell, lane)) as EntityId)) return 'closed';
  }
  return 'open';
}

/** Priecestia mapy s aktuálnym stavom závory (vzostupne podľa bunky) — `RailVM.crossings`. */
export function crossingStates(world: World): readonly { readonly cell: number; readonly barrier: 'open' | 'closed' }[] {
  return [...world.rail.crossings].sort((a, b) => a - b).map((cell) => ({ cell, barrier: crossingBarrier(world, cell) }));
}
