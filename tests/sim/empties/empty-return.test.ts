// Návrat prázdnych kontajnerov (T6C-02, ADR-034 bod 6): plán po odchode importu kamiónom (`emptyReturnRate`, `hinterlandDaysRange`, jediný
// `Rng`), kamión `delivery` s novou jednotkou `direction: 'empty'`, brána (`EmptyReturned`), vykládka na rampe, job na depo prázdnych,
// `EmptyStored`, fallback do bežného dvora (depo chýba / je plné) a plán len v prístave s depom (dodatok T6C-02, odchýlka 7).
import { describe, expect, it } from 'vitest';
import { planEmptyReturn } from '../../../src/sim/trucks/empty-plan';
import { assertCargoConservation } from '../helpers/invariants';
import { send } from '../helpers/f6a';
import { TICKS_PER_DAY, acceptedImport, depotOf, emptiesByLocation, emptyWorld, eventsOf, f6cDefs, run, runUntil } from '../helpers/f6c';
import { EmptyDepot } from '@sim/modules';
import { DEFAULT_CONTAINER_LABELS, type CargoUnit } from '@sim/cargo';
import type { EntityId } from '@sim/core';

const TWO_STRADDLES = ['straddle_carrier', 'straddle_carrier'];

/** Jednotka importu linky na kamióne (tvar pre `planEmptyReturn`, ledger sa nepoužije). */
function importUnit(lineId: string | null, direction: CargoUnit['direction'] = 'import'): CargoUnit {
  return {
    ...DEFAULT_CONTAINER_LABELS,
    id: 9_001 as EntityId,
    typeId: 'container_teu',
    contractId: lineId === null ? null : (1 as never),
    voyageId: null,
    lineId,
    direction,
    destinationPort: null,
    weightClass: 'medium',
    hold: null,
    status: 'available',
    repairUntilTick: null, reefer: null,
    quantity: 1,
    location: { kind: 'in_truck', truckId: 1 as EntityId },
  };
}

describe('planEmptyReturn — plán návratu po odchode importu', () => {
  it('prístav s depom, rate 1: jedna položka na linku jednotky, dueTick = tick + round(dni × ticksPerDay) v rozsahu hinterlandDaysRange', () => {
    const world = emptyWorld({ defs: f6cDefs({ emptyFlow: { emptyReturnRate: 1, hinterlandDaysRange: [1, 3] } }) });
    for (let i = 0; i < 20; i++) planEmptyReturn(world, importUnit('northern_star'));
    const plan = world.emptyFlow.returnPlan;
    expect(plan).toHaveLength(20);
    for (const entry of plan) {
      expect(entry.lineId).toBe('northern_star');
      expect(entry.dueTick - world.clock.tick).toBeGreaterThanOrEqual(TICKS_PER_DAY);
      expect(entry.dueTick - world.clock.tick).toBeLessThanOrEqual(3 * TICKS_PER_DAY);
    }
    expect(plan.map((entry) => entry.dueTick)).toEqual([...plan.map((entry) => entry.dueTick)].sort((a, b) => a - b));
    expect(new Set(plan.map((entry) => entry.dueTick)).size).toBeGreaterThan(1);
  });

  it('rate 0: žiadny návrat; jednotka bez linky, export a prázdny kontajner plán nezaložia; Rng sa spotrebuje len pri import jednotke s linkou', () => {
    const world = emptyWorld({ defs: f6cDefs({ emptyFlow: { emptyReturnRate: 0 } }) });
    planEmptyReturn(world, importUnit('blue_anchor'));
    expect(world.emptyFlow.returnPlan).toEqual([]);
    const rich = emptyWorld();
    const before = rich.rng.getState();
    planEmptyReturn(rich, importUnit(null));
    planEmptyReturn(rich, importUnit('blue_anchor', 'export'));
    planEmptyReturn(rich, importUnit('blue_anchor', 'empty'));
    planEmptyReturn(rich, importUnit('blue_anchor', 'tranship'));
    expect(rich.emptyFlow.returnPlan).toEqual([]);
    expect(rich.rng.getState()).toEqual(before);
    planEmptyReturn(rich, importUnit('blue_anchor'));
    expect(rich.rng.getState()).not.toEqual(before);
    expect(rich.emptyFlow.returnPlan).toHaveLength(1);
  });

  it('prístav bez depa prázdnych: nič sa nenaplánuje a Rng sa nespotrebuje (svet ostáva bitovo ako F6a)', () => {
    const world = emptyWorld({ depot: false });
    const before = world.rng.getState();
    planEmptyReturn(world, importUnit('blue_anchor'));
    expect(world.emptyFlow.returnPlan).toEqual([]);
    expect(world.rng.getState()).toEqual(before);
  });
});

