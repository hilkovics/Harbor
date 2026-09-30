import { describe, expect, it } from 'vitest';
import { CRANE_LIFT_SCALE, CRANE_PHASE_MS, YardCraneMotion, craneOpDuration, type CraneOp, type CraneSpot } from '@render/yard-crane-motion';

const HOME: CraneSpot = { x: 0, y: -1.5 };
const FAR: CraneSpot = { x: 1.2, y: 1.2 };
const NEAR: CraneSpot = { x: -0.4, y: -0.2 };

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    set: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const put = (target: CraneSpot): CraneOp => ({ kind: 'put', target });
const take = (target: CraneSpot): CraneOp => ({ kind: 'take', target });

describe('trvanie operácie žeriavu dvora', () => {
  it('typická operácia trvá 0,5 – 1 s (zadanie F5b č. 8), najkratšia a najdlhšia sú v medziach fáz', () => {
    const { travelMin, travelMax, lower, hold, lift } = CRANE_PHASE_MS;
    const fixed = lower + hold + lift;
    expect(craneOpDuration(HOME, HOME)).toBe(travelMin + fixed);
    expect(craneOpDuration({ x: 0, y: -2 }, { x: 0, y: 2 })).toBe(travelMax + fixed);
    for (const target of [NEAR, FAR]) {
      const ms = craneOpDuration(HOME, target);
      expect(ms).toBeGreaterThanOrEqual(500);
      expect(ms).toBeLessThanOrEqual(1000);
    }
  });
});

