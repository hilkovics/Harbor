/**
 * Vstavané príkazy simulácie a ich registrácia (CLAUDE.md, pravidlo 7 — tabuľka tried, žiadny `switch`).
 * Nový príkaz = nová trieda so statickým `TYPE` a `fromJSON` + riadok v `BUILTIN_COMMANDS` (+ testy).
 *
 * Predvolený `commandRegistry` sa naplní pri načítaní `command-registry.ts`, takže `commandFromJSON` pozná
 * všetky príkazy bez ohľadu na to, odkiaľ ho konzument importuje.
 */
import { AcceptContractCommand } from './accept-contract';
import { BuyVehicleCommand } from './buy-vehicle';
import type { Command, SerializedCommand } from './command';
import type { CommandRegistry } from './command-registry';
import { DeclineContractCommand } from './decline-contract';
import { PlaceModuleCommand } from './place-module';
import { PlaceRoadCommand } from './place-road';
import { RemoveModuleCommand } from './remove-module';
import { RemoveRoadCommand } from './remove-road';
import { SellVehicleCommand } from './sell-vehicle';
import { SetGameSpeedCommand } from './set-game-speed';
import { SpawnShipDebugCommand } from './spawn-ship-debug';

/** Trieda príkazu, ktorú možno registrovať: typ v registri + factory zo serializovaného tvaru. */
export interface RegistrableCommand {
  readonly TYPE: string;
  fromJSON(json: SerializedCommand): Command;
}

/**
 * Vstavané príkazy v poradí registrácie (ARCHITECTURE §12.2): F1 + moduly F2 (T02-04) + ladiaca loď (T02-05) + vozidlá
 * F3 (T03-04) + kontrakty F5 (T05-03, ADR-026).
 */
export const BUILTIN_COMMANDS: readonly RegistrableCommand[] = Object.freeze([
  PlaceRoadCommand,
  RemoveRoadCommand,
  SetGameSpeedCommand,
  PlaceModuleCommand,
  RemoveModuleCommand,
  SpawnShipDebugCommand,
  BuyVehicleCommand,
  SellVehicleCommand,
  AcceptContractCommand,
  DeclineContractCommand,
]);

/** Zaregistruje všetky vstavané príkazy do `registry` (už registrovaný typ → `CommandError`). */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const command of BUILTIN_COMMANDS) {
    registry.register(command.TYPE, (json) => command.fromJSON(json));
  }
}
