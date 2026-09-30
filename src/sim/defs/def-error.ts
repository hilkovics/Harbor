/** Chyba defu: názov defu + JSON pointer na problémové pole (`''` = celý def). Správa: `<defName><path>: <problém>`. */
export class DefError extends Error {
  readonly defName: string;
  /** JSON pointer (RFC 6901), napr. `/tickGameSeconds` alebo `/items/2/params/apronSlots`; prázdny reťazec = koreň defu. */
  readonly path: string;
  readonly problem: string;

  constructor(defName: string, path: string, problem: string) {
    super(`${defName}${path}: ${problem}`);
    this.name = 'DefError';
    this.defName = defName;
    this.path = path;
    this.problem = problem;
  }
}
