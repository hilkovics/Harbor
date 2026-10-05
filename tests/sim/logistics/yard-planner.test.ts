// YardPlanner (TR2-02; ADR-039 bod 7, 8): segregácia exportu podľa (voyage, hmotnosť, veľkosť), prázdne podľa (linka, veľkosť), nezavalenie podľa
// plánovaného odchodu, kapacita bloku, determinizmus a režim `random` cez `Rng`.
import { describe, expect, it } from 'vitest';
import { DefRegistry } from '@sim/defs';
import { chooseYardSlot, plannedDepartureTick } from '@sim/logistics';
import { RAW_DEFS } from '../world/world-fixtures';
import { dispatchDefs } from './dispatch-fixtures';
import { emptyLabelsOf, exportLabels, newUnit, stubVoyageArrivals, storeByPlanner, yardTestWorld } from './yard-fixtures';

const column = (place: { bay: number; row: number } | null): string | null => (place === null ? null : `${String(place.bay)}/${String(place.row)}`);

describe('segregácia exportu (voyage, hmotnostná trieda, veľkosť)', () => {
  it('rovnaký kľúč ide na jeden stoh; iná voyage, hmotnosť či veľkosť na iný; 40′ na pár stohov', () => {
    const { world, berth, yards } = yardTestWorld();
    const restore = stubVoyageArrivals(world, { 1: 5000, 2: 5000 });
    const placed = [
      storeByPlanner(world, berth, newUnit(world, exportLabels(1, 'heavy'), 7)),
      storeByPlanner(world, berth, newUnit(world, exportLabels(1, 'heavy'), 7)),
      storeByPlanner(world, berth, newUnit(world, exportLabels(1, 'light'), 7)),
      storeByPlanner(world, berth, newUnit(world, exportLabels(2, 'heavy'), 8)),
      storeByPlanner(world, berth, newUnit(world, exportLabels(1, 'heavy', 40), 7)),
    ];
    restore();
    expect(placed.every((place) => place !== null)).toBe(true);
    const [a, b, c, d, wide] = placed.map((place) => place as NonNullable<typeof place>);
    expect([a.block.id, b.block.id, c.block.id, d.block.id]).toEqual([yards[0].id, yards[0].id, yards[0].id, yards[0].id]); // blízky dvor
    expect([column(b), b.tier]).toEqual([column(a), 1]); // rovnaký kľúč = rovnaký stoh, o vrstvu vyššie
    expect(new Set([column(a), column(c), column(d)]).size).toBe(3); // iná hmotnosť / iná voyage = iný stoh
    expect(wide.bay % 2).toBe(0);
    expect(new Set([column(a), column(c), column(d)]).has(column(wide))).toBe(false);
  });
});

describe('prázdne kontajnery podľa (linka, veľkosť)', () => {
  it('prázdne tej istej linky a veľkosti sa vrstvia do jedného stohu, iná linka alebo veľkosť má vlastný', () => {
    const { world, berth } = yardTestWorld();
    const placed = [
      storeByPlanner(world, berth, newUnit(world, emptyLabelsOf('northern_star'))),
      storeByPlanner(world, berth, newUnit(world, emptyLabelsOf('northern_star'))),
      storeByPlanner(world, berth, newUnit(world, emptyLabelsOf('blue_wave'))),
      storeByPlanner(world, berth, newUnit(world, emptyLabelsOf('northern_star', 40))),
    ].map((place) => place as NonNullable<typeof place>);
    const [a, b, c, wide] = placed;
    expect([column(b), b.tier]).toEqual([column(a), 1]);
    expect(column(c)).not.toBe(column(a));
    expect(wide.bay % 2).toBe(0);
    expect(column(wide)).not.toBe(column(a));
  });
});

