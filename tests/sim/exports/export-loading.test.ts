/**
 * Nakládka exportu v režime `apron` (F6a, T6A-05, ADR-032 bod 8–14): stowage poradie (heavy → medium → light, id), rezerva
 * apronu pre opačný smer, kapacita lode pre import + export, dual cycling (`dualCycleFactor`), lashing a papiere, `shipped` pri
 * odchode lode a uzavretie bookingu (výplata pomerne k naloženým, penalizácie, vrátenie nenaložených odosielateľovi).
 * Svet = prístav F4 s dvoma vozidlami (`exportWorld`), booking sa prijíma príkazom, príchody kamiónov sú pevné (`arrivals`).
 */
import { describe, expect, it } from 'vitest';
import type { WeightClass } from '@sim/cargo/cargo-unit';
import { compareStowageOrder } from '@sim/cargo/stowage';
import { bookingUnitsPenaltyCents } from '@sim/contracts/contract-terms';
import type { EntityId } from '@sim/core';
import { apronDirectionCap, exportApronUsage, importApronUsage } from '@sim/logistics/apron-usage';
import { exportAboard, importAboard, pendingExportUnits, stowageOutOfOrder } from '@sim/logistics/voyage-cargo';
import { BerthModule, CRANE_STATES, CraneModule } from '@sim/modules';
import { dualPhaseTicks } from '@sim/systems/crane-system';
import type { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import {
  F6A_CUTOFF_HOURS,
  TICKS_PER_HOUR,
  apronDefs,
  exportWorld,
  f6aDefs,
  lostUnits,
  ofType,
  runUntilDeparted,
  startLoading,
  tickUntil,
} from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';

const LOAD_TIMEOUT = 40_000;
/** Pevné príchody kamiónov (ticky od prijatia) pred cut-off (4 320). */
const EARLY = [10, 20, 30, 40, 50, 60];
const berthOf = (world: World): BerthModule => [...world.modules.values()].find((module): module is BerthModule => module instanceof BerthModule) as BerthModule;
const craneOf = (world: World): CraneModule => [...world.modules.values()].find((module): module is CraneModule => module instanceof CraneModule) as CraneModule;

/** Hmotnostné triedy exportných jednotiek zaznamenané počas behu (jednotka po odchode lode z ledgera zmizne). */
function weightRecorder(world: World): { readonly record: () => void; readonly weights: Map<EntityId, WeightClass> } {
  const weights = new Map<EntityId, WeightClass>();
  return {
    weights,
    record: () => {
      for (const unit of world.cargo.liveUnits()) if (unit.direction === 'export' && !weights.has(unit.id)) weights.set(unit.id, unit.weightClass);
    },
  };
}

describe('stowage poradie nakládky (ADR-032 bod 8)', () => {
  it('jedno vozidlo: jednotky sa nakladajú v poradí heavy → medium → light, pri zhode podľa id; žiadna mimo poradia', () => {
    const defs = apronDefs({ exportFlow: { weightClassShares: { light: 1, medium: 1, heavy: 1 } } });
    const { world } = startLoading({ defs, vehicles: ['straddle_carrier'], kind: 'export', booked: 9, arrivals: [10, 20, 30, 40, 50, 60, 70, 80, 90] });
    const recorder = weightRecorder(world);
    const events = runUntilDeparted(world, LOAD_TIMEOUT, recorder.record);
    const loaded = ofType(events, 'UnitLoaded');
    expect(loaded).toHaveLength(9);
    expect(new Set([...recorder.weights.values()]).size).toBeGreaterThan(1);
    const keys = loaded.map((entry) => ({ id: entry.event.unitId, weightClass: recorder.weights.get(entry.event.unitId) as WeightClass }));
    const sorted = [...keys].sort(compareStowageOrder);
    expect(keys.map((key) => key.id)).toEqual(sorted.map((key) => key.id));
    expect(loaded.every((entry) => !entry.event.outOfOrder)).toBe(true);
    expect(lostUnits(world)).toBe(0);
  });

  it('stowageOutOfOrder: nenaložená jednotka voyage s menším kľúčom na termináli (mimo hold) → mimo poradia', () => {
    const world = exportWorld({ vehicles: [] });
    const contract = startLoading({ world, kind: 'export', booked: 3, arrivals: [] }).offer.exportContract;
    const labels = (weightClass: WeightClass) => ({ direction: 'export' as const, voyageId: contract.voyageId, destinationPort: contract.booking.destinationPort, weightClass });
    const stored = (weightClass: WeightClass, slot: number): EntityId => {
      const unit = world.cargo.create('container_teu', { kind: 'in_truck', truckId: 900 as EntityId }, contract.id, labels(weightClass));
      world.cargo.move(unit.id, { kind: 'at_ramp', rampId: 8 as EntityId, dock: 0 });
      world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: 901 as EntityId });
      world.cargo.move(unit.id, { kind: 'in_storage', moduleId: 4 as EntityId, slot });
      return unit.id;
    };
    const heavy = world.cargo.get(stored('heavy', 0));
    const light = world.cargo.get(stored('light', 1));
    expect(world.cargo.get(light?.id as EntityId)).toBeDefined();
    // Ťažká jednotka (skorší kľúč) leží v sklade: nakladanie ľahkej je mimo poradia, ťažkej v poradí.
    expect(stowageOutOfOrder(world, light!)).toBe(true);
    expect(stowageOutOfOrder(world, heavy!)).toBe(false);
    // Zadržaná (VGM hold) jednotka s menším kľúčom loď nečaká — nepočíta sa.
    world.cargo.setHold(heavy!.id, { reason: 'vgm', untilTick: 99_999 });
    expect(stowageOutOfOrder(world, world.cargo.get(light!.id)!)).toBe(false);
  });
});

