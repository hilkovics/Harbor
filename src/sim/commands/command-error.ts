/**
 * Chyba príkazu ako dát (nie odmietnutie hráčovej akcie — to je `ValidationResult` / `CommandRejected`).
 *
 * Samostatný súbor, aby ju mohli importovať implementácie príkazov aj `command-registry.ts` bez cyklu importov
 * (register pri načítaní importuje vstavané príkazy, `builtin-commands.ts`).
 */

/**
 * Neplatný serializovaný príkaz (neznámy typ, zlý tvar payloadu), neplatné argumenty konštruktora príkazu
 * (napr. necelé súradnice bunky) alebo chyba registrácie typu.
 */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}
