import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import cargoTypesJson from '@data/defs/cargo_types.json';
import contractTemplatesJson from '@data/defs/contract_templates.json';
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import linesJson from '@data/defs/lines.json';
import containerTypesJson from '@data/defs/container_types.json';
import logisticsJson from '@data/defs/logistics.json';
import modulesJson from '@data/defs/modules.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import trucksJson from '@data/defs/trucks.json';
import vehiclesJson from '@data/defs/vehicles.json';
import economySchema from '@data/schemas/economy.schema.json';
import infrastructureSchema from '@data/schemas/infrastructure.schema.json';
import logisticsSchema from '@data/schemas/logistics.schema.json';
import timeSchema from '@data/schemas/time.schema.json';
import { SimClock } from '@sim/core/sim-clock';
import { DefError, DefRegistry, SUPPORTED_SCHEMA_VERSION, loadBundledDefs } from '@sim/defs';
import { checkNumber } from '@sim/defs/def-spec';

type DefName = 'time' | 'economy' | 'infrastructure' | 'logistics';

interface RawBundle {
  container_types: Record<string, unknown>;
  time: Record<string, unknown>;
  economy: Record<string, unknown>;
  infrastructure: Record<string, unknown>;
  cargo_types: Record<string, unknown>;
  modules: Record<string, unknown>;
  ships: Record<string, unknown>;
  vehicles: Record<string, unknown>;
  trucks: Record<string, unknown>;
  logistics: Record<string, unknown>;
  contract_templates: Record<string, unknown>;
  lines: Record<string, unknown>;
}

/** Čerstvá hlboká kópia bundled defov; negatívne testy z nej upravia jedno pole. */
function rawDefs(): RawBundle {
  return {
    time: structuredClone(timeJson),
    economy: structuredClone(economyJson),
    infrastructure: structuredClone(infrastructureJson),
    cargo_types: structuredClone(cargoTypesJson),
    modules: structuredClone(modulesJson),
    ships: structuredClone(shipsJson),
    vehicles: structuredClone(vehiclesJson),
    trucks: structuredClone(trucksJson),
    logistics: structuredClone(logisticsJson),
    contract_templates: structuredClone(contractTemplatesJson),
    lines: structuredClone(linesJson),
    container_types: structuredClone(containerTypesJson),
  };
}

/** Nastaví hodnotu na JSON pointeri (`/speeds/1`) v klonovanom deffe. */
function setAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.slice(1).split('/');
  const last = segments.pop() as string;
  let target = root;
  for (const segment of segments) target = target[segment] as Record<string, unknown>;
  target[last] = value;
}

/** Overí, že `fn` hodí `DefError` s daným defom a cestou (a správou `<defName><path>: …`). */
function expectDefError(fn: () => unknown, defName: string, path: string): DefError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DefError);
  const error = caught as DefError;
  expect(error).toBeInstanceOf(Error);
  expect(error.defName).toBe(defName);
  expect(error.path).toBe(path);
  expect(error.message.startsWith(`${defName}${path}: `)).toBe(true);
  return error;
}