describe('bez zavalenia (plánovaný odchod)', () => {
  it('plánovaný odchod: export = príchod lode + poradie stowage (ťažké skôr), prázdne nikdy', () => {
    const { world } = yardTestWorld();
    const restore = stubVoyageArrivals(world, { 1: 1000, 2: 3000 });
    const heavy = newUnit(world, exportLabels(1, 'heavy'), 7);
    const light = newUnit(world, exportLabels(1, 'light'), 7);
    const later = newUnit(world, exportLabels(2, 'heavy'), 8);
    const empty = newUnit(world, emptyLabelsOf('northern_star'));
    const times = [heavy, light, later, empty].map((unit) => plannedDepartureTick(world, unit));
    restore();
    expect(times[0]).toBeLessThan(times[1]); // ťažké pred ľahkým v tej istej voyage
    expect(times[1]).toBeLessThan(times[2]); // skorší príchod lode pred neskorším
    expect(times[3]).toBe(Infinity);
  });

  // Dvor s jediným stĺpcom (kapacita 3 TEU): bez voľného stohu rozhoduje len pravidlo zavalenia.
  const oneColumnWorld = () => yardTestWorld(dispatchDefs({ yardCapacity: 3 }), 3050, [{ x: 35, y: 18 }]);

  it('skorší odchod sa ukladá navrch neskoršieho; neskorší na skorší nesmie (null = jednotka čaká, nič sa nezavalí)', () => {
    const { world, berth } = oneColumnWorld();
    const restore = stubVoyageArrivals(world, { 1: 1000, 2: 9000 });
    expect(storeByPlanner(world, berth, newUnit(world, exportLabels(2, 'medium'), 8))).not.toBeNull(); // neskorší odchod dole
    expect(storeByPlanner(world, berth, newUnit(world, exportLabels(1, 'medium'), 7))).not.toBeNull(); // skorší navrch
    expect(chooseYardSlot(world, newUnit(world, exportLabels(2, 'medium'), 8), berth)).toBeNull(); // neskorší by zavalil skorší
    expect(chooseYardSlot(world, newUnit(world, exportLabels(1, 'medium'), 7), berth)).not.toBeNull(); // rovnaký kľúč = rovnaký odchod, nezavaľuje
    restore();
  });

  it('opačné poradie: neskorší export na vrchu skoršieho stohu sa vôbec neuloží', () => {
    const { world, berth } = oneColumnWorld();
    const restore = stubVoyageArrivals(world, { 1: 1000, 2: 9000 });
    expect(storeByPlanner(world, berth, newUnit(world, exportLabels(1, 'medium'), 7))).not.toBeNull();
    expect(storeByPlanner(world, berth, newUnit(world, exportLabels(2, 'medium'), 8))).toBeNull();
    restore();
  });

  it('kapacita bloku: do dvora s 3 TEU sa nezmestí 4. jednotka ani 40′ (potrebuje pár stĺpcov)', () => {
    const { world, berth } = oneColumnWorld();
    for (let i = 0; i < 3; i++) expect(storeByPlanner(world, berth, newUnit(world))).not.toBeNull();
    expect(storeByPlanner(world, berth, newUnit(world))).toBeNull();
    const wide = newUnit(world, { ...exportLabels(1, 'medium', 40) }, 7);
    expect(chooseYardSlot(world, wide, berth)).toBeNull();
  });
});

describe('determinizmus a režim random', () => {
  const RANDOM_DEFS = DefRegistry.fromRaw({ ...RAW_DEFS, logistics: { ...RAW_DEFS.logistics, yardPlanner: 'random' } });

  it('planned: rovnaký svet = rovnaký výber a Rng sa nespotrebuje', () => {
    const run = (): { picks: (string | null)[]; rng: unknown } => {
      const { world, berth } = yardTestWorld();
      const before = JSON.stringify(world.rng.getState());
      const picks = Array.from({ length: 8 }, () => column(storeByPlanner(world, berth, newUnit(world))));
      expect(JSON.stringify(world.rng.getState())).toBe(before);
      return { picks, rng: before };
    };
    expect(run()).toEqual(run());
  });

  it('random: výber ide cez Rng — rovnaký seed dá rovnaké bunky, iný seed iné; Rng sa posunie', () => {
    const run = (seed: number): (string | null)[] => {
      const { world, berth } = yardTestWorld(RANDOM_DEFS, seed);
      const before = JSON.stringify(world.rng.getState());
      const picks = Array.from({ length: 10 }, () => column(storeByPlanner(world, berth, newUnit(world))));
      expect(JSON.stringify(world.rng.getState())).not.toBe(before);
      return picks;
    };
    expect(run(11)).toEqual(run(11));
    expect(run(11)).not.toEqual(run(12));
  });
});
