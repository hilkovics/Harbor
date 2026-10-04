// T6C-05: oznámenia o prázdnych kontajneroch a prekládke — návrat prázdnych (nenápadný, súhrnný), oprava hotová, výdaj prázdneho
// zlyhal, tranship zmeškaný / zachránený / predaný (ADR-034). Sim ich emituje až s T6C-02 / T6C-03, preto sa testuje na
// syntetických udalostiach nad svetom s kontraktmi vloženými do knihy a postaveným depom prázdnych.
import { describe, expect, it } from 'vitest';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { QUIET_TOAST_AUTO_CLOSE_MS, TOAST_AUTO_CLOSE_MS } from '@app/config';
import type { TimerHost } from '@app/snapshot-store';
import {
  EMPTY_PICKUP_MISSED_TOAST_TITLE,
  EMPTY_REPAIRED_TOAST_TITLE,
  EMPTY_RETURNED_TOAST_TITLE,
  TRANSHIP_MISSED_TOAST_TITLE,
  TRANSHIP_RESCUED_TOAST_TITLE,
  TRANSHIP_SOLD_TOAST_TITLE,
  TOAST_SHOW_ON_MAP_LABEL,
  ToastCenter,
  emptiesText,
  toastSpecsForEvents,
} from '@app/toast-center';
import { buildLogistics, createApp, runCommands, type App } from './app-fixtures';
import { acceptRoundtrip, addRoundtripOffer } from './f6a-fixtures';
import { acceptContract, addRepositioningOffer, addTranshipOffer } from './f6c-fixtures';

const EMPTY_DEPOT_ID = 6 as EntityId;
const GATE = 7 as EntityId;
const TRUCK = 8 as EntityId;

function appWithDepot(): App {
  const app = createApp();
  buildLogistics(app);
  runCommands(app, [{ type: 'PlaceModule', defId: 'empty_depot', x: 34, y: 18, rotation: 0 }]);
  return app;
}

const returned = (lineId: string, unitId: number): SimEvent => ({ type: 'EmptyReturned', unitId: unitId as EntityId, lineId, truckId: TRUCK, gateId: GATE });
const repaired = (lineId: string, unitId: number, costCents: number, moduleId: EntityId = EMPTY_DEPOT_ID): SimEvent => ({
  type: 'EmptyRepaired',
  unitId: unitId as EntityId,
  lineId,
  moduleId,
  costCents,
});

describe('emptiesText', () => {
  it('1 prázdny kontajner, 2–4 prázdne kontajnery, 5+ prázdnych kontajnerov', () => {
    expect([1, 2, 4, 5, 12].map(emptiesText)).toEqual([
      '1 prázdny kontajner',
      '2 prázdne kontajnery',
      '4 prázdne kontajnery',
      '5 prázdnych kontajnerov',
      '12 prázdnych kontajnerov',
    ]);
  });
});

describe('toastSpecsForEvents: návrat prázdnych', () => {
  it('súhrnný nenápadný toast: jeden za linku a dávku so súčtom kusov, nie za každý kus', () => {
    const { world } = createApp();
    const specs = toastSpecsForEvents(world, [returned('blue_anchor', 1), returned('blue_anchor', 2), returned('blue_anchor', 3), returned('golden_wave', 4)]);
    expect(specs.map((spec) => spec.key)).toEqual(['empty_returned:blue_anchor', 'empty_returned:golden_wave']);
    expect(specs[0]).toMatchObject({ tone: 'info', icon: 'ic_truck', title: EMPTY_RETURNED_TOAST_TITLE, autoCloseMs: QUIET_TOAST_AUTO_CLOSE_MS });
    expect(specs[0]?.text).toBe('Blue Anchor Lines · 3 prázdne kontajnery z vnútrozemia');
    expect(specs[1]?.text).toBe('Golden Wave Container · 1 prázdny kontajner z vnútrozemia');
    // Nenápadný: bez akcie (panel ani kamera) a kratší čas než bežný toast.
    expect(specs[0]).not.toHaveProperty('panel');
    expect(specs[0]).not.toHaveProperty('focus');
    expect(QUIET_TOAST_AUTO_CLOSE_MS).toBeLessThan(TOAST_AUTO_CLOSE_MS);
  });

  it('ToastCenter: ďalší návrat tej istej linky sa pri zobrazenom toaste nezdvojí a toast sa zatvorí rýchlo', () => {
    const timers = new FakeTimers();
    const { bridge } = createApp();
    const center = new ToastCenter(bridge, { timers });
    bridge.publish([returned('blue_anchor', 1)]);
    bridge.publish([returned('blue_anchor', 2)]);
    expect(center.get()).toHaveLength(1);
    timers.advance(QUIET_TOAST_AUTO_CLOSE_MS);
    expect(center.get()).toEqual([]);
    bridge.publish([returned('blue_anchor', 3)]);
    expect(center.get()).toHaveLength(1);
    center.dispose();
  });
});

