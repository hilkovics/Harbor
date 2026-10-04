/**
 * Sebakontrola pomocníkov fázy 4 (T04-05): čisté funkcie, ktoré testy `f4-*` používajú na vyhodnotenie udalostí
 * (FSM kamióna, prechody bránou, throttle `NoWaitingBay`, reťaz pohybov jednotky). Beží nad vymyslenými udalosťami, takže
 * nepotrebuje implementáciu F4 — chytí chybu v pomocníkoch skôr, než by ju zhodila implementácia.
 */
import { describe, expect, it } from 'vitest';
import type { CargoLocation } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import {
  EXPORT_CHAIN_KINDS,
  TRUCK_CYCLE,
  exportChainViolation,
  gateCrossingTicks,
  landsideEvents,
  maxNoWaitingBayPerRampHour,
  minGap,
  moveChains,
  truckFsmViolation,
  truckStateChains,
  type LandsideEvent,
  type TruckState,
} from './f4';
import { type TimedEvent } from './harbor';

const timed = (tick: number, event: LandsideEvent, hour = 0): TimedEvent => ({ tick, hour, event }) as unknown as TimedEvent;
const change = (tick: number, truckId: number, from: TruckState, to: TruckState): TimedEvent =>
  timed(tick, { type: 'TruckStateChanged', truckId: truckId as EntityId, from, to });

/** Kompletný životný cyklus jedného kamióna (každý stav 5 tickov od ticku `start`). */
function cycle(truckId: number, start: number): TimedEvent[] {
  return TRUCK_CYCLE.slice(1).map((to, index) => change(start + 5 * (index + 1), truckId, TRUCK_CYCLE[index], to));
}

describe('truckFsmViolation', () => {
  it('kanonický cyklus s prípadným záverečným to_portal → exited je v poriadku', () => {
    const events = [...cycle(1, 0), change(50, 1, 'to_portal', 'exited')];
    expect(truckFsmViolation(events)).toBeNull();
  });

  it('preskočený stav, zlý začiatok a nenadväzujúce from sa nahlásia', () => {
    expect(truckFsmViolation([change(1, 1, 'to_gate', 'waiting')])).toMatch(/nie je povolený prechod/);
    expect(truckFsmViolation([change(1, 1, 'waiting', 'to_dock')])).toMatch(/predošlý stav kamióna bol to_gate/);
    expect(truckFsmViolation([change(1, 1, 'to_gate', 'gate_queue'), change(2, 1, 'to_bay', 'waiting')])).toMatch(/predošlý stav kamióna bol gate_queue/);
  });

  it('no_path sa vracia do stavu, z ktorého kamión vypadol', () => {
    const ok = [change(1, 1, 'to_gate', 'no_path'), change(2, 1, 'no_path', 'to_gate')];
    expect(truckFsmViolation(ok)).toBeNull();
    const wrong = [change(1, 1, 'to_gate', 'gate_queue'), change(2, 1, 'gate_queue', 'to_bay'), change(3, 1, 'to_bay', 'no_path'), change(4, 1, 'no_path', 'to_dock')];
    expect(truckFsmViolation(wrong)).toMatch(/mal sa vrátiť tam/);
  });

  it('kamióny sa sledujú nezávisle', () => {
    const events = [change(1, 1, 'to_gate', 'gate_queue'), change(2, 2, 'to_gate', 'gate_queue'), change(3, 1, 'gate_queue', 'to_bay'), change(4, 2, 'gate_queue', 'to_bay')];
    expect(truckFsmViolation(events)).toBeNull();
  });
});

describe('truckStateChains', () => {
  it('zloží stavy po kamiónoch od to_gate', () => {
    const chains = truckStateChains([...cycle(7, 0), ...cycle(9, 3)]);
    expect([...chains.keys()]).toEqual([7, 9]);
    expect(chains.get(7 as EntityId)).toEqual([...TRUCK_CYCLE]);
  });
});

