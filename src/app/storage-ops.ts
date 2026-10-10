/**
 * Posledná operácia s kontajnerom na slote skladu (F5b č. 8, `ModuleVM.lastStorageOp`): sim ju nevedie, renderer ju potrebuje
 * na animáciu portálového žeriavu dvora. `SimBridge` ju skladá z udalostí `CargoMoved` (`to` alebo `from` je `in_storage`):
 * vozidlo kontajner uložilo (`put`) alebo vzalo (`take`). F6c: `empty` = operácia s prázdnym kontajnerom (`direction: 'empty'`), ktorý
 * `CargoMoved` nenesie — smer jednotky podá volajúci (`IsEmptyUnit`, `SimBridge`: ledger); jednotka, ktorá medzitým z ledgera zmizla
 * (odišla ako `exported`), je neznáma, takže `empty` nenesie. Stav je čisto prezentačný — nejde do save a nemení sa tok nákladu.
 */
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';

export interface StorageOp {
  readonly slot: number;
  /** Tick udalosti `CargoMoved`. */
  readonly tick: number;
  readonly kind: 'put' | 'take';
  /** F6c: operácia s prázdnym kontajnerom (kontajner na spreaderi žeriavu dvora je sivý); chýba = nie. */
  readonly empty?: true;
}

/** Je jednotka prázdny kontajner? (`SimBridge`: smer z ledgera; neznáma jednotka → `false`.) */
export type IsEmptyUnit = (unitId: EntityId) => boolean;

const NOT_EMPTY: IsEmptyUnit = () => false;

/** Posledná operácia podľa `id` skladu. */
export type StorageOps = ReadonlyMap<number, StorageOp>;

export class StorageOpTracker {
  private readonly ops = new Map<number, StorageOp>();

  /** Posledné operácie podľa skladu; referencia je stabilná (obsah sa mení cez `record`). */
  get view(): StorageOps {
    return this.ops;
  }

  /**
   * Spracuje udalosti frameu v poradí vzniku: `CargoMoved` z / do `in_storage` zapíše operáciu skladu (neskoršia prepíše
   * skoršiu; `isEmpty` rozhodne o `empty`), `ModuleRemoved` operáciu zabudne.
   */
  record(events: readonly SimEvent[], isEmpty: IsEmptyUnit = NOT_EMPTY): void {
    for (const event of events) {
      if (event.type === 'ModuleRemoved') {
        this.ops.delete(event.moduleId);
      } else if (event.type === 'CargoMoved') {
        const touchesStorage = event.from.kind === 'in_storage' || event.to.kind === 'in_storage';
        const empty = touchesStorage && isEmpty(event.unitId) ? ({ empty: true } as const) : {};
        if (event.from.kind === 'in_storage') this.ops.set(event.from.moduleId, { slot: event.from.slot, tick: event.tick, kind: 'take', ...empty });
        if (event.to.kind === 'in_storage') this.ops.set(event.to.moduleId, { slot: event.to.slot, tick: event.tick, kind: 'put', ...empty });
      }
    }
  }
}