describe('návrat prázdneho — kamión, brána, TP depa', () => {
  it('splatný návrat: kamión delivery s novou prázdnou jednotkou → EmptyReturned → vyloženie na TP depa (straddle carrier) → job → uložené v depe (EmptyStored bez fallbacku)', () => {
    const world = emptyWorld({ vehicles: TWO_STRADDLES });
    world.emptyFlow.scheduleReturn(world.clock.tick + 5, 'northern_star');
    const events = runUntil(world, (w) => w.emptyFlow.returnPlan.length === 0 && emptiesByLocation(w)['in_storage'] === 1, 3_000, 'uloženie prázdneho');
    const depot = depotOf(world);
    expect(eventsOf(events, 'TruckSpawned')).toHaveLength(1);
    const [returned] = eventsOf(events, 'EmptyReturned');
    expect(returned).toMatchObject({ lineId: 'northern_star' });
    const [stored] = eventsOf(events, 'EmptyStored');
    expect(stored).toMatchObject({ unitId: returned.unitId, lineId: 'northern_star', moduleId: depot.id, fallback: false });
    expect(world.cargo.get(returned.unitId)).toMatchObject({ direction: 'empty', lineId: 'northern_star', contractId: null, status: 'available', location: { kind: 'in_storage', moduleId: depot.id } });
    // reťaz presunov bez teleportácie: in_truck → in_vehicle → in_storage (ledger povoľuje len tieto prechody)
    const moved = eventsOf(events, 'CargoMoved').filter((event) => event.unitId === returned.unitId).map((event) => `${event.from.kind}>${event.to.kind}`);
    expect(moved).toEqual(['in_truck>in_vehicle', 'in_vehicle>in_storage']);
    // kamión odíde prázdny a zmizne z mapy
    runUntil(world, (w) => w.trucks.size === 0, 3_000, 'odchod kamióna');
    expect(world.trucks.size).toBe(0);
    assertCargoConservation(world);
    expect(world.cargo.createdCount - world.cargo.liveCount - world.cargo.exportedCount - world.cargo.shippedCount).toBe(0);
  });

  it('plán sa spotrebuje až po vzniku kamióna; bez brány položka počká a nič nezanikne', () => {
    const world = emptyWorld({ vehicles: TWO_STRADDLES, landside: [] });
    world.emptyFlow.scheduleReturn(world.clock.tick + 2, 'blue_anchor');
    run(world, 50);
    expect(world.emptyFlow.returnPlan).toHaveLength(1);
    expect(world.trucks.size).toBe(0);
    expect(world.cargo.createdCount).toBe(0);
  });

  it('dve linky: každý návrat nesie svoju linku a obe jednotky skončia v depe', () => {
    const world = emptyWorld({ vehicles: TWO_STRADDLES });
    const tick = world.clock.tick;
    world.emptyFlow.scheduleReturn(tick + 5, 'blue_anchor');
    world.emptyFlow.scheduleReturn(tick + 5, 'golden_wave');
    const events = runUntil(world, (w) => w.emptyFlow.returnPlan.length === 0 && emptiesByLocation(w)['in_storage'] === 2, 4_000, 'dve prázdne v depe');
    expect(eventsOf(events, 'EmptyReturned').map((event) => event.lineId).sort()).toEqual(['blue_anchor', 'golden_wave']);
    const depot = depotOf(world);
    const lines = world.cargo.unitsAt('in_storage', depot.id).map((id) => world.cargo.get(id)?.lineId);
    expect(lines.sort()).toEqual(['blue_anchor', 'golden_wave']);
  });
});

