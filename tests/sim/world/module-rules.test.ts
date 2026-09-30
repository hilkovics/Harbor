// Pravidlá umiestnenia a odstránenia modulov (T02-04, ARCHITECTURE §8, ADR-015): findPlacementViolations vráti všetky
// porušené pravidlá naraz v poradí PLACEMENT_RULES, štrukturálny rozsah je presne to, čo stráži World.addModule,
// a findRemovalViolations zdieľa World.removeModule aj RemoveModule.validate.
//
// harbor_01 (BARE_MAP bez Root modulu): voda y ≤ 13, nábrežie y 14–16 x 10–85, pevnina y ≥ 17; parcela starter
// x 30–57 y 14–33 (vlastnená), west_quay x 6–27 a east_yard x 60–87 (na predaj), x 28–29 verejné.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { Rotation } from '@sim/grid';
import { BerthModule, CraneModule } from '@sim/modules';
import {
  PLACEMENT_RULES,
  PLACEMENT_RULE_ERROR,
  World,
  attachesToHost,
  findPlacementViolations,
  findRemovalViolations,
  type PlacementRule,
  type PlacementScope,
} from '@sim/world';
import { BERTH, CRANE, MODULE_DEFS, NARROW_CRANE } from '../modules/module-fixtures';
import { BARE_MAP, SEED, hashState } from './world-fixtures';
import { PIER_MAP } from './pier-map';
import { driveCrane, restoreCrane } from '../helpers/crane-state';

const id = (value: number): EntityId => value as EntityId;

function bareWorld(): World {
  return World.create(MODULE_DEFS, BARE_MAP, SEED);
}

function pierWorld(): World {
  return World.create(MODULE_DEFS, PIER_MAP, SEED);
}

/** Pravidlá porušené umiestnením `defId` na (x, y, rot). */
function rules(world: World, defId: string, x: number, y: number, rotation: Rotation = 0, scope: PlacementScope = 'all'): PlacementRule[] {
  return findPlacementViolations(world, MODULE_DEFS.modules.get(defId), { x, y, rotation }, scope).map((v) => v.rule);
}

function build(world: World, defId: string, x: number, y: number, rotation: Rotation = 0) {
  expect(rules(world, defId, x, y, rotation)).toEqual([]);
  return world.placeModule({ defId, x, y, rotation }, 0);
}

describe('tabuľky pravidiel', () => {
  it('štrukturálne pravidlá (ModuleError vo World.addModule) vs pravidlá hráča', () => {
    const structural = PLACEMENT_RULES.filter((rule) => PLACEMENT_RULE_ERROR[rule] !== null);
    expect(structural).toEqual(['out_of_bounds', 'occupied', 'road', 'no_berth', 'rotation_mismatch', 'max_cranes', 'crane_overlap']);
    for (const rule of structural) expect(PLACEMENT_RULE_ERROR[rule]).toBe(rule);
  });

  it('attachesToHost podľa placement.mustAttachTo (žeriav áno, kotvisko nie)', () => {
    expect(attachesToHost(MODULE_DEFS.modules.get(CRANE))).toBe(true);
    expect(attachesToHost(MODULE_DEFS.modules.get(BERTH))).toBe(false);
  });
});

