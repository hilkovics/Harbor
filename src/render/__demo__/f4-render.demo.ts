/**
 * Demo renderu Fázy 4 (T04-06): mapa `harbor_01` s pevnými view-modelmi (`f4-render.fixtures.ts`) — bez simu, bez UI.
 * Spúšťa ju stránka `f4-render.html` (Vite dev server: `/src/render/__demo__/f4-render.html`); Playwright
 * (`tests/e2e/f4-render.spec.ts`) z nej robí screenshoty.
 *
 * Scéna: pruhy brány (vstupný s krokom, výstupný voľný), odstavná plocha s dvoma kamiónmi a kamióny na ceste aj v zákrute. Po
 * vykreslení nastaví `data-demo-ready="true"` na `<body>` a vystaví `window.__f4RenderDemo` (renderer, VM scény,
 * `show(vm, alpha)` na prekreslenie zmeneným view-modelom a `focus(x, y, zoom)` na priblíženie kamery).
 */
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '../../../design/tokens.css';
import { loadBundledMap } from '@sim/grid';
import type { EntitiesVM } from '../view-models';
import { WorldRenderer } from '../world-renderer';
import { F4_MAIN_SCENE, F4_MAIN_VIEW, createF4Grid } from './f4-render.fixtures';

export interface F4RenderDemo {
  readonly renderer: WorldRenderer;
  /** View-modely úvodnej scény (kópiu upravenú testom pošli do `show`). */
  readonly scene: EntitiesVM;
  /** Synchronizuje renderer s `vm` pre `alpha` a počká, kým Pixi nakreslí ďalší frame. */
  readonly show: (vm: EntitiesVM, alpha?: number) => Promise<void>;
  /** Vycentruje kameru na bunku (x; y) so zoomom `zoom` a prekreslí scénu. */
  readonly focus: (cellX: number, cellY: number, zoom: number) => Promise<void>;
}

declare global {
  interface Window {
    __f4RenderDemo?: F4RenderDemo;
  }
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
  if (host === null) throw new Error('f4-render.html: chýba #map');
  // Číslo v odznaku fronty sa kreslí písmom z tokenu `--font-ui` (Inter 600); bez načítaného písma by Pixi použil náhradné.
  await document.fonts.load('600 12px Inter');
  const map = loadBundledMap();
  const renderer = await WorldRenderer.create({ host, map, grid: createF4Grid(map) });

  // Kamera: zoom 0,5 (štart) → cieľový zoom scény, stred na scénu.
  const { camera } = renderer;
  const setView = (cellX: number, cellY: number, zoom: number): void => {
    camera.zoomAt(zoom / camera.zoom, camera.viewportWidth / 2, camera.viewportHeight / 2);
    camera.centerOn(cellX, cellY);
    renderer.syncCamera();
  };
  setView(F4_MAIN_VIEW.centerX, F4_MAIN_VIEW.centerY, F4_MAIN_VIEW.zoom);

  const show = async (vm: EntitiesVM, alpha = 1): Promise<void> => {
    renderer.syncEntities(vm, alpha);
    await afterTwoFrames();
  };
  const focus = async (cellX: number, cellY: number, zoom: number): Promise<void> => {
    setView(cellX, cellY, zoom);
    await show(F4_MAIN_SCENE);
  };
  window.__f4RenderDemo = { renderer, scene: F4_MAIN_SCENE, show, focus };
  await show(F4_MAIN_SCENE);
  document.body.dataset['demoReady'] = 'true';
}

main().catch((error: unknown) => {
  document.body.dataset['demoError'] = error instanceof Error ? error.message : String(error);
  throw error;
});