describe('rezerva apronu a kapacita lode (ADR-032 bod 10, 11)', () => {
  it('kým má loď import aj export, každý smer obsadí najviac apronSlots − apronReserveSlots (6 z 8); apron nikdy nad kapacitu', () => {
    const { world } = startLoading({ defs: apronDefs(), kind: 'roundtrip', booked: 12, importUnits: 12, arrivals: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120] });
    const berth = berthOf(world);
    let maxImport = 0;
    let maxExport = 0;
    let both = 0;
    runUntilDeparted(world, LOAD_TIMEOUT, () => {
      assertCargoConservation(world);
      const ship = berth.dockedShipId === null ? undefined : world.ships.get(berth.dockedShipId);
      if (ship?.state !== 'docked' || importAboard(world, ship.id) === 0 || pendingExportUnits(world, ship.id) === 0) return;
      both += 1;
      const cap = apronDirectionCap(berth, true);
      expect(cap).toBe(6);
      maxImport = Math.max(maxImport, importApronUsage(world, berth));
      maxExport = Math.max(maxExport, exportApronUsage(world, berth));
      expect(importApronUsage(world, berth)).toBeLessThanOrEqual(cap);
      expect(exportApronUsage(world, berth)).toBeLessThanOrEqual(cap);
      expect(berth.apron.usedCount + berth.apron.reservedCount).toBeLessThanOrEqual(berth.apron.capacity);
    });
    expect(both).toBeGreaterThan(100);
    expect(maxImport).toBeGreaterThan(0);
    expect(maxExport).toBeGreaterThan(0);
    expect(lostUnits(world)).toBe(0);
  });

  it('kapacita lode platí pre import + export na palube: pri plnej lodi sa najprv vykladá (unload), až potom dual cycle; na palube nikdy viac než capacityUnits', () => {
    // 96 miest (najväčší objem šablón): loď plná importu a tri exporty pripravené na aprone.
    const defs = apronDefs({ ship: { id: 'feeder', fields: { capacityUnits: 96 } } });
    const { world, offer } = startLoading({ defs, kind: 'roundtrip', booked: 6, importUnits: 96, arrivals: [] });
    const berth = berthOf(world);
    const crane = craneOf(world);
    tickUntil(world, (w) => berth.dockedShipId !== null && w.ships.get(berth.dockedShipId)?.state === 'docked', 20_000);
    const contract = offer.exportContract;
    const labels = { direction: 'export' as const, voyageId: contract.voyageId, destinationPort: contract.booking.destinationPort, weightClass: 'medium' as const };
    // Sloty 5–7: nižšie rezervuje žeriav pri vykládke (rezervuje vždy najnižší voľný slot).
    for (const slot of [5, 6, 7]) {
      const unit = world.cargo.create('container_teu', { kind: 'in_truck', truckId: 900 as EntityId }, contract.id, labels);
      for (const next of [
        { kind: 'at_ramp', rampId: 8 as EntityId, dock: 0 },
        { kind: 'in_vehicle', vehicleId: 901 as EntityId },
        { kind: 'on_apron', berthId: berth.id, slot },
      ] as const) {
        world.cargo.move(unit.id, next);
      }
      contract.recordArrival(unit.id, false);
    }
    const ship = world.ships.get(berth.dockedShipId as EntityId)!;
    expect(world.cargo.countAt('on_ship', ship.id)).toBe(96);
    // Žeriav už vykladá (loď je plná); ďalšie štarty cyklov sa zaznamenávajú v tickoch, v ktorých vstúpi do `grabbing`.
    expect([crane.state, crane.cycle]).toEqual(['grabbing', 'unload']);
    const cycles: string[] = [crane.cycle];
    let loaded = 0;
    for (let i = 0; i < 2000 && loaded < 3; i++) {
      for (const event of world.tick()) if (event.type === 'UnitLoaded') loaded += 1;
      expect(world.cargo.countAt('on_ship', ship.id)).toBeLessThanOrEqual(96);
      if (crane.state === 'grabbing' && crane.phaseTicksLeft === crane.phaseTicksTotal) cycles.push(crane.cycle);
    }
    expect(loaded).toBe(3);
    // Loď je plná (96 z 96): prvý cyklus vykladá; po uvoľnení miesta nasleduje dual cycle (export + import).
    expect(cycles.slice(0, 3)).toEqual(['unload', 'dual_load', 'dual_unload']);
    expect(lostUnits(world)).toBe(0);
  });
});