describe('YardCraneMotion', () => {
  it('bez operácie stojí v domovskej polohe, bez kontajnera a nie je zaneprázdnený', () => {
    const time = clock(100);
    const motion = new YardCraneMotion(HOME, time.now);
    expect(motion.busy).toBe(false);
    expect(motion.pose()).toEqual({ gantryY: HOME.y, trolleyX: HOME.x, hoist: 0, cargo: null, phase: 'idle' });
  });

  it('put: presun s kontajnerom nad slot → spustenie → položenie → zdvihnutie prázdneho spreadera; kontajner sa vytratí', () => {
    const time = clock(1000);
    const motion = new YardCraneMotion(HOME, time.now);
    motion.push(put(FAR));
    expect(motion.busy).toBe(true);
    const travelMs = craneOpDuration(HOME, FAR) - CRANE_PHASE_MS.lower - CRANE_PHASE_MS.hold - CRANE_PHASE_MS.lift;

    // začiatok: kontajner visí na spreaderi (hore, zväčšený), žeriav je ešte v domovskej polohe
    const start = motion.pose();
    expect(start.phase).toBe('travel');
    expect(start.gantryY).toBeCloseTo(HOME.y, 9);
    expect(start.cargo).toEqual({ alpha: 1, scale: CRANE_LIFT_SCALE });

    // presun: poloha sa plynule mení medzi domovom a cieľom, spreader je hore
    time.set(1000 + travelMs / 2);
    const moving = motion.pose();
    expect(moving.phase).toBe('travel');
    expect(moving.hoist).toBe(0);
    expect(moving.gantryY).toBeGreaterThan(HOME.y);
    expect(moving.gantryY).toBeLessThan(FAR.y);
    expect(moving.trolleyX).toBeGreaterThan(HOME.x);
    expect(moving.trolleyX).toBeLessThan(FAR.x);

    // spustenie: nad slotom, hoist rastie 0 → 1, kontajner sa zmenšuje na mierku 1
    time.set(1000 + travelMs + CRANE_PHASE_MS.lower / 2);
    const lowering = motion.pose();
    expect(lowering.phase).toBe('lower');
    expect(lowering.gantryY).toBeCloseTo(FAR.y, 9);
    expect(lowering.trolleyX).toBeCloseTo(FAR.x, 9);
    expect(lowering.hoist).toBeGreaterThan(0);
    expect(lowering.hoist).toBeLessThan(1);
    expect(lowering.cargo?.scale).toBeGreaterThan(1);
    expect(lowering.cargo?.scale).toBeLessThan(CRANE_LIFT_SCALE);

    // položenie: spreader dole, kontajner v mierke 1
    time.set(1000 + travelMs + CRANE_PHASE_MS.lower + CRANE_PHASE_MS.hold / 2);
    const held = motion.pose();
    expect(held.phase).toBe('hold');
    expect(held.hoist).toBe(1);
    expect(held.cargo).toEqual({ alpha: 1, scale: 1 });

    // zdvihnutie: spreader ide hore prázdny, kontajner ostáva na slote a vytráca sa
    time.set(1000 + travelMs + CRANE_PHASE_MS.lower + CRANE_PHASE_MS.hold + CRANE_PHASE_MS.lift / 2);
    const lifting = motion.pose();
    expect(lifting.phase).toBe('lift');
    expect(lifting.hoist).toBeGreaterThan(0);
    expect(lifting.hoist).toBeLessThan(1);
    expect(lifting.cargo?.scale).toBe(1);
    expect(lifting.cargo?.alpha).toBeGreaterThan(0);
    expect(lifting.cargo?.alpha).toBeLessThan(1);

    // koniec: žeriav stojí nad slotom, hore, bez kontajnera
    time.set(1000 + craneOpDuration(HOME, FAR));
    expect(motion.pose()).toEqual({ gantryY: FAR.y, trolleyX: FAR.x, hoist: 0, cargo: null, phase: 'idle' });
    expect(motion.busy).toBe(false);
  });

  it('take: prázdny spreader ide nad slot, spustí sa, kontajner uchopí, zdvihne a na vrchole odovzdá (vytratí)', () => {
    const time = clock(0);
    const motion = new YardCraneMotion(HOME, time.now);
    motion.push(take(NEAR));
    const travelMs = craneOpDuration(HOME, NEAR) - CRANE_PHASE_MS.lower - CRANE_PHASE_MS.hold - CRANE_PHASE_MS.lift;
    expect(motion.pose().cargo).toBeNull(); // prázdny spreader
    time.set(travelMs + CRANE_PHASE_MS.lower + CRANE_PHASE_MS.hold * 0.5);
    const grabbing = motion.pose();
    expect(grabbing.phase).toBe('hold');
    expect(grabbing.cargo?.alpha).toBeCloseTo(0.5, 9); // kontajner sa objavuje pri uchopení
    time.set(travelMs + CRANE_PHASE_MS.lower + CRANE_PHASE_MS.hold + CRANE_PHASE_MS.lift * 0.5);
    const lifting = motion.pose();
    expect(lifting.phase).toBe('lift');
    expect(lifting.cargo?.alpha).toBe(1);
    expect(lifting.cargo?.scale).toBeGreaterThan(1);
    time.set(travelMs + CRANE_PHASE_MS.lower + CRANE_PHASE_MS.hold + CRANE_PHASE_MS.lift * 0.99);
    expect(motion.pose().cargo?.alpha).toBeLessThan(0.1); // odovzdané vozidlu
    time.set(craneOpDuration(HOME, NEAR) + 1);
    expect(motion.pose().cargo).toBeNull();
  });

  it('poloha je spojitá (žiadny skok) počas celej operácie a zhodná s cieľom po skončení', () => {
    const time = clock(0);
    const motion = new YardCraneMotion(HOME, time.now);
    motion.push(put(FAR));
    let last = motion.pose();
    const total = craneOpDuration(HOME, FAR);
    for (let ms = 10; ms <= total + 50; ms += 10) {
      time.set(ms);
      const pose = motion.pose();
      expect(Math.hypot(pose.gantryY - last.gantryY, pose.trolleyX - last.trolleyX)).toBeLessThan(0.12); // špička rýchlosti ~10 buniek/s = 0,1 bunky za 10 ms
      expect(Math.abs(pose.hoist - last.hoist)).toBeLessThan(0.2);
      last = pose;
    }
    expect([last.gantryY, last.trolleyX]).toEqual([FAR.y, FAR.x]);
  });

  it('operácia počas bežiacej sa zaradí ako jediná čakajúca (ďalšia ju nahradí) a nadväzuje na koniec predchádzajúcej', () => {
    const time = clock(0);
    const motion = new YardCraneMotion(HOME, time.now);
    motion.push(put(FAR));
    time.set(100);
    motion.push(take(NEAR)); // čaká
    motion.push(take({ x: -1, y: 1 })); // nahradí čakajúcu
    const firstEnd = craneOpDuration(HOME, FAR);
    time.set(firstEnd - 1);
    expect(motion.pose().phase).toBe('lift'); // prvá ešte beží
    time.set(firstEnd + 10);
    const second = motion.pose();
    expect(second.phase).toBe('travel'); // druhá začala, nadväzuje na koniec prvej (cez jej trvanie)
    expect(second.gantryY).toBeCloseTo(FAR.y, 1); // ešte pri mieste, kde prvá skončila
    time.set(firstEnd + craneOpDuration(FAR, { x: -1, y: 1 }) + 5);
    expect(motion.pose()).toEqual({ gantryY: 1, trolleyX: -1, hoist: 0, cargo: null, phase: 'idle' }); // bola vykonaná len posledná
    expect(motion.busy).toBe(false);
  });

  it('prefers-reduced-motion: žeriav bez animácie skočí nad cieľ, nie je zaneprázdnený a nemá kontajner', () => {
    const time = clock(0);
    const motion = new YardCraneMotion(HOME, time.now, () => true);
    motion.push(put(FAR));
    expect(motion.busy).toBe(false);
    expect(motion.pose()).toEqual({ gantryY: FAR.y, trolleyX: FAR.x, hoist: 0, cargo: null, phase: 'idle' });
    time.advance(5000);
    expect(motion.pose().phase).toBe('idle');
  });

  it('`reducedMotion` sa číta pri každej operácii (používateľ ho môže zmeniť za behu)', () => {
    const time = clock(0);
    let reduced = false;
    const motion = new YardCraneMotion(HOME, time.now, () => reduced);
    motion.push(put(FAR));
    expect(motion.busy).toBe(true);
    reduced = true;
    motion.push(take(NEAR));
    expect(motion.busy).toBe(false);
    expect(motion.pose().gantryY).toBe(NEAR.y);
  });
});
