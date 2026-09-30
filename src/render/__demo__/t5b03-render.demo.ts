/**
 * Demo renderu karty T5B-03 (spätná väzba F5b č. 3, 8, 10, 11): mapa `harbor_01` s pevnými view-modelmi
 * (`t5b03-render.fixtures.ts`) — bez simu, bez UI. Spúšťa ju stránka `t5b03-render.html`
 * (`/src/render/__demo__/t5b03-render.html?scene=scale|connect|yard|dock`); Playwright (`tests/e2e/t5b03-render.spec.ts`)
 * z nej robí screenshoty.
 *
 * Animácie (závora, žeriav dvora, manéver kamióna pri rampe) bežia podľa **riadených hodín** `window.__t5b03Demo.clock`,
 * takže screenshoty sú deterministické: test nastaví čas (`clock.set(ms)`) a zavolá `show(vm)`. `?reducedMotion=1` zapne
 * režim bez dekoratívnych animácií. Po vykreslení nastaví `data-demo-ready="true"` na `<body>`.
 */
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '../../../design/tokens.css';
import { loadBundledMap } from '@sim/grid';
import type { EntitiesVM } from '../view-models';
import { WorldRenderer } from '../world-renderer';
import { T5B03_SCENES, createT5b03Grid, type T5b03SceneName } from './t5b03-render.fixtures';

/** Riadené hodiny animácií (ms). */
export interface DemoClock {
  readonly now: () => number;
  readonly set: (ms: number) => void;
}

export interface T5b03RenderDemo {
  readonly renderer: WorldRenderer;
  readonly scene: EntitiesVM;
  readonly clock: DemoClock;
  /** Synchronizuje renderer s `vm` pre `alpha` bez čakania na frame (póza sa počíta hneď; screenshot vyžaduje `show`). */
  readonly sync: (vm: EntitiesVM, alpha?: number) => void;
  /** Synchronizuje renderer s `vm` pre `alpha` a počká, kým Pixi nakreslí ďalší frame. */
  readonly show: (vm: EntitiesVM, alpha?: number) => Promise<void>;
  /** Vycentruje kameru na bunku (x; y) so zoomom `zoom` a prekreslí `vm`. */
  readonly focus: (vm: EntitiesVM, cellX: number, cellY: number, zoom: number) => Promise<void>;
}

declare global {
  interface Window {
    __t5b03Demo?: T5b03RenderDemo;
  }
}

function selectedScene(): T5b03SceneName {
  const name = new URLSearchParams(window.location.search).get('scene') ?? 'scale';
  if (!Object.hasOwn(T5B03_SCENES, name)) throw new Error(`t5b03-render.html: neznáma scéna "${name}"`);
  return name as T5b03SceneName;
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
  if (host === null) throw new Error('t5b03-render.html: chýba #map');
  await document.fonts.load('600 12px Inter');
  const scene = T5B03_SCENES[selectedScene()];
  const map = loadBundledMap();
  let time = 0;
  const clock: DemoClock = {
    now: () => time,
    set: (ms) => {
      time = ms;
    },
  };
  const reduced = new URLSearchParams(window.location.search).get('reducedMotion') === '1';
  const renderer = await WorldRenderer.create({ host, map, grid: createT5b03Grid(map, scene), now: clock.now, reducedMotion: () => reduced });

  const { camera } = renderer;
  const setView = (cellX: number, cellY: number, zoom: number): void => {
    camera.zoomAt(zoom / camera.zoom, camera.viewportWidth / 2, camera.viewportHeight / 2);
    camera.centerOn(cellX, cellY);
    renderer.syncCamera();
  };
  setView(scene.view.centerX, scene.view.centerY, scene.view.zoom);

  const sync = (vm: EntitiesVM, alpha = 1): void => {
    renderer.syncEntities(vm, alpha);
  };
  const show = async (vm: EntitiesVM, alpha = 1): Promise<void> => {
    sync(vm, alpha);
    await afterTwoFrames();
  };
  const focus = async (vm: EntitiesVM, cellX: number, cellY: number, zoom: number): Promise<void> => {
    setView(cellX, cellY, zoom);
    await show(vm);
  };
  window.__t5b03Demo = { renderer, scene: scene.vm, clock, sync, show, focus };
  await show(scene.vm);
  document.body.dataset['demoReady'] = 'true';
}

main().catch((error: unknown) => {
  document.body.dataset['demoError'] = error instanceof Error ? error.message : String(error);
  throw error;
});
