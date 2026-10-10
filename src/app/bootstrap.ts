/**
 * Bootstrap aplikácie: poskladá svet, most, slučku, render, ovládanie a React UI (ARCHITECTURE §2, §3, §13, §15).
 *
 * Tok dát:
 *   vstup → InputController → Command → SimBridge.dispatch → World (applyPending v GameLoop)
 *   World → udalosti → SimBridge.onEvents → WorldRenderer (RoadChanged) ; snapshot → useSimSnapshot → HUD, BuildBar
 *   World → SimBridge.entities() (EntitiesVM) → WorldRenderer.syncEntities(vm, alpha) každý frame (moduly, žeriavy, lode, vozidlá, kamióny)
 *   World → udalosti → ToastCenter → Toasts („Chýba sklad“, „Nepripojené“, „Rampa neprevádzková“, „Stojisko je plné“ … s akciou
 *   „Ukázať“ = centrovanie kamery; kontrakty: nové ponuky, prijatie, výplata, penalizácie, zlyhanie, mesačný výkaz
 *   s akciou „Zobraziť“ = otvorenie panelu kontraktov)
 *   snapshot (kontrakty, XP, delta dňa, gameOver) → ContractsPanel, TopHUD, GameOverModal; „Nová hra“ → `onNewGame`
 *   World → udalosti (`DayClosed`) → SaveController.handleEvents → autosave (po framu, nikdy v ticku); `Ctrl+S` →
 *   InputController.onQuickSave → SaveController.quickSave; načítanie/import → `onLoadGame(world)` (runGame reštartuje v pauze)
 *
 * Herný stav (World, GameLoop, Pixi) žije mimo Reactu — React je len vrstva nad mapou, takže StrictMode ani
 * opätovné vykreslenia hru nezdvojujú.
 */
import { StrictMode, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { TruckVM } from '@render/view-models';
import { WorldRenderer, starterParcelRect } from '@render/world-renderer';
import type { World } from '@sim/world';
import { App } from './app';
import { BuildSelection } from './build-selection';
import { createAppWorld, startViewCenter } from './config';
import { installDevHook, truckStateCounts } from './dev-hook';
import { attachDomInput } from './dom-input';
import { GameLoop, startRafLoop } from './game-loop';
import { InputController } from './input-controller';
import { ModuleSelection, bindSelectionRing } from './module-selection';
import { OverlaySelection } from './overlay-selection';
import { PanelSelection } from './panel-selection';
import { RoadSelection } from './road-selection';
import { SaveController, createPersistence, type PersistenceServices } from './save/save-controller';
import { SimBridge } from './sim-bridge';
import { applyStartSpeed } from './start-speed';
import { ToastCenter, type ToastSpec } from './toast-center';

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
  /** Výber typu cesty (BuildBar Landside); `InputController` ho zrkadlí s build módom ciest. */
  readonly roadSelection: RoadSelection;
  /** Otvorený pravý panel (kontrakty); zdieľajú ho HUD, klávesnica a akcia „Zobraziť“ v toastoch. */
  readonly panels: PanelSelection;
  /** Otvorený overlay (Nastavenia / Uložiť a načítať); kým je otvorený, `attachDomInput` ignoruje herné klávesy. */
  readonly overlays: OverlaySelection;
  /** Oznámenia zo simu (toasty); odoberá udalosti `bridge.onEvents`. */
  readonly toasts: ToastCenter;
  /** Ukladanie a načítanie hry (sloty, autosave, export/import, nastavenia); UI ho číta cez `getState`/`subscribe`. */
  readonly saves: SaveController;
  /** Zastaví slučku, odpojí vstup, zruší React strom a Pixi a odstráni DOM aplikácie. */
  destroy(): void;
}

export interface BootstrapOptions {
  /** Vlastný svet (testy, načítanie uloženej hry); predvolene nová hra z `config` (seed, mapa). */
  readonly world?: World;
  /**
   * „Nová hra“ v modále konca hry (bankrot). Volá ho UI z klikacieho handlera — zrušenie a nový `bootstrap` zariadi
   * volajúci (`runGame`); bez neho sa stránka načíta odznova.
   */
  readonly onNewGame?: () => void;
  /**
   * Načítanie uloženej hry alebo import súboru: `SaveController` obnovil `world` (`World.deserialize`) a žiada reštart
   * nad ním — zrušenie tejto hry a nový `bootstrap` zariadi volajúci (`runGame`), ktorý ho spustí pozastavený. Bez neho
   * načítanie a import ohlásia chybu (toast).
   */
  readonly onLoadGame?: (world: World) => void;
  /**
   * Rýchlosť, ktorú má hra po štarte (príkaz `SetGameSpeed` v prvom frame, `applyStartSpeed`): nová hra `defaultSpeed`
   * z nastavení, načítaná `0` (pauza). Bez neho ostáva rýchlosť sveta.
   */
  readonly startSpeed?: number;
  /** Toast zaradený hneď po štarte (`runGame` ním po načítaní hry hlási „Načítané“; `ToastCenter` pôvodnej hry sa pri reštarte ruší). */
  readonly startToast?: ToastSpec;
  /** Úložisko slotov a nastavení zdieľané medzi reštartmi hry; predvolene `createPersistence()`. */
  readonly persistence?: PersistenceServices;
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
  applyStartSpeed(world, options.startSpeed);
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

