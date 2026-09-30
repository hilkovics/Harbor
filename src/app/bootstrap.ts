/**
 * Bootstrap aplikácie: poskladá svet, most, slučku, render, ovládanie a React UI (ARCHITECTURE §2, §3, §13, §15).
 *
 * Tok dát:
 *   vstup → InputController → Command → SimBridge.dispatch → World (applyPending v GameLoop)
 *   World → udalosti → SimBridge.onEvents → WorldRenderer (RoadChanged) ; snapshot → useSimSnapshot → HUD, BuildBar
 *   World → SimBridge.entities() (EntitiesVM) → WorldRenderer.syncEntities(vm, alpha) každý frame (moduly, žeriavy, lode, vozidlá)
 *   World → udalosti → ToastCenter → Toasts („Chýba sklad“, „Nepripojené“ s akciou „Ukázať“ = centrovanie kamery)
 *
 * Herný stav (World, GameLoop, Pixi) žije mimo Reactu — React je len vrstva nad mapou, takže StrictMode ani
 * opätovné vykreslenia hru nezdvojujú.
 */
import { StrictMode, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WorldRenderer, starterParcelRect } from '@render/world-renderer';
import type { World } from '@sim/world';
import { App } from './app';
import { BuildSelection } from './build-selection';
import { createAppWorld, startViewCenter } from './config';
import { installDevHook } from './dev-hook';
import { attachDomInput } from './dom-input';
import { GameLoop, startRafLoop } from './game-loop';
import { InputController } from './input-controller';
import { ModuleSelection, bindSelectionRing } from './module-selection';
import { SimBridge } from './sim-bridge';
import { ToastCenter } from './toast-center';

export interface AppHandle {
  readonly world: World;
  readonly bridge: SimBridge;
  readonly loop: GameLoop;
  readonly renderer: WorldRenderer;
  readonly input: InputController;
  /** Výber v BuildBar (`selectedDefId`); `InputController` ho odoberá cez `subscribe` (build mód modulov). */
  readonly selection: BuildSelection;
  /** Výber modulu na mape (id) pre inšpektor a obrys `selection_ring`. */
  readonly moduleSelection: ModuleSelection;
  /** Oznámenia zo simu (toasty); odoberá udalosti `bridge.onEvents`. */
  readonly toasts: ToastCenter;
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
  try {
    // Renderer kreslí ŽIVÚ mriežku sveta (vrátane postavených ciest) a živé parcely, nie šablónu mapy `world.map`.
    renderer = await WorldRenderer.create({
      host: mapHost,
      map: world.map,
      grid: world.grid,
      parcels: [...world.parcels.values()], // živé parcely: obrysy podľa aktuálneho `ownership`
    });
  } catch (error) {
    showFatal(shell, error);
    throw error;
  }

  // Úvodný pohľad: stred starter parcely, ale zvislo posunutý tak, aby bolo vidno pobrežie a more nad ním (nie len HUD).
  const { camera } = renderer;
  const visibleRows = camera.viewportHeight / (camera.zoom * renderer.palette.cellPx);
  const startCenter = startViewCenter(world.grid, starterParcelRect(world.map), visibleRows);
  camera.centerOn(startCenter.x, startCenter.y);

  // Ghost stavby kreslí `renderer.build` (jediná `BuildLayer`, nad žeriavmi); cesty aj moduly, ňou aj obrys výberu.
  const selection = new BuildSelection();
  const moduleSelection = new ModuleSelection();
  const input = new InputController({
    bridge,
    camera: renderer.camera,
    ghost: renderer.build,
    moduleGhost: renderer.build,
    buildSelection: selection,
    moduleSelection,
    onStateChange: (state) => {
      mapHost.dataset.inputState = state;
    },
  });
  mapHost.dataset.inputState = input.state;
  const detachInput = attachDomInput(input, { host: mapHost, window, releaseFocus: releaseDocumentFocus });

  // Kamera: „Ukázať“ v toaste a DEV `centerOn` (e2e) zdieľajú jednu funkciu; `zoom` (1 = bunka `--cell` px) je voliteľný.
  const centerCamera = (cellX: number, cellY: number, zoom?: number): void => {
    const { camera: view } = renderer;
    if (zoom !== undefined) view.zoomAt(zoom / view.zoom, view.viewportWidth / 2, view.viewportHeight / 2);
    view.centerOn(cellX, cellY);
  };
  const toasts = new ToastCenter(bridge, { centerOn: (cellX, cellY) => centerCamera(cellX, cellY) });

  const stopSelectionRing = bindSelectionRing(moduleSelection, bridge, renderer.build);
  const stopRenderEvents = bridge.onEvents((events) => {
    for (const event of events) {
      if (event.type === 'RoadChanged') renderer.updateRoads(event.cells);
    }
  });
  // Starter moduly (Root berth + žeriav) nemajú udalosť `ModulePlaced` — prvý stav sa číta priamo zo sveta.
  renderer.syncEntities(bridge.entities(), 0);
  const stopLoop = startRafLoop(loop, (alpha, _events, dtMs) => {
    input.update(dtMs);
    renderer.syncEntities(bridge.entities(), alpha);
  });

  installDevHook(bridge, {
    cellToScreen: (cellX, cellY) => {
      const center = renderer.camera.cellCenterToScreen(cellX, cellY);
      const rect = renderer.app.canvas.getBoundingClientRect();
      return { x: rect.left + center.x, y: rect.top + center.y };
    },
    rendered: () => ({
      modules: renderer.modules.moduleCount,
      cranes: renderer.cranes.craneCount,
      ships: renderer.ships.shipCount,
      vehicles: renderer.ships.vehicleCount,
      ghostCells: renderer.build.shownCount,
      ghostConnectors: renderer.build.markerCount,
      selectionRing: renderer.build.selectionShown,
    }),
    moduleGhost: () => input.moduleGhost(),
    centerOn: centerCamera,
  });

  const reactRoot = createRoot(uiHost);
  reactRoot.render(createElement(StrictMode, null, createElement(App, { bridge, feedback: input, selection, moduleSelection, toasts })));

  let destroyed = false;
  return {
    world,
    bridge,
    loop,
    renderer,
    input,
    selection,
    moduleSelection,
    toasts,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      stopRenderEvents();
      stopSelectionRing();
      toasts.dispose();
      detachInput();
      input.dispose();
      reactRoot.unmount();
      renderer.destroy();
      shell.remove();
      if (window.__sim?.bridge === bridge) delete window.__sim;
    },
  };
}
