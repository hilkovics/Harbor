/**
 * Demo renderu karty TR5-03 (R5 typy kontajnerov, reefer rack, reach stacker): mapa `harbor_01` s pevnými view-modelmi (`r5-types.fixtures.ts`) — bez simu, bez UI.
 * Spúšťa ju stránka `r5-types.html` (`/src/render/__demo__/r5-types.html?scene=types`); Playwright (`tests/e2e/r5-types-render.spec.ts`) z nej robí
 * screenshoty. Po vykreslení nastaví `data-demo-ready="true"` na `<body>`. Hodiny animácií sú riadené (`window.__r5Demo.clock`), screenshoty sú deterministické.
 */
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '../../../design/tokens.css';
import { loadBundledMap } from '@sim/grid';
import type { EntitiesVM } from '../view-models';
import { WorldRenderer } from '../world-renderer';
import { createR1Grid } from './r1-traffic.fixtures';
import { R5_SCENES, type R5SceneName } from './r5-types.fixtures';

/** Riadené hodiny animácií (ms). */
export interface DemoClock {
  readonly now: () => number;
  readonly set: (ms: number) => void;
}

export interface R5TypesDemo {
  readonly renderer: WorldRenderer;
  readonly scene: EntitiesVM;
  readonly clock: DemoClock;
  /** Synchronizuje renderer s `vm` a počká, kým Pixi nakreslí ďalší frame. */
  readonly show: (vm: EntitiesVM, alpha?: number) => Promise<void>;
}

declare global {
  interface Window {
    __r5Demo?: R5TypesDemo;
  }
}

function selectedScene(): R5SceneName {
  const name = new URLSearchParams(window.location.search).get('scene') ?? 'types';
  if (!Object.hasOwn(R5_SCENES, name)) throw new Error(`r5-types.html: neznáma scéna "${name}"`);
  return name as R5SceneName;
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
  if (host === null) throw new Error('r5-types.html: chýba #map');
  await document.fonts.load('600 12px Inter');
  const scene = R5_SCENES[selectedScene()];
  const map = loadBundledMap();
  let time = 0;
  const clock: DemoClock = {
    now: () => time,
    set: (ms) => {
      time = ms;
    },
  };
  const renderer = await WorldRenderer.create({ host, map, grid: createR1Grid(map, scene), now: clock.now, reducedMotion: () => true });

  const { camera } = renderer;
  camera.zoomAt(scene.view.zoom / camera.zoom, camera.viewportWidth / 2, camera.viewportHeight / 2);
  camera.centerOn(scene.view.centerX, scene.view.centerY);
  renderer.syncCamera();

  const show = async (vm: EntitiesVM, alpha = 1): Promise<void> => {
    renderer.syncEntities(vm, alpha);
    await afterTwoFrames();
  };
  window.__r5Demo = { renderer, scene: scene.vm, clock, show };
  await show(scene.vm);
  document.body.dataset['demoReady'] = 'true';
}

main().catch((error: unknown) => {
  document.body.dataset['demoError'] = error instanceof Error ? error.message : String(error);
  throw error;
});
