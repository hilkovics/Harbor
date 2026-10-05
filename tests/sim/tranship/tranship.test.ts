/**
 * Prekládka loď A → terminál → loď B (T6C-03, ADR-034 bod 11 + dodatok T6C-03): loď A privezie jednotky `tranship`, vyložia sa (hák / apron)
 * a uložia **zoskupene podľa kontraktu**, naložia sa na loď B (vlastná voyage, príchod `transhipGapDaysRange` po lodi A) → `shipped`; nikdy
 * neprejdú bránou. Zmeškaná prekládka (loď B odplávala bez jednotiek): `TranshipMissed` + penalizácia, záchrana na ďalšiu voyage linky
 * (`TranshipRescued`), inak po `transhipRescueDays` predaj kamiónom (`TranshipSold`, `exported`) — nič sa neteleportuje.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { StorageModule } from '@sim/modules';
import { stateHash, World, type AnyWorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptCommand, exportWorld, f6aDefs, hookDefs, ofType, send, tickEvents } from '../helpers/f6a';
import { acceptedImport, eventsOf, offerTranship, runUntil, lost } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { MAP } from '../world/world-fixtures';

const VEHICLES = ['straddle_carrier', 'straddle_carrier'];
const ECONOMY = { transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] };

function transhipWorld(options: { readonly hook?: boolean; readonly economy?: Record<string, unknown>; readonly seed?: number } = {}): World {
  const economy = { ...ECONOMY, ...options.economy };
  const defs = options.hook === true ? hookDefs(1, { economy }) : f6aDefs({ economy });
  return exportWorld({ defs, vehicles: VEHICLES, seed: options.seed });
}

/** Reťaz polôh každej jednotky z `CargoMoved` (`kind → kind → …`). */
function chains(events: readonly { readonly event: { readonly type: string } }[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const entry of events) {
    const event = entry.event as unknown as { type: string; unitId: number; from: { kind: string }; to: { kind: string } };
    if (event.type !== 'CargoMoved') continue;
    const chain = out.get(event.unitId) ?? [event.from.kind];
    chain.push(event.to.kind);
    out.set(event.unitId, chain);
  }
  return out;
}

const closed = (world: World): boolean => world.ships.size === 0 && [...world.contractBook.contracts.values()].every((c) => c.state === 'completed' || c.state === 'failed') && world.contractBook.contracts.size > 0;

