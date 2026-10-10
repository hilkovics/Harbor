/**
 * Demo renderu karty TR1-06 (R1 doprava bez prekrývania, ADR-037): mapa `harbor_01` s pevnými view-modelmi
 * (`r1-traffic.fixtures.ts`) — bez simu, bez UI. Spúšťa ju stránka `r1-traffic.html`
 * (`/src/render/__demo__/r1-traffic.html?scene=queue|crane|depot|jam|hairpin`); Playwright (`tests/e2e/r1-traffic-render.spec.ts`)
 * z nej robí screenshoty. Po vykreslení nastaví `data-demo-ready="true"` na `<body>`.
 *
 * Hodiny animácií bežia podľa **riadených hodín** `window.__r1Demo.clock` (rovnako ako ostatné dema), takže screenshoty sú
 * deterministické.
 */
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '../../../design/tokens.css';
import { loadBundledMap } from '@sim/grid';
import type { EntitiesVM } from '../view-models';
import { WorldRenderer } from '../world-renderer';
import { R1_SCENES, createR1Grid, type R1SceneName } from './r1-traffic.fixtures';

/** Riadené hodiny animácií (ms). */
export interface DemoClock {
  readonly now: () => number;
  readonly set: (ms: number) => void;
}

export interface R1TrafficDemo {
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
    __r1Demo?: R1TrafficDemo;
  }
}

function selectedScene(): R1SceneName {
  const name = new URLSearchParams(window.location.search).get('scene') ?? 'queue';
  if (!Object.hasOwn(R1_SCENES, name)) throw new Error(`r1-traffic.html: neznáma scéna "${name}"`);
  return name as R1SceneName;
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
  if (host === null) throw new Error('r1-traffic.html: chýba #map');
  await document.fonts.load('600 12px Inter');
  const scene = R1_SCENES[selectedScene()];
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
  window.__r1Demo = { renderer, scene: scene.vm, clock, sync, show, focus };
  await show(scene.vm);
  document.body.dataset['demoReady'] = 'true';
}

main().catch((error: unknown) => {
  document.body.dataset['demoError'] = error instanceof Error ? error.message : String(error);
  throw error;
});
