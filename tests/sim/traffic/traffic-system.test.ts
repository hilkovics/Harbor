/**
 * TrafficSystem (R1, TR1-02; ADR-037, ADR-038): pruhy podľa strany vjazdu, nasledovanie bez prekryvu, križovatka s výjazdom,
 * úsek one_lane oproti, otočka cez vlastnú stopu, cyklus čakania s preplánovaním a determinizmus. Syntetické vozidlá
 * v `to_pickup` bez jobu; tická sa samotná doprava (viď `traffic-fixtures.ts`), po každom ticku platí `carrierOverlapProblem`.
 */
import { describe, expect, it } from 'vitest';
import { carrierOverlapProblem, keyCell, keyLane } from '@sim/traffic';
import { bodyCells, cellOf, idx, keyAt, lay, line, spawn, tickTraffic, trafficBed, type XY } from './traffic-fixtures';

describe('pruhy podľa strany vjazdu', () => {
  it('protismerné vozidlá na dvojpruhovej ceste sa míňajú bez čakania, každé vo svojom pruhu', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    const down = spawn(bed, line([40, 22], [40, 30]));
    const up = spawn(bed, line([40, 30], [40, 22]));
    const lanes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      tickTraffic(world);
      for (const [name, vehicle] of [['down', down], ['up', up]] as const) {
        const [, y] = cellOf(world, vehicle);
        // Na slepých koncoch (y = 22 a 30) platí pravidlo slepej bunky, tu sa sleduje len voľná cesta.
        if (vehicle.body.length > 0 && y >= 24 && y <= 28) lanes.add(`${name}:${String(keyLane(vehicle.body[0]))}`);
      }
      expect([down.blockedTicks, up.blockedTicks]).toEqual([0, 0]);
    }
    expect(cellOf(world, down)).toEqual([40, 30]);
    expect(cellOf(world, up)).toEqual([40, 22]);
    // Vjazd zo severu (strana e0 = N) je pruh 0, vjazd z juhu pruh 1 — protismerné vozidlá sa nestretnú v jednom slote.
    expect([...lanes].sort()).toEqual(['down:0', 'up:1']);
  });

  it('stojace vozidlo na konci trasy drží svoje telo (najviac lengthCells slotov) a nič iné nedrží', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    const truck = spawn(bed, line([40, 22], [40, 27]), { length: 3 });
    tickTraffic(world, 10);
    expect(bodyCells(world, truck)).toEqual([[40, 27], [40, 26], [40, 25]]);
    expect(truck.ahead).toEqual([]);
    expect(world.laneSlots.claimedCount).toBe(3);
    expect(world.laneSlots.holderOf(idx(world, [40, 24]), 0)).toBeNull();
  });
});

describe('nasledovanie bez prekryvu (dĺžka 3)', () => {
  it('za stojacim vodcom sa kamión zastaví pred jeho chvostom a čaká; po uvoľnení pokračuje', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 32]));
    const leader = spawn(bed, line([40, 24], [40, 28]), { length: 3 });
    const follower = spawn(bed, line([40, 22], [40, 32]), { length: 3 });
    tickTraffic(world, 20);
    // Vodca stojí v (40, 28) s telom 28, 27, 26 → nasledovník s hlavou v 25 a telom 25, 24, 23.
    expect(bodyCells(world, leader)).toEqual([[40, 28], [40, 27], [40, 26]]);
    expect(cellOf(world, follower)).toEqual([40, 25]);
    expect(bodyCells(world, follower)).toEqual([[40, 25], [40, 24], [40, 23]]);
    expect(follower.blockedTicks).toBeGreaterThan(5);
    // Vodca pokračuje po trase dopredu (stojaci nosič na ceste slot drží, preto ho musí uvoľniť jazdou); nasledovník sa za ním rozbehne.
    leader.followRoute(Object.freeze(line([40, 28], [40, 32]).map((xy) => idx(world, xy))));
    tickTraffic(world, 6);
    expect(cellOf(world, leader)[1]).toBeGreaterThan(28);
    expect(cellOf(world, follower)[1]).toBeGreaterThan(25);
  });

  it('pri pomalšom vodcovi sa nasledovník nikdy nedostane bližšie než jeho chvost (telo na telo)', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 40]));
    const leader = spawn(bed, line([40, 24], [40, 40]), { length: 3, speed: 0.4 });
    const follower = spawn(bed, line([40, 22], [40, 40]), { length: 3, speed: 1 });
    for (let i = 0; i < 80; i++) {
      tickTraffic(world);
      const gap = leader.cell - follower.cell;
      expect(gap).toBeGreaterThanOrEqual(0);
    }
    expect(cellOf(world, leader)).toEqual([40, 40]);
    expect(cellOf(world, follower)[1]).toBeGreaterThan(30);
  });
});