describe('DefRegistry.fromRaw', () => {
  it('platné defy → register s typovanými getterami', () => {
    const registry = DefRegistry.fromRaw(rawDefs());
    expect(registry.time.tickGameSeconds).toBe(timeJson.tickGameSeconds);
    expect(registry.economy.startingCashCents).toBe(economyJson.startingCashCents);
    expect(registry.infrastructure.road.costPerCellCents).toBe(infrastructureJson.road.costPerCellCents);
    expect(registry.logistics.repathIntervalTicks).toBe(logisticsJson.repathIntervalTicks);
    expect(registry.vehicles.get('straddle_carrier').speedCellsPerTick).toBe(0.4);
    expect(registry.trucks.get('truck_container').speedCellsPerTick).toBe(0.6);
  });

  describe('chýbajúci def → DefError s názvom defu', () => {
    it.each(['time', 'economy', 'infrastructure', 'cargo_types', 'modules', 'ships', 'vehicles', 'trucks', 'logistics'] as const)('%s', (name) => {
      const raw: Partial<ReturnType<typeof rawDefs>> = rawDefs();
      delete raw[name];
      const error = expectDefError(() => DefRegistry.fromRaw(raw), name, '');
      expect(error.message).toContain(name);
    });

    it('def explicitne undefined alebo null', () => {
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), time: undefined }), 'time', '');
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), economy: null }), 'economy', '');
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), infrastructure: undefined }), 'infrastructure', '');
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), modules: undefined }), 'modules', '');
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), ships: null }), 'ships', '');
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), vehicles: undefined }), 'vehicles', '');
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), trucks: undefined }), 'trucks', '');
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), logistics: null }), 'logistics', '');
    });

    it.each([[[]], ['{}'], [42]] as unknown[][])('def nie je objekt (%j)', (value) => {
      expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), time: value }), 'time', '');
    });
  });

  describe('zlý typ alebo rozsah poľa → DefError s cestou', () => {
    const cases: readonly (readonly [def: DefName, path: string, value: unknown])[] = [
      ['time', '/tickGameSeconds', '10'],
      ['time', '/tickGameSeconds', 10.5],
      ['time', '/tickGameSeconds', 0],
      ['time', '/tickGameSeconds', null],
      ['time', '/tickGameSeconds', 7],
      ['time', '/tickGameSeconds', 120],
      ['time', '/tickGameSeconds', -10],
      ['time', '/ticksPerRealSecond', 0],
      ['time', '/maxTicksPerFrame', 0],
      ['time', '/maxTicksPerFrame', -64],
      ['time', '/maxTicksPerFrame', 1.5],
      ['time', '/maxTicksPerFrame', '64'],
      ['time', '/maxTicksPerFrame', null],
      ['time', '/speeds', 8],
      ['time', '/speeds', []],
      ['time', '/speeds', [1, 2, 4]],
      ['time', '/speeds/1', 1.5],
      ['time', '/speeds/2', -1],
      ['time', '/speeds/1', '1'],
      ['time', '/speeds', [0, 1, 1]],
      ['economy', '/startingCashCents', '120000000'],
      ['economy', '/startingCashCents', 1.5],
      ['economy', '/startingCashCents', -1],
      ['economy', '/demurrageRateOfRewardPerHour', 1.5],
      ['economy', '/demurrageRateOfRewardPerHour', -0.1],
      ['economy', '/latePenaltyRateOfRewardPerDay', Number.NaN],
      ['economy', '/failAfterDaysLate', 2.5],
      ['economy', '/leaseMonthlyRateOfPrice', 'x'],
      ['economy', '/bankruptcyDays', 0],
      ['economy', '/offersPerDay', -1],
      ['economy', '/offerExpiryDays', 0],
      ['economy', '/removalRefundRate', 1.5],
      ['economy', '/removalRefundRate', -0.1],
      ['economy', '/removalRefundRate', '0.5'],
      ['economy', '/removalRefundRate', Number.NaN],
      ['infrastructure', '/road', 5],
      ['infrastructure', '/road', null],
      ['infrastructure', '/rail', []],
      ['infrastructure', '/road/costPerCellCents', -1],
      ['infrastructure', '/road/costPerCellCents', 2000.5],
      ['infrastructure', '/road/costPerCellCents', '200000'],
      ['infrastructure', '/road/maintenancePerDayCents', -1],
      ['infrastructure', '/rail/costPerCellCents', null],
      ['infrastructure', '/rail/maintenancePerDayCents', 0.5],
      ['infrastructure', '/roadKinds', null],
      ['infrastructure', '/roadKinds/one_lane', 7],
      ['infrastructure', '/roadKinds/one_lane/costPerCellCents', -1],
      ['infrastructure', '/roadKinds/one_way/costPerCellCents', 1.5],
      ['infrastructure', '/roadKinds/one_lane/speedFactor', 0],
      ['infrastructure', '/roadKinds/one_lane/speedFactor', -0.5],
      ['infrastructure', '/roadKinds/one_lane/speedFactor', 1.01],
      ['infrastructure', '/roadKinds/one_way/speedFactor', '1'],
      ['logistics', '/defaultInternalTicks', -1],
      ['logistics', '/defaultInternalTicks', 6.5],
      ['logistics', '/defaultInternalTicks', '6'],
      ['logistics', '/repathIntervalTicks', 0],
      ['logistics', '/repathIntervalTicks', 30.5],
      ['logistics', '/repathIntervalTicks', null],
      ['logistics', '/congestion', 0.9],
      ['logistics', '/congestion', []],
      ['logistics', '/congestion/trafficDecayPerHour', 1.5],
      ['logistics', '/congestion/trafficDecayPerHour', -0.1],
      ['logistics', '/congestion/trafficDecayPerHour', '0.9'],
      // R1 (ADR-037): doprava bez prekrývania
      ['logistics', '/traffic', null],
      ['logistics', '/traffic/gridlockTicks', 0],
      ['logistics', '/traffic/gridlockTicks', 1.5],
      ['logistics', '/traffic/stuckTicks', 0],
      ['logistics', '/traffic/rerouteCooldownTicks', -1],
      ['logistics', '/traffic/idleParkDelayTicks', null],
      // T06-07: lodná navigácia (predtým konštanty v src/sim/ships)
      ['logistics', '/shipNavigation', null],
      ['logistics', '/shipNavigation/approachMarginCells', 0],
      ['logistics', '/shipNavigation/approachMarginCells', 1.5],
      ['logistics', '/shipNavigation/sweepStepCells', 0],
      ['logistics', '/shipNavigation/sweepStepCells', -0.5],
      ['logistics', '/shipNavigation/sweepStepCells', '0.5'],
      // T06-08b (review T06-07, minor 3): krok vzorkovania v [0,1; 1] (obal šikmého úseku ostane tesný a lacný)
      ['logistics', '/shipNavigation/sweepStepCells', 0.05],
      ['logistics', '/shipNavigation/sweepStepCells', 1.5],
      ['logistics', '/shipNavigation/turnManeuvers', -1],
      ['logistics', '/shipNavigation/turnManeuvers', 101],
      ['logistics', '/shipNavigation/turnManeuvers', 0.5],
      ['logistics', '/shipNavigation/sidewaysManeuvers', 101],
      ['logistics', '/shipNavigation/sidewaysManeuvers', null],
    ];

    it.each(cases)('%s %s = %j', (def, path, value) => {
      const raw = rawDefs();
      setAtPath(raw[def], path, value);
      expectDefError(() => DefRegistry.fromRaw(raw), def, path);
    });

    it('správa obsahuje názov defu, cestu aj problém', () => {
      const raw = rawDefs();
      raw.time['tickGameSeconds'] = '10';
      const error = expectDefError(() => DefRegistry.fromRaw(raw), 'time', '/tickGameSeconds');
      expect(error.problem).toContain('celé číslo');
      expect(error.message).toBe(`time/tickGameSeconds: ${error.problem}`);
    });

    it('tickGameSeconds, ktoré nedelí 60 → DefError s vysvetlením', () => {
      const raw = rawDefs();
      raw.time['tickGameSeconds'] = 7;
      const error = expectDefError(() => DefRegistry.fromRaw(raw), 'time', '/tickGameSeconds');
      expect(error.problem).toContain('musí deliť 60');
      expect(error.problem).toContain('dostal 7');
    });

    it('chýbajúce povinné pole → cesta poľa', () => {
      const raw = rawDefs();
      delete raw.economy['bankruptcyDays'];
      expectDefError(() => DefRegistry.fromRaw(raw), 'economy', '/bankruptcyDays');
    });

    it.each([
      ['time', 'maxTicksPerFrame'],
      ['economy', 'removalRefundRate'],
      ['infrastructure', 'rail'],
      ['infrastructure', 'roadKinds'],
      ['logistics', 'defaultInternalTicks'],
      ['logistics', 'repathIntervalTicks'],
      ['logistics', 'congestion'],
    ] as const)('nové povinné pole %s/%s', (def, key) => {
      const raw = rawDefs();
      delete raw[def][key];
      expectDefError(() => DefRegistry.fromRaw(raw), def, `/${key}`);
    });

    it('chýbajúce vnorené povinné pole → cesta vnoreného poľa', () => {
      const raw = rawDefs();
      delete (raw.infrastructure['road'] as Record<string, unknown>)['costPerCellCents'];
      expectDefError(() => DefRegistry.fromRaw(raw), 'infrastructure', '/road/costPerCellCents');
    });

    it.each(['two_lane', 'one_lane', 'one_way'])('chýbajúci typ cesty roadKinds/%s → úplná cesta', (kind) => {
      const raw = rawDefs();
      delete (raw.infrastructure['roadKinds'] as Record<string, unknown>)[kind];
      expectDefError(() => DefRegistry.fromRaw(raw), 'infrastructure', `/roadKinds/${kind}`);
    });

    it('neznámy typ cesty v roadKinds → DefError s úplnou cestou', () => {
      const raw = rawDefs();
      (raw.infrastructure['roadKinds'] as Record<string, unknown>)['four_lane'] = { costPerCellCents: 1, speedFactor: 1 };
      expectDefError(() => DefRegistry.fromRaw(raw), 'infrastructure', '/roadKinds/four_lane');
    });

    it('alias road.costPerCellCents sa musí zhodovať s roadKinds.two_lane.costPerCellCents (ADR-020)', () => {
      const raw = rawDefs();
      (raw.infrastructure['road'] as Record<string, unknown>)['costPerCellCents'] = 199_999;
      const error = expectDefError(() => DefRegistry.fromRaw(raw), 'infrastructure', '/road/costPerCellCents');
      expect(error.message).toContain('roadKinds/two_lane/costPerCellCents');
      const kinds = raw.infrastructure['roadKinds'] as Record<string, Record<string, unknown>>;
      kinds['two_lane']['costPerCellCents'] = 199_999;
      expect(DefRegistry.fromRaw(raw).infrastructure.roadKinds.two_lane.costPerCellCents).toBe(199_999);
    });

    it('hranice speedFactor: 1 a malé kladné číslo sú platné', () => {
      const raw = rawDefs();
      const kinds = raw.infrastructure['roadKinds'] as Record<string, Record<string, unknown>>;
      kinds['one_lane']['speedFactor'] = 1;
      kinds['one_way']['speedFactor'] = 0.01;
      const { roadKinds } = DefRegistry.fromRaw(raw).infrastructure;
      expect([roadKinds.one_lane.speedFactor, roadKinds.one_way.speedFactor]).toEqual([1, 0.01]);
    });

    it('chýbajúce vnorené povinné pole logistics.traffic → úplná cesta', () => {
      const raw = rawDefs();
      delete (raw.logistics['traffic'] as Record<string, unknown>)['stuckTicks'];
      expectDefError(() => DefRegistry.fromRaw(raw), 'logistics', '/traffic/stuckTicks');
    });

    it('odstránené kľúče soft kongescie (ADR-037) sa hlásia ako neznáme', () => {
      const raw = rawDefs();
      (raw.logistics['congestion'] as Record<string, unknown>)['penaltyMax'] = 3;
      expectDefError(() => DefRegistry.fromRaw(raw), 'logistics', '/congestion/penaltyMax');
    });

    it('hranice logistics: defaultInternalTicks 0, trafficDecayPerHour 0 aj 1, traffic ticky 1 sú platné', () => {
      const raw = rawDefs();
      raw.logistics['defaultInternalTicks'] = 0;
      Object.assign(raw.logistics['congestion'] as Record<string, unknown>, { trafficDecayPerHour: 0 });
      Object.assign(raw.logistics['traffic'] as Record<string, unknown>, { gridlockTicks: 1, stuckTicks: 1, rerouteCooldownTicks: 1, idleParkDelayTicks: 1 });
      const logistics = DefRegistry.fromRaw(raw).logistics;
      expect([logistics.defaultInternalTicks, logistics.congestion.trafficDecayPerHour, logistics.traffic.gridlockTicks]).toEqual([0, 0, 1]);
      (raw.logistics['congestion'] as Record<string, unknown>)['trafficDecayPerHour'] = 1;
      expect(DefRegistry.fromRaw(raw).logistics.congestion.trafficDecayPerHour).toBe(1);
    });

    it('hranice: maxTicksPerFrame 1 a removalRefundRate 0 aj 1 sú platné', () => {
      const raw = rawDefs();
      raw.time['maxTicksPerFrame'] = 1;
      raw.economy['removalRefundRate'] = 0;
      expect(DefRegistry.fromRaw(raw).time.maxTicksPerFrame).toBe(1);
      raw.economy['removalRefundRate'] = 1;
      expect(DefRegistry.fromRaw(raw).economy.removalRefundRate).toBe(1);
    });
  });

  describe('neznámy kľúč → DefError', () => {
    it.each(['time', 'economy', 'infrastructure', 'logistics'] as const)('%s', (def) => {
      const raw = rawDefs();
      raw[def]['unexpectedKey'] = 1;
      expectDefError(() => DefRegistry.fromRaw(raw), def, '/unexpectedKey');
    });

    it('neznámy kľúč vo vnorenom objekte má úplnú cestu', () => {
      const raw = rawDefs();
      (raw.infrastructure['rail'] as Record<string, unknown>)['costPerCel'] = 1;
      expectDefError(() => DefRegistry.fromRaw(raw), 'infrastructure', '/rail/costPerCel');
    });

    it('neznámy kľúč v logistics.congestion má úplnú cestu', () => {
      const raw = rawDefs();
      (raw.logistics['congestion'] as Record<string, unknown>)['penaltyMaxx'] = 1;
      expectDefError(() => DefRegistry.fromRaw(raw), 'logistics', '/congestion/penaltyMaxx');
    });

    it('preklep v názve poľa sa hlási ako neznámy kľúč', () => {
      const raw = rawDefs();
      raw.time['tickGameSecond'] = raw.time['tickGameSeconds'];
      delete raw.time['tickGameSeconds'];
      expectDefError(() => DefRegistry.fromRaw(raw), 'time', '/tickGameSecond');
    });

    it('špeciálne znaky v kľúči sa escapujú (RFC 6901)', () => {
      const raw = rawDefs();
      raw.time['a/b~c'] = 1;
      expectDefError(() => DefRegistry.fromRaw(raw), 'time', '/a~1b~0c');
    });
  });

  describe('zlá schemaVersion → DefError', () => {
    it.each(['time', 'economy', 'infrastructure', 'logistics'] as const)('%s: iná verzia', (def) => {
      const raw = rawDefs();
      raw[def]['schemaVersion'] = SUPPORTED_SCHEMA_VERSION + 1;
      expectDefError(() => DefRegistry.fromRaw(raw), def, '/schemaVersion');
    });

    it.each([['1'], [null], [1.5]])('nečíselná/neplatná verzia %j', (value) => {
      const raw = rawDefs();
      raw.economy['schemaVersion'] = value;
      expectDefError(() => DefRegistry.fromRaw(raw), 'economy', '/schemaVersion');
    });

    it('chýbajúca schemaVersion', () => {
      const raw = rawDefs();
      delete raw.time['schemaVersion'];
      expectDefError(() => DefRegistry.fromRaw(raw), 'time', '/schemaVersion');
    });
  });

  describe('nemenný výstup', () => {
    it('objekty aj pole speeds sú zmrazené', () => {
      const registry = DefRegistry.fromRaw(rawDefs());
      expect(Object.isFrozen(registry.time)).toBe(true);
      expect(Object.isFrozen(registry.time.speeds)).toBe(true);
      expect(Object.isFrozen(registry.economy)).toBe(true);
      expect(Object.isFrozen(registry.infrastructure)).toBe(true);
      expect(Object.isFrozen(registry.infrastructure.road)).toBe(true);
      expect(Object.isFrozen(registry.infrastructure.rail)).toBe(true);
      expect(Object.isFrozen(registry.logistics)).toBe(true);
      expect(Object.isFrozen(registry.logistics.congestion)).toBe(true);
      expect(() => {
        (registry.time as { tickGameSeconds: number }).tickGameSeconds = 1;
      }).toThrow(TypeError);
      expect(() => {
        (registry.infrastructure.road as { costPerCellCents: number }).costPerCellCents = 1;
      }).toThrow(TypeError);
    });

    it('vstupné objekty sa nemenia ani nezmrazujú', () => {
      const raw = rawDefs();
      const before = structuredClone(raw);
      const registry = DefRegistry.fromRaw(raw);
      expect(raw).toEqual(before);
      expect(Object.isFrozen(raw.time)).toBe(false);
      expect(Object.isFrozen(raw.time['speeds'])).toBe(false);
      expect(Object.isFrozen(raw.infrastructure['road'])).toBe(false);
      expect(Object.isFrozen(raw.logistics['congestion'])).toBe(false);
      expect(registry.logistics.congestion).not.toBe(raw.logistics['congestion']);
      expect(registry.time.speeds).not.toBe(raw.time['speeds']);
      expect(registry.infrastructure.road).not.toBe(raw.infrastructure['road']);
    });
  });
});