  // Kamera: „Ukázať“ v toaste a DEV `centerOn` (e2e) zdieľajú jednu funkciu; `zoom` (1 = bunka `--cell` px) je voliteľný.
  const centerCamera = (cellX: number, cellY: number, zoom?: number): void => {
    const { camera: view } = renderer;
    if (zoom !== undefined) view.zoomAt(zoom / view.zoom, view.viewportWidth / 2, view.viewportHeight / 2);
    view.centerOn(cellX, cellY);
  };
  const panels = new PanelSelection();
  const overlays = new OverlaySelection();
  const toasts = new ToastCenter(bridge, {
    centerOn: (cellX, cellY) => centerCamera(cellX, cellY),
    openPanel: (panel) => {
      panels.select(panel);
    },
  });

  if (options.startToast !== undefined) toasts.push(options.startToast);

  // Ukladanie hry (T06-03): autosave po framu (`bridge.onEvents` volá `publish` po všetkých tickoch frameu, nie v `world.tick()`).
  const saves = new SaveController({
    bridge,
    persistence: options.persistence ?? createPersistence(),
    notify: (spec) => {
      toasts.push(spec);
    },
    ...(options.onLoadGame === undefined ? {} : { loadWorld: options.onLoadGame }),
  });
  const stopAutosave = bridge.onEvents((events) => {
    saves.handleEvents(events);
  });

  // Ghost stavby kreslí `renderer.build` (jediná `BuildLayer`, nad žeriavmi); cesty aj moduly, ňou aj obrys výberu.
  const selection = new BuildSelection();
  const moduleSelection = new ModuleSelection();
  const roadSelection = new RoadSelection();
  const input = new InputController({
    bridge,
    camera: renderer.camera,
    ghost: renderer.build,
    moduleGhost: renderer.build,
    buildSelection: selection,
    moduleSelection,
    roadSelection,
    ghostArrows: renderer.build,
    onStateChange: (state) => {
      mapHost.dataset.inputState = state;
    },
    onQuickSave: () => {
      saves.quickSave();
    },
  });
  mapHost.dataset.inputState = input.state;
  const detachInput = attachDomInput(input, { host: mapHost, window, releaseFocus: releaseDocumentFocus, keysBlocked: overlays.isOpen });

  const stopSelectionRing = bindSelectionRing(moduleSelection, bridge, renderer.build);
  const stopRenderEvents = bridge.onEvents((events) => {
    for (const event of events) {
      if (event.type === 'RoadChanged') renderer.updateRoads(event.cells);
    }
  });
  // Starter moduly (Root berth + žeriav) nemajú udalosť `ModulePlaced` — prvý stav sa číta priamo zo sveta.
  let syncedTrucks: readonly TruckVM[] = bridge.entities().trucks;
  renderer.syncEntities(bridge.entities(), 0);
  const stopLoop = startRafLoop(loop, (alpha, _events, dtMs) => {
    input.update(dtMs);
    const entities = bridge.entities();
    syncedTrucks = entities.trucks;
    renderer.syncEntities(entities, alpha);
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
      trucks: renderer.ships.truckCount,
      trains: renderer.trains.trainCount,
      crossings: renderer.crossings.count,
      truckStates: truckStateCounts(syncedTrucks),
      ghostCells: renderer.build.shownCount,
      ghostConnectors: renderer.build.markerCount,
      ghostArrows: renderer.build.arrowCount,
      selectionRing: renderer.build.selectionShown,
    }),
    moduleGhost: () => input.moduleGhost(),
    centerOn: centerCamera,
    advance: (ticks) => loop.advance(ticks),
  });

  const reactRoot = createRoot(uiHost);
  reactRoot.render(createElement(StrictMode, null, createElement(App, { bridge, feedback: input, selection, moduleSelection, roadSelection, toasts, panels, overlays, saves, onNewGame: options.onNewGame })));

  let destroyed = false;
  return {
    world,
    bridge,
    loop,
    renderer,
    input,
    selection,
    moduleSelection,
    roadSelection,
    panels,
    overlays,
    toasts,
    saves,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      stopAutosave();
      saves.dispose();
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
