// PlaceModule (T02-04, ARCHITECTURE §8 body 1–4, 6, 7; ADR-015): validate vráti všetky dôvody naraz v kanonickom
// poradí, cells = footprint po rotácii, costCents = cena defu; apply stavia cez ModuleRegistry, strhne cenu a emituje
// ModulePlaced + MoneyChanged(module_capex).
//
// harbor_01 bez Root modulu (newBareWorld): voda y ≤ 13, nábrežie y 14–16 x 10–85, pevnina y ≥ 17; starter parcela
// x 30–57 y 14–33 (vlastnená), west_quay x 6–27 (na predaj).
import { describe, expect, it } from 'vitest';
import { APRON_MODULES as modulesJson } from '../helpers/apron-modules';
import { PlaceModuleCommand, commandFromJSON, type ValidationReason } from '@sim/commands';
import { DefRegistry } from '@sim/defs';
import { BerthModule, ContainerYard, CraneModule, VehicleDepot, footprintOf } from '@sim/modules';
import { World } from '@sim/world';
import { PIER_MAP } from '../world/pier-map';
import { RAW_DEFS } from '../world/world-fixtures';
import { DEFS, SEED, START_CASH, hashState, newBareWorld, ofType } from './command-fixtures';
import { setCash } from '../helpers/economy';

const BERTH = 'berth_standard';
const CRANE = 'crane_container_gantry';
const BERTH_COST = DEFS.modules.get(BERTH).costCents;
const CRANE_COST = DEFS.modules.get(CRANE).costCents;

const place = (defId: string, x: number, y: number, rotation = 0): PlaceModuleCommand => new PlaceModuleCommand({ defId, x, y, rotation });

/** Postaví modul skutočným príkazom (overí platnosť) a zahodí udalosti. */
function built(world: World, defId: string, x: number, y: number, rotation = 0): World {
  const command = place(defId, x, y, rotation);
  expect(command.validate(world).reasons).toEqual([]);
  command.apply(world);
  world.events.flush();
  return world;
}

const footprint = (defId: string, x: number, y: number, rotation: 0 | 90 | 180 | 270 = 0) => footprintOf(DEFS.modules.get(defId), x, y, rotation).cells;

