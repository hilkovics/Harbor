// CargoLocation a tabuľka povolených prechodov (ARCHITECTURE §7.1): dáta namiesto switch-ov, importné reťazce,
// `exported` ako konečný stav, opisy držiteľov a jediná brána `normalizeLocation`.
import { describe, expect, it } from 'vitest';
import {
  CARGO_HOLDER_KINDS,
  CARGO_HOLDER_SPECS,
  CARGO_LOCATION_KINDS,
  CARGO_SPAWN_KINDS,
  CARGO_TRANSITIONS,
  formatLocation,
  holderIdOf,
  isCargoLocationKind,
  isSameLocation,
  isTransitionAllowed,
  normalizeLocation,
  slotOf,
  uniqueSlotOf,
  type CargoLocation,
  type CargoLocationKind,
} from '@sim/cargo';
import { CONTAINER_CHAIN, LIQUID_CHAIN, RORO_CHAIN, SAMPLE_LOCATIONS, at } from './cargo-fixtures';

/** Očakávaná tabuľka prepísaná z §7.1 — zmena tabuľky v kóde musí byť vedomá (a zapísaná v ARCHITECTURE). */
const EXPECTED_TRANSITIONS: Readonly<Record<CargoLocationKind, readonly CargoLocationKind[]>> = {
  on_ship: ['in_crane', 'in_pipeline', 'in_vehicle'],
  in_crane: ['on_apron'],
  on_apron: ['in_vehicle'],
  in_vehicle: ['in_storage', 'at_ramp'],
  in_storage: ['in_vehicle', 'in_pipeline'],
  in_pipeline: ['in_storage', 'at_ramp'],
  at_ramp: ['in_truck', 'in_train'],
  in_truck: ['exported'],
  in_train: ['exported'],
  exported: [],
};

const kindsOf = (chain: readonly CargoLocation[]): CargoLocationKind[] => ['on_ship', ...chain.map((location) => location.kind)];

