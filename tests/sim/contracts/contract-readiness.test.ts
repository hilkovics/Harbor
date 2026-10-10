/**
 * `AcceptContract` overí pripravenosť prístavu (T06-07, BACKLOG P1 „AcceptContract bez overenia pripravenosti
 * prístavu", dodatok ADR-026 v ADR-031): ponuku nejde prijať, keď loď kontraktu nemá kam zakotviť.
 *
 * - `no_berth_for_ship_class` — žiadny súvislý úsek kotvísk skupiny (§5.4) nemá pre triedu lode z ponuky dosť dĺžky
 *   (`Σ lengthCells`), hĺbky (`depthClass ≥ draftClass` každého kotviska) a pásu vody (`frontWaterCells ≥ widthCells`);
 * - `no_crane_for_category` — taký úsek existuje, ale žiadny nemá žeriav kategórie nákladu kontraktu.
 * Obsadenosť kotvísk (loď pri kotvisku, rezervácia) a lodná doprava sa neposudzujú — loď počká na anchorage. Validácia
 * nemení svet ani nespotrebuje `Rng`; odmietnutie pri aplikácii = `CommandRejected` a ponuka ostane v `offered`.
 */
import { describe, expect, it } from 'vitest';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { BerthModule } from '@sim/modules';
import { World } from '@sim/world';
import { must } from '../helpers/harbor';
import { DEFS, MAP, RAW_DEFS, acceptContract, commandReasons, offeredContracts, stateOfContract } from '../helpers/f5';

const BERTH_ID = 1;
const CRANE_ID = 2;
/** Strop tickov na príchod lode prvej ponuky ku kotvisku (príchod najneskôr o `arrivalDaysRange[1]` dňa + plavba). */
const SHIP_WAIT_LIMIT = 40_000;
/** Voľné miesto na nábreží harbor_01 hneď za Root kotviskom (40…47, 14) — dve kotviská tvoria skupinu dĺžky 16. */
const ADJACENT_BERTH: SerializedCommand = { type: 'PlaceModule', defId: 'berth_standard', x: 48, y: 14, rotation: 0 };

/** Defy, v ktorých pool ponúka len kontajnery pre Handysize (10 buniek > jedno kotvisko 8) už od tieru 0. */
const HANDY_DEFS = DefRegistry.fromRaw({
  ...RAW_DEFS,
  contract_templates: {
    ...RAW_DEFS.contract_templates,
    items: RAW_DEFS.contract_templates.items.filter((item) => item.shipClassIds.includes('handy')).map((item) => ({ ...item, minTier: 0 })),
  },
});

/** Bundled defy s upravenou triedou lode `feeder`. */
function feederDefs(patch: Record<string, unknown>): DefRegistry {
  return DefRegistry.fromRaw({
    ...RAW_DEFS,
    ships: { ...RAW_DEFS.ships, items: RAW_DEFS.ships.items.map((item) => (item.id === 'feeder' ? { ...item, ...patch } : item)) },
  });
}

/** Nový svet po prvom ticku (pool naplnený). */
function worldWith(defs: DefRegistry = DEFS): World {
  const world = World.create(defs, MAP, 20261001);
  world.tick();
  return world;
}

/** Zaradí a hneď aplikuje príkaz (bez ticku), vráti udalosti. */
function execute(world: World, command: SerializedCommand): readonly SimEvent[] {
  world.enqueue(commandFromJSON(command));
  return world.applyPending();
}

function firstOffer(world: World): number {
  return must(offeredContracts(world)[0], 'ponuka').id;
}

