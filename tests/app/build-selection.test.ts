import { describe, expect, it, vi } from 'vitest';
import { BuildSelection } from '@app/build-selection';

describe('BuildSelection (výber v BuildBar)', () => {
  it('na začiatku nie je nič vybrané', () => {
    expect(new BuildSelection().get()).toBeNull();
  });

  it('select nastaví výber a null ho zruší', () => {
    const selection = new BuildSelection();
    selection.select('berth_standard');
    expect(selection.get()).toBe('berth_standard');
    selection.select(null);
    expect(selection.get()).toBeNull();
  });

  it('poslucháč sa volá len pri skutočnej zmene', () => {
    const selection = new BuildSelection();
    const listener = vi.fn();
    selection.subscribe(listener);
    selection.select(null); // bez zmeny
    expect(listener).not.toHaveBeenCalled();
    selection.select('crane_container_gantry');
    selection.select('crane_container_gantry'); // bez zmeny
    expect(listener).toHaveBeenCalledTimes(1);
    selection.select(null);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('poslucháč pri volaní vidí už nový výber', () => {
    const selection = new BuildSelection();
    const seen: (string | null)[] = [];
    selection.subscribe(() => seen.push(selection.get()));
    selection.select('berth_standard');
    selection.select(null);
    expect(seen).toEqual(['berth_standard', null]);
  });

  it('unsubscribe zastaví doručovanie; rovnakú funkciu možno registrovať viackrát nezávisle', () => {
    const selection = new BuildSelection();
    const listener = vi.fn();
    const first = selection.subscribe(listener);
    const second = selection.subscribe(listener);
    selection.select('a');
    expect(listener).toHaveBeenCalledTimes(2);
    first();
    selection.select('b');
    expect(listener).toHaveBeenCalledTimes(3);
    second();
    selection.select('c');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('poslucháč odhlásený počas notifikácie sa už nezavolá', () => {
    const selection = new BuildSelection();
    const calls: string[] = [];
    let stopSecond: () => void = () => undefined;
    selection.subscribe(() => {
      calls.push('first');
      stopSecond();
    });
    stopSecond = selection.subscribe(() => calls.push('second'));
    selection.select('x');
    expect(calls).toEqual(['first']);
  });

  it('get, select a subscribe sú stabilné funkcie (priamo do useSyncExternalStore / props)', () => {
    const { get, select, subscribe } = new BuildSelection();
    const listener = vi.fn();
    subscribe(listener);
    select('berth_standard');
    expect(get()).toBe('berth_standard');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
