/**
 * Zbierka udalostí za tick (ARCHITECTURE §12.1). Systémy volajú `emit`, na konci ticku `World`
 * zavolá `flush()` a prezentácia (render/UI) dostane udalosti len na čítanie.
 */

const NO_EVENTS: readonly never[] = Object.freeze([]);

export class EventBus<E> {
  private buffer: Readonly<E>[] = [];

  /** Počet udalostí čakajúcich na `flush()`. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Pridá udalosť do bufferu tohto ticku (udalosti sú readonly DTO). */
  emit(event: Readonly<E>): void {
    this.buffer.push(event);
  }

  /**
   * Vráti udalosti v poradí emitovania a buffer vyprázdni. Vrátené pole sa už nemení
   * (ďalšie `emit` ide do nového bufferu), takže ho možno bezpečne odovzdať prezentácii.
   */
  flush(): readonly Readonly<E>[] {
    if (this.buffer.length === 0) return NO_EVENTS;
    const events = this.buffer;
    this.buffer = [];
    return events;
  }
}
