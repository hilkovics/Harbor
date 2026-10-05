// T6A-07: oznámenia o exporte a bookingu — cut-off o N h, jednotka rolled, VGM hold, loď odplávala s exportom, penalizácia
// bookingu a jeden toast za voyage pri prijatí roundtripu (ADR-032). Sim emituje tieto udalosti až s T6A-04/05, preto sa
// testuje na syntetických udalostiach a svete s bookingom vloženým do knihy kontraktov.
import { describe, expect, it } from 'vitest';
import type { ContractId, EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import {
  BOOKING_PENALTY_TOAST_TITLE,
  ToastCenter,
  TOAST_SHOW_PANEL_LABEL,
  cutoffInText,
  toastSpecsForEvents,
  unitsText,
} from '@app/toast-center';
import { createApp } from './app-fixtures';
import { acceptRoundtrip, addRoundtripOffer } from './f6a-fixtures';

const SCALE = { ticksPerHour: 360, ticksPerDay: 8640 };

function appWithRoundtrip() {
  const app = createApp();
  const roundtrip = addRoundtripOffer(app.world);
  acceptRoundtrip(app.world, roundtrip);
  return { ...app, ...roundtrip, exportId: roundtrip.exportContract.id as ContractId, importId: roundtrip.importContract.id as ContractId };
}

describe('pomocné texty', () => {
  it('unitsText: 1 jednotka, 2–4 jednotky, 5+ jednotiek', () => {
    expect([1, 2, 4, 5, 12].map(unitsText)).toEqual(['1 jednotka', '2 jednotky', '4 jednotky', '5 jednotiek', '12 jednotiek']);
  });

  it('cutoffInText: hodiny / dni, pod hodinu „menej než hodinu“', () => {
    expect(cutoffInText(6 * 360, SCALE)).toBe('6 h');
    expect(cutoffInText(8640 + 2 * 360, SCALE)).toBe('1 d 2 h');
    expect(cutoffInText(100, SCALE)).toBe('menej než hodinu');
    expect(cutoffInText(-5, SCALE)).toBe('menej než hodinu');
  });
});

describe('toastSpecsForEvents: export a booking', () => {
  it('CutoffWarning: warning „Cut-off exportu o 6 h“ s cieľom a dovezenými jednotkami, akcia na panel', () => {
    const { world, exportId, exportContract } = appWithRoundtrip();
    exportContract.recordArrival(1 as EntityId, false);
    exportContract.recordArrival(2 as EntityId, false);
    const cutoffTick = world.clock.tick + 6 * world.clock.ticksPerHour;
    const specs = toastSpecsForEvents(world, [{ type: 'CutoffWarning', contractId: exportId, cutoffTick }]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      key: `cutoff_warning:${String(exportId)}`,
      tone: 'warning',
      icon: 'ic_clock',
      title: 'Cut-off exportu o 6 h',
      panel: 'contracts',
    });
    expect(specs[0]?.text).toBe(`#${String(exportId)} · Export 24 TEU → Rotterdam · dovezené 2 / 24 TEU`);
  });

  it('UnitRolled: jeden toast za kontrakt a dávku so súčtom jednotiek; iný kontrakt samostatne', () => {
    const { world, exportId, importId } = appWithRoundtrip();
    const rolled = (contractId: ContractId, unitId: number): SimEvent => ({ type: 'UnitRolled', contractId, unitId: unitId as EntityId });
    const specs = toastSpecsForEvents(world, [rolled(exportId, 1), rolled(exportId, 2), rolled(exportId, 3), rolled(importId, 9)]);
    expect(specs.map((spec) => spec.key)).toEqual([`unit_rolled:${String(exportId)}`, `unit_rolled:${String(importId)}`]);
    expect(specs[0]).toMatchObject({ tone: 'warning', icon: 'ic_warning', title: '3 jednotky po cut-off (rolled)', panel: 'contracts' });
    expect(specs[0]?.text).toContain('Export 24 TEU → Rotterdam');
    expect(specs[0]?.text).toContain('naloží sa len ak loď ešte nezačala lashing');
    expect(specs[1]?.title).toBe('1 jednotka po cut-off (rolled)');
  });

  it('VgmHoldStarted: „Chýba VGM“ zlúčené podľa kontraktu, uvoľnenie podľa najskoršieho konca', () => {
    const { world, exportId } = appWithRoundtrip();
    const hold = (unitId: number, hours: number): SimEvent => ({
      type: 'VgmHoldStarted',
      contractId: exportId,
      unitId: unitId as EntityId,
      untilTick: world.clock.tick + hours * world.clock.ticksPerHour,
    });
    const specs = toastSpecsForEvents(world, [hold(1, 6), hold(2, 5)]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ key: `vgm_hold:${String(exportId)}`, tone: 'warning', icon: 'ic_lock', title: 'Chýba VGM' });
    expect(specs[0]?.text).toBe(`#${String(exportId)} · Export 24 TEU → Rotterdam · zadržané: 2 jednotky, uvoľnenie o 5 h`);
  });

  it('ExportShipped: success s triedou lode, počtom a cieľom z export kontraktu lode; bez kontraktu len číslo lode', () => {
    const { world, exportContract } = appWithRoundtrip();
    exportContract.shipId = 55 as EntityId;
    const [shipped] = toastSpecsForEvents(world, [{ type: 'ExportShipped', shipId: 55 as EntityId, units: 22 }]);
    expect(shipped).toMatchObject({ key: 'export_shipped:55', tone: 'success', icon: 'ic_ship', title: 'Loď odplávala s exportom', panel: 'contracts' });
    expect(shipped?.text).toBe('Feeder · 22 TEU → Rotterdam');
    const [unknown] = toastSpecsForEvents(world, [{ type: 'ExportShipped', shipId: 77 as EntityId, units: 3 }]);
    expect(unknown?.text).toBe('Loď #77 · 3 jedn.');
  });

  it('BookingPenaltyApplied: názov podľa druhu, počet jednotiek a suma; nesplnený booking bez počtu', () => {
    const { world, exportId } = appWithRoundtrip();
    const penalty = (kind: 'last_minute' | 'rolled' | 'unfulfilled', units: number, amountCents: number): SimEvent => ({
      type: 'BookingPenaltyApplied',
      contractId: exportId,
      kind,
      units,
      amountCents,
    });
    const specs = toastSpecsForEvents(world, [penalty('last_minute', 1, 192_000), penalty('rolled', 2, 480_000), penalty('unfulfilled', 1, 960_000)]);
    expect(specs.map((spec) => spec.title)).toEqual([
      BOOKING_PENALTY_TOAST_TITLE.last_minute,
      BOOKING_PENALTY_TOAST_TITLE.rolled,
      BOOKING_PENALTY_TOAST_TITLE.unfulfilled,
    ]);
    expect(specs.map((spec) => spec.key)).toEqual(['last_minute', 'rolled', 'unfulfilled'].map((kind) => `booking_penalty:${String(exportId)}:${kind}`));
    expect(specs.every((spec) => spec.tone === 'warning' && spec.panel === 'contracts')).toBe(true);
    const label = `#${String(exportId)} · Export 24 TEU → Rotterdam`;
    expect(specs[0]?.text).toBe(`${label} · 1 jednotka · −$1,920`);
    expect(specs[1]?.text).toBe(`${label} · 2 jednotky · −$4,800`);
    expect(specs[2]?.text).toBe(`${label} · −$9,600`);
  });

  it('ContractAccepted roundtripu: jeden toast za voyage s oboma kontraktmi a časom do príchodu lode', () => {
    const { world, importId, exportId, voyageId } = appWithRoundtrip();
    const specs = toastSpecsForEvents(world, [
      { type: 'ContractAccepted', contractId: importId },
      { type: 'ContractAccepted', contractId: exportId },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ key: `contract_accepted:${String(voyageId)}`, tone: 'info', title: 'Kontrakt prijatý', panel: 'contracts' });
    expect(specs[0]?.text).toBe(`#${String(importId)} · 48 TEU + #${String(exportId)} · Export 24 TEU → Rotterdam — loď príde o 2 dni`);
  });

  it('výplata exportu nesie cieľ v popise kontraktu', () => {
    const { world, exportId } = appWithRoundtrip();
    const [spec] = toastSpecsForEvents(world, [{ type: 'ContractCompleted', contractId: exportId, rewardCents: 8_800_000, penaltiesCents: 0, xp: 22, onTime: true }]);
    expect(spec?.text).toBe(`#${String(exportId)} · Export 24 TEU → Rotterdam · +$88,000 a +22 XP`);
  });

  it('CutoffPassed, VgmHoldReleased, UnitLoaded a DualCycle toast nemajú', () => {
    const { world, exportId } = appWithRoundtrip();
    const specs = toastSpecsForEvents(world, [
      { type: 'CutoffPassed', contractId: exportId, arrivedUnits: 10, bookedUnits: 24 },
      { type: 'VgmHoldReleased', contractId: exportId, unitId: 1 as EntityId },
      { type: 'UnitLoaded', craneId: 2 as EntityId, shipId: 3 as EntityId, unitId: 1 as EntityId, contractId: exportId, lastMinute: false, outOfOrder: false },
      { type: 'DualCycle', craneId: 2 as EntityId, shipId: 3 as EntityId, loadedUnitId: 1 as EntityId, unloadedUnitId: 4 as EntityId },
    ]);
    expect(specs).toEqual([]);
  });
});

describe('ToastCenter: export', () => {
  it('rovnaký kontrakt a druh penalizácie sa nezdvojí, kým je toast zobrazený; akcia „Zobraziť“ otvorí panel kontraktov', () => {
    const { bridge, exportId } = appWithRoundtrip();
    const opened: string[] = [];
    const center = new ToastCenter(bridge, {
      openPanel: (panel) => {
        opened.push(panel);
      },
    });
    const penalty: SimEvent = { type: 'BookingPenaltyApplied', contractId: exportId, kind: 'rolled', units: 1, amountCents: 1000 };
    bridge.publish([penalty]);
    bridge.publish([penalty]);
    expect(center.get()).toHaveLength(1);
    const [toast] = center.get();
    expect(toast?.showLabel).toBe(TOAST_SHOW_PANEL_LABEL);
    toast?.onShow?.(toast.id);
    expect(opened).toEqual(['contracts']);
    center.dispose();
  });
});