describe('fallback — prázdny do bežného dvora len keď depo chýba (T6C-07b, M1)', () => {
  it('depo plné (kapacita 1): druhý návrat sa zahodí (EmptyReturnDeclined), do dvora sa neukladá žiadny prázdny', () => {
    const defs = f6cDefs({ moduleParams: { empty_depot: { capacityUnits: 1 } } });
    const world = emptyWorld({ defs, vehicles: TWO_STRADDLES });
    const tick = world.clock.tick;
    world.emptyFlow.scheduleReturn(tick + 5, 'blue_anchor');
    world.emptyFlow.scheduleReturn(tick + 5, 'blue_anchor');
    const events = run(world, 5_000);
    expect(world.emptyFlow.returnPlan).toHaveLength(0);
    expect(eventsOf(events, 'EmptyReturnDeclined')).toEqual([{ type: 'EmptyReturnDeclined', lineId: 'blue_anchor' }]);
    expect(eventsOf(events, 'EmptyStored').map((event) => event.fallback)).toEqual([false]);
    expect(world.storedCargo.emptySize).toBe(1);
    expect(depotOf(world).storedCount).toBe(1);
    expect(world.cargo.createdCount).toBe(1);
    run(world, 600);
    expect(world.cargo.countByKind('exported')).toBe(0);
    expect(emptiesByLocation(world)).toEqual({ in_storage: 1 });
  });

  it('depo zbúrané po naplánovaní (svet bez depa v čase návratu): prázdny skončí vo dvore (fallback)', () => {
    const world = emptyWorld({ vehicles: TWO_STRADDLES });
    world.emptyFlow.scheduleReturn(world.clock.tick + 5, 'blue_anchor');
    send(world, { type: 'RemoveModule', moduleId: depotOf(world).id });
    expect([...world.modules.values()].some((module) => module instanceof EmptyDepot)).toBe(false);
    const events = runUntil(world, (w) => w.emptyFlow.returnPlan.length === 0 && emptiesByLocation(w)['in_storage'] === 1, 4_000, 'prázdny vo dvore');
    expect(eventsOf(events, 'EmptyStored').map((event) => event.fallback)).toEqual([true]);
  });
});

describe('import → návrat prázdneho (celý reťaz cez kontrakt)', () => {
  it('prístav bez depa: odvezený import nezaloží návrat (returnPlan ostane prázdny, nevznikne žiadna prázdna jednotka)', () => {
    const defs = f6cDefs({ emptyFlow: { emptyReturnRate: 1 }, economy: { arrivalDaysRange: [0.5, 0.5] } });
    const world = emptyWorld({ defs, depot: false, vehicles: TWO_STRADDLES });
    acceptedImport(world, 'golden_wave', 4);
    runUntil(world, (w) => w.cargo.exportedCount === 4, 40_000, 'import odvezený kamiónmi');
    expect(world.emptyFlow.returnPlan).toEqual([]);
    expect(world.cargo.createdCount).toBe(4);
  }, 120_000);

  it('rate 1: každá jednotka importu, ktorá odíde kamiónom, naplánuje návrat prázdneho svojej linky; po 1 dni prídu a uložia sa v depe', () => {
    const defs = f6cDefs({ emptyFlow: { emptyReturnRate: 1, hinterlandDaysRange: [1, 1] }, economy: { arrivalDaysRange: [0.5, 0.5] } });
    const world = emptyWorld({ defs, vehicles: TWO_STRADDLES });
    const { contractId } = acceptedImport(world, 'golden_wave', 4);
    const events = runUntil(world, (w) => w.cargo.exportedCount === 4, 40_000, 'import odvezený kamiónmi');
    events.push(...run(world, 2));
    expect(eventsOf(events, 'ContractCompleted').map((event) => event.contractId)).toEqual([contractId]);
    expect(world.emptyFlow.returnPlan.length + eventsOf(events, 'EmptyReturned').length).toBe(4);
    expect(world.emptyFlow.returnPlan.every((entry) => entry.lineId === 'golden_wave')).toBe(true);
    const more = runUntil(world, (w) => w.emptyFlow.returnPlan.length === 0 && emptiesByLocation(w)['in_storage'] === 4, 3 * TICKS_PER_DAY, 'štyri prázdne v depe');
    expect(eventsOf(more, 'EmptyStored').every((event) => !event.fallback && event.lineId === 'golden_wave')).toBe(true);
    run(world, 2_000);
    expect(world.trucks.size).toBe(0);
    expect(emptiesByLocation(world)).toEqual({ in_storage: 4 });
    assertCargoConservation(world);
    expect(world.cargo.createdCount - world.cargo.liveCount - world.cargo.exportedCount - world.cargo.shippedCount).toBe(0);
  }, 120_000);
});
