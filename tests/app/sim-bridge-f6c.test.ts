// T6C-05: snapshot kariet repositioningu a prekládky — karty sa prepočítajú pri udalostiach prázdnych a prekládky (revízia), lebo
// zmena stavu jednotky (`CargoLedger.setStatus`) nemá vlastnú udalosť pohybu; `EmptyPickupMissed` revíziu nemení.
import { describe, expect, it } from 'vitest';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { createApp } from './app-fixtures';
import { acceptContract, addRepositioningOffer, addTranshipOffer, storeEmptyUnit } from './f6c-fixtures';

const YARD = 4 as EntityId;
const SOME = 9 as EntityId;
const SOME_CONTRACT = 9 as ContractId;

const lineEvent = (type: 'EmptyDamaged' | 'EmptyRepairStarted' | 'EmptyRepaired'): SimEvent => {
  const base = { unitId: SOME, lineId: 'blue_anchor', moduleId: YARD };
  if (type === 'EmptyDamaged') return { type, ...base };
  if (type === 'EmptyRepairStarted') return { type, ...base, untilTick: 10 };
  return { type, ...base, costCents: 12_000 };
};

describe('SimBridge.snapshot: karty prázdnych a prekládky', () => {
  it('availableEmpties repositioningu sa prepočíta po EmptyDamaged / EmptyRepairStarted / EmptyRepaired (zmena stavu bez CargoMoved)', () => {
    const { world, bridge } = createApp();
    const offer = addRepositioningOffer(world);
    const units = [0, 1, 2].map((slot) => storeEmptyUnit(world, 'blue_anchor', YARD, slot));
    bridge.publish([{ type: 'ContractOffered', contractId: offer.id }]);
    const card = () => bridge.snapshot().contracts.find((candidate) => candidate.id === offer.id);
    expect(card()?.availableEmpties).toBe(3);
    const first = bridge.snapshot().contracts;

    const [unit] = units;
    if (unit === undefined) throw new Error('jednotka chýba');
    world.cargo.setStatus(unit.id, 'damaged', null);
    expect(bridge.snapshot().contracts, 'bez udalosti sú karty z cache').toBe(first);
    bridge.publish([lineEvent('EmptyDamaged')]);
    expect(card()?.availableEmpties).toBe(2);

    world.cargo.setStatus(unit.id, 'in_repair', world.clock.tick + 10);
    bridge.publish([lineEvent('EmptyRepairStarted')]);
    expect(card()?.availableEmpties).toBe(2);

    world.cargo.setStatus(unit.id, 'available', null);
    bridge.publish([lineEvent('EmptyRepaired')]);
    expect(card()?.availableEmpties).toBe(3);
  });

  it('TranshipMissed / TranshipRescued / TranshipSold prepočítajú karty (lehota záchrany, plavba B, predané)', () => {
    const { world, bridge } = createApp();
    const offer = addTranshipOffer(world, { volumeUnits: 10 });
    acceptContract(world, offer);
    const id = offer.id as ContractId;
    const outVoyageId = offer.outVoyageId as VoyageId;
    bridge.publish([{ type: 'ContractAccepted', contractId: id }]);
    const card = () => bridge.snapshot().contracts.find((candidate) => candidate.id === id);
    expect(card()?.tranship).not.toHaveProperty('rescueDeadlineTick');

    offer.rescueDeadlineTick = world.clock.tick + 100;
    bridge.publish([{ type: 'TranshipMissed', contractId: id, units: 4, outVoyageId }]);
    expect(card()?.tranship?.rescueDeadlineTick).toBe(world.clock.tick + 100);

    offer.unitsExported = 4;
    offer.arrivedUnits = 10;
    bridge.publish([{ type: 'TranshipSold', contractId: id, units: 4 }]);
    expect(card()?.unitsExported).toBe(4);
    expect(card()?.booking?.returnedUnits).toBe(4);
    bridge.publish([{ type: 'TranshipRescued', contractId: id, units: 4, outVoyageId }]);
    expect(card()?.tranship?.outVoyageId).toBe(outVoyageId);
  });

  it('revízia: EmptyReturned, EmptyStored, EmptyPickedUp a udalosti prekládky ju zvýšia; EmptyPickupMissed nie', () => {
    const { bridge } = createApp();
    const publish = (event: SimEvent): number => {
      const before = bridge.snapshot().revision;
      bridge.publish([event]);
      return bridge.snapshot().revision - before;
    };
    expect(publish({ type: 'EmptyReturned', unitId: SOME, lineId: 'blue_anchor', truckId: SOME, gateId: SOME })).toBe(1);
    expect(publish({ type: 'EmptyStored', unitId: SOME, lineId: 'blue_anchor', moduleId: YARD, fallback: true })).toBe(1);
    expect(publish({ type: 'EmptyPickedUp', unitId: SOME, lineId: 'blue_anchor', contractId: SOME_CONTRACT, truckId: SOME })).toBe(1);
    expect(publish({ type: 'EmptyPickupMissed', lineId: 'blue_anchor', contractId: SOME_CONTRACT, truckId: SOME })).toBe(0);
  });
});