describe('krížová kontrola rampa × kamión (review T04-11 f)', () => {
  const rampIndex = modulesJson.items.findIndex((item) => item.kind === 'ramp');
  const withTruckCapacity = (capacityUnits: number) => ({
    ...rawDefs(),
    trucks: { ...trucksJson, items: trucksJson.items.map((item) => ({ ...item, capacityUnits })) },
  });

  it('kamión kategórie rampy s capacityUnits > stagingPerDock → DefError na stagingPerDock rampy', () => {
    const staging = modulesJson.items[rampIndex].params.stagingPerDock as number;
    const error = expectDefError(() => DefRegistry.fromRaw(withTruckCapacity(staging + 1)), 'modules', `/items/${String(rampIndex)}/params/stagingPerDock`);
    expect(error.problem).toContain(`capacityUnits ${String(staging + 1)} > stagingPerDock ${String(staging)}`);
  });

  it('capacityUnits = stagingPerDock je platné; rozhoduje prvý kamión kategórie v poradí trucks.json (ten pošle spawner)', () => {
    const staging = modulesJson.items[rampIndex].params.stagingPerDock as number;
    expect(() => DefRegistry.fromRaw(withTruckCapacity(staging))).not.toThrow();
    const big = { ...trucksJson.items[0], id: 'truck_big_test', capacityUnits: staging + 1 };
    expect(() => DefRegistry.fromRaw({ ...rawDefs(), trucks: { ...trucksJson, items: [...trucksJson.items, big] } })).not.toThrow();
    expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), trucks: { ...trucksJson, items: [big, ...trucksJson.items] } }), 'modules', `/items/${String(rampIndex)}/params/stagingPerDock`);
  });

  it('rampa bez kamióna svojej kategórie je v registri prípustná (existenciu v zabalených dátach overí validate:defs)', () => {
    const noContainer = { ...rawDefs(), trucks: { ...trucksJson, items: trucksJson.items.map((item) => ({ ...item, cargoCategories: ['bulk'] })) } };
    expect(() => DefRegistry.fromRaw(noContainer)).not.toThrow();
  });
});

