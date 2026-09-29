/**
 * Vstavané príkazy simulácie a ich registrácia (CLAUDE.md, pravidlo 7 — tabuľka tried, žiadny `switch`).
 * Nový príkaz = nová trieda so statickým `TYPE` a `fromJSON` + riadok v `BUILTIN_COMMANDS` (+ testy).
 *
 * Predvolený `commandRegistry` sa naplní pri načítaní `command-registry.ts`, takže `commandFromJSON` pozná
 * všetky príkazy bez ohľadu na to, odkiaľ ho konzument importuje.
 */
import type { Command, SerializedCommand } from './command';
import type { CommandRegistry } from './command-registry';
import { PlaceRoadCommand } from './place-road';
import { RemoveRoadCommand } from './remove-road';
import { SetGameSpeedCommand } from './set-game-speed';

/** Trieda príkazu, ktorú možno registrovať: typ v registri + factory zo serializovaného tvaru. */
export interface RegistrableCommand {
  readonly TYPE: string;
  fromJSON(json: SerializedCommand): Command;
}

/** Príkazy F1 v poradí registrácie (ARCHITECTURE §12.2). */
export const BUILTIN_COMMANDS: readonly RegistrableCommand[] = Object.freeze([
  PlaceRoadCommand,
  RemoveRoadCommand,
  SetGameSpeedCommand,
]);

/** Zaregistruje všetky vstavané príkazy do `registry` (už registrovaný typ → `CommandError`). */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const command of BUILTIN_COMMANDS) {
    registry.register(command.TYPE, (json) => command.fromJSON(json));
  }
}
