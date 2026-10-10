/**
 * Sloty nosiča (R1, TR1-02; ADR-037): `body` (hlava prvá, najviac `lengthCells`), `ahead` (sloty pred hlavou), uvoľnenie chvosta pri
 * dosiahnutí stredu bunky, slot držaný viackrát (otočka cez vlastnú stopu), obrat uprostred úseku, zmena trasy a opustenie cesty.
 * `Vehicle` bez sveta, sloty v samostatnom `LaneSlots`.
 */
import { describe, expect, it } from 'vitest';
import { LaneSlots, slotKey } from '@sim/traffic';
import { Vehicle } from '@sim/vehicles';
import { DEFS } from '../world/world-fixtures';

const WIDTH = 10;
const cell = (x: number): number => 5 * WIDTH + x;

function vehicle(route: number[], options: { length?: number; body?: number[]; ahead?: number[]; progress?: number } = {}): Vehicle {
  const base = DEFS.vehicles.get('straddle_carrier');
  const def = { ...base, lengthCells: options.length ?? 2 };
  return new Vehicle({
    id: 7 as never,
    def,
    depotId: 3 as never,
    state: 'to_pickup',
    x: (route[0] % WIDTH) + 0.5,
    y: Math.floor(route[0] / WIDTH) + 0.5,
    heading: 90,
    purchaseCostCents: 0,
    route,
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.ahead === undefined ? {} : { ahead: options.ahead }),
    ...(options.progress === undefined ? {} : { progress: options.progress }),
  });
}

