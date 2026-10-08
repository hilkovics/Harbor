/**
 * MachineLayer (R3, TR3-03): stroje v blokoch (`EntitiesVM.machines`, RTG) — `MachineView` podľa `id`. Portál sa kreslí nad vozidlami (kamión stojí pod ním
 * v pruhu), preto `WorldRenderer` vkladá `view` nad `EntityLayer`.
 */
import { Container } from 'pixi.js';
import type { CargoSpriteDeps } from './cargo-sprite';
import { MachineView } from './machine-view';
import type { MachineVM } from './view-models';
import { ViewSync } from './view-sync';

export class MachineLayer {
  readonly view = new Container({ label: 'machines' });
  private readonly machines: ViewSync<MachineVM, MachineView>;

  constructor(deps: CargoSpriteDeps) {
    this.machines = new ViewSync<MachineVM, MachineView>({
      create: (vm) => {
        const view = new MachineView(vm, deps);
        this.view.addChild(view.view);
        return view;
      },
      remove: (view) => {
        view.destroy();
      },
      matches: (view, vm) => view.vm.defId === vm.defId && view.vm.blockId === vm.blockId,
      update: (view, vm) => {
        view.update(vm);
      },
    });
  }

  /** Počet nakreslených strojov. */
  get machineCount(): number {
    return this.machines.size;
  }

  /** View stroja `id` (testy, ladenie). */
  machineView(id: number): MachineView | undefined {
    return this.machines.get(id);
  }

  sync(machines: readonly MachineVM[]): void {
    this.machines.sync(machines);
  }

  destroy(): void {
    this.machines.clear();
    this.view.destroy({ children: true });
  }
}
