// T6A-07b: UI export a roundtrip nad skutočným simom (nie fixture): pool ponúk s booking skupinami od prvej polnoci, akcia
// „Prijať“ / „Odmietnuť“ s id prvého kontraktu skupiny, dôvody neprijatia, karty bookingu počas scenára `export_inbound`
// a toasty (`CutoffWarning`, `ExportShipped`) nad skutočnými udalosťami a svetom.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ContractId, EntityId } from '@sim/core';
import { commandFromJSON } from '@sim/commands';
import { voyageGroups } from '@ui/contracts-panel';
import { acceptDisabledReason, contractCards, cutoffLeadTicks } from '@app/contract-cards';
import { acceptOffer, declineOffer } from '@app/contract-actions';
import { REASON_TEXT } from '@app/build-feedback';
import { GameLoop } from '@app/game-loop';
import { SimBridge } from '@app/sim-bridge';
import { toastSpecsForEvents } from '@app/toast-center';
import { exportWorld, offerBooking } from '../sim/helpers/f6a';
import { createApp } from './app-fixtures';
import { addRoundtripOffer } from './f6a-fixtures';
import { createScenarioApp } from './f6a-scenario';

/** Prvé kontrakty skupiny voyage tak, ako ich panel posiela do `onAccept` (`parts[0].id`). */
const leadId = (group: ReturnType<typeof voyageGroups>[number]): number => Number(group.parts[0]?.id);

describe('ponuky booking v poole od prvej polnoci (skutočný pool)', () => {
  const app = createApp();
  app.loop.advance(app.world.clock.ticksPerDay + 10);
  const cards = app.bridge.snapshot().contracts;
  const exportCards = cards.filter((card) => card.kind === 'export');

  it('pool dá import ponuky aj booking skupiny; export karta nesie cieľ, počet TEU a odstup cut-off z defu', () => {
    const { economy } = app.world.defs;
    expect(cards.filter((card) => card.kind === 'import' && card.state === 'offered').length).toBeGreaterThanOrEqual(economy.offersPerDay);
    expect(exportCards.length).toBeGreaterThan(0);
    for (const card of exportCards) {
      expect(card.state).toBe('offered');
      expect(card.booking).toMatchObject({ bookedUnits: card.volumeUnits, pendingArrivals: 0, arrivedUnits: 0, loadedUnits: 0, heldUnits: 0 });
      expect(card.booking?.destinationPort).toBeTruthy();
      expect(card.booking).not.toHaveProperty('cutoffTick');
      expect(card.booking?.cutoffLeadTicks).toBe(economy.cutoffHours * app.world.clock.ticksPerHour);
      expect(card.booking?.cutoffLeadTicks).toBe(cutoffLeadTicks(app.world));
      expect(card.disabledReason).toBeUndefined(); // štartovací prístav má kotvisko aj žeriav
    }
  });

  it('karty sa zoskupia podľa voyage: každá booking skupina má práve jeden export (samostatný alebo s importom roundtripu)', () => {
    for (const group of voyageGroups(cards)) {
      expect(group.parts.map((part) => part.voyageId)).toEqual(group.parts.map(() => group.voyageId));
      if (group.parts.length === 1) expect(group.parts[0]?.voyageId).toBe(group.parts[0]?.id);
    }
    expect(voyageGroups(cards).filter((group) => group.parts.some((part) => part.kind === 'export'))).toHaveLength(exportCards.length);
  });
});

