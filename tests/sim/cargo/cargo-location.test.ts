// CargoLocation a tabuľka povolených prechodov (ARCHITECTURE §7.1): dáta namiesto switch-ov, importné aj exportné
// reťazce (ADR-032), `exported` a `shipped` ako konečné stavy, opisy držiteľov a jediná brána `normalizeLocation`.
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
import { CONTAINER_CHAIN, EXPORT_CHAIN, LAST_MINUTE_CHAIN, LIQUID_CHAIN, RORO_CHAIN, RTG_DISCHARGE_CHAIN, RTG_LOAD_CHAIN, SAMPLE_LOCATIONS, UNDER_HOOK_EXPORT_CHAIN, UNDER_HOOK_IMPORT_CHAIN, at } from './cargo-fixtures';

/** Očakávaná tabuľka prepísaná z §7.1 a ADR-032 — zmena tabuľky v kóde musí byť vedomá (a zapísaná v ARCHITECTURE). */
const EXPECTED_TRANSITIONS: Readonly<Record<CargoLocationKind, readonly CargoLocationKind[]>> = {
  on_ship: ['in_crane', 'in_pipeline', 'in_vehicle', 'shipped'],
  in_crane: ['on_apron', 'on_ship', 'in_vehicle'],
  on_apron: ['in_vehicle', 'in_crane'],
  in_vehicle: ['in_storage', 'at_ramp', 'on_apron', 'in_crane', 'in_handler'],
  in_handler: ['in_storage', 'in_vehicle'],
  in_storage: ['in_vehicle', 'in_pipeline', 'in_handler'],
  in_pipeline: ['in_storage', 'at_ramp'],
  at_ramp: ['in_truck', 'in_train', 'in_vehicle'],
  in_truck: ['exported', 'at_ramp'],
  in_train: ['exported'],
  exported: [],
  shipped: [],
};

const TERMINAL: readonly CargoLocationKind[] = ['exported', 'shipped'];

const kindsOf = (chain: readonly CargoLocation[]): CargoLocationKind[] => ['on_ship', ...chain.map((location) => location.kind)];

