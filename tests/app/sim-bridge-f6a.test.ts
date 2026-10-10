// T6A-07: snapshot kariet kontraktov s export bookingom — karty sa prepočítajú pri udalostiach bookingu (revízia) a čas
// (cut-off) sa na kartách odpočítava z ticku bez prepočtu.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { createApp } from './app-fixtures';
import { acceptRoundtrip, addRoundtripOffer } from './f6a-fixtures';

describe('SimBridge.snapshot: karty exportu', () => {
  it('ExportArrived / VgmHoldStarted / UnitRolled prepočítajú karty, CutoffWarning nie', () => {
    const { world, bridge } = createApp();
    const roundtrip = addRoundtripOffer(world);
    acceptRoundtrip(world, roundtrip);
    const { exportContract } = roundtrip;
    const exportCard = () => bridge.snapshot().contracts.find((card) => card.id === exportContract.id);

    // Karty vznikajú len pri zmene revízie (udalosť poolu), nie pri priamom vložení do knihy.
    bridge.publish([{ type: 'ContractOffered', contractId: roundtrip.importContract.id }]);
    const first = bridge.snapshot().contracts;
    expect(first.map((card) => card.kind)).toEqual(['import', 'export']);
    expect(exportCard()?.booking).toMatchObject({ arrivedUnits: 0, rolledUnits: 0, heldUnits: 0 });

    // Kontrakt sa zmenil bez udalosti: karty sú z cache, kým nepríde udalosť bookingu.
    exportContract.recordArrival(5 as EntityId, true);
    exportContract.heldUnits = 1;
    expect(bridge.snapshot().contracts).toBe(first);
    bridge.publish([{ type: 'CutoffWarning', contractId: exportContract.id, cutoffTick: 10 }]);
    expect(bridge.snapshot().contracts).toBe(first);

    bridge.publish([{ type: 'ExportArrived', contractId: exportContract.id, unitId: 5 as EntityId, truckId: 6 as EntityId, gateId: 7 as EntityId }]);
    const second = bridge.snapshot().contracts;
    expect(second).not.toBe(first);
    expect(exportCard()?.booking).toMatchObject({ arrivedUnits: 1, rolledUnits: 1, heldUnits: 1 });

    exportContract.heldUnits = 0;
    bridge.publish([{ type: 'VgmHoldReleased', contractId: exportContract.id, unitId: 5 as EntityId }]);
    expect(exportCard()?.booking?.heldUnits).toBe(0);
  });
});
