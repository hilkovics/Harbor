/**
 * Hot path exportu bez alokácií v ticku (T6A-09b, review src/sim, major 4; ADR-032, ADR-033): dispatcher (nakládka, vykládka pod hákom,
 * prijatie exportu), štart cyklu žeriavu a spawn kamiónov s exportom nevytvárajú v ustálenom behu `Set` ani nezoraďujú polia
 * v každom ticku — používajú znovupoužiteľné polia na úrovni modulu (vzor `BOOKINGS`, `DUE_HOLDS`) a výber najlepšej jednotky
 * stowage plánu bez triedenia. Test zaznamená miesto (zásobník volaní) každej konštrukcie `Set` a každého `Array.prototype.sort`
 * počas okna a vyžaduje, aby žiadne nepochádzalo zo súborov hot pathu exportu (tvorba jobu `TransportJob` alebo invarianty kroku 12
 * majú vlastné alokácie, mimo tejto karty).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DefRegistry } from '@sim/defs';
import type { World } from '@sim/world';
import { apronDefs, hookDefs, startLoading, tickUntil } from '../helpers/f6a';

const ARRIVALS = [10, 20, 30, 40, 50, 60, 70, 80];
/** Súbory hot pathu exportu a žeriava. */
const HOT_PATH = /(export-load|export-intake|crane-handover|crane-system|export-trucks)\.ts/;
/** Počet zásobníkových rámcov od miesta volania, v ktorých sa hľadá súbor hot pathu (obal sledovania + volajúci). */
const FRAMES = 4;

/** Tickuje `ticks` tickov a vráti miesta konštrukcií `Set` a volaní `sort` zo súborov hot pathu. */
function hotPathAllocations(world: World, ticks: number): string[] {
  const found: string[] = [];
  const record = (what: string): void => {
    const frames = (new Error().stack ?? '').split('\n').slice(2, 2 + FRAMES);
    const hit = frames.find((frame) => HOT_PATH.test(frame));
    if (hit !== undefined) found.push(`${what} ${hit.trim()}`);
  };
  const realSort = Array.prototype.sort;
  const RealSet = globalThis.Set;
  class CountingSet<T> extends RealSet<T> {
    constructor(values?: Iterable<T> | null) {
      super(values);
      record('Set');
    }
  }
  const sort = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare?: (a: unknown, b: unknown) => number) {
    record('sort');
    return realSort.call(this, compare);
  });
  vi.stubGlobal('Set', CountingSet);
  try {
    for (let i = 0; i < ticks; i++) world.tick();
  } finally {
    vi.unstubAllGlobals();
    sort.mockRestore();
  }
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each<[string, () => DefRegistry]>([
  ['apron', () => apronDefs()],
  ['under_hook', () => hookDefs()],
])('hot path exportu — režim %s', (_mode, makeDefs) => {
  it('príchody kamiónov a prijatie do skladu (spawn, intake joby): žiadny Set ani sort zo súborov hot pathu', () => {
    const { world, offer } = startLoading({ defs: makeDefs(), kind: 'roundtrip', booked: 8, importUnits: 8, arrivals: ARRIVALS });
    const found = hotPathAllocations(world, 800);
    expect(offer.exportContract.booking.arrivedUnits).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });

  it('okno s nakládkou (jednotky v sklade, dispatch nakládky, štart cyklu žeriavu): žiadny Set ani sort zo súborov hot pathu', () => {
    const { world, offer } = startLoading({ defs: makeDefs(), kind: 'roundtrip', booked: 8, importUnits: 8, arrivals: ARRIVALS });
    tickUntil(world, (w) => w.ships.size === 1 && offer.exportContract.booking.loadedUnits >= 1, 40_000);
    const found = hotPathAllocations(world, 600);
    expect(offer.exportContract.booking.loadedUnits).toBeGreaterThan(1);
    expect(found).toEqual([]);
  });
});