describe('križovatka — vojde sa naraz so slotom za ňou', () => {
  it('vozidlo nevstúpi do križovatky, kým je obsadená bunka za ňou; potom zaberie križovatku aj výjazd naraz', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([36, 24], [44, 24]));
    lay(world, line([40, 25], [40, 27]));
    // (40, 24) je križovatka; blokátor drží výjazd (41, 24) pruh 1 (vjazd od západu = strana e1 → pruh 1).
    const blocker = spawn(bed, [[41, 24]], { body: [keyAt(world, [41, 24], 1)] });
    const car = spawn(bed, line([38, 24], [43, 24]), { speed: 0.5 });
    tickTraffic(world, 6);
    expect(cellOf(world, car)).toEqual([39, 24]);
    expect(car.ahead).toEqual([]);
    expect(car.blockedTicks).toBeGreaterThan(0);
    expect(world.laneSlots.holderOf(idx(world, [40, 24]), 0)).toBeNull();
    blocker.releaseSlots();
    tickTraffic(world, 1);
    // Rozbehnutý do križovatky drží križovatku (ahead[0]) a bunky, ktoré treba, aby ju telo (dĺžka 2) celé opustilo.
    expect(car.ahead.map(keyCell)).toEqual([idx(world, [40, 24]), idx(world, [41, 24]), idx(world, [42, 24])]);
    expect(car.blockedTicks).toBe(0);
    tickTraffic(world, 12);
    expect(cellOf(world, car)).toEqual([43, 24]);
  });

  it('reťaz susedných križovatiek sa zaberá celá a za poslednou toľko buniek, aby ju telo celé opustilo', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([36, 24], [44, 24]));
    lay(world, [[40, 25], [41, 25]]);
    // (40, 24) a (41, 24) sú obe križovatky (susedia W, E, S); vozidlo dĺžky 2 potrebuje za nimi dve bunky.
    const car = spawn(bed, line([39, 24], [43, 24]), { length: 2, speed: 0.5 });
    tickTraffic(world, 1);
    expect(car.ahead.map(keyCell)).toEqual([idx(world, [40, 24]), idx(world, [41, 24]), idx(world, [42, 24]), idx(world, [43, 24])]);
  });

  it('trasa končiaca v križovatke: zaberie sa len po koniec trasy', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([36, 24], [44, 24]));
    lay(world, line([40, 25], [40, 26]));
    const car = spawn(bed, line([38, 24], [40, 24]), { length: 3, speed: 0.5 });
    tickTraffic(world, 3);
    expect(car.ahead.map(keyCell)).toEqual([idx(world, [40, 24])]);
  });

  it('protiidúce vozidlá medzi dvoma križovatkami s jednou bunkou medzi nimi sa nezablokujú (telo dĺžky 2 zostáva v križovatke)', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([36, 24], [48, 24]));
    lay(world, line([40, 25], [40, 26]));
    lay(world, line([42, 25], [42, 26]));
    const east = spawn(bed, line([37, 24], [46, 24]));
    const west = spawn(bed, line([46, 24], [37, 24]));
    const { gridlockTicks } = world.defs.logistics.traffic;
    for (let i = 0; i < 40; i++) {
      tickTraffic(world);
      expect(Math.max(east.blockedTicks, west.blockedTicks)).toBeLessThan(gridlockTicks);
    }
    expect(cellOf(world, east)).toEqual([46, 24]);
    expect(cellOf(world, west)).toEqual([37, 24]);
  });
});

describe('úsek one_lane — vstup oproti je zakázaný', () => {
  it('vozidlo idúce oproti počká pred úsekom, kým z neho prvé nevyjde; potom prejde', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([32, 26], [47, 26]));
    lay(world, line([36, 26], [43, 26]), 'one_lane');
    const east = spawn(bed, line([32, 26], [47, 26]));
    const west = spawn(bed, line([47, 26], [32, 26]));
    const segment = world.cellLanes.segmentOf(idx(world, [40, 26]));
    let waited = false;
    for (let i = 0; i < 60; i++) {
      tickTraffic(world);
      const inside = (vehicle: typeof east): boolean => vehicle.body.some((key) => world.cellLanes.segmentOf(keyCell(key)) === segment);
      // Nikdy nie sú v úseku obe naraz.
      expect(inside(east) && inside(west)).toBe(false);
      if (west.blockedTicks > 0 || east.blockedTicks > 0) waited = true;
    }
    expect(waited).toBe(true);
    expect(cellOf(world, east)).toEqual([47, 26]);
    expect(cellOf(world, west)).toEqual([32, 26]);
  });

  it('dve vozidlá v rovnakom smere idú úsekom za sebou bez čakania', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([32, 26], [47, 26]));
    lay(world, line([36, 26], [43, 26]), 'one_lane');
    const first = spawn(bed, line([32, 26], [47, 26]));
    const second = spawn(bed, line([32, 26], [47, 26]));
    // druhé počká na uvoľnenie štartovej bunky (rovnaká bunka), potom ide za prvým; v cieli sa zastaví pred jeho chvostom (dĺžka 2)
    for (let i = 0; i < 60; i++) tickTraffic(world);
    expect([cellOf(world, first), cellOf(world, second)]).toEqual([[47, 26], [45, 26]]);
  });
});