describe('loadBundledDefs', () => {
  it('bundled defy sa načítajú s hodnotami z data/defs', () => {
    const registry = loadBundledDefs();
    expect(registry.time).toEqual(timeJson);
    expect(registry.economy).toEqual(economyJson);
    expect(registry.infrastructure).toEqual(infrastructureJson);
    expect(registry.logistics).toEqual(logisticsJson);
    // Kontrolné hodnoty podľa ARCHITECTURE §3, §4.6 a §8 bod 8.
    expect(registry.time.tickGameSeconds).toBe(10);
    expect(registry.time.speeds).toEqual([0, 1, 2, 4, 8]);
    expect(registry.time.maxTicksPerFrame).toBe(64);
    expect(registry.economy.startingCashCents).toBe(120_000_000);
    expect(registry.economy.offersPerDay).toBe(6);
    expect(registry.economy.removalRefundRate).toBe(0.5);
    // ADR-010: cesta 2 000 USD a koľaj 6 000 USD za bunku, bez údržby.
    expect(registry.infrastructure.road).toEqual({ costPerCellCents: 200_000, maintenancePerDayCents: 0 });
    expect(registry.infrastructure.rail).toEqual({ costPerCellCents: 600_000, maintenancePerDayCents: 0 });
    // T03-18 (ADR-020): typy ciest podľa karty; dvojpruhová = alias road.costPerCellCents.
    expect(registry.infrastructure.roadKinds).toEqual({
      two_lane: { costPerCellCents: 200_000, speedFactor: 1 },
      one_lane: { costPerCellCents: 120_000, speedFactor: 0.7 },
      one_way: { costPerCellCents: 150_000, speedFactor: 1 },
    });
    expect(Object.isFrozen(registry.infrastructure.roadKinds.one_lane)).toBe(true);
    // T03-01 (ADR-010): logistika podľa ARCHITECTURE §4.6.
    expect(registry.logistics).toEqual({
      schemaVersion: 1,
      defaultInternalTicks: 6,
      repathIntervalTicks: 30,
      // R2 (ADR-039): sklad so stohmi.
      rehandleTicks: 12,
      rehandleGiveUpTicks: 96,
      buryReserveColumns: 4,
      rehandleSpareCells: 2,
      importDwellEstimateHours: 6,
      yardPlanner: 'planned',
      congestion: { trafficDecayPerHour: 0.9 },
      // R1 (ADR-037): doprava bez prekrývania.
      traffic: { gridlockTicks: 30, stuckTicks: 120, rerouteCooldownTicks: 60, idleParkDelayTicks: 6 },
      // T06-07: hodnoty doterajších konštánt APPROACH_MARGIN_CELLS, SWEEP_STEP_CELLS, TURN_MANEUVERS, SIDEWAYS_MANEUVERS.
      shipNavigation: { approachMarginCells: 1, sweepStepCells: 0.5, turnManeuvers: 1, sidewaysManeuvers: 1 },
      // T6A-02 (ADR-032): tok exportu po súši.
      exportFlow: { arrivalWindowDays: 2, vgmMissingChance: 0.05, vgmHoldHours: 6, weightClassShares: { light: 0.3, medium: 0.5, heavy: 0.2 } },
      // T6C-01 (ADR-034): tok prázdnych kontajnerov.
      emptyFlow: {
        hinterlandDaysRange: [1, 3],
        emptyReturnRate: 0.6,
        damageChance: 0.08,
        repairHours: 6,
        emptyPickupRate: 0.4,
        emptyPickupLeadHoursRange: [4, 12],
        emptyPickupMaxWaitHours: 6,
      },
    });
  });

  it('každé volanie vráti nezávislý register', () => {
    expect(loadBundledDefs()).not.toBe(loadBundledDefs());
  });
});