describe('Prijať a Odmietnuť cez akcie panelu nad skutočným simom', () => {
  /** Overí prijatú booking skupinu: všetky kontrakty `accepted`, spoločný plán lode, export s cut-offom a plánom príchodov. */
  function expectAcceptedBookingGroup(app: ReturnType<typeof createApp>, ids: readonly number[]): void {
    const contracts = ids.map((id) => app.world.contracts.get(id as ContractId));
    expect(contracts.map((contract) => contract?.state)).toEqual(ids.map(() => 'accepted'));
    const exports = contracts.filter((contract) => contract?.kind === 'export');
    expect(exports).toHaveLength(1);
    const [exportContract] = exports;
    const arrival = exportContract?.shipArrivalTick ?? 0;
    for (const contract of contracts) {
      expect(contract?.shipArrivalTick).toBe(arrival);
      expect(contract?.acceptedTick).toBe(exportContract?.acceptedTick);
    }
    const { ticksPerHour, ticksPerDay, tick } = app.world.clock;
    const [minDays, maxDays] = app.world.defs.economy.exportArrivalDaysRange;
    expect(arrival - tick).toBeGreaterThanOrEqual(Math.round(minDays * ticksPerDay) - 1);
    expect(arrival - tick).toBeLessThanOrEqual(Math.round(maxDays * ticksPerDay));
    const booking = exportContract?.booking;
    expect(booking?.cutoffTick).toBe(arrival - app.world.defs.economy.cutoffHours * ticksPerHour);
    expect(booking?.arrivalPlan).toHaveLength(exportContract?.volumeUnits ?? -1);
    // karta po prijatí: konkrétny cut-off tick namiesto odstupu, zostávajúce príchody z plánu, bez dôvodu neprijatia
    const card = app.bridge.snapshot().contracts.find((candidate) => candidate.id === exportContract?.id);
    expect(card?.state).toBe('accepted');
    expect(card?.booking).toMatchObject({ cutoffTick: booking?.cutoffTick, pendingArrivals: exportContract?.volumeUnits });
    expect(card?.booking).not.toHaveProperty('cutoffLeadTicks');
    expect(card?.disabledReason).toBeUndefined();
  }

  it('booking skupina z poolu (export-only alebo roundtrip): AcceptContract s id prvej karty prijme celú voyage', () => {
    const app = createApp();
    app.loop.advance(app.world.clock.ticksPerDay + 10);
    const groups = voyageGroups(app.bridge.snapshot().contracts).filter((candidate) => candidate.parts.some((part) => part.kind === 'export'));
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.parts.map((part) => part.state)).toEqual(group.parts.map(() => 'offered'));
      const id = leadId(group);
      expect(acceptOffer(app.bridge, id)).toBe(true);
      app.loop.frame(0);
      expectAcceptedBookingGroup(
        app,
        group.parts.map((part) => Number(part.id)),
      );
    }
  });

  it('export-only ponuka (jeden kontrakt vo voyage): príkaz s jej id prijme booking s plánom príchodov zo simu', () => {
    const app = createApp();
    const offer = offerBooking(app.world, { kind: 'export', booked: 12, destinationPort: 'Hamburg' });
    app.bridge.publish([{ type: 'ContractOffered', contractId: offer.exportContract.id }]);
    const group = voyageGroups(app.bridge.snapshot().contracts).find((candidate) => candidate.voyageId === offer.voyageId);
    expect(group?.parts).toHaveLength(1);
    expect(acceptOffer(app.bridge, leadId(group as NonNullable<typeof group>))).toBe(true);
    app.loop.frame(0);
    expectAcceptedBookingGroup(app, [offer.exportContract.id]);
  });

  it('roundtrip: jeden príkaz s id prvého kontraktu (import) prijme celú voyage — spoločný plán lode, booking len na exporte', () => {
    const app = createApp();
    const roundtrip = addRoundtripOffer(app.world);
    app.bridge.publish([{ type: 'ContractOffered', contractId: roundtrip.importContract.id }]);
    const group = voyageGroups(app.bridge.snapshot().contracts).find((candidate) => candidate.voyageId === roundtrip.voyageId);
    expect(group?.parts.map((part) => part.kind)).toEqual(['import', 'export']);
    const id = leadId(group as NonNullable<typeof group>);
    expect(id).toBe(roundtrip.importContract.id);
    expect(acceptOffer(app.bridge, id)).toBe(true);
    app.loop.frame(0);
    const { importContract, exportContract } = roundtrip;
    expect([importContract.state, exportContract.state]).toEqual(['accepted', 'accepted']);
    expect(importContract.shipArrivalTick).toBe(exportContract.shipArrivalTick);
    expect(importContract.acceptedTick).toBe(exportContract.acceptedTick);
    expect(exportContract.cutoffTick).toBeDefined();
    expect(exportContract.arrivalPlan).toHaveLength(exportContract.volumeUnits);
    expect(importContract.booking).toBeNull();
    const cards = app.bridge.snapshot().contracts.filter((card) => card.voyageId === roundtrip.voyageId);
    expect(cards.map((card) => [card.kind, card.state])).toEqual([['import', 'accepted'], ['export', 'accepted']]);
  });

  it('roundtrip: Odmietnuť s id prvého kontraktu zruší ponuku oboch kontraktov; prijatá ponuka už odmietnuť nejde', () => {
    const app = createApp();
    const declined = addRoundtripOffer(app.world);
    const kept = addRoundtripOffer(app.world);
    app.bridge.publish([{ type: 'ContractOffered', contractId: declined.importContract.id }]);
    expect(declineOffer(app.bridge, declined.importContract.id)).toBe(true);
    app.loop.frame(0);
    expect(app.world.contracts.get(declined.importContract.id as ContractId)).toBeUndefined();
    expect(app.world.contracts.get(declined.exportContract.id as ContractId)).toBeUndefined();
    expect(app.bridge.snapshot().contracts.some((card) => card.voyageId === declined.voyageId)).toBe(false);

    expect(acceptOffer(app.bridge, kept.importContract.id)).toBe(true);
    app.loop.frame(0);
    expect(declineOffer(app.bridge, kept.importContract.id)).toBe(false); // už nie je ponuka: validate odmietne, nič sa nepošle
    expect(acceptOffer(app.bridge, 99_999)).toBe(false);
    expect(kept.exportContract.state).toBe('accepted');
  });

  it('bez žeriavu kategórie je „Prijať“ zablokované zmysluplným dôvodom zo simu pre každú kartu import / export / roundtrip', () => {
    const app = createApp();
    app.loop.advance(app.world.clock.ticksPerDay + 10); // pool: import aj booking ponuky
    const roundtrip = addRoundtripOffer(app.world);
    app.bridge.publish([{ type: 'ContractOffered', contractId: roundtrip.importContract.id }]);
    app.bridge.dispatch(commandFromJSON({ type: 'RemoveModule', moduleId: 2 })); // žeriav štartovacieho kotviska
    app.loop.frame(0);
    expect(app.world.modules.get(2 as EntityId)).toBeUndefined();
    const offers = contractCards(app.world).filter((card) => card.state === 'offered');
    expect(new Set(offers.map((card) => card.kind))).toEqual(new Set(['import', 'export']));
    expect(offers.length).toBeGreaterThan(8);
    for (const card of offers) expect(card.disabledReason).toBe(REASON_TEXT.no_crane_for_category);
    expect(acceptDisabledReason(app.world, roundtrip.exportContract)).toBe('Pri kotvisku pre loď chýba žeriav na tento náklad');
    expect(acceptOffer(app.bridge, roundtrip.importContract.id)).toBe(false);
    expect(roundtrip.importContract.state).toBe('offered');
  });
});