describe('otočka cez vlastnú stopu', () => {
  it('dvojpruhový slepý koniec: späť ide opačným pruhom bez čakania', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 26]));
    const truck = spawn(bed, line([40, 22], [40, 26]), { length: 3 });
    tickTraffic(world, 8);
    expect(bodyCells(world, truck)).toEqual([[40, 26], [40, 25], [40, 24]]);
    truck.followRoute(Object.freeze(line([40, 26], [40, 22]).map((xy) => idx(world, xy))));
    tickTraffic(world, 8);
    expect(cellOf(world, truck)).toEqual([40, 22]);
    expect(truck.blockedTicks).toBe(0);
  });

  it('jednopruhový slepý koniec: vlastný slot je voľný, slot sa v tele zopakuje a uvoľní sa až po poslednom výskyte', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 26]), 'one_lane');
    const truck = spawn(bed, line([40, 22], [40, 26]), { length: 3, speed: 1 });
    tickTraffic(world, 12);
    expect(bodyCells(world, truck)).toEqual([[40, 26], [40, 25], [40, 24]]);
    truck.followRoute(Object.freeze(line([40, 26], [40, 22]).map((xy) => idx(world, xy))));
    let repeated = false;
    for (let i = 0; i < 20; i++) {
      tickTraffic(world);
      if (new Set(truck.body).size < truck.body.length) repeated = true;
    }
    expect(repeated).toBe(true);
    expect(cellOf(world, truck)).toEqual([40, 22]);
    expect(truck.blockedTicks).toBe(0);
    expect(world.laneSlots.claimedCount).toBe(new Set(truck.body).size);
  });
});

/**
 * Obchádzka: cesta y = 28 (x 34…41) s obchádzkou y = 29 (x 36…39). A stojí v (36, 28) a chce na východ, B v (37, 28) na západ —
 * navzájom si držia bunky križovatiek (cyklus čakania). Po `gridlockTicks` A preplánuje cez obchádzku a oba dôjdu.
 */
function deadlockBed(): { bed: ReturnType<typeof trafficBed>; a: ReturnType<typeof spawn>; b: ReturnType<typeof spawn> } {
  const bed = trafficBed();
  lay(bed.world, line([34, 28], [41, 28]));
  lay(bed.world, line([36, 29], [39, 29]));
  // Obe križovatky (36, 28) a (37, 28) už vozidlá držia, takže sa nemôžu nepozorovane „prejsť“.
  const a = spawn(bed, line([36, 28], [40, 28]), { body: [keyAt(bed.world, [36, 28], 0)] });
  const b = spawn(bed, line([37, 28], [34, 28]), { body: [keyAt(bed.world, [37, 28], 0)] });
  return { bed, a, b };
}

