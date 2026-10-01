/**
 * Malý pozorovateľný výber jednej hodnoty (`T | null`) zdieľaný medzi Reactom a ovládaním mapy. Rovnaký vzor ako
 * `subscribeFeedback` v `InputController`: žiadna knižnica, `get` a `subscribe` sú stabilné funkcie (arrow vlastnosti),
 * takže ich možno dať priamo do `useSyncExternalStore`.
 *
 * Používajú ho `BuildSelection` (vybraná položka BuildBaru, `defId`) a `ModuleSelection` (modul v inšpektore, `id`).
 */
export type SelectionListener = () => void;

/** Čo potrebuje ovládanie mapy z výberu: čítať, meniť a odoberať zmeny. */
export interface SelectionSource<T> {
  /** Aktuálna hodnota; `null` = nič nie je vybrané. */
  readonly get: () => T | null;
  /** Nastaví výber (`null` = zrušiť). */
  readonly select: (value: T | null) => void;
  /** Odber zmien; vráti funkciu na odhlásenie. */
  readonly subscribe: (listener: SelectionListener) => () => void;
}

export class SelectionCell<T> implements SelectionSource<T> {
  private current: T | null = null;
  private readonly listeners = new Set<{ readonly listener: SelectionListener }>();

  readonly get = (): T | null => this.current;

  /** Nastaví výber (`null` = zrušiť); poslucháčov volá len pri skutočnej zmene. */
  readonly select = (value: T | null): void => {
    if (value === this.current) return;
    this.current = value;
    for (const registration of [...this.listeners]) {
      if (this.listeners.has(registration)) registration.listener();
    }
  };

  /** Odber zmien výberu; vráti funkciu na odhlásenie. Obal umožňuje registrovať tú istú funkciu viackrát. */
  readonly subscribe = (listener: SelectionListener): (() => void) => {
    const registration = { listener };
    this.listeners.add(registration);
    return () => {
      this.listeners.delete(registration);
    };
  };
}
