// Prideľovanie ťahačov žeriavom STS (TR3-02, ADR-040 bod 7): `gangRoster` rozdelí ťahače (vzostupne podľa id) žeriavom v režime `gang`; dispatcher priraďuje joby žeriava
// len jeho gangu (`gang`) alebo ťahačom mimo gangov (`pool`). Deterministické, odvodené (nie v save).
import { describe, expect, it } from 'vitest';
import { SetCraneGangCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { loadMap, parseMapDef } from '@sim/grid';
import { craneGangMode, craneTractorsPerSts, gangRoster } from '@sim/logistics';
import { hookCraneOf } from '@sim/logistics/job-source';
import { CraneModule } from '@sim/modules';
import { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptCommand, hookDefs, send } from '../helpers/f6a';
import { lost, offerTranship } from '../helpers/f6c';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

const ECONOMY = { transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] };

function scenarioWorld(): World {
  const scenario = loadScenarioFile('tt_rtg');
  const world = World.create(hookDefs(0, { economy: ECONOMY }), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed, { checkInvariants: true });
  runScenario(world, scenario, 1);
  return world;
}

const cranesOf = (world: World): CraneModule[] => [...world.modules.values()].filter((module): module is CraneModule => module instanceof CraneModule);
const tractorIds = (world: World): EntityId[] => [...world.vehicles.keys()];

describe('gangRoster', () => {
  it('východisko je pool (equipment.json): žiadny gang, počet na STS z defu', () => {
    const world = scenarioWorld();
    const [crane] = cranesOf(world);
    expect(craneGangMode(world, crane)).toBe('pool');
    expect(craneTractorsPerSts(world, crane)).toBe(world.defs.equipment.tractors.defaultPerSts);
    expect(gangRoster(world).size).toBe(0);
  });

  it('dva gangy po 2: prvý žeriav dostane prvé dva ťahače, druhý ďalšie dva; zvyšné dva sú bazén', () => {
    const world = scenarioWorld();
    const [a, b] = cranesOf(world);
    new SetCraneGangCommand(a.id, 'gang', 2).apply(world);
    new SetCraneGangCommand(b.id, 'gang', 2).apply(world);
    const ids = tractorIds(world);
    const roster = gangRoster(world);
    expect([...roster.get(a.id) ?? []]).toEqual(ids.slice(0, 2));
    expect([...roster.get(b.id) ?? []]).toEqual(ids.slice(2, 4));
  });

  it('gang väčší než zostáva ťahačov dostane zvyšok (druhý žeriav 4 z 6 → len 2)', () => {
    const world = scenarioWorld();
    const [a, b] = cranesOf(world);
    new SetCraneGangCommand(a.id, 'gang', 4).apply(world);
    new SetCraneGangCommand(b.id, 'gang', 4).apply(world);
    const roster = gangRoster(world);
    expect([roster.get(a.id)?.length, roster.get(b.id)?.length]).toEqual([4, 2]);
  });
});

describe('dispatcher dodržiava gang / pool', () => {
  /** Beh prekládky 30 TEU; po každom ticku overí, že vozidlo každého jobu žeriava patrí do jeho množiny; vráti ťahače, ktoré dostali job. */
  function runWith(setup: (world: World, a: CraneModule, b: CraneModule) => void, allowed: (world: World, craneId: EntityId, a: CraneModule, b: CraneModule) => readonly EntityId[]): { used: Map<EntityId, Set<EntityId>>; world: World } {
    const world = scenarioWorld();
    const [a, b] = cranesOf(world);
    setup(world, a, b);
    const contract = offerTranship(world, { units: 30 });
    send(world, acceptCommand(contract.id));
    const used = new Map<EntityId, Set<EntityId>>();
    for (let i = 0; i < 60_000 && world.cargo.shippedCount < 30; i++) {
      world.tick();
      for (const job of world.jobs.values()) {
        const craneId = hookCraneOf(job);
        if (craneId === undefined || job.vehicleId === null) continue;
        const set = used.get(craneId) ?? new Set<EntityId>();
        set.add(job.vehicleId);
        used.set(craneId, set);
        expect(allowed(world, craneId, a, b), `job ${job.label} žeriava #${String(craneId)} obsluhuje vozidlo #${String(job.vehicleId)} mimo množiny`).toContain(job.vehicleId);
      }
    }
    expect(world.cargo.shippedCount).toBe(30);
    expect(lost(world)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
    return { used, world };
  }

  it('gang 2 + gang 2: každý žeriav len svoje dva ťahače; posledné dva ťahače nedostanú žiadny job', () => {
    const { used, world } = runWith(
      (w, a, b) => {
        new SetCraneGangCommand(a.id, 'gang', 2).apply(w);
        new SetCraneGangCommand(b.id, 'gang', 2).apply(w);
      },
      (w, craneId) => [...(gangRoster(w).get(craneId) ?? [])],
    );
    const ids = tractorIds(world);
    const everyUsed = new Set([...used.values()].flatMap((set) => [...set]));
    expect([...everyUsed].sort((x, y) => x - y)).toEqual(ids.slice(0, 4));
  });

  it('pool + gang 2: gang žeriav len svoje dva ťahače, pool žeriav len ťahače mimo gangu (4)', () => {
    const { used, world } = runWith(
      (w, a, b) => {
        new SetCraneGangCommand(b.id, 'gang', 2).apply(w);
      },
      (w, craneId, a, b) => (craneId === b.id ? [...(gangRoster(w).get(b.id) ?? [])] : tractorIds(w).filter((id) => !(gangRoster(w).get(b.id) ?? []).includes(id))),
    );
    const [, b] = cranesOf(world);
    expect([...(used.get(b.id) ?? [])].every((id) => (gangRoster(world).get(b.id) ?? []).includes(id))).toBe(true);
  });
});