describe('CARGO_LOCATION_KINDS a CARGO_TRANSITIONS', () => {
  it('všetkých 12 druhov lokácií v poradí §7.1 (ADR-032 pridal shipped, ADR-040 in_handler)', () => {
    expect(CARGO_LOCATION_KINDS).toEqual([
      'on_ship',
      'in_crane',
      'on_apron',
      'in_vehicle',
      'in_handler',
      'in_storage',
      'in_pipeline',
      'at_ramp',
      'in_truck',
      'in_train',
      'exported',
      'shipped',
    ]);
    expect(Object.isFrozen(CARGO_LOCATION_KINDS)).toBe(true);
  });

  it('tabuľka prechodov presne zodpovedá §7.1 (ReadonlyMap druh → zmrazené pole cieľov)', () => {
    expect(CARGO_TRANSITIONS).toBeInstanceOf(Map);
    expect([...CARGO_TRANSITIONS.keys()]).toEqual(CARGO_LOCATION_KINDS);
    expect(Object.fromEntries(CARGO_TRANSITIONS)).toEqual(EXPECTED_TRANSITIONS);
    for (const targets of CARGO_TRANSITIONS.values()) expect(Object.isFrozen(targets)).toBe(true);
  });

  it('exported a shipped sú konečné stavy bez výstupov; žiadny druh neprechádza sám do seba; na loď len zo žeriavu', () => {
    for (const terminal of TERMINAL) expect(CARGO_TRANSITIONS.get(terminal)).toEqual([]);
    for (const kind of CARGO_LOCATION_KINDS) {
      for (const terminal of TERMINAL) expect(isTransitionAllowed(terminal, kind)).toBe(false);
      expect(isTransitionAllowed(kind, kind)).toBe(false);
      expect(isTransitionAllowed(kind, 'on_ship'), kind).toBe(kind === 'in_crane');
      expect(isTransitionAllowed(kind, 'shipped'), kind).toBe(kind === 'on_ship');
    }
  });

  it('isTransitionAllowed je presne tabuľka (všetkých 121 dvojíc)', () => {
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

  it.each([
    ['export (kamión → rampa → sklad → apron → žeriav → loď → shipped)', EXPORT_CHAIN],
    ['last minute (rampa → apron bez skladu)', LAST_MINUTE_CHAIN],
  ])('exportný reťazec %s je povolený krok po kroku (ADR-032 bod 3)', (_name, chain) => {
    const kinds: CargoLocationKind[] = ['in_truck', ...chain.map((location) => location.kind)];
    for (let i = 1; i < kinds.length; i++) {
      expect(isTransitionAllowed(kinds[i - 1], kinds[i]), `${kinds[i - 1]} → ${kinds[i]}`).toBe(true);
    }
    expect(kinds.at(-1)).toBe('shipped');
  });

  it.each([
    ['import pod hákom (on_ship → in_crane → in_vehicle → in_storage …)', UNDER_HOOK_IMPORT_CHAIN, 'on_ship', 'exported'],
    ['export pod hákom (… in_storage → in_vehicle → in_crane → on_ship → shipped)', UNDER_HOOK_EXPORT_CHAIN, 'in_truck', 'shipped'],
  ] as const)('reťazec %s je povolený krok po kroku (ADR-033)', (_name, chain, first, last) => {
    const kinds: CargoLocationKind[] = [first, ...chain.map((location) => location.kind)];
    for (let i = 1; i < kinds.length; i++) {
      expect(isTransitionAllowed(kinds[i - 1], kinds[i]), `${kinds[i - 1]} → ${kinds[i]}`).toBe(true);
    }
    expect(kinds.at(-1)).toBe(last);
  });

  it.each([
    ['vykládka cez RTG (on_ship → in_crane → in_vehicle → in_handler → in_storage)', RTG_DISCHARGE_CHAIN, 'on_ship'],
    ['nakládka cez RTG (in_storage → in_handler → in_vehicle → in_crane → on_ship → shipped)', RTG_LOAD_CHAIN, 'in_storage'],
  ] as const)('reťazec %s je povolený krok po kroku (ADR-040)', (_name, chain, first) => {
    const kinds: CargoLocationKind[] = [first, ...chain.map((location) => location.kind)];
    for (let i = 1; i < kinds.length; i++) {
      expect(isTransitionAllowed(kinds[i - 1], kinds[i]), `${kinds[i - 1]} → ${kinds[i]}`).toBe(true);
    }
  });

  it('in_handler je prechodová poloha: len in_vehicle ↔ in_handler ↔ in_storage, ťahač ani stoh sa nepreskočí', () => {
    expect([...(CARGO_TRANSITIONS.get('in_handler') ?? [])].sort()).toEqual(['in_storage', 'in_vehicle']);
    expect(holderIdOf(at.handler(95))).toBe(95);
    expect(slotOf(at.handler(95))).toBeNull();
    for (const [from, to] of [['in_handler', 'in_crane'], ['in_handler', 'on_apron'], ['in_handler', 'at_ramp'], ['on_apron', 'in_handler'], ['in_crane', 'in_handler'], ['in_handler', 'in_handler']] as const) {
      expect(isTransitionAllowed(from, to), `${from} → ${to}`).toBe(false);
    }
    expect(normalizeLocation({ kind: 'in_handler', machineId: 7 })).toEqual({ ok: true, location: { kind: 'in_handler', machineId: 7 } });
    expect(normalizeLocation({ kind: 'in_handler', machineId: 0 }).ok).toBe(false);
    expect(normalizeLocation({ kind: 'in_handler', vehicleId: 7 }).ok).toBe(false);
  });

  it.each<[CargoLocationKind, CargoLocationKind]>([
    ['on_ship', 'in_storage'],
    ['on_ship', 'on_apron'],
    ['on_ship', 'exported'],
    ['in_crane', 'in_storage'],
    ['in_crane', 'at_ramp'],
    ['in_crane', 'shipped'],
    ['on_apron', 'in_storage'],
    ['on_apron', 'on_ship'],
    ['in_storage', 'at_ramp'],
    ['in_storage', 'on_apron'],
    ['in_vehicle', 'exported'],
    ['in_vehicle', 'on_ship'],
    ['in_storage', 'in_crane'],
    ['at_ramp', 'in_crane'],
    ['at_ramp', 'exported'],
    ['at_ramp', 'in_storage'],
    ['in_truck', 'in_train'],
    ['in_truck', 'in_storage'],
    ['in_truck', 'shipped'],
  ])('%s → %s nie je povolený (teleport cez vynechaný krok)', (from, to) => {
    expect(isTransitionAllowed(from, to)).toBe(false);
  });

  it('z lode je dosiahnuteľný každý druh; z každého druhu s držiteľom export po súši a okrem vlaku aj loď (žiadna slepá ulička)', () => {
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
    for (const kind of CARGO_HOLDER_KINDS) {
      expect(reachable(kind).has('exported'), kind).toBe(true);
      expect(reachable(kind).has('shipped'), kind).toBe(kind !== 'in_train');
    }
  });

  it('neznámy druh nie je lokácia a nemá prechody', () => {
    expect(isCargoLocationKind('on_ship')).toBe(true);
    expect(isCargoLocationKind('in_warehouse')).toBe(false);
    expect(isCargoLocationKind(3)).toBe(false);
    expect(isCargoLocationKind(undefined)).toBe(false);
    expect(isTransitionAllowed('in_warehouse' as CargoLocationKind, 'in_crane')).toBe(false);
    expect(isTransitionAllowed('on_ship', 'in_warehouse' as CargoLocationKind)).toBe(false);
  });

  it('jednotka smie vzniknúť na lodi (import) a v kamióne (export, ADR-032)', () => {
    expect(CARGO_SPAWN_KINDS).toEqual(['on_ship', 'in_truck']);
    expect(Object.isFrozen(CARGO_SPAWN_KINDS)).toBe(true);
  });
});

describe('CARGO_HOLDER_SPECS', () => {
  it('držiteľa majú všetky druhy okrem konečných (exported, shipped); kľúče zodpovedajú ukážkovým lokáciám', () => {
    expect(CARGO_HOLDER_KINDS).toEqual(CARGO_LOCATION_KINDS.filter((kind) => !TERMINAL.includes(kind)));
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
    ['shipped', null, null, null, 'shipped'],
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
    ['shipped s držiteľom', '/shipId', { kind: 'shipped', shipId: 4 }, /neznámy kľúč.*shipped/],
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
