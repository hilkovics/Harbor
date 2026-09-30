/**
 * Herné hodiny simulácie (ARCHITECTURE §3): `{ tick, speed }` + odvodené minúta/hodina/deň/mesiac.
 *
 * Hodiny eventy neemitujú — `advance()` iba vráti uzavreté hranice; `HourClosed`/`DayClosed`/`MonthClosed`
 * emituje `World` cez `EventBus` (krok 1 v `World.tick()`). Trvanie ticku pochádza z `time` defu (`tickGameSeconds`).
 *
 * Dve sady odvodených hodnôt (všetky 0-based):
 * - celkové počty od začiatku hry: `gameMinute`, `gameHour`, `gameDay`, `gameMonth`;
 * - kalendárne zložky pre HUD: `minuteOfHour` (0–59), `hourOfDay` (0–23), `dayOfMonth` (0–29).
 */

/** Konfigurácia hodín; štrukturálne kompatibilná s `TimeDef` (T00-10), ktorý má ďalšie polia. */
export interface SimClockConfig {
  /** Koľko herných sekúnd trvá jeden tick (musí deliť 60 bezo zvyšku). */
  readonly tickGameSeconds: number;
}

/** Serializovateľný stav hodín (do save). */
export interface SimClockState {
  readonly tick: number;
  readonly speed: number;
}

/** Ktoré hranice sa uzavreli počas jedného `advance()`. Uzavretý mesiac implikuje uzavretý deň aj hodinu. */
export interface ClockBoundaries {
  readonly hourClosed: boolean;
  readonly dayClosed: boolean;
  readonly monthClosed: boolean;
}

// Kalendárne konštanty herného času (ARCHITECTURE §3) — skutočné konštanty, nie laditeľné hodnoty.
/** Sekúnd v minúte (§3). */
export const SECONDS_PER_MINUTE = 60;
/** Minút v hodine (§3). */
const MINUTES_PER_HOUR = 60;
/** Hodín v dni (§3). */
const HOURS_PER_DAY = 24;
/** Dní v mesiaci — herný mesiac má vždy 30 dní (§3). */
const DAYS_PER_MONTH = 30;
/**
 * Počiatočná rýchlosť novej hry: 1× = štandardná (§3). Musí byť v `time.speeds` — overuje `World.create`
 * (schéma `time` vyžaduje len 0).
 */
export const INITIAL_SPEED = 1;

function assertValidSpeed(speed: number): void {
  if (!Number.isInteger(speed) || speed < 0) {
    throw new RangeError(`SimClock: rýchlosť musí byť celé číslo ≥ 0 (0 = pauza), dostal ${String(speed)}`);
  }
}

export class SimClock {
  /** Ticky v jednej hernej minúte (pri `tickGameSeconds: 10` je to 6). */
  readonly ticksPerMinute: number;
  /** Ticky v hernej hodine (360). */
  readonly ticksPerHour: number;
  /** Ticky v hernom dni (8 640). */
  readonly ticksPerDay: number;
  /** Ticky v hernom mesiaci (259 200). */
  readonly ticksPerMonth: number;

  private currentTick: number;
  private currentSpeed: number;

  /**
   * @param config trvanie ticku (z `time` defu)
   * @param state voliteľný uložený stav; bez neho začína tick 0 pri rýchlosti 1×
   */
  constructor(config: SimClockConfig, state: SimClockState = { tick: 0, speed: INITIAL_SPEED }) {
    const { tickGameSeconds } = config;
    if (!Number.isInteger(tickGameSeconds) || tickGameSeconds < 1 || SECONDS_PER_MINUTE % tickGameSeconds !== 0) {
      throw new RangeError(
        `SimClock: tickGameSeconds musí byť celé číslo, ktoré deli ${SECONDS_PER_MINUTE}, dostal ${String(tickGameSeconds)}`,
      );
    }
    this.ticksPerMinute = SECONDS_PER_MINUTE / tickGameSeconds;
    this.ticksPerHour = this.ticksPerMinute * MINUTES_PER_HOUR;
    this.ticksPerDay = this.ticksPerHour * HOURS_PER_DAY;
    this.ticksPerMonth = this.ticksPerDay * DAYS_PER_MONTH;

    if (!Number.isSafeInteger(state.tick) || state.tick < 0) {
      throw new RangeError(`SimClock: tick musí byť celé číslo ≥ 0, dostal ${String(state.tick)}`);
    }
    assertValidSpeed(state.speed);
    this.currentTick = state.tick;
    this.currentSpeed = state.speed;
  }

  /** Obnoví hodiny z uloženého stavu (pozri `getState`). */
  static fromState(config: SimClockConfig, state: SimClockState): SimClock {
    return new SimClock(config, state);
  }

  /** Stav pre save. */
  getState(): SimClockState {
    return { tick: this.currentTick, speed: this.currentSpeed };
  }

  /** Počet dokončených tickov od začiatku hry. */
  get tick(): number {
    return this.currentTick;
  }

  /** Rýchlosť hry (0 = pauza). Hodiny ju samy nevynucujú — tick-y riadi `GameLoop`. */
  get speed(): number {
    return this.currentSpeed;
  }

  // Odvodené hodnoty sú celkové počty uplynulých jednotiek od začiatku hry (0-based), nie kalendárne zložky.

  /** Uplynulé herné minúty od začiatku hry. */
  get gameMinute(): number {
    return Math.floor(this.currentTick / this.ticksPerMinute);
  }

  /** Uplynulé herné hodiny od začiatku hry. */
  get gameHour(): number {
    return Math.floor(this.currentTick / this.ticksPerHour);
  }

  /** Uplynulé herné dni od začiatku hry (prvý deň = 0). */
  get gameDay(): number {
    return Math.floor(this.currentTick / this.ticksPerDay);
  }

  /** Uplynulé herné mesiace od začiatku hry (prvý mesiac = 0). */
  get gameMonth(): number {
    return Math.floor(this.currentTick / this.ticksPerMonth);
  }

  // Kalendárne zložky (0-based) — odvodené z tickových konštánt vyššie, bez ďalších čísel. HUD: „Deň N · HH:MM“.

  /** Minúta v rámci aktuálnej hodiny, 0–59. */
  get minuteOfHour(): number {
    return this.gameMinute % MINUTES_PER_HOUR;
  }

  /** Hodina v rámci aktuálneho dňa, 0–23. */
  get hourOfDay(): number {
    return this.gameHour % HOURS_PER_DAY;
  }

  /** Deň v rámci aktuálneho mesiaca, 0-based (0–29; herný mesiac má vždy 30 dní). */
  get dayOfMonth(): number {
    return this.gameDay % DAYS_PER_MONTH;
  }

  /** Nastaví rýchlosť (celé číslo ≥ 0; povolené hodnoty z `time.speeds` overuje `SetGameSpeed`). */
  setSpeed(speed: number): void {
    assertValidSpeed(speed);
    this.currentSpeed = speed;
  }

  /** Posunie hodiny o jeden tick a vráti hranice, ktoré sa práve uzavreli. */
  advance(): ClockBoundaries {
    this.currentTick += 1;
    return {
      hourClosed: this.currentTick % this.ticksPerHour === 0,
      dayClosed: this.currentTick % this.ticksPerDay === 0,
      monthClosed: this.currentTick % this.ticksPerMonth === 0,
    };
  }
}
