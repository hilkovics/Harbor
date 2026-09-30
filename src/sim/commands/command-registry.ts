/**
 * Register typov príkazov: `type` → factory (CLAUDE.md, pravidlo 7 — žiadny `switch`). Základ replay scenárov
 * a save (ARCHITECTURE §12.2): `commandFromJSON(cmd.toJSON())` vytvorí ekvivalentný príkaz.
 *
 * Nová `CommandRegistry` je prázdna; predvolený `commandRegistry` má vstavané príkazy (`BUILTIN_COMMANDS` v
 * `builtin-commands.ts`) zaregistrované pri načítaní tohto modulu (staticky), nie počas hry.
 */
import { registerBuiltinCommands } from './builtin-commands';
import type { Command, SerializedCommand } from './command';
import { CommandError } from './command-error';

export { CommandError } from './command-error';

/** Vytvorí príkaz zo serializovaného tvaru; pri neplatnom payloade vyhodí `CommandError`. */
export type CommandFactory = (json: SerializedCommand) => Command;

export class CommandRegistry {
  private readonly factories = new Map<string, CommandFactory>();

  /** Zaregistruje factory pre `type`; prázdny alebo už registrovaný typ → `CommandError`. */
  register(type: string, factory: CommandFactory): void {
    if (type.length === 0) throw new CommandError('CommandRegistry.register: typ príkazu nesmie byť prázdny');
    if (this.factories.has(type)) throw new CommandError(`CommandRegistry.register: typ '${type}' je už registrovaný`);
    this.factories.set(type, factory);
  }

  has(type: string): boolean {
    return this.factories.has(type);
  }

  /** Registrované typy v poradí registrácie. */
  get types(): readonly string[] {
    return [...this.factories.keys()];
  }

  /**
   * Príkaz zo serializovaného tvaru (napr. riadok scenára po `JSON.parse`). Vstup, ktorý nie je objekt s neprázdnym
   * reťazcom `type`, alebo neznámy typ → `CommandError`.
   */
  fromJSON(json: SerializedCommand): Command {
    const raw: unknown = json;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new CommandError('commandFromJSON: príkaz musí byť objekt { type, … }');
    }
    const { type } = raw as { type?: unknown };
    if (typeof type !== 'string' || type.length === 0) {
      throw new CommandError('commandFromJSON: /type musí byť neprázdny reťazec');
    }
    const factory = this.factories.get(type);
    if (factory === undefined) {
      const known = this.types.length > 0 ? this.types.join(', ') : '–';
      throw new CommandError(`commandFromJSON: neznámy typ príkazu '${type}' (registrované: ${known})`);
    }
    return factory(json);
  }
}

/** Predvolený register simulácie so vstavanými príkazmi; `commandFromJSON` číta z neho. */
export const commandRegistry = new CommandRegistry();
registerBuiltinCommands(commandRegistry);

/** Príkaz zo serializovaného tvaru cez predvolený register (neznámy typ → `CommandError`). */
export function commandFromJSON(json: SerializedCommand): Command {
  return commandRegistry.fromJSON(json);
}
