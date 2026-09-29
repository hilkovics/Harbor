/**
 * Bootstrap aplikácie: poskladá svet, most, slučku, render, ovládanie a React UI (ARCHITECTURE §2, §3, §13, §15).
 *
 * Tok dát:
 *   vstup → InputController → Command → SimBridge.dispatch → World (applyPending v GameLoop)
 *   World → udalosti → SimBridge.onEvents → WorldRenderer (RoadChanged) ; snapshot → useSimSnapshot → HUD
 *
 * Herný stav (World, GameLoop, Pixi) žije mimo Reactu — React je len vrstva nad mapou, takže StrictMode ani
 * opätovné vykreslenia hru nezdvojujú.
 */
import { StrictMode, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WorldRenderer } from '@render/world-renderer';
import { BuildLayer } from '@render/build-layer';
import type { World } from '@sim/world';
import { App } from './app';
import { createAppWorld } from './config';
import { installDevHook } from './dev-hook';
import { attachDomInput } from './dom-input';
import { GameLoop, startRafLoop } from './game-loop';
import { InputController } from './input-controller';
import { SimBridge } from './sim-bridge';

export interface AppHandle {
  readonly world: World;
  readonly bridge: SimBridge;
  readonly loop: GameLoop;
  readonly renderer: WorldRenderer;
  readonly input: InputController;
  /** Zastaví slučku, odpojí vstup, zruší React strom a Pixi a odstráni DOM aplikácie. */
  destroy(): void;
}

export interface BootstrapOptions {
  /** Vlastný svet (testy, načítanie uloženej hry); predvolene nová hra z `config` (seed, mapa). */
  readonly world?: World;
}

/** Zloží fokus z aktívneho prvku UI (klik do mapy vráti klávesy hre). */
function releaseDocumentFocus(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}

/** Ukáže chybu spustenia hráčovi (canvas by inak ostal prázdny a bez vysvetlenia). */
function showFatal(shell: HTMLElement, error: unknown): void {
  const box = document.createElement('p');
  box.className = 'app__fatal';
  box.setAttribute('role', 'alert');
  box.textContent = `Hru sa nepodarilo spustiť: ${error instanceof Error ? error.message : String(error)}`;
  shell.appendChild(box);
}

/**
 * Spustí hru v prvku `root` (napr. `#root`). Vráti sa po inicializácii rendereru; pri chybe (napr. WebGL nedostupné)
 * zobrazí správu v strane a chybu prehodí ďalej.
 */
export async function bootstrap(root: HTMLElement, options: BootstrapOptions = {}): Promise<AppHandle> {
  const world = options.world ?? createAppWorld();
  const bridge = new SimBridge(world);
  const loop = new GameLoop(world, bridge);

  const shell = document.createElement('div');
  shell.className = 'app';
  const mapHost = document.createElement('div');
  mapHost.className = 'app__map';
  const uiHost = document.createElement('div');
  uiHost.className = 'app__ui';
  shell.append(mapHost, uiHost);
  root.replaceChildren(shell);

  let renderer: WorldRenderer;
  let buildLayer: BuildLayer;
  try {
    // Renderer kreslí ŽIVÚ mriežku sveta (vrátane postavených ciest), nie šablónu mapy `world.map`.
    renderer = await WorldRenderer.create({ host: mapHost, map: world.map, grid: world.grid });
    try {
      buildLayer = await BuildLayer.create();
    } catch (error) {
      renderer.destroy();
      throw error;
    }
  } catch (error) {
    showFatal(shell, error);
    throw error;
  }
  renderer.world.addChild(buildLayer.view);

  const input = new InputController({
    bridge,
    camera: renderer.camera,
    ghost: buildLayer,
    onStateChange: (state) => {
      mapHost.dataset.inputState = state;
    },
  });
  mapHost.dataset.inputState = input.state;
  const detachInput = attachDomInput(input, { host: mapHost, window, releaseFocus: releaseDocumentFocus });

  const stopRenderEvents = bridge.onEvents((events) => {
    for (const event of events) {
      if (event.type === 'RoadChanged') renderer.updateRoads(event.cells);
    }
  });
  const stopLoop = startRafLoop(loop, (_alpha, _events, dtMs) => {
    input.update(dtMs);
  });

  installDevHook(bridge, {
    cellToScreen: (cellX, cellY) => {
      const center = renderer.camera.cellCenterToScreen(cellX, cellY);
      const rect = renderer.app.canvas.getBoundingClientRect();
      return { x: rect.left + center.x, y: rect.top + center.y };
    },
  });

  const reactRoot = createRoot(uiHost);
  reactRoot.render(createElement(StrictMode, null, createElement(App, { bridge, feedback: input })));

  let destroyed = false;
  return {
    world,
    bridge,
    loop,
    renderer,
    input,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      stopRenderEvents();
      detachInput();
      input.dispose();
      reactRoot.unmount();
      buildLayer.destroy();
      renderer.destroy();
      shell.remove();
      if (window.__sim?.bridge === bridge) delete window.__sim;
    },
  };
}
