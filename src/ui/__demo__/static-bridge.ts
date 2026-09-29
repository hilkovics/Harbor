/**
 * Statický falošný `SimBridge` pre dema UI a testy: drží jeden snapshot v pamäti, `dispatch(SetGameSpeed)` ho prepíše
 * a notifikuje odberateľov (demo je preto klikateľné bez simulácie). Tvar `SimBridge` je trieda so súkromnými poľami,
 * preto je jediné miesto, kde sa falošný objekt pretypuje, `asBridge` nižšie.
 */
import type { Command, SerializedCommand, ValidationResult } from '@sim/commands';
import type { Grid, Parcel } from '@sim/grid';
import type { SimBridge, WorldSnapshot } from '@app/sim-bridge';
import timeDef from '@data/defs/time.json';

export interface StaticState {
  readonly cashCents: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly speed: number;
}

/** Rýchlosti priamo z `data/defs/time.json`, aby demo nezaostalo za defom. */
export const DEMO_SPEEDS: readonly number[] = timeDef.speeds;

/** Výchozí stav dema: 1 200 000 USD, Deň 12 (0-based 11), 14:20, rýchlosť 1×. */
export const DEFAULT_STATIC_STATE: StaticState = { cashCents: 120_000_000, day: 11, hour: 14, minute: 20, speed: 1 };

const OK: ValidationResult = Object.freeze({ ok: true, reasons: [], cells: [], costCents: 0 });

export interface StaticBridge {
  readonly bridge: SimBridge;
  /** Serializované príkazy, ktoré HUD odoslal (v poradí). */
  readonly dispatched: SerializedCommand[];
  /** Prepíše časť stavu a notifikuje odberateľov. */
  set(patch: Partial<StaticState>): void;
}

export function createStaticBridge(initial: Partial<StaticState> = {}, speeds: readonly number[] = DEMO_SPEEDS): StaticBridge {
  const listeners = new Set<() => void>();
  const dispatched: SerializedCommand[] = [];
  let state: StaticState = { ...DEFAULT_STATIC_STATE, ...initial };
  const build = (): WorldSnapshot =>
    Object.freeze({
      tick: 0,
      ...state,
      grid: null as unknown as Grid,
      parcels: new Map<string, Parcel>(),
    });
  let snapshot = build();

  const set = (patch: Partial<StaticState>): void => {
    state = { ...state, ...patch };
    snapshot = build();
    for (const listener of [...listeners]) listener();
  };

  const fake = {
    world: { defs: { time: { speeds } } },
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (command: Command) => {
      const json = command.toJSON();
      dispatched.push(json);
      if (json.type === 'SetGameSpeed' && typeof json.speed === 'number') set({ speed: json.speed });
    },
    validate: () => OK,
  };
  // Jediné pretypovanie: `SimBridge` je trieda so súkromnými poľami, štrukturálne ju falošný objekt nespĺňa.
  const asBridge = fake as unknown as SimBridge;
  return { bridge: asBridge, dispatched, set };
}
