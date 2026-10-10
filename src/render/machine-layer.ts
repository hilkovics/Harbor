/**
 * MachineLayer (R3, TR3-03): stroje v blokoch (`EntitiesVM.machines`, RTG) — `MachineView` podľa `id`. Portál sa kreslí nad vozidlami (kamión stojí pod ním
 * v pruhu), preto `WorldRenderer` vkladá `view` nad `EntityLayer`.
 */
import { Container } from 'pixi.js';
import type { CargoSpriteDeps } from './cargo-sprite';
import { MachineView } from './machine-view';
import { ReachStackerView } from './reach-stacker-view';
import { REACH_STACKER_ID } from './entity-assets';
import type { MachineVM } from './view-models';
import { ViewSync } from './view-sync';

export class MachineLayer {
  readonly view = new Container({ label: 'machines' });
  private readonly machines: ViewSync<MachineVM, MachineView | ReachStackerView>;

  constructor(deps: CargoSpriteDeps) {
    this.machines = new ViewSync<MachineVM, MachineView | ReachStackerView>({
      create: (vm) => {
        const view = vm.defId === REACH_STACKER_ID ? new ReachStackerView(vm, deps) : new MachineView(vm, deps);
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
    const view = this.machines.get(id);
    return view instanceof MachineView ? view : undefined;
  }

  /** View reach stackera `id` (R5; testy, ladenie). */
  reachStackerView(id: number): ReachStackerView | undefined {
    const view = this.machines.get(id);
    return view instanceof ReachStackerView ? view : undefined;
  }

  sync(machines: readonly MachineVM[]): void {
    this.machines.sync(machines);
  }

  destroy(): void {
    this.machines.clear();
    this.view.destroy({ children: true });
  }
}