describe('prechody bránou', () => {
  const events = [
    change(100, 1, 'gate_queue', 'to_bay'),
    change(105, 2, 'to_bay', 'waiting'),
    change(118, 2, 'gate_queue', 'to_bay'),
    change(140, 1, 'gate_queue_out', 'to_portal'),
    change(141, 3, 'to_gate', 'gate_queue'),
  ];

  it('gateCrossingTicks berie prechody z gate_queue aj gate_queue_out v poradí vzniku', () => {
    expect(gateCrossingTicks(events)).toEqual([100, 118, 140]);
  });

  it('minGap je najmenší odstup po sebe idúcich hodnôt, Infinity pre menej než dve', () => {
    expect(minGap([100, 118, 140])).toBe(18);
    expect(minGap([100, 100])).toBe(0);
    expect(minGap([5])).toBe(Infinity);
    expect(minGap([])).toBe(Infinity);
  });
});

describe('maxNoWaitingBayPerRampHour', () => {
  it('počíta udalosti na rampu a hernú hodinu; rôzne hodiny a rampy sa nesčítajú', () => {
    const noBay = (tick: number, hour: number, rampId: number): TimedEvent => timed(tick, { type: 'NoWaitingBay', rampId: rampId as EntityId }, hour);
    expect(maxNoWaitingBayPerRampHour([])).toBe(0);
    expect(maxNoWaitingBayPerRampHour([noBay(1, 0, 8), noBay(400, 1, 8), noBay(1, 0, 9)])).toBe(1);
    expect(maxNoWaitingBayPerRampHour([noBay(1, 0, 8), noBay(20, 0, 8)])).toBe(2);
  });
});

describe('landsideEvents', () => {
  it('vyberie len udalosti daného typu', () => {
    const events = [change(1, 1, 'to_gate', 'gate_queue'), timed(2, { type: 'TruckExited', truckId: 1 as EntityId, units: 1 })];
    expect(landsideEvents(events, 'TruckExited').map((entry) => entry.event.units)).toEqual([1]);
    expect(landsideEvents(events, 'TruckSpawned')).toEqual([]);
  });
});

describe('exportChainViolation', () => {
  const unit = 5 as EntityId;
  const at = (kind: CargoLocation['kind']): CargoLocation => {
    switch (kind) {
      case 'on_ship':
        return { kind, shipId: 1 as EntityId };
      case 'in_crane':
        return { kind, craneId: 2 as EntityId };
      case 'on_apron':
        return { kind, berthId: 1 as EntityId, slot: 0 };
      case 'in_vehicle':
        return { kind, vehicleId: 9 as EntityId };
      case 'in_storage':
        return { kind, moduleId: 4 as EntityId, slot: 0 };
      case 'at_ramp':
        return { kind, rampId: 8 as EntityId, dock: 0 };
      case 'in_truck':
        return { kind, truckId: 20 as EntityId };
      default:
        return { kind: 'exported' } as CargoLocation;
    }
  };
  /** Reťaz pohybov; `wrongFromAt` prepíše `from` jedného pohybu lokáciou `in_crane` (nenadväzuje). */
  const chain = (wrongFromAt?: number): TimedEvent[] =>
    EXPORT_CHAIN_KINDS.slice(1).map((to, index) => ({
      tick: index,
      hour: 0,
      event: { type: 'CargoMoved', unitId: unit, from: at(index === wrongFromAt ? 'in_crane' : EXPORT_CHAIN_KINDS[index]), to: at(to), tick: index },
    }));

  it('presná osemkrokovská reťaz je v poriadku a moveChains ju zoskupí podľa jednotky', () => {
    const chains = moveChains(chain());
    expect([...chains.keys()]).toEqual([unit]);
    expect(exportChainViolation(unit, must(chains.get(unit)))).toBeNull();
  });

  it('chýbajúci krok, návrat a nenadväzujúci pohyb sa nahlásia', () => {
    const withoutRamp = chain().filter((_, index) => index !== 5);
    expect(exportChainViolation(unit, must(moveChains(withoutRamp).get(unit)))).toMatch(/reťaz/);
    expect(exportChainViolation(unit, must(moveChains(chain(3)).get(unit)))).toMatch(/reťaz|nenadväzuje/);
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('očakávaná hodnota');
  return value;
}
