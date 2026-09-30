/**
 * Command pattern (CLAUDE.md, pravidlo 5; ARCHITECTURE §6, §12.2): jediná cesta, ako hráč (alebo replay) mení svet.
 *
 * Tok: `world.enqueue(cmd)` → pred ďalším krokom 1 ticku (alebo v `world.applyPending()`) `World` zavolá
 * `validate(world)`; pri `ok === false` emituje `CommandRejected` a stav nemení, inak zavolá `apply(world)`.
 * Príkazy sú serializovateľné (`toJSON` ↔ `commandFromJSON`) → replay scenárov a save.
 * Príkazy hry dedia `SimCommand` (spoločné odmietnutie `game_over` po bankrote, ADR-027); `World` ho vynúti aj pre iné
 * implementácie `Command`.
 */
import type { World } from '../world/world';
import type { ValidationResult } from './validation';

/** JSON tvar príkazu: `type` + payload (len JSON hodnoty). */
export interface SerializedCommand {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface Command {
  /** Typ príkazu = kľúč v registri (`PlaceRoad`, `SetGameSpeed`, …); rovnaký ako `toJSON().type`. */
  readonly type: string;
  /**
   * Overí príkaz voči aktuálnemu stavu. **Nesmie meniť svet** ani spotrebovať `Rng` — UI ho volá pri každom pohybe ghostu.
   */
  validate(world: World): ValidationResult;
  /**
   * Vykoná príkaz. `World` ho volá len hneď po úspešnom `validate` nad tým istým stavom; udalosti emituje cez
   * `world.events`.
   */
  apply(world: World): void;
  /** Serializovateľný tvar; `commandFromJSON(cmd.toJSON())` vytvorí ekvivalentný príkaz. */
  toJSON(): SerializedCommand;
}