describe('prekládka A → B — bežný tok', () => {
  it.each([
    ['apron', false],
    ['pod hákom', true],
  ])('%s: jednotky prejdú on_ship → in_crane → … → in_storage → … → in_crane → on_ship → shipped, nikdy bránou; kontrakt sa vyplatí v plnej výške', (_name, hook) => {
    const world = transhipWorld({ hook });
    const contract = offerTranship(world, { units: 6 });
    expect(send(world, acceptCommand(contract.id)).some((event) => event.type === 'ContractAccepted')).toBe(true);
    // loď B príde presne `transhipGapDaysRange` po lodi A (1 deň = 8 640 ticks), jeden ťah Rng po ťahu príchodu lode A
    expect(contract.outArrivalTick).toBe((contract.shipArrivalTick as number) + 8_640);
    const events = runUntil(world, closed, 60_000, 'uzavretie prekládky');
    assertCargoConservation(world);
    expect(findWorldViolation(world)).toBeUndefined();
    expect(contract.state).toBe('completed');
    expect(contract.booking.loadedUnits).toBe(6);
    expect(contract.unitsUnloaded).toBe(6);
    expect(world.cargo.shippedCount).toBe(6);
    expect(world.cargo.exportedCount).toBe(0);
    expect(lost(world)).toBe(0);
    const perUnit = chains(events);
    expect(perUnit.size).toBe(6);
    for (const [unitId, chain] of perUnit) {
      expect(chain.at(-1), `jednotka ${String(unitId)}`).toBe('shipped');
      expect(chain.some((kind) => kind === 'at_ramp' || kind === 'in_truck' || kind === 'exported')).toBe(false);
      expect(chain.slice(0, 2)).toEqual(['on_ship', 'in_crane']);
      expect(chain.slice(-3)).toEqual(['in_crane', 'on_ship', 'shipped']);
      expect(chain).toContain('in_storage');
    }
    expect(eventsOf(events, 'TranshipMissed')).toEqual([]);
    expect(eventsOf(events, 'UnitLoaded')).toHaveLength(6);
    expect(eventsOf(events, 'UnitLoaded').every((event) => event.contractId === contract.id)).toBe(true);
    expect(eventsOf(events, 'ContractCompleted')).toEqual([expect.objectContaining({ contractId: contract.id, rewardCents: 1_000_000, penaltiesCents: 0 })]);
    expect(eventsOf(events, 'ExportShipped')).toEqual([expect.objectContaining({ units: 6 })]);
    // loď A aj B odišli; B bola bez jednotiek, kým ju nenaložili (spawn s 0 jednotkami)
    expect(eventsOf(events, 'ShipSpawned').map((event) => event.units)).toEqual([6, 0]);
    expect(eventsOf(events, 'ShipDeparted')).toHaveLength(2);
  });

  it('ukladanie zoskupene podľa kontraktu: všetky jednotky jednej prekládky ležia v jednom sklade (druhý sklad ostane prázdny), kým sa nenaložia', () => {
    const world = exportWorld({ defs: f6aDefs({ economy: ECONOMY }), vehicles: VEHICLES, yards: ['near', 'far'] });
    const contract = offerTranship(world, { units: 8 });
    send(world, acceptCommand(contract.id));
    runUntil(world, () => contract.state === 'exporting', 30_000, 'vyloženie lode A');
    // vyloženie končí vložením poslednej jednotky do skladu — ešte chvíľu tickujeme, kým sú všetky v sklade
    runUntil(world, () => world.cargo.countByKind('in_storage') === 8, 5_000, 'uloženie v sklade');
    const yards = [...world.modules.values()].filter((module): module is StorageModule => module instanceof StorageModule);
    expect(yards).toHaveLength(2);
    const counts = yards.map((yard) => world.cargo.countAt('in_storage', yard.id));
    expect(counts.sort((a, b) => a - b)).toEqual([0, 8]);
    expect(world.storedCargo.groupOf(contract.id)?.units).toHaveLength(8);
  });

  it('loď A môže niesť aj import (roundtrip-ová loď inej voyage nie je potrebná): import a prekládka vedľa seba sa vyložia a import odíde kamiónmi', () => {
    const world = transhipWorld();
    const imported = acceptedImport(world, 'blue_anchor', 3);
    const contract = offerTranship(world, { units: 3, lineId: 'northern_star' });
    send(world, acceptCommand(contract.id));
    const events = runUntil(world, closed, 80_000, 'uzavretie importu a prekládky');
    assertCargoConservation(world);
    expect(world.contracts.get(imported.contractId as never)?.state).toBe('completed');
    expect(contract.state).toBe('completed');
    expect(world.cargo.exportedCount).toBe(3);
    expect(world.cargo.shippedCount).toBe(3);
    expect(lost(world)).toBe(0);
    expect(eventsOf(events, 'TranshipMissed')).toEqual([]);
  });
});

/** Dôjde k stavu „loď B zmeškala jednotky“: kontrakt je `exporting`, jednotky ležia v sklade a loď B (id `ghost`) už nie je na mape. */
function missedWorld(options: { readonly rescue?: boolean } = {}): {
  world: World;
  contract: ReturnType<typeof offerTranship>;
  events: ReturnType<typeof tickEvents>;
  rescueContractId: number | undefined;
} {
  const world = transhipWorld();
  const contract = offerTranship(world, { units: 5 });
  send(world, acceptCommand(contract.id));
  runUntil(world, () => contract.state === 'exporting' && world.cargo.countByKind('in_storage') === 5, 40_000, 'jednotky prekládky v sklade');
  let rescueContractId: number | undefined;
  if (options.rescue === true) {
    rescueContractId = acceptedImport(world, contract.lineId).contractId;
    expect(rescueContractId).toBeGreaterThan(contract.id);
  }
  // loď B „odplávala“ bez jednotiek: kontrakt ukazuje na loď, ktorá na mape nie je (SHIP B odišla pred nakládkou)
  contract.outShipId = 9_999 as EntityId;
  contract.outArrivalTick = world.clock.tick;
  const events = tickEvents(world, 1);
  return { world, contract, events, rescueContractId };
}

