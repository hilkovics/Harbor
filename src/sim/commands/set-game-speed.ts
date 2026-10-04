/**
 * `SetGameSpeed { speed }` — zmena rýchlosti hry (ARCHITECTURE §3, §12.2). Povolené sú len hodnoty
 * z `time.speeds` (0 = pauza, tiež platná); inak `invalid_speed`. `apply` nastaví `clock.speed` a emituje práve
 * jeden `GameSpeedChanged` — aj keď sa rýchlosť nemení (príkaz je idempotentný, udalosť potvrdzuje stav).
 * Koľko tickov sa vykoná za frame, riadi `GameLoop` podľa `clock.speed`; sim tu nič iné nemení.
 */
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { SimCommand } from './sim-command';
import { checkFiniteNumber, readPayload } from './payload';
import type { ValidationResult } from './validation';

/** Kľúče serializovaného tvaru `{ type, speed }`. */
const SET_GAME_SPEED_KEYS: readonly string[] = ['type', 'speed'];

const VALID: ValidationResult = Object.freeze({ ok: true, reasons: Object.freeze([]), cells: Object.freeze([]), costCents: 0 });
const INVALID_SPEED: ValidationResult = Object.freeze({
  ok: false,
  reasons: Object.freeze(['invalid_speed'] as const),
  cells: Object.freeze([]),
  costCents: 0,
});

export class SetGameSpeedCommand extends SimCommand {
  static readonly TYPE = 'SetGameSpeed';

  readonly type = SetGameSpeedCommand.TYPE;
  /** Požadovaný násobok rýchlosti (0 = pauza). */
  readonly speed: number;

  /** @param speed konečné číslo (inak `CommandError`); či je v `time.speeds`, overí `validate`. */
  constructor(speed: number) {
    super();
    this.speed = checkFiniteNumber(speed, SetGameSpeedCommand.TYPE, '/speed');
  }

  /** Príkaz z tvaru `{ type: 'SetGameSpeed', speed }`; iný tvar → `CommandError`. */
  static fromJSON(json: SerializedCommand): SetGameSpeedCommand {
    const raw = readPayload(json, SetGameSpeedCommand.TYPE, SET_GAME_SPEED_KEYS);
    return new SetGameSpeedCommand(checkFiniteNumber(raw['speed'], SetGameSpeedCommand.TYPE, '/speed'));
  }

  protected check(world: World): ValidationResult {
    return world.defs.time.speeds.includes(this.speed) ? VALID : INVALID_SPEED;
  }

  /** Vykoná príkaz; svet ho volá len po úspešnom `validate` (inak `Error`, nič nezmení). */
  apply(world: World): void {
    if (!this.validate(world).ok) {
      throw new Error(`${this.type}.apply: rýchlosť ${String(this.speed)} nie je v time.speeds — volaj apply len po úspešnom validate`);
    }
    world.clock.setSpeed(this.speed);
    world.events.emit({ type: 'GameSpeedChanged', speed: this.speed });
  }

  toJSON(): SerializedCommand {
    return { type: this.type, speed: this.speed };
  }
}
