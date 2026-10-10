// PlaceRail / RemoveRail (TR6-01, ADR-043): koľajová vrstva mriežky, cena z defu, atomickosť, žiadne kríženie s cestou, odmietnutie odstránenia koľaje pod vlakom.
import { describe, expect, it } from 'vitest';
import { PlaceRailCommand, PlaceRoadCommand, RemoveRailCommand, RemoveRoadCommand, commandFromJSON } from '@sim/commands';
import { DEFS, MAP, SEED } from '../world/world-fixtures';
import { World } from '@sim/world';
import { send } from '../helpers/f6a';
import { RAIL_PORTAL, approachCells, railWorld } from '../helpers/r6-rail';

const RAIL_COST = DEFS.infrastructure.rail.costPerCellCents;
const ROAD_CELL = { x: 44, y: 40 };

function plain(): World {
  return World.create(DEFS, MAP, SEED);
}

describe('PlaceRail', () => {
  it('postaví koľaj na súš: vrstva `rail`, cena z defu (road_capex) a jeden RoadChanged', () => {
    const world = plain();
    const cells = [{ x: 60, y: 52 }, { x: 61, y: 52 }];
    const command = new PlaceRailCommand(cells);
    const verdict = command.validate(world);
    expect(verdict).toMatchObject({ ok: true, costCents: 2 * RAIL_COST });
    const cash = world.cashCents;
    const events = send(world, command.toJSON());
    expect(events.filter((event) => event.type === 'RoadChanged')).toHaveLength(1);
    expect(world.grid.at(60, 52).road).toBe('rail');
    expect(world.cashCents).toBe(cash - 2 * RAIL_COST);
    expect(events.find((event) => event.type === 'MoneyChanged')).toMatchObject({ reason: 'road_capex', deltaCents: -2 * RAIL_COST });
  });

  it('bunka s koľajou sa preskočí; samé preskočené bunky = `empty`', () => {
    const world = plain();
    send(world, { type: 'PlaceRail', cells: [{ x: 60, y: 52 }] });
    expect(new PlaceRailCommand([{ x: 60, y: 52 }]).validate(world).reasons).toEqual(['empty']);
    expect(new PlaceRailCommand([{ x: 60, y: 52 }, { x: 61, y: 52 }]).validate(world)).toMatchObject({ ok: true, costCents: RAIL_COST });
  });

  it('nekríži cestu ani modul a nestojí na vode; jedna zlá bunka odmietne celý príkaz (atomicky)', () => {
    const world = plain();
    expect(world.grid.at(ROAD_CELL.x, ROAD_CELL.y).road).toBe('road');
    expect(new PlaceRailCommand([ROAD_CELL]).validate(world).reasons).toContain('occupied');
    expect(new PlaceRailCommand([{ x: 0, y: 0 }]).validate(world).reasons).toContain('terrain');
    const module = [...world.modules.values()][0];
    expect(new PlaceRailCommand([{ x: module.origin.x, y: module.origin.y }]).validate(world).reasons).toContain('occupied');
    expect(new PlaceRailCommand([{ x: 60, y: 52 }, ROAD_CELL]).validate(world).ok).toBe(false);
    expect(send(world, { type: 'PlaceRail', cells: [{ x: 60, y: 52 }, ROAD_CELL] })).toEqual([]);
    expect(world.grid.at(60, 52).road).toBe('none');
    expect(new PlaceRailCommand([{ x: 200, y: 0 }]).validate(world).reasons).toContain('out_of_bounds');
  });

  it('cestu na koľaji tiež nepostavíš; bez hotovosti `insufficient_funds`', () => {
    const world = plain();
    send(world, { type: 'PlaceRail', cells: [{ x: 60, y: 52 }] });
    expect(new PlaceRoadCommand([{ x: 60, y: 52 }]).validate(world).reasons).toContain('occupied');
    expect(new RemoveRoadCommand([{ x: 60, y: 52 }]).validate(world).reasons).toContain('no_road');
    const cells = Array.from({ length: 200 }, (_, i) => ({ x: 20 + (i % 40), y: 55 + Math.floor(i / 40) }));
    expect(new PlaceRailCommand(cells).validate(world).reasons).toContain('insufficient_funds');
  });

  it('serializuje sa a vráti cez commandFromJSON', () => {
    const json = new PlaceRailCommand([{ x: 1, y: 2 }]).toJSON();
    expect(json).toEqual({ type: 'PlaceRail', cells: [{ x: 1, y: 2 }] });
    expect(commandFromJSON(json)).toBeInstanceOf(PlaceRailCommand);
    expect(commandFromJSON(new RemoveRailCommand([{ x: 1, y: 2 }]).toJSON())).toBeInstanceOf(RemoveRailCommand);
  });
});

describe('RemoveRail', () => {
  it('odstráni koľaj a vráti refundáciu (road_sale); bunka bez koľaje → no_road', () => {
    const world = plain();
    send(world, { type: 'PlaceRail', cells: [{ x: 60, y: 52 }, { x: 61, y: 52 }] });
    expect(new RemoveRailCommand([{ x: 62, y: 52 }]).validate(world).reasons).toEqual(['no_road']);
    const cash = world.cashCents;
    const verdict = new RemoveRailCommand([{ x: 60, y: 52 }]).validate(world);
    expect(verdict.ok).toBe(true);
    expect(verdict.costCents).toBeLessThan(0);
    const events = send(world, { type: 'RemoveRail', cells: [{ x: 60, y: 52 }] });
    expect(world.grid.at(60, 52).road).toBe('none');
    expect(world.cashCents).toBe(cash - verdict.costCents);
    expect(events.find((event) => event.type === 'MoneyChanged')).toMatchObject({ reason: 'road_sale' });
  });

  it('koľaj na trase vlaka sa neodstráni', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 0 } });
    for (let i = 0; i < 20; i++) world.tick();
    expect(world.trains.size).toBe(1);
    expect(new RemoveRailCommand([RAIL_PORTAL]).validate(world).reasons).toEqual(['occupied']);
    expect(new RemoveRailCommand(approachCells()).validate(world).ok).toBe(false);
  });
});
