// Akceptácia TR2-02 (ADR-039 bod 7): plánovač ukladá podľa času odchodu, takže pri výbere vo vykládkovom poradí je rehandlesPerMove < 0,3;
// náhodné ukladanie (def `yardPlanner: "random"`) ho zvýši nad 1. Menší scenárový test (jeden blok, 72 exportov v 72 voyage,
// vozidlo, výber jobmi v poradí stowage), lebo `vertical_slice` drží v sklade naraz málo kontajnerov (import odchádza hneď) a rehandling takmer nevzniká.
import { describe, expect, it } from 'vitest';
import type { CargoUnit, WeightClass } from '@sim/cargo';
import { STOWAGE_WEIGHT_RANK } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import { yardMetrics } from '@sim/logistics';
import { YardBlock } from '@sim/modules';
import { findWorldViolation, type World } from '@sim/world';
import { RAW_DEFS } from '../world/world-fixtures';
import { assertCargoConservation } from '../helpers/invariants';
import { YARD_W } from './dispatch-fixtures';
import { buyVehicle, exportLabels, newUnit, openLoadJob, storeByPlanner, stubVoyageArrivals, yardTestWorld } from './yard-fixtures';

/**
 * Prúd exportov: 12 klesajúcich postupností (kto privezie neskôr, odchádza skôr) po 6 kontajneroch, prekladaných po kolách — jednotka `(kolo k, postupnosť s)`
 * odchádza ako `6 × s + (5 − k)`. Plánovač z nich poskladá 12 stohov zoradených podľa odchodu (pasujúci stoh = vlastná postupnosť); náhodné ukladanie
 * ich pomieša a vrch stohu odchádza neskôr než niečo pod ním. Každá jednotka má vlastnú voyage (odchod = voyage), takže výber nemá z čoho vyberať.
 */
const SEQUENCES = 12;
const PER_SEQUENCE = 6;
const UNITS = SEQUENCES * PER_SEQUENCE;
const ARRIVALS = Object.fromEntries(Array.from({ length: UNITS }, (_, i) => [i + 1, (i + 1) * 1_000])) as Record<number, number>;

/** Poradie príchodu do skladu: kolo po kole, v každom kole jedna jednotka z každej postupnosti; voyage = poradie odchodu 1…72. */
function arrivalOrder(): { voyage: number; weight: WeightClass }[] {
  const order: { voyage: number; weight: WeightClass }[] = [];
  for (let round = 0; round < PER_SEQUENCE; round++) {
    for (let sequence = 0; sequence < SEQUENCES; sequence++) order.push({ voyage: PER_SEQUENCE * sequence + (PER_SEQUENCE - 1 - round) + 1, weight: 'medium' });
  }
  return order;
}

/** Blok s vyššími stohmi (96 TEU = 4 × 3 × 8 ako depo; stohy do 8 vrstiev) — pri nízkych stohoch (3) je rehandling na výber v princípe pod 0,5. */
function tallYardDefs(mode: 'planned' | 'random'): DefRegistry {
  const items = RAW_DEFS.modules.items.map((item) =>
    item.id === 'container_yard_small' ? { ...item, params: { ...item.params, capacityUnits: 96, bays: 4, rows: 3, maxTier: 8 } } : item,
  );
  return DefRegistry.fromRaw({ ...RAW_DEFS, modules: { ...RAW_DEFS.modules, items }, logistics: { ...RAW_DEFS.logistics, yardPlanner: mode } });
}

function runMode(mode: 'planned' | 'random'): { rehandlesPerMove: number | null; rehandles: number; moves: number; world: World } {
  const { world, berth, depotId } = yardTestWorld(tallYardDefs(mode), 3050, [YARD_W]);
  const restore = stubVoyageArrivals(world, ARRIVALS);
  const stored: CargoUnit[] = [];
  for (const { voyage, weight } of arrivalOrder()) {
    const unit = newUnit(world, exportLabels(voyage, weight), 100 + voyage);
    if (storeByPlanner(world, berth, unit) === null) throw new Error('blok je plný skôr, než sa uložilo všetko');
    stored.push(unit);
  }
  const depot = world.modules.get(depotId);
  if (depot === undefined) throw new Error('chýba depo');
  buyVehicle(world, depot as never);
  // Výber v poradí stowage ako dispatcher (`compareLoadOrder`): skorší príchod lode, ťažké skôr; v rámci triedy kontajner navrchu stohu, potom id.
  const block = [...world.modules.values()].find((module): module is YardBlock => module instanceof YardBlock);
  if (block === undefined) throw new Error('chýba blok');
  const remaining = [...stored];
  while (remaining.length > 0) {
    remaining.sort(
      (a, b) =>
        ARRIVALS[a.voyageId as unknown as number] - ARRIVALS[b.voyageId as unknown as number] ||
        STOWAGE_WEIGHT_RANK[a.weightClass] - STOWAGE_WEIGHT_RANK[b.weightClass] ||
        block.burialDepth(a.id) - block.burialDepth(b.id) ||
        a.id - b.id,
    );
    const unit = remaining.shift() as CargoUnit;
    openLoadJob(world, berth, unit.id);
    let guard = 0;
    while (world.cargo.get(unit.id)?.location.kind !== 'on_apron' && guard++ < 6000) world.tick();
    if (world.cargo.get(unit.id)?.location.kind !== 'on_apron') throw new Error(`jednotka #${String(unit.id)} sa nevybrala (rehandling uviazol)`);
    // Žeriav ju zdvihne z apronu, naloží a loď odpláva (v jednom okamihu — fiktívny držiteľ nikdy neuvidí krok 12): slot apronu sa uvoľní.
    world.cargo.move(unit.id, { kind: 'in_crane', craneId: 901 as EntityId });
    world.cargo.move(unit.id, { kind: 'on_ship', shipId: 900 as EntityId });
    world.cargo.move(unit.id, { kind: 'shipped' });
  }
  restore();
  const metrics = yardMetrics(world);
  return { rehandlesPerMove: metrics.rehandlesPerMove, rehandles: metrics.rehandles, moves: metrics.moves, world };
}

describe('plánovač vs náhodné ukladanie (rehandlesPerMove)', () => {
  const planned = runMode('planned');
  const random = runMode('random');

  it('planned: výber vo vykládkovom poradí takmer nepotrebuje rehandling (< 0,3 na výber)', () => {
    expect(planned.moves).toBe(UNITS);
    expect(planned.rehandlesPerMove).toBeLessThan(0.3);
    expect(findWorldViolation(planned.world)).toBeUndefined();
    assertCargoConservation(planned.world);
  });

  it('random: ten istý prúd jednotiek a výberov dá viac ako 1 rehandling na výber', () => {
    expect(random.moves).toBe(UNITS);
    expect(random.rehandlesPerMove).toBeGreaterThan(1);
    expect(findWorldViolation(random.world)).toBeUndefined();
    assertCargoConservation(random.world);
  });
});