describe('scenár export_inbound: karty bookingu a toasty zo skutočných udalostí', () => {
  const app = createScenarioApp();
  const CONTRACT = 7;
  const samples: { tick: number; arrived: number; pending: number; held: number; state: string }[] = [];

  beforeAll(() => {
    const WARNING_LEAD = 6 * app.world.clock.ticksPerHour;
    // Hrubý krok; pri CutoffWarning a cut-off krok 1 tick, aby toast dostal udalosť v ticku framu.
    app.advanceTo(
      30_000,
      (a) => {
        const cutoff = a.world.contracts.get(CONTRACT as ContractId)?.booking?.cutoffTick;
        return cutoff !== undefined && [cutoff - WARNING_LEAD, cutoff].some((target) => Math.abs(a.world.clock.tick - target) < 30) ? 1 : 100;
      },
      (a) => {
        const card = a.bridge.snapshot().contracts.find((candidate) => candidate.id === CONTRACT);
        if (card?.booking !== undefined) {
          samples.push({ tick: a.world.clock.tick, arrived: card.booking.arrivedUnits, pending: card.booking.pendingArrivals, held: card.booking.heldUnits, state: card.state });
        }
      },
    );
  }, 120_000);

  it('prijatie scenárom (príkaz s id 7) vedie k karte accepted s konkrétnym cut-off tickom a plánom 36 príchodov', () => {
    const accepted = app.toasts.filter((entry) => entry.spec.key === `contract_accepted:${String(CONTRACT)}`);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.spec.text).toMatch(/Export 36 TEU → Rotterdam/);
    const first = samples.find((sample) => sample.state === 'accepted');
    expect(first?.pending).toBe(36);
    expect(first?.arrived).toBe(0);
  });

  it('počítadlá na karte rastú s príchodmi kamiónov: dovezené + zostávajúce príchody = 36, hold sa prejaví v heldUnits', () => {
    const accepted = samples.filter((sample) => sample.state === 'accepted');
    for (const sample of accepted) expect(sample.arrived + sample.pending).toBeLessThanOrEqual(36);
    const arrivedSeries = accepted.map((sample) => sample.arrived);
    expect([...arrivedSeries].sort((a, b) => a - b)).toEqual(arrivedSeries);
    expect(arrivedSeries.at(-1)).toBe(36);
    expect(accepted.at(-1)?.pending).toBe(0);
    expect(Math.max(...accepted.map((sample) => sample.held))).toBe(1);
    expect(accepted.at(-1)?.held).toBe(0);
  });

  it('CutoffWarning: cutoffTick je budúci tick (o 6 h pred cut-off) a toast ukáže „Cut-off exportu o 6 h“ s dovezenými jednotkami', () => {
    const contract = app.world.contracts.get(CONTRACT as ContractId);
    const cutoff = contract?.booking?.cutoffTick ?? -1;
    const warnings = app.events.filter((entry) => entry.event.type === 'CutoffWarning');
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    if (warning === undefined || warning.event.type !== 'CutoffWarning') throw new Error('varovanie chýba');
    expect(warning.event.contractId).toBe(CONTRACT);
    expect(warning.event.cutoffTick).toBe(cutoff);
    expect(warning.event.cutoffTick).toBeGreaterThan(warning.tick);
    expect(warning.event.cutoffTick - warning.tick).toBeLessThanOrEqual(6 * app.world.clock.ticksPerHour);
    const toast = app.toasts.find((entry) => entry.spec.key === `cutoff_warning:${String(CONTRACT)}`);
    expect(toast?.spec).toMatchObject({ tone: 'warning', title: 'Cut-off exportu o 6 h', panel: 'contracts' });
    expect(toast?.spec.text).toMatch(/^#7 · Export 36 TEU → Rotterdam · dovezené \d+ \/ 36 TEU$/);
  });

  it('rolled jednotka a VGM hold dostanú toast; rolled po cut-off ukáže „po cut-off (rolled)“', () => {
    const keys = app.toasts.map((entry) => entry.spec.key);
    expect(keys).toContain(`unit_rolled:${String(CONTRACT)}`);
    expect(keys).toContain(`vgm_hold:${String(CONTRACT)}`);
    const rolled = app.toasts.find((entry) => entry.spec.key === `unit_rolled:${String(CONTRACT)}`);
    expect(rolled?.spec.title).toBe('1 jednotka po cut-off (rolled)');
  });
});