describe('cyklus čakania a preplánovanie', () => {
  it('vzájomné blokovanie sa zapíše ako cyklus; po gridlockTicks jeden preplánuje cez obchádzku a oba dôjdu', () => {
    const { bed, a, b } = deadlockBed();
    const { world } = bed;
    const { gridlockTicks, rerouteCooldownTicks } = world.defs.logistics.traffic;
    tickTraffic(world, gridlockTicks - 1);
    expect([a.blockedTicks, b.blockedTicks]).toEqual([gridlockTicks - 1, gridlockTicks - 1]);
    expect([cellOf(world, a), cellOf(world, b)]).toEqual([[36, 28], [37, 28]]);
    expect(a.rerouteCooldown).toBe(0);
    tickTraffic(world, 1);
    // A (nižšie id) preplánoval mimo blokovanej bunky; B nemá inú cestu, pokus mu však spotreboval odpočet.
    expect(a.rerouteCooldown).toBe(rerouteCooldownTicks);
    expect(b.rerouteCooldown).toBe(rerouteCooldownTicks);
    expect(a.remainingRoute()).toContain(idx(world, [37, 29]));
    tickTraffic(world, 20);
    expect(cellOf(world, a)).toEqual([40, 28]);
    expect(cellOf(world, b)).toEqual([34, 28]);
    expect([a.blockedTicks, b.blockedTicks]).toEqual([0, 0]);
  });

  it('bez cyklu (len čakanie za stojacim vodcom) sa pred stuckTicks nepreplánuje; po stuckTicks áno', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([36, 28], [44, 28]));
    lay(world, line([36, 29], [44, 29]));
    lay(world, [[36, 30], [37, 30]]);
    const { gridlockTicks, stuckTicks } = world.defs.logistics.traffic;
    const leader = spawn(bed, line([39, 28], [40, 28]));
    const follower = spawn(bed, line([37, 28], [43, 28]));
    tickTraffic(world, gridlockTicks + 5);
    expect(follower.blockedTicks).toBeGreaterThanOrEqual(gridlockTicks);
    expect(follower.rerouteCooldown).toBe(0);
    tickTraffic(world, stuckTicks);
    // po stuckTicks preplánuje (A* mimo bunky vodcu): cesta cez y = 29 neexistuje bez spojky, takže zostane trasa, ale odpočet sa spustí
    expect(follower.rerouteCooldown).toBeGreaterThan(0);
    expect(leader.blockedTicks).toBe(0);
  });
});

describe('determinizmus', () => {
  const run = (): string => {
    const { bed, a, b } = deadlockBed();
    tickTraffic(bed.world, 80);
    return JSON.stringify([a.toState(), b.toState()]);
  };

  it('rovnaké vstupy dajú rovnaký stav (poradie spracovania, rekurzia, preplánovanie)', () => {
    expect(run()).toBe(run());
  });

  it('toState nesie body, ahead, blockedTicks a rerouteCooldown a vozidlo z neho pokračuje bitovo rovnako', () => {
    const { bed, a } = deadlockBed();
    const { world } = bed;
    tickTraffic(world, 3);
    const state = a.toState();
    expect(state.body).toEqual([[idx(world, [36, 28]), 0]]);
    expect(state.ahead).toEqual([]);
    expect(state.blockedTicks).toBe(3);
    expect(state.rerouteCooldown).toBe(0);
  });
});

describe('vstup do jazdného stavu a opustenie', () => {
  it('vozidlo bez slotov zaberie najprv svoju bunku; ak ju drží iné, stojí a čaká, po uvoľnení pokračuje', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    // Stojaci držiteľ pruhu 0 bunky (40, 24); nové vozidlo tam má výjazd k juhu (e1 → pruh 0) → rovnaký slot.
    const holder = spawn(bed, [[40, 24]], { body: [keyAt(world, [40, 24], 0)] });
    const second = spawn(bed, line([40, 24], [40, 27]));
    tickTraffic(world, 5);
    expect(cellOf(world, second)).toEqual([40, 24]);
    expect(second.body).toEqual([]);
    expect(second.blockedTicks).toBe(5);
    holder.releaseSlots();
    tickTraffic(world, 6);
    expect(cellOf(world, second)).toEqual([40, 27]);
    expect(second.blockedTicks).toBe(0);
  });

  it('opustenie cesty (leaveRoad) uvoľní celé telo a vynuluje čakanie', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    const truck = spawn(bed, line([40, 22], [40, 30]), { length: 3 });
    tickTraffic(world, 4);
    expect(truck.heldSlotCount).toBeGreaterThan(0);
    truck.blockedTicks = 3;
    truck.leaveRoad();
    expect(truck.heldSlotCount).toBe(0);
    expect(world.laneSlots.claimedCount).toBe(0);
    expect([truck.blockedTicks, truck.rerouteCooldown]).toEqual([0, 0]);
  });

  it('vozidlo, ktoré dorazí k modulu (loading, unloading), idle aj bez cesty (no_path), drží celé telo — stojaci nosič je prekážka', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    const car = spawn(bed, line([40, 22], [40, 30]));
    tickTraffic(world, 12);
    const held = [...car.body];
    expect(held).toHaveLength(2);
    for (const state of ['loading', 'to_dropoff', 'unloading', 'idle'] as const) {
      car.transition(state);
      expect([state, car.body]).toEqual([state, held]);
      expect(world.laneSlots.claimedCount).toBe(2);
    }
    expect(carrierOverlapProblem(world)).toBeNull();
  });

  it('nosič mimo cesty nedrží sloty ani po zmene trasy (xy nezáleží): invariant platí', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 26]));
    const xy: XY = [40, 24];
    const car = spawn(bed, [xy]);
    tickTraffic(world, 2);
    expect(car.cell).toBe(idx(world, xy));
  });
});