describe('findPlacementViolations — kotvisko na harbor_01', () => {
  it('Root pozícia (40, 14) rot 0 je platná', () => {
    expect(rules(bareWorld(), BERTH, 40, 14)).toEqual([]);
  });

  it.each<[string, number, number, Rotation, PlacementRule[]]>([
    ['na vode (y 10–12, mimo parcely)', 40, 10, 0, ['terrain', 'parcel_not_owned']],
    ['vnútrozemie (pevnina, hrana nesusedí s vodou)', 40, 20, 0, ['terrain', 'no_water_side']],
    ['o riadok nižšie: hrana y 15 susedí s nábrežím, spodok na pevnine', 40, 15, 0, ['terrain', 'no_water_side']],
    ['otočené o 180° (voda na juhu = pevnina)', 40, 14, 180, ['no_water_side']],
    ['otočené o 90° (3×8 sa na nábrežie nezmestí)', 40, 14, 90, ['terrain', 'no_water_side']],
    ['cudzia parcela west_quay (na predaj)', 12, 14, 0, ['parcel_not_owned']],
    ['cez verejné bunky x 28–29 a cudziu parcelu', 24, 14, 0, ['parcel_not_owned']],
    ['presah mimo mapy: všetky dôvody naraz, bunky mimo mapy len out_of_bounds', 90, 14, 0, ['out_of_bounds', 'terrain', 'parcel_not_owned', 'no_water_side']],
    ['celé mimo mapy', -20, -20, 0, ['out_of_bounds']],
  ])('%s → %j', (_name, x, y, rotation, expected) => {
    expect(rules(bareWorld(), BERTH, x, y, rotation)).toEqual(expected);
  });

  it('prenajatá parcela je rovnako platná ako vlastnená', () => {
    const world = bareWorld();
    const parcel = world.parcels.get('west_quay');
    if (parcel === undefined) throw new Error('chýba west_quay');
    parcel.ownership = 'leased';
    expect(rules(world, BERTH, 12, 14)).toEqual([]);
  });

  it('prekryv s iným kotviskom → occupied; susedné kotvisko (pásy vedľa seba) je platné', () => {
    const world = bareWorld();
    build(world, BERTH, 40, 14);
    expect(rules(world, BERTH, 44, 14)).toEqual(['occupied']);
    expect(rules(world, BERTH, 48, 14)).toEqual([]);
    expect(rules(world, BERTH, 32, 14)).toEqual([]);
  });

  it('cesta vo footprinte → road (štrukturálne pravidlo)', () => {
    const world = bareWorld();
    world.grid.at(45, 16).road = 'road';
    expect(rules(world, BERTH, 40, 14)).toEqual(['road']);
    world.grid.at(45, 16).road = 'rail';
    expect(rules(world, BERTH, 40, 14, 0, 'structural')).toEqual(['road']);
  });

  it('pás vody zasahuje do footprintu modulu → water_blocked (umelý stav: modul na vode)', () => {
    const world = bareWorld();
    world.grid.at(41, 12).moduleId = id(99);
    expect(rules(world, BERTH, 40, 14)).toEqual(['water_blocked']);
  });

  it('štrukturálny rozsah ignoruje terén, parcelu a vodu', () => {
    const world = bareWorld();
    expect(rules(world, BERTH, 40, 10, 0, 'structural')).toEqual([]);
    expect(rules(world, BERTH, 12, 14, 0, 'structural')).toEqual([]);
    expect(rules(world, BERTH, 90, 14, 0, 'structural')).toEqual(['out_of_bounds']);
  });

  it('popis porušenia pomenuje bunku', () => {
    const [violation] = findPlacementViolations(bareWorld(), MODULE_DEFS.modules.get(BERTH), { x: 12, y: 14, rotation: 0 });
    expect(violation).toEqual({ rule: 'parcel_not_owned', detail: 'bunka (12, 14) nie je na vlastnej ani prenajatej parcele' });
  });

  it('svet nemení (ani pri porušeniach)', () => {
    const world = bareWorld();
    build(world, BERTH, 40, 14);
    const before = hashState(world.serialize());
    for (const [x, y] of [[44, 14], [90, 14], [40, 10], [12, 14]]) rules(world, BERTH, x, y);
    rules(world, CRANE, 47, 14);
    expect(hashState(world.serialize())).toBe(before);
    expect(world.events.pending).toBe(0);
  });
});

describe('findPlacementViolations — pás vody (syntetická mapa pier_test)', () => {
  it('kotviská rôznych orientácií na móle a nábreží sú samostatne platné', () => {
    const world = pierWorld();
    expect(rules(world, BERTH, 10, 10, 0)).toEqual([]);
    expect(rules(world, BERTH, 5, 2, 90)).toEqual([]);
    expect(rules(world, BERTH, 5, 2, 270)).toEqual([]);
  });

  it('pás kotviska s inou waterSide pretína pás existujúceho → water_blocked (v oboch poradiach)', () => {
    const northFirst = pierWorld();
    build(northFirst, BERTH, 10, 10, 0);
    expect(rules(northFirst, BERTH, 5, 2, 90)).toEqual(['water_blocked']);
    expect(rules(northFirst, BERTH, 5, 2, 270)).toEqual([]); // pás na západ (x 2–4) sa nepretína

    const eastFirst = pierWorld();
    build(eastFirst, BERTH, 5, 2, 90);
    expect(rules(eastFirst, BERTH, 10, 10, 0)).toEqual(['water_blocked']);
  });

  it('bunka pásu nie je voda (ostrovček nábrežia) → water_blocked', () => {
    const [violation] = findPlacementViolations(pierWorld(), MODULE_DEFS.modules.get(BERTH), { x: 22, y: 10, rotation: 0 });
    expect(violation?.rule).toBe('water_blocked');
    expect(violation?.detail).toMatch(/\(24, 8\) nie je voda/);
  });

  it('pás siaha za okraj mapy → water_blocked; hrana priamo pri okraji → no_water_side', () => {
    const world = pierWorld();
    expect(rules(world, BERTH, 36, 2, 90)).toEqual(['water_blocked']);
    const [violation] = findPlacementViolations(world, MODULE_DEFS.modules.get(BERTH), { x: 36, y: 2, rotation: 90 });
    expect(violation?.detail).toMatch(/\(40, 2\) je mimo mapy/);
  });

  it('BerthModule.frontWaterBand = pás, ktorý pravidlo kontroluje', () => {
    const world = pierWorld();
    const berth = build(world, BERTH, 5, 2, 90);
    if (!(berth instanceof BerthModule)) throw new Error('nie je berth');
    expect(berth.waterSide).toBe('e');
    expect(berth.frontWaterBand).toHaveLength(8 * 3);
    expect(berth.frontWaterBand.slice(0, 2)).toEqual([{ x: 8, y: 2 }, { x: 8, y: 3 }]);
    expect(berth.frontWaterBand.at(-1)).toEqual({ x: 10, y: 9 });
  });
});

