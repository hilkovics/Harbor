/**
 * TrainLayer (R6, TR6-03): vlaky (`EntitiesVM.trains`) — `TrainView` podľa `id`. Kreslí sa nad vozidlami a pod strojmi (RMG je nad vlakom).
 */
import { Container } from 'pixi.js';
import type { CargoSpriteDeps } from './cargo-sprite';
import type { RailPath } from './rail-path';
import { TrainView } from './train-view';
import type { TrainVM } from './view-models';
import { ViewSync } from './view-sync';

export class TrainLayer {
  readonly view = new Container({ label: 'trains' });
  private readonly trains: ViewSync<TrainVM, TrainView>;

  constructor(deps: CargoSpriteDeps, paths: () => readonly RailPath[] = () => []) {
    this.trains = new ViewSync<TrainVM, TrainView>({
      create: (vm) => {
        const view = new TrainView(vm, deps, paths);
        this.view.addChild(view.view);
        return view;
      },
      remove: (view) => {
        view.destroy();
      },
      matches: () => true,
      update: (view, vm) => {
        view.update(vm);
      },
    });
  }

  /** Počet nakreslených vlakov. */
  get trainCount(): number {
    return this.trains.size;
  }

  /** View vlaku `id` (testy, ladenie). */
  trainView(id: number): TrainView | undefined {
    return this.trains.get(id);
  }

  sync(trains: readonly TrainVM[]): void {
    this.trains.sync(trains);
  }

  destroy(): void {
    this.trains.clear();
    this.view.destroy({ children: true });
  }
}