describe('ExportShipped: toast nájde kontrakt lode voyage v skutočnom svete', () => {
  it('loď roundtripu prijatého cez UI akciu: ExportShipped s id lode ukáže triedu, počet a cieľ z export kontraktu', () => {
    const world = exportWorld();
    const bridge = new SimBridge(world);
    const loop = new GameLoop(world, bridge);
    const offer = offerBooking(world, { kind: 'roundtrip', booked: 3, importUnits: 2, destinationPort: 'Gdańsk' });
    bridge.publish([{ type: 'ContractOffered', contractId: offer.exportContract.id }]);
    const group = voyageGroups(bridge.snapshot().contracts).find((candidate) => candidate.voyageId === offer.voyageId);
    expect(group?.parts.map((part) => part.kind)).toEqual(['import', 'export']);
    expect(acceptOffer(bridge, leadId(group as NonNullable<typeof group>))).toBe(true);
    // loď voyage príde 1 deň po prijatí (skrátený def) a ContractSystem ju priradí oboma kontraktom
    loop.advance(world.clock.ticksPerDay + 200);
    const { importContract, exportContract } = offer;
    expect(importContract?.shipId).toBeDefined();
    expect(exportContract.shipId).toBe(importContract?.shipId);
    const shipId = exportContract.shipId as EntityId;
    expect(world.contractBook.voyageIdOfShip(shipId)).toBe(offer.voyageId);
    expect(world.ships.has(shipId)).toBe(true);
    const shipVm = bridge.snapshot().ships.find((candidate) => candidate.id === shipId);
    expect(shipVm?.cargoSplit?.export).toBe(0);
    expect(shipVm?.cargoSplit?.import).toBe(shipVm?.unitsOnBoard);

    const specs = toastSpecsForEvents(world, [{ type: 'ExportShipped', shipId, units: 3 }]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ key: `export_shipped:${String(shipId)}`, tone: 'success', panel: 'contracts' });
    expect(specs[0]?.text).toBe('Feeder · 3 TEU → Gdańsk');
  });

  it('neznáma loď (ladiaca) má záložný text bez cieľa', () => {
    const { world } = createApp();
    const specs = toastSpecsForEvents(world, [{ type: 'ExportShipped', shipId: 4242 as EntityId, units: 5 }]);
    expect(specs[0]?.text).toBe('Loď #4242 · 5 jedn.');
  });
});