describe('CARGO_LOCATION_KINDS a CARGO_TRANSITIONS', () => {
  it('všetkých 10 druhov lokácií v poradí §7.1', () => {
    expect(CARGO_LOCATION_KINDS).toEqual([
      'on_ship',
      'in_crane',
      'on_apron',
      'in_vehicle',
      'in_storage',
      'in_pipeline',
      'at_ramp',
      'in_truck',
      'in_train',
      'exported',
    ]);
    expect(Object.isFrozen(CARGO_LOCATION_KINDS)).toBe(true);
  });

  it('tabuľka prechodov presne zodpovedá §7.1 (ReadonlyMap druh → zmrazené pole cieľov)', () => {
    expect(CARGO_TRANSITIONS).toBeInstanceOf(Map);
    expect([...CARGO_TRANSITIONS.keys()]).toEqual(CARGO_LOCATION_KINDS);
    expect(Object.fromEntries(CARGO_TRANSITIONS)).toEqual(EXPECTED_TRANSITIONS);
    for (const targets of CARGO_TRANSITIONS.values()) expect(Object.isFrozen(targets)).toBe(true);
  });

  it('exported je konečný stav bez výstupov; žiadny druh neprechádza sám do seba ani späť na loď', () => {
    expect(CARGO_TRANSITIONS.get('exported')).toEqual([]);
    for (const kind of CARGO_LOCATION_KINDS) {
      expect(isTransitionAllowed('exported', kind)).toBe(false);
      expect(isTransitionAllowed(kind, kind)).toBe(false);
      expect(isTransitionAllowed(kind, 'on_ship')).toBe(false);
    }
  });

  it('isTransitionAllowed je presne tabuľka (všetkých 100 dvojíc)', () => {
    for (const from of CARGO_LOCATION_KINDS) {
      for (const to of CARGO_LOCATION_KINDS) {
        expect(isTransitionAllowed(from, to), `${from} → ${to}`).toBe(EXPECTED_TRANSITIONS[from].includes(to));
      }
    }
  });

  it.each([
    ['container/bulk', CONTAINER_CHAIN],
    ['liquid/gas (in_pipeline, vlak)', LIQUID_CHAIN],
    ['RoRo (auto samo ako in_vehicle)', RORO_CHAIN],
  ])('importný reťazec %s je povolený krok po kroku', (_name, chain) => {
    const kinds = kindsOf(chain);
    for (let i = 1; i < kinds.length; i++) {
      expect(isTransitionAllowed(kinds[i - 1], kinds[i]), `${kinds[i - 1]} → ${kinds[i]}`).toBe(true);
    }
    expect(kinds.at(-1)).toBe('exported');
  });

  it.each<[CargoLocationKind, CargoLocationKind]>([
    ['on_ship', 'in_storage'],
    ['on_ship', 'on_apron'],
    ['on_ship', 'exported'],
    ['in_crane', 'in_vehicle'],
    ['in_crane', 'on_ship'],
    ['on_apron', 'in_storage'],
    ['on_apron', 'in_crane'],
    ['in_storage', 'at_ramp'],
    ['in_vehicle', 'exported'],
    ['at_ramp', 'exported'],
    ['in_truck', 'in_train'],
  ])('%s → %s nie je povolený (teleport cez vynechaný krok)', (from, to) => {
    expect(isTransitionAllowed(from, to)).toBe(false);
  });

  it('z lode je dosiahnuteľný každý druh a z každého druhu je dosiahnuteľný export (žiadna slepá ulička)', () => {
    const reachable = (start: CargoLocationKind): Set<CargoLocationKind> => {
      const seen = new Set<CargoLocationKind>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const kind = queue.shift() as CargoLocationKind;
        for (const next of CARGO_TRANSITIONS.get(kind) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return seen;
    };
    expect([...reachable('on_ship')].sort()).toEqual([...CARGO_LOCATION_KINDS].sort());
    for (const kind of CARGO_LOCATION_KINDS) expect(reachable(kind).has('exported'), kind).toBe(true);
  });

  it('neznámy druh nie je lokácia a nemá prechody', () => {
    expect(isCargoLocationKind('on_ship')).toBe(true);
    expect(isCargoLocationKind('in_warehouse')).toBe(false);
    expect(isCargoLocationKind(3)).toBe(false);
    expect(isCargoLocationKind(undefined)).toBe(false);
    expect(isTransitionAllowed('in_warehouse' as CargoLocationKind, 'in_crane')).toBe(false);
    expect(isTransitionAllowed('on_ship', 'in_warehouse' as CargoLocationKind)).toBe(false);
  });

  it('jednotka smie vzniknúť len na lodi (F2 = import)', () => {
    expect(CARGO_SPAWN_KINDS).toEqual(['on_ship']);
    expect(Object.isFrozen(CARGO_SPAWN_KINDS)).toBe(true);
  });
});

describe('CARGO_HOLDER_SPECS', () => {
  it('držiteľa majú všetky druhy okrem exported; kľúče zodpovedajú ukážkovým lokáciám', () => {
    expect(CARGO_HOLDER_KINDS).toEqual(CARGO_LOCATION_KINDS.filter((kind) => kind !== 'exported'));
    for (const kind of CARGO_HOLDER_KINDS) {
      const spec = CARGO_HOLDER_SPECS[kind];
      const expectedKeys = ['kind', spec.holderKey, ...(spec.slotKey === null ? [] : [spec.slotKey])];
      expect(Object.keys(SAMPLE_LOCATIONS[kind]).sort(), kind).toEqual(expectedKeys.sort());
    }
    expect(Object.isFrozen(CARGO_HOLDER_SPECS)).toBe(true);
  });

  it('jedinečné miesto majú len apron a sklad; dock rampy zdieľa viac jednotiek (§7.5, §7.7)', () => {
    const unique = CARGO_HOLDER_KINDS.filter((kind) => CARGO_HOLDER_SPECS[kind].uniqueSlot);
    expect(unique).toEqual(['on_apron', 'in_storage']);
    expect(CARGO_HOLDER_SPECS.at_ramp).toMatchObject({ slotKey: 'dock', uniqueSlot: false });
  });

  it('loď vydáva od najmenšieho id, ostatní držitelia vo FIFO', () => {
    for (const kind of CARGO_HOLDER_KINDS) {
      expect(CARGO_HOLDER_SPECS[kind].order, kind).toBe(kind === 'on_ship' ? 'id' : 'arrival');
    }
  });
});

describe('holderIdOf, slotOf, uniqueSlotOf, formatLocation', () => {
  it.each<[CargoLocationKind, number | null, number | null, number | null, string]>([
    ['on_ship', 900, null, null, 'on_ship(shipId=900)'],
    ['in_crane', 901, null, null, 'in_crane(craneId=901)'],
    ['on_apron', 902, 1, 1, 'on_apron(berthId=902, slot=1)'],
    ['in_vehicle', 903, null, null, 'in_vehicle(vehicleId=903)'],
    ['in_storage', 904, 7, 7, 'in_storage(moduleId=904, slot=7)'],
    ['in_pipeline', 905, null, null, 'in_pipeline(pipelineId=905)'],
    ['at_ramp', 906, 2, null, 'at_ramp(rampId=906, dock=2)'],
    ['in_truck', 907, null, null, 'in_truck(truckId=907)'],
    ['in_train', 908, null, null, 'in_train(trainId=908)'],
    ['exported', null, null, null, 'exported'],
  ])('%s: držiteľ %s, miesto %s, jedinečné miesto %s, opis %s', (kind, holder, slot, unique, text) => {
    const location = SAMPLE_LOCATIONS[kind];
    expect(holderIdOf(location)).toBe(holder);
    expect(slotOf(location)).toBe(slot);
    expect(uniqueSlotOf(location)).toBe(unique);
    expect(formatLocation(location)).toBe(text);
  });
});

describe('isSameLocation (T03-05)', () => {
  it('rovnaký druh, držiteľ aj miesto → true; iné miesto, držiteľ alebo druh → false; kópia s iným poradím kľúčov → true', () => {
    expect(isSameLocation(at.apron(902, 1), at.apron(902, 1))).toBe(true);
    expect(isSameLocation(at.apron(902, 1), { slot: 1, berthId: 902, kind: 'on_apron' } as CargoLocation)).toBe(true);
    expect(isSameLocation(at.apron(902, 1), at.apron(902, 2))).toBe(false);
    expect(isSameLocation(at.apron(902, 1), at.apron(903, 1))).toBe(false);
    expect(isSameLocation(at.vehicle(902), at.crane(902))).toBe(false);
    expect(isSameLocation({ kind: 'exported' }, { kind: 'exported' })).toBe(true);
    for (const kind of CARGO_LOCATION_KINDS) expect(isSameLocation(SAMPLE_LOCATIONS[kind], SAMPLE_LOCATIONS[kind]), kind).toBe(true);
  });
});

describe('normalizeLocation', () => {
  it.each(CARGO_LOCATION_KINDS)('%s: platná lokácia → zmrazená kópia rovnaká ako vstup', (kind) => {
    const input = SAMPLE_LOCATIONS[kind];
    const result = normalizeLocation(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.location).toEqual(input);
    expect(result.location).not.toBe(input);
    expect(Object.isFrozen(result.location)).toBe(true);
  });

  it('kanonické poradie kľúčov kind, držiteľ, miesto (deterministický JSON) aj pri inom poradí vstupu', () => {
    const result = normalizeLocation({ slot: 3, berthId: 12, kind: 'on_apron' });
    expect(result.ok && JSON.stringify(result.location)).toBe('{"kind":"on_apron","berthId":12,"slot":3}');
  });

  it('miesto 0 je platné (sloty sa číslujú od 0)', () => {
    expect(normalizeLocation(at.apron(1, 0)).ok).toBe(true);
    expect(normalizeLocation(at.ramp(1, 0)).ok).toBe(true);
  });

  it.each<[string, string, unknown, RegExp]>([
    ['null', '', null, /objekt.*null/],
    ['pole', '', [], /objekt.*pole/],
    ['číslo', '', 5, /objekt.*5/],
    ['chýba kind', '/kind', { shipId: 1 }, /neznámy druh.*undefined/],
    ['neznámy kind', '/kind', { kind: 'in_warehouse', moduleId: 1 }, /neznámy druh lokácie "in_warehouse".*on_ship/],
    ['kľúč iného druhu', '/craneId', { kind: 'on_ship', craneId: 1 }, /neznámy kľúč.*on_ship.*shipId/],
    ['exported s držiteľom', '/truckId', { kind: 'exported', truckId: 4 }, /neznámy kľúč.*exported/],
    ['chýba držiteľ', '/craneId', { kind: 'in_crane' }, /chýba povinný kľúč.*in_crane/],
    ['chýba miesto', '/slot', { kind: 'on_apron', berthId: 2 }, /chýba povinný kľúč.*on_apron/],
    ['držiteľ 0', '/shipId', { kind: 'on_ship', shipId: 0 }, /celé číslo ≥ 1.*0/],
    ['držiteľ záporný', '/truckId', { kind: 'in_truck', truckId: -3 }, /celé číslo ≥ 1.*-3/],
    ['držiteľ necelý', '/trainId', { kind: 'in_train', trainId: 1.5 }, /celé číslo ≥ 1.*1\.5/],
    ['držiteľ reťazec', '/shipId', { kind: 'on_ship', shipId: '3' }, /celé číslo ≥ 1.*"3"/],
    ['miesto záporné', '/slot', { kind: 'in_storage', moduleId: 4, slot: -1 }, /celé číslo ≥ 0.*-1/],
    ['miesto necelé', '/dock', { kind: 'at_ramp', rampId: 4, dock: 0.5 }, /celé číslo ≥ 0.*0\.5/],
    ['miesto NaN', '/slot', { kind: 'on_apron', berthId: 4, slot: Number.NaN }, /celé číslo ≥ 0.*NaN/],
  ])("%s → problém na '%s'", (_name, path, raw, problem) => {
    const result = normalizeLocation(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.path).toBe(path);
    expect(result.problem).toMatch(problem);
  });
});
