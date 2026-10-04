// Pomôcky testov F6a nad skutočným svetom zo scenára `data/scenarios/export_inbound.json` (T6A-07b): svet beží cez
// `GameLoop` + `SimBridge` tak ako v hre (snapshot, VM, toasty), príkazy scenára sa aplikujú v ich tickoch.
import { commandFromJSON } from '@sim/commands';
import type { SimEvent } from '@sim/events';
import { loadBundledDefs } from '@sim/defs';
import { loadBundledMap } from '@sim/grid';
import { World } from '@sim/world';
import { GameLoop } from '@app/game-loop';
import { SimBridge } from '@app/sim-bridge';
import { toastSpecsForEvents, type ToastSpec } from '@app/toast-center';
import { loadScenarioFile, type Scenario } from '../sim/helpers/scenario';

export interface ScenarioApp {
  readonly world: World;
  readonly bridge: SimBridge;
  readonly loop: GameLoop;
  readonly scenario: Scenario;
  /** Všetky udalosti doručené bridge (poradie vzniku) s tickom, v ktorom boli publikované (koniec framu). */
  readonly events: { readonly tick: number; readonly event: SimEvent }[];
  /** Toasty tak, ako by ich dostal hráč: `toastSpecsForEvents` nad svetom hneď po každom frame (aj s tickom framu). */
  readonly toasts: { readonly tick: number; readonly spec: ToastSpec }[];
  /**
   * Posunie svet o `ticks` tickov (po framoch `GameLoop.advance`), pričom príkazy scenára s `atTick` v tomto rozsahu sa
   * aplikujú presne v ich ticku (ako `runScenario`). `onStep` sa volá po každom kroku s krokom o `step` ticku.
   */
  advanceTo(untilTick: number, step?: number | ((app: ScenarioApp) => number), onStep?: (app: ScenarioApp) => void): void;
}

/** Svet scenára (`scenarioId`) so skutočnými defmi a mapou; príkazy z tick 0 sa aplikujú pri prvom `advanceTo`. */
export function createScenarioApp(scenarioId = 'export_inbound'): ScenarioApp {
  const scenario = loadScenarioFile(scenarioId);
  const world = World.create(loadBundledDefs(), loadBundledMap(), scenario.seed);
  const bridge = new SimBridge(world);
  const loop = new GameLoop(world, bridge);
  const events: { tick: number; event: SimEvent }[] = [];
  const toasts: { tick: number; spec: ToastSpec }[] = [];
  bridge.onEvents((batch) => {
    for (const event of batch) events.push({ tick: world.clock.tick, event });
    for (const spec of toastSpecsForEvents(world, batch)) toasts.push({ tick: world.clock.tick, spec });
  });
  const pending = [...scenario.commands].sort((a, b) => a.atTick - b.atTick);
  let next = 0;

  const dispatchDue = (): void => {
    while (next < pending.length && pending[next].atTick <= world.clock.tick) {
      bridge.dispatch(commandFromJSON(pending[next].command));
      next += 1;
    }
  };

  const app: ScenarioApp = {
    world,
    bridge,
    loop,
    scenario,
    events,
    toasts,
    advanceTo(untilTick, step = 50, onStep) {
      while (world.clock.tick < untilTick) {
        dispatchDue();
        const nextCommand = next < pending.length ? pending[next].atTick : Infinity;
        const size = typeof step === 'number' ? step : step(app);
        const target = Math.min(untilTick, nextCommand, world.clock.tick + Math.max(1, size));
        loop.advance(target - world.clock.tick);
        onStep?.(app);
      }
      dispatchDue();
    },
  };
  return app;
}
