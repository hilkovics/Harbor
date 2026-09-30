/**
 * Výber položky v BuildBar (`selectedDefId`) — malý pozorovateľný stav zdieľaný medzi Reactom (BuildBar) a ovládaním
 * mapy (`InputController`, build mód modulov v T02-10). Rovnaký vzor ako `subscribeFeedback` v `InputController`:
 * žiadna knižnica, `subscribe` + `get` sú stabilné funkcie, takže ich možno dať priamo do `useSyncExternalStore`.
 *
 * Vo F2 (T02-09) výber len nastaví `defId`; build mód (ghost, umiestnenie) pripojí T02-10 odberom `subscribe`.
 */
export type SelectionListener = () => void;

export class BuildSelection {
  private current: string | null = null;
  private readonly listeners = new Set<{ readonly listener: SelectionListener }>();

  /** Vybraná definícia modulu (`berth_standard`), alebo `null` = nič nie je vybrané. */
  readonly get = (): string | null => this.current;

  /** Nastaví výber (`null` = zrušiť); poslucháčov volá len pri skutočnej zmene. */
  readonly select = (defId: string | null): void => {
    if (defId === this.current) return;
    this.current = defId;
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
