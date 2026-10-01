/**
 * Demo renderu Fázy 2 (T02-07): mapa `harbor_01` s pevnými view-modelmi (`f2-render.fixtures.ts`) — bez simu, bez UI.
 * Spúšťa ju stránka `f2-render.html` (Vite dev server: `/src/render/__demo__/f2-render.html`); Playwright
 * (`tests/e2e/f2-render.spec.ts`) z nej robí screenshot.
 *
 * Parametre URL: `scene=main|rotated` (predvolene `main`), `ghost=valid|invalid|none` (predvolene `valid`).
 * Po vykreslení nastaví `data-demo-ready="true"` na `<body>` a vystaví `window.__f2RenderDemo`.
 */
import '../../../design/tokens.css';
import { loadBundledMap } from '@sim/grid';
import { WorldRenderer } from '../world-renderer';
import { SCENES, SCENE_VIEW, mainGhost, type SceneId } from './f2-render.fixtures';

export interface F2RenderDemo {
  readonly renderer: WorldRenderer;
  readonly scene: SceneId;
}

declare global {
  interface Window {
    __f2RenderDemo?: F2RenderDemo;
  }
}

function isSceneId(value: string | null): value is SceneId {
  return value !== null && Object.hasOwn(SCENES, value);
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
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('scene');
  const scene: SceneId = isSceneId(requested) ? requested : 'main';
  const ghost = params.get('ghost') ?? 'valid';

  const host = document.getElementById('map');
  if (host === null) throw new Error('f2-render.html: chýba #map');
  const renderer = await WorldRenderer.create({ host, map: loadBundledMap() });

  // Kamera: zoom 0,5 (štart) → cieľový zoom scény, stred na scénu.
  const view = SCENE_VIEW[scene];
  const { camera } = renderer;
  camera.zoomAt(view.zoom / camera.zoom, camera.viewportWidth / 2, camera.viewportHeight / 2);
  camera.centerOn(view.centerX, view.centerY);
  renderer.syncCamera();

  renderer.syncEntities(SCENES[scene], 1);
  if (scene === 'main' && ghost !== 'none') renderer.setModuleGhost(mainGhost(ghost !== 'invalid'));

  window.__f2RenderDemo = { renderer, scene };
  await afterTwoFrames();
  document.body.dataset['demoReady'] = 'true';
}

main().catch((error: unknown) => {
  document.body.dataset['demoError'] = error instanceof Error ? error.message : String(error);
  throw error;
});