describe('toastSpecsForEvents: oprava hotová', () => {
  it('zlúčené podľa depa a linky: počet opravených a súčet cien; akcia „Ukázať“ na depo', () => {
    const { world } = appWithDepot();
    const specs = toastSpecsForEvents(world, [repaired('blue_anchor', 1, 12_000), repaired('blue_anchor', 2, 12_000), repaired('golden_wave', 3, 12_000)]);
    expect(specs.map((spec) => spec.key)).toEqual([`empty_repaired:${String(EMPTY_DEPOT_ID)}:blue_anchor`, `empty_repaired:${String(EMPTY_DEPOT_ID)}:golden_wave`]);
    expect(specs[0]).toMatchObject({ tone: 'success', icon: 'ic_check', title: EMPTY_REPAIRED_TOAST_TITLE });
    expect(specs[0]?.text).toBe('YRD-06 · Blue Anchor Lines · opravené: 2 · −$240');
    expect(specs[1]?.text).toBe('YRD-06 · Golden Wave Container · opravené: 1 · −$120');
    const depot = world.modules.get(EMPTY_DEPOT_ID);
    expect(depot).toBeDefined();
    expect(specs[0]?.focus).toEqual({ x: (depot?.origin.x ?? 0) + (depot?.size.w ?? 0) / 2, y: (depot?.origin.y ?? 0) + (depot?.size.h ?? 0) / 2 });
  });

  it('zaniknuté depo: toast ostane, len bez akcie „Ukázať“', () => {
    const { world } = createApp();
    const [spec] = toastSpecsForEvents(world, [repaired('blue_anchor', 1, 12_000, 99 as EntityId)]);
    expect(spec).toMatchObject({ title: EMPTY_REPAIRED_TOAST_TITLE });
    expect(spec).not.toHaveProperty('focus');
  });

  it('ToastCenter: akcia „Ukázať“ vycentruje kameru na depo', () => {
    const app = appWithDepot();
    const centered: [number, number][] = [];
    const center = new ToastCenter(app.bridge, {
      centerOn: (x, y) => {
        centered.push([x, y]);
      },
    });
    app.bridge.publish([repaired('blue_anchor', 1, 12_000)]);
    const [toast] = center.get();
    expect(toast?.showLabel).toBe(TOAST_SHOW_ON_MAP_LABEL);
    toast?.onShow?.(toast.id);
    const depot = app.world.modules.get(EMPTY_DEPOT_ID);
    expect(centered).toEqual([[(depot?.origin.x ?? 0) + (depot?.size.w ?? 0) / 2, (depot?.origin.y ?? 0) + (depot?.size.h ?? 0) / 2]]);
    center.dispose();
  });
});

describe('toastSpecsForEvents: výdaj prázdneho zlyhal', () => {
  it('warning s kontraktom exportéra, linkou a dôvodom; viac kamiónov kontraktu v dávke dá jeden toast s počtom', () => {
    const { world } = createApp();
    const roundtrip = addRoundtripOffer(world);
    acceptRoundtrip(world, roundtrip);
    const exportId = roundtrip.exportContract.id as ContractId;
    const missed = (truckId: number): SimEvent => ({ type: 'EmptyPickupMissed', lineId: 'blue_anchor', contractId: exportId, truckId: truckId as EntityId });
    const [single] = toastSpecsForEvents(world, [missed(1)]);
    expect(single).toMatchObject({ key: `empty_pickup_missed:${String(exportId)}`, tone: 'warning', icon: 'ic_warning', title: EMPTY_PICKUP_MISSED_TOAST_TITLE, panel: 'contracts' });
    expect(single?.text).toBe(`#${String(exportId)} · Export 24 TEU → Rotterdam · Blue Anchor Lines nemala dostupný prázdny kontajner, kamión odišiel prázdny`);
    const specs = toastSpecsForEvents(world, [missed(1), missed(2), missed(3)]);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.text).toMatch(/odišiel prázdny \(×3\)$/);
  });
});

