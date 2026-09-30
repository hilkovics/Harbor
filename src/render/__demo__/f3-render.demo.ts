/**
 * Demo renderu Fázy 3 (T03-08): mapa `harbor_01` s pevnými view-modelmi (`f3-render.fixtures.ts`) — bez simu, bez UI.
 * Spúšťa ju stránka `f3-render.html` (Vite dev server: `/src/render/__demo__/f3-render.html`); Playwright
 * (`tests/e2e/f3-render.spec.ts`) z nej robí screenshot.
 *
 * Scéna `main` (predvolená): 2 kontajnerové dvory (fill 0 a 75), pripojené depo, 3 straddle carriery po ceste a odpojené
 * depo s odznakom. Scéna `lanes` (`?scene=lanes`, T03-17): vozidlá v pravom pruhu na priamej ceste, v zákrutách a pri
 * T-križovatke. Po vykreslení nastaví `data-demo-ready="true"` na `<body>` a vystaví `window.__f3RenderDemo` (renderer, VM scény
 * a `show(vm, alpha)` na prekreslenie zmeneným view-modelom — test tak overí aj aktualizáciu za behu).
 */
import '../../../design/tokens.css';
import { loadBundledMap } from '@sim/grid';
import type { EntitiesVM } from '../view-models';
import { WorldRenderer } from '../world-renderer';
import { DEMO_SCENES, type DemoSceneName } from './f3-render.fixtures';

export interface F3RenderDemo {
  readonly renderer: WorldRenderer;
  /** View-modely úvodnej scény (kópiu upravenú testom pošli do `show`). */
  readonly scene: EntitiesVM;
  /** Synchronizuje renderer s `vm` pre `alpha` a počká, kým Pixi nakreslí ďalší frame. */
  readonly show: (vm: EntitiesVM, alpha?: number) => Promise<void>;
}

declare global {
  interface Window {
    __f3RenderDemo?: F3RenderDemo;
  }
}

/** Scéna podľa `?scene=<názov>`; bez parametra `main`, neznáme meno je chyba. */
function selectedScene(): DemoSceneName {
  const name = new URLSearchParams(window.location.search).get('scene') ?? 'main';
  if (!Object.hasOwn(DEMO_SCENES, name)) throw new Error(`f3-render.html: neznáma scéna "${name}"`);
  return name as DemoSceneName;
}

/** Dva `requestAnimationFrame` po sebe: Pixi stihne nakresliť aktuálny stav do canvasu. */
function afterTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

async function main(): Promise<void> {
  const host = document.getElementById('map');
  if (host === null) throw new Error('f3-render.html: chýba #map');
  const scene = DEMO_SCENES[selectedScene()];
  const map = loadBundledMap();
  const renderer = await WorldRenderer.create({ host, map, grid: scene.createGrid(map) });

  // Kamera: zoom 0,5 (štart) → cieľový zoom scény, stred na scénu.
  const { camera } = renderer;
  camera.zoomAt(scene.view.zoom / camera.zoom, camera.viewportWidth / 2, camera.viewportHeight / 2);
  camera.centerOn(scene.view.centerX, scene.view.centerY);
  renderer.syncCamera();

  const show = async (vm: EntitiesVM, alpha = 1): Promise<void> => {
    renderer.syncEntities(vm, alpha);
    await afterTwoFrames();
  };
  window.__f3RenderDemo = { renderer, scene: scene.vm, show };
  await show(scene.vm);
  document.body.dataset['demoReady'] = 'true';
}

main().catch((error: unknown) => {
  document.body.dataset['demoError'] = error instanceof Error ? error.message : String(error);
  throw error;
});