describe('findPlacementViolations — žeriav (mustAttachTo berth, ADR-014)', () => {
  function withBerth(): World {
    const world = bareWorld();
    build(world, BERTH, 40, 14);
    return world;
  }

  it('na berthe s rovnakou rotáciou je platný (bunky patria berthu, occupied sa nehlási)', () => {
    expect(rules(withBerth(), CRANE, 43, 14)).toEqual([]);
  });

  it.each<[string, number, number, Rotation, PlacementRule[]]>([
    ['na holom nábreží', 50, 14, 0, ['no_berth']],
    ['na pevnine', 43, 20, 0, ['terrain', 'no_berth']],
    ['presahuje berth (x 47–48)', 47, 14, 0, ['no_berth']],
    ['iná rotácia', 41, 14, 90, ['rotation_mismatch']],
    ['mimo mapy', 95, 14, 0, ['out_of_bounds', 'terrain', 'parcel_not_owned', 'no_berth']],
  ])('%s → %j', (_name, x, y, rotation, expected) => {
    expect(rules(withBerth(), CRANE, x, y, rotation)).toEqual(expected);
  });

  it('cez dva susedné berthy → no_berth (rôzne moduly)', () => {
    const world = withBerth();
    build(world, BERTH, 48, 14);
    const [violation] = findPlacementViolations(world, MODULE_DEFS.modules.get(CRANE), { x: 47, y: 14, rotation: 0 });
    expect(violation).toEqual({ rule: 'no_berth', detail: 'bunky ležia na rôznych moduloch #1 a #2' });
  });

  it('prekryv s iným žeriavom → crane_overlap; tretí žeriav → max_cranes', () => {
    const world = withBerth();
    build(world, CRANE, 43, 14);
    expect(rules(world, CRANE, 44, 14)).toEqual(['crane_overlap']);
    build(world, CRANE, 45, 14);
    expect(rules(world, CRANE, 40, 14)).toEqual(['max_cranes']);
    expect(rules(world, NARROW_CRANE, 47, 14)).toEqual(['max_cranes']);
    expect(rules(world, CRANE, 44, 14)).toEqual(['max_cranes', 'crane_overlap']);
  });

  it('štrukturálny rozsah = kódy ModuleError, ktoré World.addModule hlási', () => {
    const world = withBerth();
    expect(rules(world, CRANE, 43, 20, 0, 'structural')).toEqual(['no_berth']);
    expect(rules(world, CRANE, 41, 14, 90, 'structural')).toEqual(['rotation_mismatch']);
  });
});

describe('findRemovalViolations', () => {
  function harbor(): { world: World; berth: BerthModule; crane: CraneModule } {
    const world = bareWorld();
    const berth = build(world, BERTH, 40, 14);
    const crane = build(world, CRANE, 43, 14);
    if (!(berth instanceof BerthModule) || !(crane instanceof CraneModule)) throw new Error('zlé triedy');
    return { world, berth, crane };
  }

  it('voľný žeriav aj berth bez žeriavov idú odstrániť', () => {
    const { world, berth, crane } = harbor();
    expect(findRemovalViolations(world, crane)).toEqual([]);
    world.removeModule(crane.id);
    expect(findRemovalViolations(world, berth)).toEqual([]);
  });

  it('berth so žeriavom, loďou a rezervovaným slotom → všetky dôvody naraz v poradí REMOVAL_RULES', () => {
    const { world, berth } = harbor();
    berth.dockedShipId = id(77);
    berth.apron.reserve();
    expect(findRemovalViolations(world, berth).map((v) => v.rule)).toEqual(['has_cargo', 'has_cranes', 'ship_docked']);
  });

  it('žeriav na kotvisku, ktoré drží loď (dockedShipId) → ship_docked s popisom kotviska (T02-14)', () => {
    const { world, berth, crane } = harbor();
    berth.dockedShipId = id(77);
    expect(findRemovalViolations(world, crane)).toEqual([
      { rule: 'ship_docked', detail: `${crane.label} stojí na ${berth.label}, ktoré drží loď #77` },
    ]);
    berth.dockedShipId = null;
    expect(findRemovalViolations(world, crane)).toEqual([]);
  });

  it('žeriav s jednotkou uprostred cyklu → has_cargo aj busy', () => {
    const { world, berth, crane } = harbor();
    const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: id(500) }).id;
    world.cargo.move(unit, { kind: 'in_crane', craneId: crane.id });
    restoreCrane(crane, { state: 'placing', reservedSlot: berth.apron.reserve(), phaseTicksTotal: 6, phaseTicksLeft: 3 });
    crane.heldUnitId = unit;
    expect(findRemovalViolations(world, crane)).toEqual([
      { rule: 'has_cargo', detail: `${crane.label} drží náklad (in_crane)` },
      { rule: 'busy', detail: `${crane.label} je uprostred cyklu (placing)` },
    ]);
  });

  it('blokovaný žeriav bez jednotky nie je busy', () => {
    const { world, crane } = harbor();
    driveCrane(crane, 'blocked');
    expect(findRemovalViolations(world, crane)).toEqual([]);
  });
});