describe('dual cycling (ADR-032 bod 11)', () => {
  it('dual_load a hneď dual_unload: DualCycle prichádza o `D − ⌊D/2⌋` = 9 tickov po UnitLoaded (D = round(1,5 × 12) = 18)', () => {
    const { world } = startLoading({ defs: apronDefs(), kind: 'roundtrip', booked: 12, importUnits: 18, arrivals: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120] });
    const events = runUntilDeparted(world, LOAD_TIMEOUT);
    const duals = ofType(events, 'DualCycle');
    expect(duals.length).toBeGreaterThan(0);
    for (const dual of duals) {
      const load = ofType(events, 'UnitLoaded').find((entry) => entry.event.unitId === dual.event.loadedUnitId);
      expect(load).toBeDefined();
      expect(dual.tick - (load?.tick as number)).toBe(9);
      // `CraneCycleDone` (vykladaná jednotka) hneď pred `DualCycle` v tom istom ticku (ADR-032, spoločné rozhrania).
      const done = events.filter((entry) => entry.tick === dual.tick && entry.event.type === 'CraneCycleDone');
      expect(done.map((entry) => (entry.event as { unitId: EntityId }).unitId)).toContain(dual.event.unloadedUnitId);
    }
    expect(lostUnits(world)).toBe(0);
  });

  it('dualPhaseTicks: D = round(dualCycleFactor × c), dual_load ⌊D/2⌋, dual_unload D − ⌊D/2⌋, každá polovica grabbing/placing podľa §7.2', () => {
    const world = exportWorld({ defs: f6aDefs() });
    const crane = craneOf(world);
    expect(crane.params.dualCycleFactor).toBe(1.5);
    expect(dualPhaseTicks(world.stats, crane, 'dual_load')).toEqual({ grabbing: 4, placing: 5 });
    expect(dualPhaseTicks(world.stats, crane, 'dual_unload')).toEqual({ grabbing: 4, placing: 5 });
    for (const [factor, load, unload] of [
      [1, { grabbing: 3, placing: 3 }, { grabbing: 3, placing: 3 }],
      [2, { grabbing: 6, placing: 6 }, { grabbing: 6, placing: 6 }],
      [1.25, { grabbing: 3, placing: 4 }, { grabbing: 4, placing: 4 }],
    ] as const) {
      const other = exportWorld({ defs: f6aDefs({ moduleParams: { crane_container_gantry: { dualCycleFactor: factor } } }) });
      expect(dualPhaseTicks(other.stats, craneOf(other), 'dual_load'), `factor ${String(factor)} dual_load`).toEqual(load);
      expect(dualPhaseTicks(other.stats, craneOf(other), 'dual_unload'), `factor ${String(factor)} dual_unload`).toEqual(unload);
    }
  });

  it('žeriav je počas celého behu v platnom stave (stavy cyklu z CRANE_STATES) a nikdy nedrží viac než jednu jednotku', () => {
    const { world } = startLoading({ defs: apronDefs(), kind: 'roundtrip', booked: 6, importUnits: 8, arrivals: EARLY });
    const crane = craneOf(world);
    runUntilDeparted(world, LOAD_TIMEOUT, () => {
      expect(CRANE_STATES).toContain(crane.state);
      expect(world.cargo.countAt('in_crane', crane.id)).toBeLessThanOrEqual(1);
      expect(findWorldViolation(world)).toBeUndefined();
    });
  });
});