describe('Carrier — sloty tela a slotov vpredu', () => {
  it('attachSlots zapíše držané sloty; reserveHead / reserveAhead / reachCell posúvajú telo a uvoľňujú chvost nad lengthCells', () => {
    const slots = new LaneSlots(100);
    const v = vehicle([cell(1), cell(2), cell(3), cell(4)], { length: 2 });
    v.attachSlots(slots);
    v.reserveHead(slotKey(cell(1), 0));
    expect(v.body).toEqual([slotKey(cell(1), 0)]);
    v.reserveAhead(slotKey(cell(2), 0));
    expect([v.ahead, slots.claimedCount]).toEqual([[slotKey(cell(2), 0)], 2]);
    v.reachCell(cell(2));
    expect([v.body, v.ahead]).toEqual([[slotKey(cell(2), 0), slotKey(cell(1), 0)], []]);
    v.reserveAhead(slotKey(cell(3), 1));
    v.reachCell(cell(3));
    // telo má najviac 2 sloty → chvost (bunka 1) sa uvoľnil
    expect(v.body).toEqual([slotKey(cell(3), 1), slotKey(cell(2), 0)]);
    expect([slots.holderOf(cell(1), 0), slots.holderOf(cell(2), 0), slots.holderOf(cell(3), 1), slots.claimedCount]).toEqual([null, 7, 7, 2]);
  });

  it('slot držaný viackrát (otočka cez vlastnú stopu) sa uvoľní až po poslednom výskyte', () => {
    const slots = new LaneSlots(100);
    const key = slotKey(cell(2), 0);
    const v = vehicle([cell(2), cell(1)], { length: 3, body: [key, slotKey(cell(3), 0)] });
    v.attachSlots(slots);
    v.reserveAhead(slotKey(cell(1), 0));
    v.reachCell(cell(1));
    v.reserveAhead(key);
    v.reachCell(cell(2));
    expect(v.body).toEqual([key, slotKey(cell(1), 0), key]);
    expect(slots.claimedCount).toBe(2);
    v.reserveAhead(slotKey(cell(3), 1));
    v.reachCell(cell(3));
    expect(v.body).toEqual([slotKey(cell(3), 1), key, slotKey(cell(1), 0)]);
    expect(slots.holderOf(cell(2), 0)).toBe(7);
  });

  it('leaveRoad uvoľní telo aj sloty vpredu a vynuluje čakanie; jumpTo uvoľní sloty bez zmeny čakania', () => {
    const slots = new LaneSlots(100);
    const v = vehicle([cell(1), cell(2)], { body: [slotKey(cell(1), 0)], ahead: [slotKey(cell(2), 0)], progress: 0.5 });
    v.attachSlots(slots);
    v.blockedTicks = 4;
    v.rerouteCooldown = 9;
    expect(slots.claimedCount).toBe(2);
    v.leaveRoad();
    expect([v.body, v.ahead, slots.claimedCount, v.blockedTicks, v.rerouteCooldown]).toEqual([[], [], 0, 0, 0]);
    const w = vehicle([cell(1)], { body: [slotKey(cell(1), 0)] });
    w.attachSlots(slots);
    w.blockedTicks = 3;
    w.jumpTo(cell(5), WIDTH);
    expect([w.body, slots.claimedCount, w.blockedTicks]).toEqual([[], 0, 3]);
  });

  it('turnAround uprostred úseku: hlava sa presunie do doterajšej cieľovej bunky, reťaz križovatky sa uvoľní', () => {
    const slots = new LaneSlots(100);
    const v = vehicle([cell(1), cell(2), cell(3)], {
      length: 3,
      progress: 0.25,
      body: [slotKey(cell(1), 0)],
      ahead: [slotKey(cell(2), 0), slotKey(cell(3), 0)],
    });
    v.attachSlots(slots);
    v.turnAround([cell(2), cell(1), cell(0)], WIDTH);
    expect(v.body).toEqual([slotKey(cell(2), 0), slotKey(cell(1), 0)]);
    expect(v.ahead).toEqual([]);
    expect([slots.holderOf(cell(3), 0), slots.claimedCount]).toEqual([null, 2]);
    // návrat do bunky 1: jej slot už telo drží → zopakuje sa na čele
    v.reachCell(cell(1));
    expect(v.body).toEqual([slotKey(cell(1), 0), slotKey(cell(2), 0), slotKey(cell(1), 0)]);
  });

  it('followRoute a halt uvoľnia sloty vpredu, ktoré už nezodpovedajú trase; zhodné ostanú', () => {
    const slots = new LaneSlots(100);
    const v = vehicle([cell(1), cell(2), cell(3)], { body: [slotKey(cell(1), 0)], ahead: [slotKey(cell(2), 0), slotKey(cell(3), 0)] });
    v.attachSlots(slots);
    v.followRoute([cell(1), cell(2), cell(4)]);
    expect([v.ahead, slots.holderOf(cell(3), 0), slots.holderOf(cell(2), 0)]).toEqual([[slotKey(cell(2), 0)], null, 7]);
    v.halt();
    expect([v.ahead, slots.holderOf(cell(2), 0)]).toEqual([[], null]);
  });

  it('bez registra slotov (testy pohybu) sú metódy len záznam v poliach; bez brány advance nezávisí od slotov', () => {
    const v = vehicle([cell(1), cell(2), cell(3)]);
    v.reserveHead(slotKey(cell(1), 0));
    v.reserveAhead(slotKey(cell(2), 0));
    expect([v.body.length, v.ahead.length, v.heldSlotCount]).toEqual([1, 1, 2]);
    expect(v.advance(2, WIDTH)).toBe(true);
    expect(v.cell).toBe(cell(3));
  });

  it('advance s bránou: false z tryEnter zastaví nosič v strede bunky a zvyšok kroku prepadne; onReach sa volá pri každom strede', () => {
    const v = vehicle([cell(1), cell(2), cell(3), cell(4)]);
    const calls: string[] = [];
    let allow = 2;
    const gate = {
      tryEnter: (from: number, to: number): boolean => {
        calls.push(`enter ${String(from % WIDTH)}>${String(to % WIDTH)}`);
        return allow-- > 0;
      },
      onReach: (c: number): void => {
        calls.push(`reach ${String(c % WIDTH)}`);
      },
    };
    const done = v.advance(3, WIDTH, undefined, gate);
    expect(done).toBe(false);
    expect(calls).toEqual(['enter 1>2', 'reach 2', 'enter 2>3', 'reach 3', 'enter 3>4']);
    expect([v.cell, v.progress]).toEqual([cell(3), 0]);
  });
});