describe('prekládka — načasovanie lodí A a B', () => {
  it('loď B príde o tick po lodi A (čaká pred kotviskom, kým sa A nevyloží): jednotky sa vyložia aj naložia, nič sa nezmešká', () => {
    const world = transhipWorld({ economy: { transhipGapDaysRange: [0.0001, 0.0001] } });
    const contract = offerTranship(world, { units: 4 });
    send(world, acceptCommand(contract.id));
    expect(contract.outArrivalTick).toBe((contract.shipArrivalTick as number) + 1);
    const events = runUntil(world, closed, 60_000, 'uzavretie prekládky');
    assertCargoConservation(world);
    expect(contract.state).toBe('completed');
    expect(world.cargo.shippedCount).toBe(4);
    expect(eventsOf(events, 'TranshipMissed')).toEqual([]);
    const spawns = ofType(events, 'ShipSpawned');
    expect(spawns.map((entry) => entry.event.units)).toEqual([4, 0]);
    expect(spawns[1].tick - spawns[0].tick).toBe(1);
  });

  it('loď B nepríde pred lehotou zlyhania SLA (príchod za 30 dní): predaj zvyšku — TranshipSold, kontrakt zlyhá a kamión jednotky odvezie', () => {
    const world = transhipWorld({ economy: { transhipGapDaysRange: [30, 30] } });
    const contract = offerTranship(world, { units: 4 });
    send(world, acceptCommand(contract.id));
    const events = runUntil(world, () => contract.state === 'failed' && world.cargo.exportedCount === 4, 150_000, 'predaj po lehote zlyhania SLA');
    assertCargoConservation(world);
    expect(eventsOf(events, 'TranshipSold')).toEqual([{ type: 'TranshipSold', contractId: contract.id, units: 4 }]);
    expect(eventsOf(events, 'TranshipMissed')).toEqual([]);
    expect(contract.unitsExported).toBe(4);
    expect(world.cargo.shippedCount).toBe(0);
    expect(lost(world)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
  });
});

describe('zmeškaná prekládka — penalizácia, záchrana, predaj', () => {
  it('B odplávala bez jednotiek: TranshipMissed + BookingPenaltyApplied rolled v sadzbe transhipMissedRateOfReward, rescueDeadlineTick = tick + transhipRescueDays', () => {
    const { world, contract, events } = missedWorld();
    const missed = ofType(events, 'TranshipMissed');
    expect(missed).toHaveLength(1);
    expect(missed[0].event).toEqual({ type: 'TranshipMissed', contractId: contract.id, units: 5, outVoyageId: contract.outVoyageId });
    // ⌊1 000 000 × 0,25 × 5 / 5⌋ = 250 000
    expect(ofType(events, 'BookingPenaltyApplied').map((entry) => entry.event)).toEqual([{ type: 'BookingPenaltyApplied', contractId: contract.id, kind: 'rolled', units: 5, amountCents: 250_000 }]);
    expect(contract.penaltiesCents).toBe(250_000);
    expect(contract.rescueDeadlineTick).toBe(world.clock.tick + 3 * 8_640);
    expect(contract.state).toBe('exporting');
    assertCargoConservation(world);
  });

  it('bez ďalšej voyage linky: po transhipRescueDays sa jednotky predajú — TranshipSold, kontrakt sa uzavrie (failed), kamión ich odvezie ako exported; nič nezmizlo', () => {
    const { world, contract } = missedWorld();
    const deadline = contract.rescueDeadlineTick as number;
    const events = runUntil(world, () => world.cargo.exportedCount === 5, 60_000, 'predané jednotky odišli kamiónom');
    assertCargoConservation(world);
    expect(findWorldViolation(world)).toBeUndefined();
    const sold = ofType(events, 'TranshipSold');
    expect(sold).toHaveLength(1);
    expect(sold[0].tick).toBe(deadline);
    expect(sold[0].event).toEqual({ type: 'TranshipSold', contractId: contract.id, units: 5 });
    expect(contract.state).toBe('failed');
    expect(contract.unitsExported).toBe(5);
    expect(world.cargo.shippedCount).toBe(0);
    expect(lost(world)).toBe(0);
    const perUnit = [...chains(events).values()];
    expect(perUnit.length).toBe(5);
    // predané jednotky odišli bránou-rampou ako import (in_storage → … → at_ramp → in_truck → exported), nie loďou
    expect(perUnit.every((chain) => chain.at(-1) === 'exported' && chain.includes('at_ramp'))).toBe(true);
    expect(eventsOf(events, 'ContractFailed')).toHaveLength(1);
    expect(eventsOf(events, 'TranshipRescued')).toEqual([]);
  });

  it('predaný zvyšok nesie dve penalizácie rôzneho druhu (T6C-07b, ADR-034 dodatok): „zmeškané“ 25 % pri odplávaní lode B + jednorazový poplatok za nesplnený booking 10 % (loaded < 90 %), odmena 0', () => {
    const { world, contract } = missedWorld();
    // pri zmeškaní lode B: ⌊1 000 000 × 0,25 × 5 / 5⌋ = 250 000 (jednotková sadzba; platí aj pri záchrane)
    expect(contract.penaltiesCents).toBe(250_000);
    const events = runUntil(world, () => contract.state === 'failed', 60_000, 'predaj a uzavretie');
    // pri uzavretí: booking-level poplatok ⌊1 000 000 × 0,1⌋ = 100 000 (ako pri exporte, kde sa „rolled“ 5 % tiež sčíta s „unfulfilled“ 10 %)
    expect(ofType(events, 'BookingPenaltyApplied').map((entry) => entry.event)).toEqual([{ type: 'BookingPenaltyApplied', contractId: contract.id, kind: 'unfulfilled', units: 5, amountCents: 100_000 }]);
    expect(contract.penaltiesCents).toBe(350_000);
    expect(eventsOf(events, 'ContractFailed')).toEqual([{ type: 'ContractFailed', contractId: contract.id, penaltiesCents: 350_000 }]);
  });

  it('záchrana: ďalšia voyage tej istej linky v lehote → outVoyageId sa prepíše, TranshipRescued, jednotky ostanú v sklade a odplávajú na lodi tej voyage', () => {
    const { world, contract, events: first, rescueContractId } = missedWorld({ rescue: true });
    expect(ofType(first, 'TranshipMissed')).toHaveLength(1);
    const rescued = ofType(first, 'TranshipRescued');
    expect(rescued).toHaveLength(1);
    const rescueVoyage = rescued[0].event.outVoyageId;
    expect(rescueVoyage).not.toBe(contract.voyageId);
    expect(contract.outVoyageId).toBe(rescueVoyage);
    expect(contract.rescueDeadlineTick).toBeUndefined();
    expect(contract.outShipId).toBeUndefined();
    expect(world.contractBook.voyageContracts(rescueVoyage).map((c) => c.id)).toContain(contract.id);
    expect(world.cargo.countByKind('in_storage')).toBe(5);
    const events = runUntil(world, closed, 80_000, 'uzavretie po záchrane');
    assertCargoConservation(world);
    expect(findWorldViolation(world)).toBeUndefined();
    expect(contract.state).toBe('completed');
    expect(contract.booking.loadedUnits).toBe(5);
    expect(world.cargo.shippedCount).toBe(5);
    expect(lost(world)).toBe(0);
    // záchranná loď je loď voyage importu: privezie import a odvezie prekládku (jedna loď, voyage rescueVoyage)
    expect(contract.outShipId).toBe(world.contracts.get(rescueContractId as never)?.shipId);
    expect(world.contracts.get(rescueContractId as never)?.voyageId).toBe(rescueVoyage);
    // penalizácia za zmeškanie sa strhla (250 000), výplata za naložených 5 / 5 je plná
    expect(eventsOf(events, 'ContractCompleted').filter((event) => event.contractId === contract.id)).toEqual([
      expect.objectContaining({ contractId: contract.id, rewardCents: 1_000_000, penaltiesCents: 250_000 }),
    ]);
  });
});

describe('zmeškaná prekládka — obnova zo save', () => {
  const roundtrip = (world: World): World => World.deserialize(world.defs, MAP, JSON.parse(JSON.stringify(world.serialize())) as AnyWorldState);

  it('uprostred lehoty záchrany (rescueDeadlineTick nastavený): obnova dá rovnaký stateHash a predaj po lehote prebehne rovnako', () => {
    const { world, contract } = missedWorld();
    expect(contract.rescueDeadlineTick).toBeDefined();
    const restored = roundtrip(world);
    expect(stateHash(restored)).toBe(stateHash(world));
    const deadline = contract.rescueDeadlineTick as number;
    const left = deadline - world.clock.tick + 20;
    tickEvents(world, left);
    tickEvents(restored, left);
    expect(stateHash(restored)).toBe(stateHash(world));
    expect(restored.contracts.get(contract.id)?.state).toBe('failed');
  });

  it('po záchrane (prekládka v indexe cudzej voyage, ktorá jej nepatrí): obnova prejde (voyage kontrakty sa porovnávajú len podľa vlastnej voyage) a dá rovnaký stateHash aj po behu', () => {
    const { world, contract } = missedWorld({ rescue: true });
    expect(contract.rescueDeadlineTick).toBeUndefined();
    const restored = roundtrip(world);
    expect(stateHash(restored)).toBe(stateHash(world));
    tickEvents(world, 30_000);
    tickEvents(restored, 30_000);
    expect(stateHash(restored)).toBe(stateHash(world));
    expect(restored.contracts.get(contract.id)?.state).toBe('completed');
    expect(restored.cargo.shippedCount).toBe(world.cargo.shippedCount);
  });
});

describe('invariant loadedUnits bookingu (prekládka najviac, prázdne presne)', () => {
  it('prekládka naložená na loď B: loadedUnits menšie než jednotky nákladu na lodi je porušenie, väčšie (dávka na predchádzajúcej lodi po záchrane) nie', () => {
    const world = transhipWorld({ hook: true });
    const contract = offerTranship(world, { units: 4 });
    send(world, acceptCommand(contract.id));
    runUntil(world, () => contract.loadedUnits === 2, 60_000, 'dve naložené jednotky');
    expect(findWorldViolation(world)).toBeUndefined();
    const loaded = contract.loadedUnits;
    contract.loadedUnits = loaded + 1;
    expect(findWorldViolation(world), 'viac naložených než na lodi').toBeUndefined();
    contract.loadedUnits = loaded - 1;
    expect(findWorldViolation(world)).toMatch(/loadedUnits \d+, na .* je 2 jednotiek nákladu bookingu/);
    contract.loadedUnits = loaded;
  });
});

describe('prekládka — obnova zo save', () => {
  it('uloženie a načítanie v ticku, keď sú jednotky v sklade a čakajú na loď B, a uprostred nakládky na B, dá rovnaký stateHash ako nepretržitý beh', () => {
    const build = (): { world: World; contract: ReturnType<typeof offerTranship> } => {
      const world = transhipWorld({ hook: true, seed: 91 });
      const contract = offerTranship(world, { units: 6 });
      send(world, acceptCommand(contract.id));
      return { world, contract };
    };
    const probe = build();
    const probeEvents = tickEvents(probe.world, 60_000);
    const stored = ofType(probeEvents, 'ContractStateChanged').find((entry) => entry.event.to === 'exporting')?.tick as number;
    const loading = ofType(probeEvents, 'UnitLoaded')[2].tick;
    for (const at of [stored + 500, loading + 1]) {
      const run = build();
      tickEvents(run.world, at - run.world.clock.tick);
      const restored = World.deserialize(run.world.defs, MAP, JSON.parse(JSON.stringify(run.world.serialize())) as AnyWorldState);
      expect(stateHash(restored), `po obnove v ticku ${String(at)}`).toBe(stateHash(run.world));
      tickEvents(run.world, 6_000);
      tickEvents(restored, 6_000);
      expect(stateHash(restored), `po behu od ticku ${String(at)}`).toBe(stateHash(run.world));
      assertCargoConservation(restored);
    }
  }, 90_000); // 60 000-tickový prieskumný beh + dva behy s obnovou — pri zaťaženom stroji presahuje predvolených 15 s
});
