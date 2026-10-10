/**
 * Hot path prázdnych kontajnerov bez alokácií v ticku (T6C-07b, review src/sim, minor 1; vzor `tests/sim/exports/export-hot-path.test.ts`): plán
 * toku prázdnych (`EmptyFlow`: poverenia kamiónov `collect`), joby prijatia a výdaja (`empty-jobs`), kamióny `collect` (`empty-collect`), spawn návratov
 * (`empty-trucks`), zásoba prázdnych (`empty-stock`, `load-access`), nakládka a čakajúci náklad lode (`export-load`, `voyage-cargo`, `awaitsCrane`
 * dispatchera) a invarianty kroku 12 (`checkEmptyFlow`, `loadedProblem`) nevytvárajú v ustálenom behu `Set`, ani nevolajú `sort`, `find`, `findIndex`,
 * `some` (každé z nich alokuje pole alebo uzáver v každom ticku). Test zaznamená miesto (zásobník volaní) každej takej operácie počas
 * okna a vyžaduje, aby žiadne nepochádzalo z uvedených súborov / funkcií (tvorba jobu `TransportJob`, brána, stojisko majú vlastné alokácie mimo tejto karty).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimEvent } from '@sim/events';
import type { World } from '@sim/world';
import { acceptCommand, acceptedBooking, send } from '../helpers/f6a';
import { depotOf, emptiesByLocation, emptyWorld, eventsOf, f6cDefs, offerRepositioning, run, runUntil, stockDepot } from '../helpers/f6c';

const VEHICLES = ['straddle_carrier', 'straddle_carrier', 'empty_handler'];
/** Súbory a funkcie hot pathu prázdnych (viď hlavička). */
const HOT_PATH =
  /(empty-flow|empty-jobs|empty-collect|empty-trucks|empty-stock|empty-depot-service|load-access|voyage-cargo|export-load)\.ts|checkEmptyFlow|loadedProblem|awaitsCrane/;
/** Počet zásobníkových rámcov od miesta volania, v ktorých sa hľadá hot path (obal sledovania + volajúci). */
const FRAMES = 4;
const SPIED_METHODS = ['sort', 'find', 'findIndex', 'some'] as const;

/** Tickuje `ticks` tickov a vráti miesta konštrukcií `Set` a volaní sledovaných metód poľa zo súborov hot pathu; udalosti okna zapíše do `sink`. */
function hotPathAllocations(world: World, ticks: number, sink?: { readonly tick: number; readonly event: SimEvent }[]): string[] {
  const found: string[] = [];
  let recording = false;
  const record = (what: string): void => {
    if (recording) return;
    recording = true;
    try {
      const frames = (new Error().stack ?? '').split('\n').slice(2, 2 + FRAMES);
      // Tvorba jobu `TransportJob` (vznik kamióna `collect` s jobom `receive`, R4) má vlastné alokácie mimo tejto karty.
      if (frames.some((frame) => /transport-job\.ts/.test(frame))) return;
      for (const frame of frames) {
        if (!HOT_PATH.test(frame)) continue;
        found.push(`${what} ${frame.trim()}`);
        break;
      }
    } finally {
      recording = false;
    }
  };
  const RealSet = globalThis.Set;
  class CountingSet<T> extends RealSet<T> {
    constructor(values?: Iterable<T> | null) {
      super(values);
      record('Set');
    }
  }
  const spies = SPIED_METHODS.map((method) => {
    const real = Array.prototype[method] as (...args: unknown[]) => unknown;
    return vi.spyOn(Array.prototype, method).mockImplementation(function (this: unknown[], ...args: unknown[]) {
      record(`Array.${method}`);
      return real.apply(this, args);
    } as never);
  });
  vi.stubGlobal('Set', CountingSet);
  try {
    for (let i = 0; i < ticks; i++) {
      const batch = world.tick();
      if (sink !== undefined) for (const event of batch) sink.push({ tick: world.clock.tick, event });
    }
  } finally {
    vi.unstubAllGlobals();
    for (const spy of spies) spy.mockRestore();
  }
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('hot path prázdnych kontajnerov — žiadne Set / sort / find / findIndex / some zo súborov hot pathu', () => {
  it('návraty (kamión, brána, rampa, job prijatia, uloženie, kontrola) a výdaj kamiónmi collect (poverenia, pridelenie, nakládka z docku)', () => {
    const defs = f6cDefs({ emptyFlow: { damageChance: 0.5, emptyPickupMaxWaitHours: 12 } });
    const world = emptyWorld({ defs, vehicles: VEHICLES });
    stockDepot(world, 'blue_anchor', 3);
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    const tick = world.clock.tick;
    for (let i = 0; i < 4; i++) world.emptyFlow.scheduleReturn(tick + 5 + 10 * i, i % 2 === 0 ? 'northern_star' : 'golden_wave');
    for (let i = 0; i < 2; i++) world.emptyFlow.schedulePickup(tick + 20 + 10 * i, 'blue_anchor', exportContract.id);
    const found = hotPathAllocations(world, 3_000);
    expect(world.emptyFlow.pickupPlan).toEqual([]);
    expect(world.cargo.exportedCount).toBeGreaterThanOrEqual(2);
    expect(world.cargo.createdCount).toBeGreaterThan(4);
    expect(found).toEqual([]);
  }, 60_000);

  it('okno s nakládkou repositioningu (výber prázdneho, pending, štart cyklu žeriavu) a pretekajúce depo (EmptyReturnDeclined)', () => {
    const defs = f6cDefs({ moduleParams: { empty_depot: { capacityUnits: 5 } }, emptyFlow: { damageChance: 0 } });
    const world = emptyWorld({ defs, vehicles: VEHICLES });
    stockDepot(world, 'blue_anchor', 4);
    const contract = offerRepositioning(world, { booked: 4 });
    send(world, acceptCommand(contract.id));
    // loď zakotví a booking sa otvorí (rozbeh mimo sledovaného okna); v okne sa prideľuje, nakladá a vracajú sa prázdne
    runUntil(world, () => contract.state === 'exporting', 30_000, 'booking v exporting');
    const tick = world.clock.tick;
    for (let i = 0; i < 6; i++) world.emptyFlow.scheduleReturn(tick + 5 + 5 * i, 'golden_wave');
    const events: { tick: number; event: SimEvent }[] = [];
    const found = hotPathAllocations(world, 3_000, events);
    expect(contract.booking.loadedUnits).toBeGreaterThan(0);
    expect(eventsOf(events, 'EmptyReturnDeclined').length).toBeGreaterThan(0);
    expect(depotOf(world).storedCount).toBeGreaterThan(0);
    expect(emptiesByLocation(world)['in_storage']).toBeGreaterThan(0);
    expect(found).toEqual([]);
  }, 60_000);

  it('plán bez splatných položiek a bez poverení: prázdny tick nealokuje (dueReturn / duePickup bez rozkladu poľa)', () => {
    const world = emptyWorld({ vehicles: VEHICLES });
    run(world, 5);
    expect(hotPathAllocations(world, 300)).toEqual([]);
  });
});
