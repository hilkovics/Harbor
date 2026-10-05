/**
 * `carrierOverlapProblem` (ADR-037 bod 9): platný svet bez problému; každé porušenie (nesúlad cache, prekryv, dlhé alebo
 * nesúvislé telo, nosič mimo cesty so slotmi, slot vpredu mimo trasy) vráti popis. Nosič v jazdnom stave bez slotov je platný.
 */
import { describe, expect, it } from 'vitest';
import { VehicleError } from '@sim/vehicles';
import { carrierOverlapProblem } from '@sim/traffic';
import { keyAt, lay, line, spawn, tickTraffic, trafficBed } from './traffic-fixtures';

describe('carrierOverlapProblem', () => {
  it('prázdny svet a nosič, ktorý ešte nič nedrží, sú platné', () => {
    const bed = trafficBed();
    lay(bed.world, line([40, 22], [40, 26]));
    expect(carrierOverlapProblem(bed.world)).toBeNull();
    spawn(bed, line([40, 22], [40, 26]));
    expect(carrierOverlapProblem(bed.world)).toBeNull();
  });

  it('nesúlad cache: slot v tele, ktorý register nedrží, a slot v registri, ktorý nepatrí žiadnemu telu', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    const car = spawn(bed, line([40, 22], [40, 30]));
    tickTraffic(world, 3);
    const tail = car.body.pop() as number;
    car.body.push(tail ^ 1);
    expect(carrierOverlapProblem(world)).toMatch(/nikto/);
    car.body.pop();
    car.body.push(tail);
    expect(carrierOverlapProblem(world)).toBeNull();
    world.laneSlots.claim(keyAt(world, [40, 28], 0), 999);
    expect(carrierOverlapProblem(world)).toMatch(/cache slotov/);
  });

  it('dva nosiče nemôžu mať ten istý slot: pridanie vozidla s cudzím slotom vyhodí slot_taken a svet sa nezmení', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    const key = keyAt(world, [40, 24], 0);
    spawn(bed, [[40, 24]], { body: [key] });
    expect(() => spawn(bed, [[40, 24]], { body: [key] })).toThrow(VehicleError);
    expect(world.vehicles.size).toBe(1);
    expect(carrierOverlapProblem(world)).toBeNull();
  });

  it('telo dlhšie než lengthCells, nesúvislé telo, hlava mimo bunky nosiča a slot vpredu mimo trasy', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    const car = spawn(bed, line([40, 24], [40, 30]), { length: 2 });
    tickTraffic(world, 1);
    const head = car.body[0];
    // príliš dlhé telo (3 sloty pri dĺžke 2)
    const extra = keyAt(world, [40, 23], 0);
    world.laneSlots.claim(extra, car.id);
    car.body.push(extra);
    expect(carrierOverlapProblem(world)).toMatch(/dĺžka nosiča/);
    car.body.pop();
    world.laneSlots.release(extra, car.id);
    // nesúvislé telo
    const far = keyAt(world, [40, 28], 0);
    world.laneSlots.claim(far, car.id);
    const tail = car.body.pop() as number;
    world.laneSlots.release(tail, car.id);
    car.body.push(far);
    expect(carrierOverlapProblem(world)).toMatch(/nie je súvislé/);
    car.body.pop();
    world.laneSlots.release(far, car.id);
    car.body.push(tail);
    world.laneSlots.claim(tail, car.id);
    // slot vpredu mimo trasy
    const stray = keyAt(world, [40, 29], 1);
    world.laneSlots.claim(stray, car.id);
    car.ahead.push(stray);
    expect(carrierOverlapProblem(world)).toMatch(/slot vpredu/);
    car.ahead.pop();
    world.laneSlots.release(stray, car.id);
    expect(car.body[0]).toBe(head);
    expect(carrierOverlapProblem(world)).toBeNull();
  });

  it('nosič mimo cesty (bez holdsRoad) nedrží sloty ani nečaká', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    const car = spawn(bed, line([40, 22], [40, 30]));
    tickTraffic(world, 3);
    car.transition('loading');
    expect(carrierOverlapProblem(world)).toBeNull();
    car.body.push(keyAt(world, [40, 24], 0));
    expect(carrierOverlapProblem(world)).toMatch(/mimo cesty/);
    car.body.pop();
    car.blockedTicks = 2;
    expect(carrierOverlapProblem(world)).toMatch(/mimo cesty/);
  });
});
