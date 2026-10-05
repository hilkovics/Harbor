/**
 * Demo renderu Fázy 6c (T6C-04, prázdne kontajnery, depo prázdnych a empty handler): mapa `harbor_01` s pevnými view-modelmi
 * (`f6c-render.fixtures.ts`) — bez simu, bez UI. Spúšťa ju stránka `f6c-render.html`
 * (`/src/render/__demo__/f6c-render.html?scene=ships|depot|ramp`); Playwright (`tests/e2e/f6c-render-demo.spec.ts`) z nej robí screenshoty.
 *
 * Animácie (žeriav dvora) bežia podľa **riadených hodín** `window.__f6cDemo.clock`, takže screenshoty sú deterministické: test nastaví
 * čas (`clock.set(ms)`) a zavolá `show(vm)`. Po vykreslení nastaví `data-demo-ready="true"` na `<body>`.
 */
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '../../../design/tokens.css';
import { loadBundledMap } from '@sim/grid';
import type { EntitiesVM } from '../view-models';
import { WorldRenderer } from '../world-renderer';
import { createT5b03Grid } from './t5b03-render.fixtures';
import * as fixtures from './f6c-render.fixtures';
import { F6C_SCENES, type F6cSceneName } from './f6c-render.fixtures';

/** Riadené hodiny animácií (ms). */
export interface DemoClock {
  readonly now: () => number;
  readonly set: (ms: number) => void;
}

export interface F6cRenderDemo {
  readonly renderer: WorldRenderer;
  readonly scene: EntitiesVM;
  readonly clock: DemoClock;
  /** Fixtúry scén a stavitelia VM — test z nich skladá postupné snímky bez duplikácie. */
  readonly fixtures: typeof fixtures;
  /** Synchronizuje renderer s `vm` pre `alpha` a počká, kým Pixi nakreslí ďalší frame. */
  readonly show: (vm: EntitiesVM, alpha?: number) => Promise<void>;
  /** Vycentruje kameru na bunku (x; y) so zoomom `zoom` a prekreslí `vm`. */
  readonly focus: (vm: EntitiesVM, cellX: number, cellY: number, zoom: number) => Promise<void>;
}

declare global {
  interface Window {
    __f6cDemo?: F6cRenderDemo;
  }
}

function selectedScene(): F6cSceneName {
  const name = new URLSearchParams(window.location.search).get('scene') ?? 'ships';
  if (!Object.hasOwn(F6C_SCENES, name)) throw new Error(`f6c-render.html: neznáma scéna "${name}"`);
  return name as F6cSceneName;
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
  if (host === null) throw new Error('f6c-render.html: chýba #map');
  await document.fonts.load('600 12px Inter');
  const scene = F6C_SCENES[selectedScene()];
  const map = loadBundledMap();
  let time = 0;
  const clock: DemoClock = {
    now: () => time,
    set: (ms) => {
      time = ms;
    },
  };
  const renderer = await WorldRenderer.create({ host, map, grid: createT5b03Grid(map, scene), now: clock.now, reducedMotion: () => true });

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
  window.__f6cDemo = { renderer, scene: scene.vm, clock, fixtures, show, focus };
  await show(scene.vm);
  document.body.dataset['demoReady'] = 'true';
}

main().catch((error: unknown) => {
  document.body.dataset['demoError'] = error instanceof Error ? error.message : String(error);
  throw error;
});
