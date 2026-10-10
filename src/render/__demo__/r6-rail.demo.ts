/**
 * Demo renderu karty TR6-03 (R6 koľaje, vlak, RMG): mapa `harbor_01` s pevnými view-modelmi (`r6-rail.fixtures.ts`) — bez simu, bez UI.
 * Spúšťa ju stránka `r6-rail.html` (`/src/render/__demo__/r6-rail.html?scene=terminal|rmg`); Playwright
 * (`tests/e2e/r6-rail-render.spec.ts`) z nej robí screenshoty. Po vykreslení nastaví `data-demo-ready="true"` na `<body>`.
 *
 * Hodiny animácií bežia podľa **riadených hodín** `window.__r6Demo.clock`, takže screenshoty sú deterministické.
 */
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '../../../design/tokens.css';
import { DEFAULT_ROAD_KIND, loadBundledMap, type Grid, type LoadedMap } from '@sim/grid';
import type { EntitiesVM } from '../view-models';
import { Container, Graphics } from 'pixi.js';
import { CargoSprite } from '../cargo-sprite';
import { WorldRenderer } from '../world-renderer';
import { R6_SCENES, RAILS, BUFFER, type R6SceneName } from './r6-rail.fixtures';

/** Riadené hodiny animácií (ms). */
export interface DemoClock {
  readonly now: () => number;
  readonly set: (ms: number) => void;
}

export interface R6RailDemo {
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
    __r6Demo?: R6RailDemo;
  }
}

/** Mriežka mapy bez štartových ciest, s koľajami scény (`grid.road = 'rail'`). */
function createRailGrid(map: LoadedMap): Grid {
  const grid = map.createGrid();
  for (const cell of map.starter.roads) {
    const target = grid.at(cell.x, cell.y);
    target.road = 'none';
    target.roadKind = DEFAULT_ROAD_KIND;
    target.roadDir = null;
  }
  for (const cell of RAILS) grid.at(cell.x, cell.y).road = 'rail';
  return grid;
}

function selectedScene(): R6SceneName {
  const name = new URLSearchParams(window.location.search).get('scene') ?? 'terminal';
  if (!Object.hasOwn(R6_SCENES, name)) throw new Error(`r6-rail.html: neznáma scéna "${name}"`);
  return name as R6SceneName;
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

/** Buffer RMG bloku: podložka (tokeny modulu) a stohy 20′ kontajnerov ležiace pozdĺž koľaje, pod vlakom a RMG. */
function addBuffer(renderer: WorldRenderer): void {
  const { cellPx, palette } = renderer.cargoDeps;
  const layer = new Container({ label: 'r6-buffer' });
  const pad = new Graphics();
  pad
    .rect(BUFFER.x0 * cellPx - cellPx * 0.1, (BUFFER.y0 - 0.1) * cellPx, (BUFFER.rows * BUFFER.rowPitch + 0.2) * cellPx, (BUFFER.bays + 0.2) * cellPx)
    .fill({ color: palette.module.base.color, alpha: palette.module.base.alpha })
    .stroke({ width: cellPx / 32, color: palette.module.outline.color, alpha: palette.module.outline.alpha });
  layer.addChild(pad);
  BUFFER.stacks.forEach((rowStacks, row) => {
    rowStacks.forEach((container, bay) => {
      if (container === null) return;
      const sprite = new CargoSprite(900 + row * 10 + bay, 'container_teu', renderer.cargoDeps, { container });
      sprite.angle = 90;
      sprite.position.set((BUFFER.x0 + (row + 0.5) * BUFFER.rowPitch) * cellPx, (BUFFER.y0 + bay + 0.5) * cellPx);
      layer.addChild(sprite);
    });
  });
  renderer.world.addChildAt(layer, renderer.world.getChildIndex(renderer.trains.view));
}

async function main(): Promise<void> {
  const host = document.getElementById('map');
  if (host === null) throw new Error('r6-rail.html: chýba #map');
  await document.fonts.load('600 12px Inter');
  const scene = R6_SCENES[selectedScene()];
  const map = loadBundledMap();
  let time = 0;
  const clock: DemoClock = {
    now: () => time,
    set: (ms) => {
      time = ms;
    },
  };
  const renderer = await WorldRenderer.create({ host, map, grid: createRailGrid(map), now: clock.now, reducedMotion: () => true });

  addBuffer(renderer);
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
  window.__r6Demo = { renderer, scene: scene.vm, clock, show, focus };
  await show(scene.vm);
  document.body.dataset['demoReady'] = 'true';
}

main().catch((error: unknown) => {
  document.body.dataset['demoError'] = error instanceof Error ? error.message : String(error);
  throw error;
});
