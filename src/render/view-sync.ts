/**
 * Synchronizácia views s view-modelmi podľa `id` (ARCHITECTURE §15.1): nový `id` → vytvor view, zmizol → zruš,
 * zmenená statická časť → vytvor nanovo, inak len `update`. Spoločné pre `ModuleLayer`, `EntityLayer`, `CraneLayer`.
 *
 * Pre nezmenené entity sa nič nealokuje: pracovná množina `seen` je súčasťou `ViewSync` a používa sa opakovane.
 */

/** View riadené `ViewSync`. */
export interface SyncedView {
  destroy(): void;
}

export interface ViewSyncHooks<VM extends { readonly id: number }, V extends SyncedView> {
  /** `false` = VM sa tejto vrstve netýka (napr. žeriav v zozname modulov) a preskočí sa; predvolene sa berú všetky. */
  accepts?(vm: VM): boolean;
  /** Vytvorí view a pridá ho do scény. */
  create(vm: VM): V;
  /** Odstráni view zo scény a zruší ho (`view.destroy()` je nutné volať). */
  remove(view: V): void;
  /** `false`, ak sa zmenila statická časť VM a view treba vytvoriť nanovo (napr. iná poloha / rotácia / def). */
  matches(view: V, vm: VM): boolean;
  /** Aktualizuje dynamickú časť view. */
  update(view: V, vm: VM): void;
}

export class ViewSync<VM extends { readonly id: number }, V extends SyncedView> {
  private readonly views = new Map<number, V>();
  private readonly seen = new Set<number>();

  constructor(private readonly hooks: ViewSyncHooks<VM, V>) {}

  get size(): number {
    return this.views.size;
  }

  get(id: number): V | undefined {
    return this.views.get(id);
  }

  has(id: number): boolean {
    return this.views.has(id);
  }

  /** Prejde všetky views (poradie vzniku). */
  forEach(callback: (view: V, id: number) => void): void {
    this.views.forEach(callback);
  }

  /** Zosúladí views s `vms`. */
  sync(vms: readonly VM[]): void {
    const { views, seen, hooks } = this;
    seen.clear();
    for (const vm of vms) {
      if (hooks.accepts?.(vm) === false) continue;
      seen.add(vm.id);
      let view = views.get(vm.id);
      if (view !== undefined && !hooks.matches(view, vm)) {
        hooks.remove(view);
        views.delete(vm.id);
        view = undefined;
      }
      if (view === undefined) {
        views.set(vm.id, hooks.create(vm));
      } else {
        hooks.update(view, vm);
      }
    }
    views.forEach((view, id) => {
      if (seen.has(id)) return;
      hooks.remove(view);
      views.delete(id);
    });
  }

  /** Zruší všetky views. */
  clear(): void {
    this.views.forEach((view) => {
      this.hooks.remove(view);
    });
    this.views.clear();
    this.seen.clear();
  }
}
