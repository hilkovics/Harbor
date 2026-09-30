/**
 * Vstavané príkazy simulácie a ich registrácia (CLAUDE.md, pravidlo 7 — tabuľka tried, žiadny `switch`).
 * Nový príkaz = nová trieda so statickým `TYPE` a `fromJSON` + riadok v `BUILTIN_COMMANDS` (+ testy).
 *
 * Predvolený `commandRegistry` sa naplní pri načítaní `command-registry.ts`, takže `commandFromJSON` pozná
 * všetky príkazy bez ohľadu na to, odkiaľ ho konzument importuje.
 */
import type { Command, SerializedCommand } from './command';
import type { CommandRegistry } from './command-registry';
import { PlaceModuleCommand } from './place-module';
import { PlaceRoadCommand } from './place-road';
import { RemoveModuleCommand } from './remove-module';
import { RemoveRoadCommand } from './remove-road';
import { SetGameSpeedCommand } from './set-game-speed';

/** Trieda príkazu, ktorú možno registrovať: typ v registri + factory zo serializovaného tvaru. */
export interface RegistrableCommand {
  readonly TYPE: string;
  fromJSON(json: SerializedCommand): Command;
}

/** Vstavané príkazy v poradí registrácie (ARCHITECTURE §12.2): F1 + moduly F2 (T02-04). */
export const BUILTIN_COMMANDS: readonly RegistrableCommand[] = Object.freeze([
  PlaceRoadCommand,
  RemoveRoadCommand,
  SetGameSpeedCommand,
  PlaceModuleCommand,
  RemoveModuleCommand,
]);

/** Zaregistruje všetky vstavané príkazy do `registry` (už registrovaný typ → `CommandError`). */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const command of BUILTIN_COMMANDS) {
    registry.register(command.TYPE, (json) => command.fromJSON(json));
  }
}