describe('tickGameSeconds: schéma ⇔ DefRegistry ⇔ SimClock', () => {
  /** Nezávislý oracle: delitele 60 (nie odvodený z kódu ani zo schémy). */
  const DIVISORS_OF_60 = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
  const validateTimeSchema = new Ajv2020({ allErrors: true }).compile(timeSchema);

  const schemaAccepts = (n: number): boolean => validateTimeSchema({ ...timeJson, tickGameSeconds: n });
  const registryAccepts = (n: number): boolean => {
    try {
      DefRegistry.fromRaw({ ...rawDefs(), time: { ...timeJson, tickGameSeconds: n } });
      return true;
    } catch (error) {
      if (error instanceof DefError) {
        expect(error.defName).toBe('time');
        expect(error.path).toBe('/tickGameSeconds');
        return false;
      }
      throw error;
    }
  };
  const clockAccepts = (n: number): boolean => {
    try {
      new SimClock({ tickGameSeconds: n });
      return true;
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  };

  it('bundled time.json je platný pre schému aj registry', () => {
    expect(schemaAccepts(timeJson.tickGameSeconds)).toBe(true);
    expect(registryAccepts(timeJson.tickGameSeconds)).toBe(true);
  });

  it.each(Array.from({ length: 120 }, (_, i) => i + 1))('n = %i: schéma, registry a SimClock sa zhodujú', (n) => {
    const expected = DIVISORS_OF_60.includes(n);
    expect({ n, schema: schemaAccepts(n), registry: registryAccepts(n), clock: clockAccepts(n) }).toEqual({
      n,
      schema: expected,
      registry: expected,
      clock: expected,
    });
  });
});

describe('DefRegistry.time ako SimClockConfig', () => {
  it('new SimClock(registry.time) → 6 tickov/min (typovo aj za behu)', () => {
    const clock = new SimClock(loadBundledDefs().time);
    expect(clock.ticksPerMinute).toBe(6);
    expect(clock.ticksPerDay).toBe(8640);
  });
});

describe('checkNumber: divisorOf vyžaduje kladnú hodnotu', () => {
  const spec = { kind: 'integer', divisorOf: 60 } as const;

  it('kladný deliteľ 60 je platný', () => {
    expect(checkNumber(10, spec, '/x')).toBeUndefined();
    expect(checkNumber(60, spec, '/x')).toBeUndefined();
  });

  it.each([-1, -10, -60, 0])('%i (bez min) → problém', (value) => {
    // 60 % -10 === 0, preto samotný zvyšok nestačí; nulu a zápor musí odmietnuť práve divisorOf.
    const problem = checkNumber(value, spec, '/x');
    expect(problem?.path).toBe('/x');
    expect(problem?.message).toContain('musí byť kladné');
  });

  it('kladné číslo, ktoré nedelí, hlási deliteľnosť', () => {
    expect(checkNumber(7, spec, '/x')?.message).toContain('musí deliť 60');
  });
});

/** Konzistencia schéma (Ajv) ⇔ DefRegistry pre nové polia: rovnaké typy a rozsahy (T01-01). */
describe('nové polia: schéma ⇔ DefRegistry', () => {
  const validateTime = new Ajv2020({ allErrors: true }).compile(timeSchema);
  const validateEconomy = new Ajv2020({ allErrors: true }).compile(economySchema);
  const validateInfrastructure = new Ajv2020({ allErrors: true }).compile(infrastructureSchema);
  const validateLogistics = new Ajv2020({ allErrors: true }).compile(logisticsSchema);

  const registryAccepts = (raw: RawBundle): boolean => {
    try {
      DefRegistry.fromRaw(raw);
      return true;
    } catch (error) {
      if (error instanceof DefError) return false;
      throw error;
    }
  };

  const VALUES: readonly (readonly [unknown])[] = [
    [-1],
    [-0.1],
    [0],
    [0.5],
    [1],
    [1.5],
    [2],
    [64],
    [1000],
    [200_000.5],
    ['1'],
    [null],
    [true],
    [[]],
    [{}],
  ];

  it.each(VALUES)('time.maxTicksPerFrame = %j', (value) => {
    const raw = rawDefs();
    raw.time['maxTicksPerFrame'] = value;
    expect(registryAccepts(raw)).toBe(validateTime(raw.time));
  });

  it.each(VALUES)('economy.removalRefundRate = %j', (value) => {
    const raw = rawDefs();
    raw.economy['removalRefundRate'] = value;
    expect(registryAccepts(raw)).toBe(validateEconomy(raw.economy));
  });

  /** `roadKinds.<kind>` v klonovanom deffe. */
  const roadKind = (raw: RawBundle, kind: string): Record<string, unknown> =>
    (raw.infrastructure['roadKinds'] as Record<string, Record<string, unknown>>)[kind];

  describe.each([['road'], ['rail']] as const)('infrastructure.%s', (layer) => {
    it.each(VALUES)('costPerCellCents = %j', (value) => {
      const raw = rawDefs();
      (raw.infrastructure[layer] as Record<string, unknown>)['costPerCellCents'] = value;
      // Alias ceny cesty (ADR-020) musí sedieť s dvojpruhovou — vzťah, ktorý schéma nevyjadrí, sa tu drží v súlade.
      if (layer === 'road') roadKind(raw, 'two_lane')['costPerCellCents'] = value;
      expect(registryAccepts(raw)).toBe(validateInfrastructure(raw.infrastructure));
    });

    it.each(VALUES)('maintenancePerDayCents = %j', (value) => {
      const raw = rawDefs();
      (raw.infrastructure[layer] as Record<string, unknown>)['maintenancePerDayCents'] = value;
      expect(registryAccepts(raw)).toBe(validateInfrastructure(raw.infrastructure));
    });

    it.each(VALUES)('celý objekt = %j', (value) => {
      const raw = rawDefs();
      raw.infrastructure[layer] = value;
      expect(registryAccepts(raw)).toBe(validateInfrastructure(raw.infrastructure));
    });
  });

  describe.each([['two_lane'], ['one_lane'], ['one_way']] as const)('infrastructure.roadKinds.%s (ADR-020)', (kind) => {
    it.each(VALUES)('costPerCellCents = %j', (value) => {
      const raw = rawDefs();
      roadKind(raw, kind)['costPerCellCents'] = value;
      if (kind === 'two_lane') (raw.infrastructure['road'] as Record<string, unknown>)['costPerCellCents'] = value;
      expect(registryAccepts(raw)).toBe(validateInfrastructure(raw.infrastructure));
    });

    it.each(VALUES)('speedFactor = %j', (value) => {
      const raw = rawDefs();
      roadKind(raw, kind)['speedFactor'] = value;
      expect(registryAccepts(raw)).toBe(validateInfrastructure(raw.infrastructure));
    });

    it.each(VALUES)('celý objekt = %j', (value) => {
      const raw = rawDefs();
      (raw.infrastructure['roadKinds'] as Record<string, unknown>)[kind] = value;
      expect(registryAccepts(raw)).toBe(validateInfrastructure(raw.infrastructure));
    });
  });

  it('bundled infrastructure.json prejde schémou aj registry', () => {
    const raw = rawDefs();
    expect(validateInfrastructure(raw.infrastructure)).toBe(true);
    expect(registryAccepts(raw)).toBe(true);
  });

  describe('logistics', () => {
    const congestion = (raw: RawBundle): Record<string, unknown> => raw.logistics['congestion'] as Record<string, unknown>;

    it.each(VALUES)('defaultInternalTicks = %j', (value) => {
      const raw = rawDefs();
      raw.logistics['defaultInternalTicks'] = value;
      expect(registryAccepts(raw)).toBe(validateLogistics(raw.logistics));
    });

    it.each(VALUES)('repathIntervalTicks = %j', (value) => {
      const raw = rawDefs();
      raw.logistics['repathIntervalTicks'] = value;
      expect(registryAccepts(raw)).toBe(validateLogistics(raw.logistics));
    });

    it.each(['trafficDecayPerHour'])('congestion.%s', (key) => {
      for (const [value] of VALUES) {
        const raw = rawDefs();
        congestion(raw)[key] = value;
        expect(registryAccepts(raw), `${key} = ${JSON.stringify(value)}`).toBe(validateLogistics(raw.logistics));
      }
    });

    it.each(VALUES)('celý objekt congestion = %j', (value) => {
      const raw = rawDefs();
      raw.logistics['congestion'] = value;
      expect(registryAccepts(raw)).toBe(validateLogistics(raw.logistics));
    });

    it('chýbajúce alebo prebytočné kľúče: rovnaký verdikt', () => {
      const missing = rawDefs();
      delete congestion(missing)['trafficDecayPerHour'];
      expect(registryAccepts(missing)).toBe(validateLogistics(missing.logistics));
      expect(registryAccepts(missing)).toBe(false);

      const extra = rawDefs();
      congestion(extra)['bonus'] = 1;
      expect(registryAccepts(extra)).toBe(validateLogistics(extra.logistics));
      expect(registryAccepts(extra)).toBe(false);
    });

    /** T06-08b: `shipNavigation` — schéma aj registry s rovnakými hranicami (vrátane `sweepStepCells` v [0,1; 1]). */
    const NAVIGATION_VALUES: readonly unknown[] = [...VALUES.map(([value]) => value), 0.05, 0.09, 0.1, 0.25, 0.99, 1.01, 100, 101];

    it.each(['approachMarginCells', 'sweepStepCells', 'turnManeuvers', 'sidewaysManeuvers'])('shipNavigation.%s', (key) => {
      for (const value of NAVIGATION_VALUES) {
        const raw = rawDefs();
        (raw.logistics['shipNavigation'] as Record<string, unknown>)[key] = value;
        expect(registryAccepts(raw), `${key} = ${JSON.stringify(value)}`).toBe(validateLogistics(raw.logistics));
      }
    });

    it('shipNavigation.sweepStepCells: 0,1 a 1 prejdú, 0,09 a 1,01 nie', () => {
      const verdict = (value: number): boolean => {
        const raw = rawDefs();
        (raw.logistics['shipNavigation'] as Record<string, unknown>)['sweepStepCells'] = value;
        return registryAccepts(raw) && validateLogistics(raw.logistics);
      };
      expect([0.09, 0.1, 0.5, 1, 1.01].map(verdict)).toEqual([false, true, true, true, false]);
    });

    it('bundled logistics.json prejde schémou aj registry', () => {
      const raw = rawDefs();
      expect(validateLogistics(raw.logistics)).toBe(true);
      expect(registryAccepts(raw)).toBe(true);
    });
  });

  it('chýbajúce alebo prebytočné kľúče: rovnaký verdikt', () => {
    const missing = rawDefs();
    delete (missing.infrastructure['rail'] as Record<string, unknown>)['costPerCellCents'];
    expect(registryAccepts(missing)).toBe(validateInfrastructure(missing.infrastructure));
    expect(registryAccepts(missing)).toBe(false);

    const extra = rawDefs();
    (extra.infrastructure['road'] as Record<string, unknown>)['bonus'] = 1;
    expect(registryAccepts(extra)).toBe(validateInfrastructure(extra.infrastructure));
    expect(registryAccepts(extra)).toBe(false);
  });
});
