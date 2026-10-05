/**
 * Spoločný základ príkazov hráča (CLAUDE.md pravidlo 5; ARCHITECTURE §12.2; ADR-025 bod 5, ADR-027) — koniec hry
 * riešený na jednom mieste.
 *
 * `validate` je šablónová metóda: vyhodnotí pravidlá príkazu (`check`, implementuje podtrieda) a po `GameOver`
 * (`World.gameOver`, bankrot) výsledok prepíše na odmietnutie s jediným dôvodom `game_over` (`withGameOver`). Bunky
 * a cena z `check` ostávajú, aby ghost v UI vedel, čoho sa odmietnutie týka. Podtriedy `validate` neprepisujú.
 *
 * `World.applyQueuedCommands` volá `withGameOver` nad výsledkom `validate` každého príkazu zvlášť, takže po `GameOver`
 * sa neaplikuje ani príkaz, ktorý by `Command` implementoval bez tohto základu (poistka pre replay a testy).
 */
import type { World } from '../world/world';
import type { Command, SerializedCommand } from './command';
import type { ValidationReason, ValidationResult } from './validation';

const GAME_OVER_REASONS: readonly ValidationReason[] = Object.freeze(['game_over'] as const);

/**
 * Po `GameOver` odmietnutie `{ ok: false, reasons: ['game_over'] }` so zachovanými ostatnými poľami výsledku (bunky,
 * cena, pri `RoadQuote` aj rozpad ceny); inak `result` bez zmeny. Idempotentné.
 */
export function withGameOver<T extends ValidationResult>(world: Pick<World, 'gameOver'>, result: T): T {
  if (!world.gameOver) return result;
  return Object.freeze({ ...result, ok: false, reasons: GAME_OVER_REASONS });
}

export abstract class SimCommand implements Command {
  abstract readonly type: string;

  /** Pravidlá príkazu + koniec hry (viď hlavička súboru). Nemení svet ani `Rng`. */
  validate(world: World): ValidationResult {
    return withGameOver(world, this.check(world));
  }

  /**
   * Pravidlá príkazu bez ohľadu na koniec hry. **Nesmie meniť svet** ani spotrebovať `Rng` — UI volá `validate` pri
   * každom pohybe ghostu.
   */
  protected abstract check(world: World): ValidationResult;

  abstract apply(world: World): void;

  abstract toJSON(): SerializedCommand;
}