describe('toastSpecsForEvents: tranship', () => {
  function appWithTranship() {
    const app = createApp();
    const tranship = addTranshipOffer(app.world, { volumeUnits: 36, destinationPort: 'Hamburg' });
    acceptContract(app.world, tranship);
    return { ...app, tranship, id: tranship.id as ContractId, outVoyageId: tranship.outVoyageId as VoyageId };
  }

  it('TranshipMissed: danger „Tranship zmeškaný“ s popisom kontraktu, plavbou lode B a počtom jednotiek; akcia na panel', () => {
    const { world, id, outVoyageId } = appWithTranship();
    const [spec] = toastSpecsForEvents(world, [{ type: 'TranshipMissed', contractId: id, units: 24, outVoyageId }]);
    expect(spec).toMatchObject({ key: `tranship_missed:${String(id)}`, tone: 'danger', icon: 'ic_warning', title: TRANSHIP_MISSED_TOAST_TITLE, panel: 'contracts' });
    expect(spec?.text).toBe(`#${String(id)} · Tranship 36 TEU → Hamburg · loď B (plavba #${String(outVoyageId)}) odplávala, zmeškané: 24 jednotiek`);
  });

  it('TranshipRescued: info s plavbou, na ktorú jednotky čakajú; TranshipSold: warning s penalizáciou', () => {
    const { world, id, outVoyageId } = appWithTranship();
    const specs = toastSpecsForEvents(world, [
      { type: 'TranshipRescued', contractId: id, units: 1, outVoyageId },
      { type: 'TranshipSold', contractId: id, units: 6 },
    ]);
    expect(specs[0]).toMatchObject({ key: `tranship_rescued:${String(id)}`, tone: 'info', icon: 'ic_ship', title: TRANSHIP_RESCUED_TOAST_TITLE, panel: 'contracts' });
    expect(specs[0]?.text).toBe(`#${String(id)} · Tranship 36 TEU → Hamburg · zachránené: 1 jednotka, čakajú na plavbu #${String(outVoyageId)}`);
    expect(specs[1]).toMatchObject({ key: `tranship_sold:${String(id)}`, tone: 'warning', icon: 'ic_truck', title: TRANSHIP_SOLD_TOAST_TITLE, panel: 'contracts' });
    expect(specs[1]?.text).toBe(`#${String(id)} · Tranship 36 TEU → Hamburg · predané kamiónom (penalizácia): 6 jednotiek`);
  });

  it('popis kontraktu rozlišuje druh: repositioning „Prázdne“, prekládka „Tranship“, import bez názvu druhu', () => {
    const { world } = createApp();
    const repo = addRepositioningOffer(world, { destinationPort: 'Gdańsk' });
    const [spec] = toastSpecsForEvents(world, [{ type: 'ContractAccepted', contractId: repo.id }]);
    expect(spec?.text).toContain(`#${String(repo.id)} · Prázdne 24 TEU → Gdańsk`);
    const roundtrip = addRoundtripOffer(world);
    const [importSpec] = toastSpecsForEvents(world, [{ type: 'ContractAccepted', contractId: roundtrip.importContract.id }]);
    expect(importSpec?.text).toContain(`#${String(roundtrip.importContract.id)} · 48 TEU +`);
  });

  it('zaniknutý kontrakt: popis len `#id`, toast ostane', () => {
    const { world } = createApp();
    const [spec] = toastSpecsForEvents(world, [{ type: 'TranshipSold', contractId: 999 as ContractId, units: 2 }]);
    expect(spec?.text).toBe('#999 · predané kamiónom (penalizácia): 2 jednotky');
  });
});

describe('toastSpecsForEvents: udalosti bez toastu', () => {
  it('EmptyStored, EmptyDamaged, EmptyRepairStarted a EmptyPickedUp toast nemajú (stav je v inšpektore depa)', () => {
    const { world } = appWithDepot();
    const specs = toastSpecsForEvents(world, [
      { type: 'EmptyStored', unitId: 1 as EntityId, lineId: 'blue_anchor', moduleId: EMPTY_DEPOT_ID, fallback: false },
      { type: 'EmptyDamaged', unitId: 1 as EntityId, lineId: 'blue_anchor', moduleId: EMPTY_DEPOT_ID },
      { type: 'EmptyRepairStarted', unitId: 1 as EntityId, lineId: 'blue_anchor', moduleId: EMPTY_DEPOT_ID, untilTick: 100 },
      { type: 'EmptyPickedUp', unitId: 1 as EntityId, lineId: 'blue_anchor', contractId: 1 as ContractId, truckId: TRUCK },
    ]);
    expect(specs).toEqual([]);
  });
});

/** Ručne poháňané časovače (bez reálneho čakania). */
class FakeTimers implements TimerHost {
  now = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { at: this.now + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [handle, entry] of [...this.timers]) {
      if (entry.at > this.now) continue;
      this.timers.delete(handle);
      entry.callback();
    }
  }
}