describe('AcceptContract: pripravenosť prístavu (T06-07)', () => {
  it('Root kotvisko so žeriavom na kontajnery: ponuku Feeder možno prijať', () => {
    const world = worldWith();
    const offer = must(offeredContracts(world)[0], 'ponuka');
    expect(world.defs.ships.get(String(offer.shipClassId)).lengthCells).toBeLessThanOrEqual(8);
    expect(commandReasons(world, acceptContract(offer.id))).toEqual([]);
  });

  it('bez žeriavu: no_crane_for_category; bez kotviska: no_berth_for_ship_class', () => {
    const world = worldWith();
    const id = firstOffer(world);
    execute(world, { type: 'RemoveModule', moduleId: CRANE_ID });
    expect(world.modules.has(CRANE_ID as EntityId)).toBe(false);
    expect(commandReasons(world, acceptContract(id))).toEqual(['no_crane_for_category']);
    execute(world, { type: 'RemoveModule', moduleId: BERTH_ID });
    expect(commandReasons(world, acceptContract(id))).toEqual(['no_berth_for_ship_class']);
  });

  it('Handysize (10 buniek) pri jednom kotvisku (8): no_berth_for_ship_class; susedné kotvisko → skupina 16 so žeriavom → OK', () => {
    const world = worldWith(HANDY_DEFS);
    const offer = must(offeredContracts(world)[0], 'ponuka Handysize');
    expect(offer.shipClassId).toBe('handy');
    expect(commandReasons(world, acceptContract(offer.id))).toEqual(['no_berth_for_ship_class']);
    const placed = execute(world, ADJACENT_BERTH);
    expect(placed.some((event) => event.type === 'CommandRejected')).toBe(false);
    expect(world.berthGroups.map((group) => group.totalLength)).toEqual([16]);
    expect(commandReasons(world, acceptContract(offer.id))).toEqual([]);
  });

  it('Handysize: skupina 16 bez žeriavu → no_crane_for_category (dĺžka stačí, žeriav chýba)', () => {
    const world = worldWith(HANDY_DEFS);
    const id = firstOffer(world);
    execute(world, ADJACENT_BERTH);
    execute(world, { type: 'RemoveModule', moduleId: CRANE_ID });
    expect(commandReasons(world, acceptContract(id))).toEqual(['no_crane_for_category']);
  });

  it('plytké kotvisko (draftClass lode > depthClass) → no_berth_for_ship_class', () => {
    const world = worldWith(feederDefs({ draftClass: 2 }));
    expect(commandReasons(world, acceptContract(firstOffer(world)))).toEqual(['no_berth_for_ship_class']);
  });

  it('úzky pás vody pred kotviskom (widthCells lode > frontWaterCells) → no_berth_for_ship_class', () => {
    const world = worldWith(feederDefs({ widthCells: 4 }));
    expect(commandReasons(world, acceptContract(firstOffer(world)))).toEqual(['no_berth_for_ship_class']);
  });

  it('odmietnutie pri aplikácii: CommandRejected s dôvodom, ponuka ostane offered, Rng ani stav sa nezmenia', () => {
    const world = worldWith();
    const id = firstOffer(world);
    execute(world, { type: 'RemoveModule', moduleId: CRANE_ID });
    const before = JSON.stringify(world.serialize());
    const events = execute(world, acceptContract(id));
    expect(events).toEqual([{ type: 'CommandRejected', commandType: 'AcceptContract', reasons: ['no_crane_for_category'] }]);
    expect(stateOfContract(world, id)).toBe('offered');
    expect(JSON.stringify(world.serialize())).toBe(before);
  });

  it('obsadené kotvisko pripravenosť neruší: loď pri jedinom kotvisku, ďalšiu ponuku možno prijať', () => {
    const world = worldWith();
    const [first, second] = offeredContracts(world);
    execute(world, acceptContract(must(first, 'prvá ponuka').id));
    const berth = world.modules.get(BERTH_ID as EntityId);
    if (!(berth instanceof BerthModule)) throw new Error('Root kotvisko chýba');
    for (let i = 0; i < SHIP_WAIT_LIMIT && berth.dockedShipId === null; i++) world.tick();
    expect(berth.dockedShipId).not.toBeNull();
    expect(commandReasons(world, acceptContract(must(second, 'druhá ponuka').id))).toEqual([]);
  });
});
