/**
 * Demo renderu karty TR4-03 (R4 brány): mapa `harbor_01` s pevnými view-modelmi (`r4-gates.fixtures.ts`) — bez simu, bez UI.
 * Spúšťa ju stránka `r4-gates.html` (`/src/render/__demo__/r4-gates.html?scene=gates|rtg`); Playwright (`tests/e2e/r4-gates-render.spec.ts`) z nej robí
 * screenshoty. Po vykreslení nastaví `data-demo-ready="true"` na `<body>`. Hodiny animácií sú riadené (`window.__r4Demo.clock`), screenshoty sú deterministické.
 */
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '../../../design/tokens.css';
import { loadBundledMap } from '@sim/grid';
import type { EntitiesVM } from '../view-models';
import { WorldRenderer } from '../world-renderer';
import { createR1Grid } from './r1-traffic.fixtures';
import { R4_SCENES, type R4SceneName } from './r4-gates.fixtures';

/** Riadené hodiny animácií (ms). */
export interface DemoClock {
  readonly now: () => number;
  readonly set: (ms: number) => void;
}

export interface R4GatesDemo {
  readonly renderer: WorldRenderer;
  readonly scene: EntitiesVM;
  readonly clock: DemoClock;
  /** Synchronizuje renderer s `vm` a počká, kým Pixi nakreslí ďalší frame. */
  readonly show: (vm: EntitiesVM, alpha?: number) => Promise<void>;
}

declare global {
  interface Window {
    __r4Demo?: R4GatesDemo;
  }
}

function selectedScene(): R4SceneName {
  const name = new URLSearchParams(window.location.search).get('scene') ?? 'gates';
  if (!Object.hasOwn(R4_SCENES, name)) throw new Error(`r4-gates.html: neznáma scéna "${name}"`);
  return name as R4SceneName;
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
  if (host === null) throw new Error('r4-gates.html: chýba #map');
  await document.fonts.load('600 12px Inter');
  const scene = R4_SCENES[selectedScene()];
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
  window.__r4Demo = { renderer, scene: scene.vm, clock, show };
  await show(scene.vm);
  document.body.dataset['demoReady'] = 'true';
}

main().catch((error: unknown) => {
  document.body.dataset['demoError'] = error instanceof Error ? error.message : String(error);
  throw error;
});
