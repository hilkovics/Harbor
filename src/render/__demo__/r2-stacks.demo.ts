/**
 * Demo renderu karty TR2-03 (R2 kontajnery a stohy, ADR-039): mapa `harbor_01` s pevnými view-modelmi (`r2-stacks.fixtures.ts`) — bez simu, bez UI.
 * Spúšťa ju stránka `r2-stacks.html` (`/src/render/__demo__/r2-stacks.html?scene=terminal|block|depot|vehicles`); Playwright
 * (`tests/e2e/r2-stacks-render.spec.ts`) z nej robí screenshoty. Po vykreslení nastaví `data-demo-ready="true"` na `<body>`.
 *
 * Hodiny animácií bežia podľa **riadených hodín** `window.__r2Demo.clock`, takže screenshoty sú deterministické.
 */
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '../../../design/tokens.css';
import { loadBundledMap } from '@sim/grid';
import type { EntitiesVM } from '../view-models';
import { WorldRenderer } from '../world-renderer';
import { R2_SCENES, createR2Grid, type R2SceneName } from './r2-stacks.fixtures';

/** Riadené hodiny animácií (ms). */
export interface DemoClock {
  readonly now: () => number;
  readonly set: (ms: number) => void;
}

export interface R2StacksDemo {
  readonly renderer: WorldRenderer;
  readonly scene: EntitiesVM;
  readonly clock: DemoClock;
  /** Synchronizuje renderer s `vm` pre `alpha` a počká, kým Pixi nakreslí ďalší frame. */
  readonly show: (vm: EntitiesVM, alpha?: number) => Promise<void>;
  /** Vycentruje kameru na bunku (x; y) so zoomom `zoom` a prekreslí `vm`. */
  readonly focus: (vm: EntitiesVM, cellX: number, cellY: number, zoom: number) => Promise<void>;
}

declare global {
  interface Window {
    __r2Demo?: R2StacksDemo;
  }
}

function selectedScene(): R2SceneName {
  const name = new URLSearchParams(window.location.search).get('scene') ?? 'terminal';
  if (!Object.hasOwn(R2_SCENES, name)) throw new Error(`r2-stacks.html: neznáma scéna "${name}"`);
  return name as R2SceneName;
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
  if (host === null) throw new Error('r2-stacks.html: chýba #map');
  await document.fonts.load('600 12px Inter');
  const scene = R2_SCENES[selectedScene()];
  const map = loadBundledMap();
  let time = 0;
  const clock: DemoClock = {
    now: () => time,
    set: (ms) => {
      time = ms;
    },
  };
  const renderer = await WorldRenderer.create({ host, map, grid: createR2Grid(map, scene), now: clock.now, reducedMotion: () => true });

  const { camera } = renderer;
  const setView = (cellX: number, cellY: number, zoom: number): void => {
    camera.zoomAt(zoom / camera.zoom, camera.viewportWidth / 2, camera.viewportHeight / 2);
    camera.centerOn(cellX, cellY);
    renderer.syncCamera();
  };
  setView(scene.view.centerX, scene.view.centerY, scene.view.zoom);

  const show = async (vm: EntitiesVM, alpha = 1): Promise<void> => {
    renderer.syncEntities(vm, alpha);
    await afterTwoFrames();
  };
  const focus = async (vm: EntitiesVM, cellX: number, cellY: number, zoom: number): Promise<void> => {
    setView(cellX, cellY, zoom);
    await show(vm);
  };
  window.__r2Demo = { renderer, scene: scene.vm, clock, show, focus };
  await show(scene.vm);
  document.body.dataset['demoReady'] = 'true';
}

main().catch((error: unknown) => {
  document.body.dataset['demoError'] = error instanceof Error ? error.message : String(error);
  throw error;
});