describe('lashing, papiere a odchod lode (ADR-032 bod 12)', () => {
  it('loď po poslednej naloženej jednotke lashuje `lashingTicksPerUnit × naložené + paperworkTicks`, drží kotvisko a odíde až po odpočte', () => {
    const { world } = startLoading({ defs: apronDefs(), kind: 'export', booked: 6, arrivals: EARLY });
    const berth = berthOf(world);
    const states: string[] = [];
    const events = runUntilDeparted(world, LOAD_TIMEOUT, () => {
      const ship = [...world.ships.values()][0];
      if (ship !== undefined) {
        states.push(ship.state);
        if (ship.state === 'lashing') {
          expect(berth.dockedShipId).toBe(ship.id);
          expect(ship.lashingTicksLeft).toBeGreaterThanOrEqual(1);
        } else {
          expect(ship.lashingTicksLeft).toBe(0);
        }
      }
    });
    const lashing = ofType(events, 'ShipLashingStarted');
    expect(lashing).toHaveLength(1);
    // feeder: 6 × 6 + 360 = 396
    expect(lashing[0].event).toEqual({ type: 'ShipLashingStarted', shipId: lashing[0].event.shipId, loadedUnits: 6, ticks: 396 });
    const undocked = ofType(events, 'ShipUndocked')[0];
    expect(undocked.tick - lashing[0].tick).toBe(396);
    // Posledná jednotka sa naložila tesne pred lashingom a loď už nezačala lashing skôr.
    const lastLoad = ofType(events, 'UnitLoaded').at(-1);
    expect(lashing[0].tick - (lastLoad?.tick as number)).toBeLessThanOrEqual(2);
    expect(states.filter((state) => state === 'lashing')).toHaveLength(396);
  });

  it('pri odchode: CargoMoved on_ship → shipped × n (vzostupne podľa id) → ExportShipped → ShipDeparted v jednom ticku; loď bez nákladu', () => {
    const { world } = startLoading({ defs: apronDefs(), kind: 'export', booked: 6, arrivals: EARLY });
    const events = runUntilDeparted(world, LOAD_TIMEOUT);
    const departed = ofType(events, 'ShipDeparted')[0];
    const sameTick = events.filter((entry) => entry.tick === departed.tick).map((entry) => entry.event);
    const shippedMoves = sameTick.filter((event) => event.type === 'CargoMoved' && event.to.kind === 'shipped');
    expect(shippedMoves).toHaveLength(6);
    const ids = shippedMoves.map((event) => (event.type === 'CargoMoved' ? event.unitId : 0));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const order = sameTick.map((event) => event.type).filter((type) => type === 'CargoMoved' || type === 'ExportShipped' || type === 'ShipDeparted');
    expect(order).toEqual([...Array<string>(6).fill('CargoMoved'), 'ExportShipped', 'ShipDeparted']);
    expect(ofType(events, 'ExportShipped')[0].event.units).toBe(6);
    expect(world.ships.size).toBe(0);
    expect(world.cargo.shippedCount).toBe(6);
    expect(world.cargo.countByKind('on_ship')).toBe(0);
    expect(lostUnits(world)).toBe(0);
  });

  it('loď čaká na nenaložený export na termináli (aj v sklade), kým ho dispatcher nepošle; loď s importom neodíde', () => {
    const { world } = startLoading({ defs: apronDefs(), kind: 'roundtrip', booked: 6, importUnits: 6, arrivals: EARLY });
    const berth = berthOf(world);
    let checked = 0;
    runUntilDeparted(world, LOAD_TIMEOUT, () => {
      const ship = berth.dockedShipId === null ? undefined : world.ships.get(berth.dockedShipId);
      if (ship?.state !== 'lashing') return;
      // Počas lashingu na lodi nie je žiadny import a na termináli žiadna naložiteľná jednotka.
      expect(importAboard(world, ship.id)).toBe(0);
      expect(pendingExportUnits(world, ship.id)).toBe(0);
      expect(exportAboard(world, ship.id)).toBe(6);
      checked += 1;
    });
    expect(checked).toBeGreaterThan(300);
  });
});

