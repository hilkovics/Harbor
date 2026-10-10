/**
 * Demo renderu karty TF7-02 (F7 parcely): mapa `harbor_01` so živými parcelami — vlastnená starter, prenajatá `rail_yard`,
 * dve na predaj s cenovkou (jedna pod hoverom). Bez simu a UI. Stránka `f7-parcels.html`; Playwright
 * (`tests/e2e/f7-parcels-render.spec.ts`) z nej robí screenshot. Po vykreslení nastaví `data-demo-ready="true"` na `<body>`.
 */
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '../../../design/tokens.css';
import { loadBundledMap, type Parcel } from '@sim/grid';
import { WorldRenderer } from '../world-renderer';

export interface F7ParcelsDemo {
  readonly renderer: WorldRenderer;
  readonly parcels: Parcel[];
}

declare global {
  interface Window {
    __f7Demo?: F7ParcelsDemo;
  }
}

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
  if (host === null) throw new Error('f7-parcels.html: chýba #map');
  await document.fonts.load('600 12px Inter');
  const map = loadBundledMap();
  const parcels: Parcel[] = map.parcels.map((parcel) => ({ ...parcel }));
  const railYard = parcels.find((parcel) => parcel.id === 'rail_yard');
  if (railYard === undefined) throw new Error('f7-parcels.html: mapa nemá rail_yard');
  railYard.ownership = 'leased';
  const renderer = await WorldRenderer.create({ host, map, parcels, reducedMotion: () => true });
  const { camera } = renderer;
  camera.zoomAt(0.5 / camera.zoom, camera.viewportWidth / 2, camera.viewportHeight / 2);
  camera.centerOn(30, 30);
  renderer.syncCamera();
  renderer.parcels.setHover('west_quay');
  window.__f7Demo = { renderer, parcels };
  await afterTwoFrames();
  document.body.dataset['demoReady'] = 'true';
}

main().catch((error: unknown) => {
  document.body.dataset['demoError'] = error instanceof Error ? error.message : String(error);
  throw error;
});