describe('PlaceModule — kotvisko', () => {
  it('platné na Root pozícii: ok, cells = 32 buniek footprintu, costCents = cena defu', () => {
    expect(place(BERTH, 40, 14).validate(newBareWorld())).toEqual({ ok: true, reasons: [], cells: footprint(BERTH, 40, 14), costCents: BERTH_COST });
    expect(footprint(BERTH, 40, 14)).toHaveLength(32);
  });

  it('apply: modul s id z alokátora a zaplatenou cenou, bunky, hotovosť, udalosti, skupina kotvísk', () => {
    const world = newBareWorld();
    place(BERTH, 40, 14).apply(world);

    const berth = world.modules.get(1 as never);
    expect(berth).toBeInstanceOf(BerthModule);
    expect(berth?.purchaseCostCents).toBe(BERTH_COST);
    for (const { x, y } of footprint(BERTH, 40, 14)) expect(world.grid.at(x, y).moduleId).toBe(1);
    expect(world.cashCents).toBe(START_CASH - BERTH_COST);
    expect(world.berthGroups).toEqual([{ id: 1, berthIds: [1], totalLength: 8, minDepth: 1 }]);
    expect(world.events.flush()).toEqual([
      { type: 'ModulePlaced', moduleId: 1, defId: BERTH, x: 40, y: 14, rotation: 0, cells: footprint(BERTH, 40, 14) },
      { type: 'MoneyChanged', cashCents: START_CASH - BERTH_COST, deltaCents: -BERTH_COST, reason: 'module_capex' },
    ]);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it.each<[string, number, number, number, ValidationReason[]]>([
    ['na vode (južné konektory vedú na nábrežie, takže connector_blocked nehlási)', 40, 10, 0, ['terrain', 'parcel_not_owned']],
    ['mimo pobrežia (vnútrozemie)', 40, 20, 0, ['terrain', 'no_water_side']],
    ['hrana pri vode otočená na pevninu (180°): riadok pri vode nie je nábrežie', 40, 14, 180, ['terrain', 'no_water_side']],
    ['cudzia parcela (west_quay na predaj)', 6, 12, 0, ['parcel_not_owned']],
    ['presah mimo mapy — všetky dôvody naraz', 90, 20, 0, ['out_of_bounds', 'terrain', 'parcel_not_owned', 'no_water_side', 'connector_blocked']],
  ])('%s → %j, cells = footprint, costCents = cena', (_name, x, y, rotation, reasons) => {
    const cells = footprintOf(DEFS.modules.get(BERTH), x, y, rotation as 0 | 90 | 180 | 270).cells;
    expect(place(BERTH, x, y, rotation).validate(newBareWorld())).toEqual({ ok: false, reasons, cells, costCents: BERTH_COST });
  });

  it('prekryv s iným kotviskom → occupied; susedné kotvisko prejde a skupina má dĺžku 16', () => {
    const world = built(newBareWorld(), BERTH, 40, 14);
    expect(place(BERTH, 44, 14).validate(world).reasons).toEqual(['occupied']);
    built(world, BERTH, 48, 14);
    expect(world.berthGroups).toEqual([{ id: 1, berthIds: [1, 2], totalLength: 16, minDepth: 1 }]);
  });

  it('cesta vo footprinte → occupied (ako pri PlaceRoad)', () => {
    const world = newBareWorld();
    world.grid.at(47, 16).road = 'road';
    expect(place(BERTH, 40, 14).validate(world).reasons).toEqual(['occupied']);
  });

  it('pás vody pretína pás kotviska s inou orientáciou → water_blocked (mapa pier_test)', () => {
    const world = built(World.create(DEFS, PIER_MAP, SEED), BERTH, 10, 10, 0);
    // Kotvisko zaberá celé mólo W, konektory vedú do vody → navyše connector_blocked (§8 bod 5, ADR-017).
    expect(place(BERTH, 5, 2, 90).validate(world).reasons).toEqual(['water_blocked', 'connector_blocked']);
    expect(place(BERTH, 5, 2, 270).validate(world).reasons).toEqual(['connector_blocked']);
  });

  it('rotácia 90: cells = otočený footprint 4×8', () => {
    const result = place(BERTH, 40, 14, 90).validate(newBareWorld());
    expect(result.cells).toEqual(footprint(BERTH, 40, 14, 90));
    expect(result.cells).toHaveLength(32);
    expect(result.cells.at(-1)).toEqual({ x: 43, y: 21 });
  });
});

describe('PlaceModule — žeriav', () => {
  it('na kotvisku: ok; apply pripojí žeriav, bunky ostávajú berthu, cena žeriavu', () => {
    const world = built(newBareWorld(), BERTH, 40, 14);
    const cash = world.cashCents;
    const command = place(CRANE, 43, 14);
    expect(command.validate(world)).toEqual({ ok: true, reasons: [], cells: footprint(CRANE, 43, 14), costCents: CRANE_COST });
    command.apply(world);
    const crane = world.modules.get(2 as never);
    expect(crane).toBeInstanceOf(CraneModule);
    expect((world.modules.get(1 as never) as BerthModule).craneIds).toEqual([2]);
    expect(world.grid.at(43, 14).moduleId).toBe(1);
    expect(world.cashCents).toBe(cash - CRANE_COST);
    expect(ofType(world.events.flush(), 'ModulePlaced')).toEqual([
      { type: 'ModulePlaced', moduleId: 2, defId: CRANE, x: 43, y: 14, rotation: 0, cells: footprint(CRANE, 43, 14) },
    ]);
  });

  it('mimo kotviska → no_berth (holé nábrežie, pevnina, presah cez okraj berthu)', () => {
    const world = built(newBareWorld(), BERTH, 40, 14);
    expect(place(CRANE, 50, 14).validate(world).reasons).toEqual(['no_berth']);
    expect(place(CRANE, 43, 20).validate(world).reasons).toEqual(['terrain', 'no_berth']);
    expect(place(CRANE, 47, 14).validate(world).reasons).toEqual(['no_berth']);
  });

  it('tretí žeriav → max_cranes; prekryv → occupied; iná rotácia → rotation_mismatch', () => {
    const rich = newBareWorld();
    setCash(rich, 10 * (BERTH_COST + 3 * CRANE_COST)); // peniaze tu nie sú predmetom testu
    const world = built(built(rich, BERTH, 40, 14), CRANE, 43, 14);
    expect(place(CRANE, 44, 14).validate(world).reasons).toEqual(['occupied']);
    expect(place(CRANE, 41, 14, 90).validate(world).reasons).toEqual(['occupied', 'rotation_mismatch']);
    built(world, CRANE, 45, 14);
    expect(place(CRANE, 40, 14).validate(world).reasons).toEqual(['max_cranes']);
  });
});

describe('PlaceModule — sklad a depo (T03-02, §8 bod 5, ADR-017)', () => {
  const YARD = 'container_yard_small';
  const DEPOT = 'vehicle_depot';

  it('dvor na starter parcele: ok, cena defu; apply postaví ContainerYard (nepripojený, kým nie je cesta)', () => {
    const world = newBareWorld();
    const command = place(YARD, 50, 20);
    expect(command.validate(world)).toEqual({ ok: true, reasons: [], cells: footprint(YARD, 50, 20), costCents: DEFS.modules.get(YARD).costCents });
    command.apply(world);
    const yard = world.moduleAt(50, 20);
    expect(yard).toBeInstanceOf(ContainerYard);
    expect(yard?.purchaseCostCents).toBe(15_000_000);
    expect(world.isConnected(yard as ContainerYard)).toBe(false);
    expect(ofType(world.events.flush(), 'ModulePlaced')).toHaveLength(1);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('depo: apply postaví VehicleDepot', () => {
    const world = built(newBareWorld(), DEPOT, 34, 20);
    expect(world.moduleAt(35, 21)).toBeInstanceOf(VehicleDepot);
  });

  it('jediný konektor vedie do vody alebo do iného modulu → connector_blocked (cells a cena ostávajú pre ghost)', () => {
    const world = built(newBareWorld(), DEPOT, 50, 24);
    expect(place(YARD, 50, 20).validate(world)).toEqual({
      ok: false,
      reasons: ['connector_blocked'],
      cells: footprint(YARD, 50, 20),
      costCents: DEFS.modules.get(YARD).costCents,
    });
    expect(place(YARD, 50, 14, 180).validate(world).reasons).toEqual(['connector_blocked']);
  });

  it('cez frontu: odmietnutie connector_blocked → CommandRejected, svet sa nezmení', () => {
    const world = built(newBareWorld(), DEPOT, 50, 24);
    const before = hashState(world.serialize());
    world.enqueue(commandFromJSON({ type: 'PlaceModule', defId: YARD, x: 50, y: 20, rotation: 0 }));
    expect(ofType(world.applyPending(), 'CommandRejected')).toEqual([{ type: 'CommandRejected', commandType: 'PlaceModule', reasons: ['connector_blocked'] }]);
    expect(hashState(world.serialize())).toBe(before);
  });
});

describe('PlaceModule — def, rotácia a peniaze', () => {
  it('neznámy def → unknown_def, bez buniek a ceny', () => {
    expect(place('no_such_module', 40, 14).validate(newBareWorld())).toEqual({ ok: false, reasons: ['unknown_def'], cells: [], costCents: 0 });
  });

  it.each([45, -90, 360, 90.5])('rotácia %d → invalid_rotation (bez buniek, cena defu ostáva)', (rotation) => {
    expect(place(BERTH, 40, 14, rotation).validate(newBareWorld())).toEqual({
      ok: false,
      reasons: ['invalid_rotation'],
      cells: [],
      costCents: BERTH_COST,
    });
  });

  it('neznámy def aj zlá rotácia naraz', () => {
    expect(place('nope', 0, 0, 1).validate(newBareWorld()).reasons).toEqual(['unknown_def', 'invalid_rotation']);
  });

  it('insufficient_funds len keď cena > hotovosť (hranica presne na cene prejde)', () => {
    const world = newBareWorld();
    setCash(world, BERTH_COST);
    expect(place(BERTH, 40, 14).validate(world).ok).toBe(true);
    setCash(world, BERTH_COST - 1);
    expect(place(BERTH, 40, 14).validate(world)).toEqual({
      ok: false,
      reasons: ['insufficient_funds'],
      cells: footprint(BERTH, 40, 14),
      costCents: BERTH_COST,
    });
    setCash(world, -1);
    expect(place(BERTH, 90, 14, 45).validate(world).reasons).toEqual(['insufficient_funds', 'invalid_rotation']);
  });

  it('všetky dôvody v kanonickom poradí VALIDATION_REASONS', () => {
    const world = newBareWorld();
    setCash(world, 0);
    expect(place(BERTH, 90, 20).validate(world).reasons).toEqual([
      'out_of_bounds',
      'terrain',
      'parcel_not_owned',
      'insufficient_funds',
      'no_water_side',
      'connector_blocked',
    ]);
  });

  it('bezplatný def (costCents 0): prejde aj pri dlhu a MoneyChanged sa neemituje', () => {
    const [berthJson] = modulesJson.items;
    const defs = DefRegistry.fromRaw({
      ...RAW_DEFS,
      modules: { ...modulesJson, items: [...modulesJson.items, { ...berthJson, id: 'berth_free_test', costCents: 0 }] },
    });
    const world = World.create(defs, newBareWorld().map, SEED);
    setCash(world, -500);
    const command = place('berth_free_test', 40, 14);
    expect(command.validate(world)).toMatchObject({ ok: true, costCents: 0 });
    command.apply(world);
    expect(world.cashCents).toBe(-500);
    expect(world.events.flush().map((e) => e.type)).toEqual(['ModulePlaced']);
    expect(world.modules.get(1 as never)?.purchaseCostCents).toBe(0);
  });
});

describe('PlaceModule — príkaz a svet', () => {
  it('validate nemení svet ani nespotrebuje id', () => {
    const world = built(newBareWorld(), BERTH, 40, 14);
    const before = hashState(world.serialize());
    for (const command of [place(BERTH, 48, 14), place(BERTH, 44, 14), place(CRANE, 43, 14), place(CRANE, 47, 14), place('x', 1, 1, 7)]) {
      command.validate(world);
    }
    expect(hashState(world.serialize())).toBe(before);
    expect(world.events.pending).toBe(0);
  });

  it('apply bez platnej validácie vyhodí Error a svet nezmení', () => {
    const world = built(newBareWorld(), BERTH, 40, 14);
    const before = hashState(world.serialize());
    expect(() => place(BERTH, 44, 14).apply(world)).toThrow(/PlaceModule\.apply: príkaz nie je platný \(occupied\)/);
    expect(() => place(BERTH, 48, 14, 45).apply(world)).toThrow(/invalid_rotation/);
    expect(hashState(world.serialize())).toBe(before);
  });

  it('cez frontu sveta: platný príkaz sa aplikuje, neplatný → CommandRejected so všetkými dôvodmi', () => {
    const world = newBareWorld();
    world.enqueue(commandFromJSON({ type: 'PlaceModule', defId: BERTH, x: 40, y: 14, rotation: 0 }));
    world.enqueue(commandFromJSON({ type: 'PlaceModule', defId: BERTH, x: 44, y: 14, rotation: 45 }));
    world.enqueue(commandFromJSON({ type: 'PlaceModule', defId: CRANE, x: 50, y: 14, rotation: 0 }));
    const events = world.applyPending();
    expect(ofType(events, 'ModulePlaced').map((e) => e.moduleId)).toEqual([1]);
    expect(ofType(events, 'CommandRejected')).toEqual([
      { type: 'CommandRejected', commandType: 'PlaceModule', reasons: ['invalid_rotation'] },
      { type: 'CommandRejected', commandType: 'PlaceModule', reasons: ['no_berth'] },
    ]);
    expect(world.modules.size).toBe(1);
    expect(world.cashCents).toBe(START_CASH - BERTH_COST);
  });

  it('replay: rovnaké príkazy → rovnaký stav (deterministické id, poradie, hotovosť)', () => {
    const run = (): string => {
      const world = newBareWorld();
      for (const json of [
        { type: 'PlaceModule', defId: BERTH, x: 40, y: 14, rotation: 0 },
        { type: 'PlaceModule', defId: CRANE, x: 43, y: 14, rotation: 0 },
        { type: 'PlaceModule', defId: BERTH, x: 48, y: 14, rotation: 0 },
      ]) {
        world.enqueue(commandFromJSON(json));
      }
      world.applyPending();
      return hashState(world.serialize());
    };
    expect(run()).toBe(run());
  });
});