describe('uzavretie bookingu (ADR-032 bod 14)', () => {
  it('všetko naložené včas: výplata plnej odmeny, bez penalizácií, XP, booking completed pri opustení kotviska', () => {
    const { world, offer } = startLoading({ defs: apronDefs(), kind: 'export', booked: 6, arrivals: EARLY });
    const events = runUntilDeparted(world, LOAD_TIMEOUT);
    const contract = offer.exportContract;
    expect(contract.state).toBe('completed');
    expect(ofType(events, 'BookingPenaltyApplied')).toEqual([]);
    const completed = ofType(events, 'ContractCompleted')[0];
    expect(completed.event).toEqual({ type: 'ContractCompleted', contractId: contract.id, rewardCents: 1_000_000, penaltiesCents: 0, xp: 10, onTime: true });
    // Uzavretie je pri `undocking` (loď opustila kotvisko), pred `ExportShipped`.
    expect(completed.tick).toBe(ofType(events, 'ShipUndocked')[0].tick + 1);
    expect(completed.tick).toBeLessThan(ofType(events, 'ExportShipped')[0].tick);
    expect(ofType(events, 'MoneyChanged').filter((entry) => entry.event.reason === 'contract_revenue').map((entry) => entry.event.deltaCents)).toEqual([1_000_000]);
    expect(world.completedContracts).toBe(1);
  });

  it('last minute: jednotky po cut-off sa naložia (kým loď nelashuje), penalizácia lastMinuteExportRateOfReward za jednotku pomerne k bookingu', () => {
    const cutoff = 4320;
    const { world, offer } = startLoading({ defs: apronDefs(), kind: 'export', booked: 6, arrivals: [10, 20, 30, 40, cutoff + 200, cutoff + 400] });
    const events = runUntilDeparted(world, LOAD_TIMEOUT);
    const contract = offer.exportContract;
    expect(contract.booking.rolledUnits).toBe(2);
    expect(ofType(events, 'UnitRolled')).toHaveLength(2);
    const loaded = ofType(events, 'UnitLoaded');
    expect(loaded).toHaveLength(6);
    expect(loaded.filter((entry) => entry.event.lastMinute)).toHaveLength(2);
    const expected = bookingUnitsPenaltyCents(1_000_000, 6, 2, 0.02);
    expect(expected).toBe(Math.floor((1_000_000 * 200 * 2) / (10_000 * 6)));
    expect(ofType(events, 'BookingPenaltyApplied').map((entry) => entry.event)).toEqual([
      { type: 'BookingPenaltyApplied', contractId: contract.id, kind: 'last_minute', units: 2, amountCents: expected },
    ]);
    expect(contract.state).toBe('completed');
    expect(contract.penaltiesCents).toBe(expected);
    expect(ofType(events, 'ContractCompleted')[0].event.penaltiesCents).toBe(expected);
    expect(contract.booking.lastMinuteUnits).toBe(2);
  });

  it('jednotka po lashingu je rolled a vráti sa odosielateľovi po súši (exported): výplata pomerne k naloženým + rolled a nesplnený booking', () => {
    // 6 príchodov, posledný až po začiatku lashingu lode (loď dockuje ~8 765; papiere 3 000 tickov predĺžia lashing, takže kamión
    // prejde bránou vo vnútri lashingu a pred uzavretím bookingu).
    const defs = apronDefs({ ship: { id: 'feeder', fields: { paperworkTicks: 3000 } } });
    const { world, offer } = startLoading({ defs, kind: 'export', booked: 6, arrivals: [10, 20, 30, 40, 50, 8640 + 2400] });
    const events = runUntilDeparted(world, LOAD_TIMEOUT);
    const contract = offer.exportContract;
    expect(ofType(events, 'ShipLashingStarted')[0].event.loadedUnits).toBe(5);
    expect(ofType(events, 'ExportShipped')[0].event.units).toBe(5);
    // Booking je uzavretý (completed s 5 naloženými zo 6 < ⌈0,9 × 6⌉ = 6 → nesplnený), jednotka sa vráti kamiónom.
    expect(contract.state).toBe('completed');
    expect(contract.booking.loadedUnits).toBe(5);
    const penalties = ofType(events, 'BookingPenaltyApplied').map((entry) => entry.event);
    expect(penalties).toEqual([
      { type: 'BookingPenaltyApplied', contractId: contract.id, kind: 'rolled', units: 1, amountCents: bookingUnitsPenaltyCents(1_000_000, 6, 1, 0.05) },
      { type: 'BookingPenaltyApplied', contractId: contract.id, kind: 'unfulfilled', units: 1, amountCents: 100_000 },
    ]);
    expect(ofType(events, 'ContractCompleted')[0].event.rewardCents).toBe(Math.floor((1_000_000 * 5) / 6));
    // Vrátenie odosielateľovi: kamión odvezie jednotku (exported) po uzavretí bookingu; nič sa nestratí.
    tickUntil(world, (w) => w.cargo.exportedCount === 1, 20_000);
    expect(contract.booking.returnedUnits).toBe(1);
    expect(world.cargo.countByKind('in_storage') + world.cargo.countByKind('at_ramp')).toBe(0);
    expect(lostUnits(world)).toBe(0);
  });

  it('nič nenaložené (žiadne príchody): booking zlyhá s penalizáciou za nesplnený booking, loď odíde prázdna', () => {
    const { world, offer } = startLoading({ defs: apronDefs(), kind: 'export', booked: 6, arrivals: [] });
    const events = runUntilDeparted(world, LOAD_TIMEOUT);
    expect(offer.exportContract.state).toBe('failed');
    expect(ofType(events, 'ShipLashingStarted')).toEqual([]);
    expect(ofType(events, 'ExportShipped')).toEqual([]);
    expect(ofType(events, 'BookingPenaltyApplied').map((entry) => entry.event.kind)).toEqual(['unfulfilled']);
    expect(world.cargo.shippedCount).toBe(0);
  });

  it('VGM hold dlhší než príchod lode: zadržané jednotky sa nenakladajú a loď na ne nečaká; po uzavretí sa vrátia', () => {
    const defs = apronDefs({ exportFlow: { vgmMissingChance: 1, vgmHoldHours: 100 } });
    const { world, offer } = startLoading({ defs, kind: 'export', booked: 4, arrivals: [10, 20, 30, 40] });
    const events = runUntilDeparted(world, LOAD_TIMEOUT);
    expect(ofType(events, 'VgmHoldStarted')).toHaveLength(4);
    expect(ofType(events, 'UnitLoaded')).toEqual([]);
    expect(offer.exportContract.state).toBe('failed');
    expect(offer.exportContract.booking.heldUnits).toBe(4);
    // Zadržané jednotky odídu po súši aj počas hold (vrátenie odosielateľovi nie je nakládka); hold z indexu vypadne.
    tickUntil(world, (w) => w.cargo.exportedCount === 4, 20_000);
    expect(offer.exportContract.booking.heldUnits).toBe(0);
    expect(world.holdIndex.size).toBe(0);
    expect(lostUnits(world)).toBe(0);
    expect(F6A_CUTOFF_HOURS * TICKS_PER_HOUR).toBe(4320);
  });
});
