import { expect, test, type Page } from '@playwright/test';

// F3 render demo (T03-08): pevné view-modely bez simu (`src/render/__demo__/f3-render.html`). Screenshoty slúžia na
// vizuálnu kontrolu: fill stavy dvorov, vozidlá (empty / loaded, kurzy), pripojené a odpojené depo s odznakom.
// Scéna `lanes` (T03-17, `?scene=lanes`): vozidlá jazdia v pravom pruhu, protismerné sa nekrížia (`f3-lanes.png`); od T03-19 idú
// v zákrutách po oblúku okolo vnútorného rohu (pravá zákruta polomer 19 px, ľavá 45 px). Od F5b č. 10 majú vozidlá reálnu mierku
// (1 bunka ≈ 6 m: carrier 34 px, kamión 28 px široký) — sprite má plátno 1 bunka široké, vozidlo v ňom presahuje pruh 26 px
// najviac o pár px (carrier 4 px, kamión 1 px).
// Scéna `road-kinds` (T03-19, `?scene=road-kinds`): dvojpruhová, jednopruhová a jednosmerná cesta, križovatky rôznych
// typov, jednosmerný okruh so šípkami a vozidlá aj v oblúku (`f3-road-kinds.png`).

const DEMO_URL = '/src/render/__demo__/f3-render.html';

async function openDemo(page: Page, scene?: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(scene === undefined ? DEMO_URL : `${DEMO_URL}?scene=${scene}`);
  await page.waitForSelector('body[data-demo-ready="true"]');
  return errors;
}

test.describe('F3: render skladov, vozidiel a odznaku „nepripojené“ (demo s pevnými view-modelmi)', () => {
  test('2 dvory (fill 0 a 75), pripojené depo, 3 vozidlá a odpojené depo s odznakom', async ({ page }) => {
    const errors = await openDemo(page);

    const state = await page.evaluate(() => {
      const { renderer, scene } = window.__f3RenderDemo!;
      const modules = scene.modules.map((module) => {
        const view = renderer.modules.moduleView(module.id);
        return { id: module.id, defId: module.defId, fill: view?.fill ?? null, badge: view?.badgeVisible ?? null };
      });
      const vehicles = (scene.vehicles ?? []).map((vehicle) => {
        const view = renderer.entities.vehicleView(vehicle.id);
        const angle = view?.view.angle ?? 0;
        return { id: vehicle.id, angle: Math.round(((angle % 360) + 360) % 360), textured: view?.texture !== null };
      });
      return { modules, vehicles, moduleCount: renderer.modules.moduleCount, vehicleCount: renderer.entities.vehicleCount };
    });

    expect(state.moduleCount).toBe(4);
    expect(state.vehicleCount).toBe(3);
    expect(state.modules).toEqual([
      { id: 1, defId: 'container_yard_small', fill: 0, badge: false },
      { id: 2, defId: 'container_yard_small', fill: 75, badge: false },
      { id: 3, defId: 'vehicle_depot', fill: null, badge: false },
      { id: 4, defId: 'vehicle_depot', fill: null, badge: true },
    ]);
    // sprity (nie fallback) a kurzy 90° / 270° / 0°
    expect(state.vehicles.map((vehicle) => vehicle.textured)).toEqual([true, true, true]);
    expect(state.vehicles.map((vehicle) => vehicle.angle)).toEqual([90, 270, 0]);

    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-render-demo.png' });
    expect(errors).toEqual([]);
  });

  test('aktualizácia za behu: dvor sa zaplní na 100, depo sa pripojí (odznak zmizne), vozidlo sa posunie', async ({ page }) => {
    const errors = await openDemo(page);

    const after = await page.evaluate(async () => {
      const { renderer, scene, show } = window.__f3RenderDemo!;
      const modules = scene.modules.map((module) => {
        if (module.id === 2 && module.storage) return { ...module, storage: { ...module.storage, stored: module.storage.capacity } };
        if (module.id === 4) return { ...module, connected: true };
        return module;
      });
      const vehicles = (scene.vehicles ?? []).map((vehicle) =>
        vehicle.id === 11 ? { ...vehicle, prevX: vehicle.x, x: vehicle.x + 1, loaded: true } : vehicle,
      );
      await show({ ...scene, modules, vehicles }, 0.5);
      const moved = renderer.entities.vehicleView(11);
      return {
        fill: renderer.modules.moduleView(2)?.fill,
        badge: renderer.modules.moduleView(4)?.badgeVisible,
        moduleViews: renderer.modules.moduleCount,
        movedX: moved?.view.x,
        expectedX: 37 * renderer.palette.cellPx, // lerp(36,5 → 37,5; 0,5) = 37 bunky
        loadedTexture: moved?.texture === renderer.entities.vehicleView(12)?.texture,
      };
    });

    expect(after.fill).toBe(100);
    expect(after.badge).toBe(false);
    expect(after.moduleViews).toBe(4); // zmena zaplnenia a pripojenia nevytvorila views nanovo
    expect(after.movedX).toBe(after.expectedX);
    expect(after.loadedTexture).toBe(true); // vozidlo 11 je teraz naložené ako vozidlo 12 (rovnaká textúra)
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-render-demo-updated.png' });
    expect(errors).toEqual([]);
  });
});

test.describe('F3: vozidlá v pravom pruhu a po oblúku v zákrutách (scéna lanes)', () => {
  /** Posun stredu vozidla od osi cesty (bunky) vpravo od smeru jazdy: stred pravého pruhu, 13 px z 64 px bunky. */
  const LANE = 13 / 64;
  const RIGHT_OF_HEADING: Record<number, readonly [number, number]> = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };

  /**
   * Vozidlá v bunkách zákrut: stred oblúka `q` (roh bunky, v ktorom sa stretávajú pripojené strany), polomer pruhu v px zdroja
   * (pravá zákruta 19, ľavá 45), parameter oblúka `t` (podiel dráhy v bunke) a kurz vstupu s otočením (+90 / −90).
   */
  const ARCS: Record<number, { q: readonly [number, number]; radius: number; t: number; from: number; delta: number }> = {
    31: { q: [48, 25], radius: 19, t: 0.62, from: 90, delta: 90 }, //  (48; 24) východ → juh, pravá
    32: { q: [43, 28], radius: 45, t: 0.62, from: 180, delta: -90 }, //  (42; 28) juh → východ, ľavá
    33: { q: [48, 25], radius: 45, t: 0.25, from: 0, delta: -90 }, //  (48; 24) sever → západ, ľavá
    34: { q: [43, 28], radius: 19, t: 0.3, from: 270, delta: 90 }, //  (42; 28) západ → sever, pravá
    35: { q: [48, 28], radius: 19, t: 0.5, from: 180, delta: 90 }, //  (48; 28) juh → západ, pravá
    36: { q: [48, 28], radius: 45, t: 0.8, from: 90, delta: -90 }, //  (48; 28) východ → sever, ľavá
  };

  test('priama cesta, protismer vedľa seba, T-križovatka: každé vozidlo v pravom pruhu; v zákrutách na oblúku', async ({ page }) => {
    const errors = await openDemo(page, 'lanes');

    const state = await page.evaluate(() => {
      const { renderer, scene } = window.__f3RenderDemo!;
      const cellPx = renderer.palette.cellPx;
      const vehicles = (scene.vehicles ?? []).map((vehicle) => {
        const view = renderer.entities.vehicleView(vehicle.id);
        const sprite = view?.view.children[0];
        return {
          id: vehicle.id,
          x: view?.view.x ?? Number.NaN,
          y: view?.view.y ?? Number.NaN,
          angle: (((view?.view.angle ?? 0) % 360) + 360) % 360,
          spriteWidth: sprite?.width ?? Number.NaN,
          textured: view?.texture !== null,
        };
      });
      return { cellPx, vehicles, vehicleCount: renderer.entities.vehicleCount, modules: renderer.modules.moduleCount };
    });
    const scene = await page.evaluate(() => window.__f3RenderDemo!.scene.vehicles ?? []);

    expect(state.vehicleCount).toBe(scene.length);
    expect(state.modules).toBe(0);
    expect(state.vehicles.every((vehicle) => vehicle.textured)).toBe(true);

    for (const vehicle of state.vehicles) {
      const vm = scene.find((candidate) => candidate.id === vehicle.id)!;
      const px = vehicle.x / state.cellPx;
      const py = vehicle.y / state.cellPx;
      const arc = ARCS[vehicle.id];
      if (arc === undefined) {
        const [rx, ry] = RIGHT_OF_HEADING[vm.heading];
        // stred vozidla = poloha z VM + posun o 13/64 bunky doprava od smeru jazdy
        expect(px, `x vozidla ${String(vehicle.id)}`).toBeCloseTo(vm.x + rx * LANE, 6);
        expect(py, `y vozidla ${String(vehicle.id)}`).toBeCloseTo(vm.y + ry * LANE, 6);
        expect(vehicle.angle).toBeCloseTo(vm.heading, 6);
      } else {
        // zákruta: vozidlo leží na oblúku okolo vnútorného rohu, uhol sa otáča plynulo z kurzu vstupu na kurz výstupu
        expect(Math.hypot(px - arc.q[0], py - arc.q[1]) * 64, `polomer oblúka vozidla ${String(vehicle.id)}`).toBeCloseTo(arc.radius, 6);
        const expectedAngle = (((arc.from + arc.delta * arc.t) % 360) + 360) % 360;
        expect(vehicle.angle, `uhol vozidla ${String(vehicle.id)}`).toBeCloseTo(expectedAngle, 6);
      }
      // sprite má jednotnú mierku vozidiel (VEHICLE_SCALE = 1): plátno 1 bunka, vozidlo a kontajner v ňom v reálnej mierke
      expect(vehicle.spriteWidth / state.cellPx).toBeCloseTo(1, 6);
    }

    // protismerná dvojica v jednej bunke: stredy sú od seba práve jeden pruh (26/64 bunky) kolmo na cestu
    const at = (id: number): { x: number; y: number } => state.vehicles.find((vehicle) => vehicle.id === id)!;
    expect(Math.abs(at(21).y - at(22).y) / state.cellPx).toBeCloseTo(26 / 64, 6);
    expect(at(21).x).toBeCloseTo(at(22).x, 6);
    expect(Math.abs(at(25).x - at(26).x) / state.cellPx).toBeCloseTo(26 / 64, 6);
    expect(at(25).y).toBeCloseTo(at(26).y, 6);

    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-lanes.png' });
    expect(errors).toEqual([]);
  });

  test('zákruta za behu: vozidlo prejde hranu bunky a stred po oblúku (alpha 0, 0,5 a 1), bez skoku cez stredovú čiaru', async ({ page }) => {
    const errors = await openDemo(page, 'lanes');

    const samples = await page.evaluate(async () => {
      const { renderer, scene, show } = window.__f3RenderDemo!;
      const cellPx = renderer.palette.cellPx;
      const result: { alpha: number; x: number; y: number; angle: number }[] = [];
      for (let i = 0; i <= 20; i++) {
        const alpha = i / 20;
        await show(scene, alpha);
        const view = renderer.entities.vehicleView(31)!;
        result.push({ alpha, x: view.view.x / cellPx, y: view.view.y / cellPx, angle: (((view.view.angle % 360) + 360) % 360) });
      }
      return result;
    });

    // vozidlo 31: prev (47,95; 24,5) kurz 90° → aktuálna (48,5; 24,62) kurz 180°; zákruta (48; 24) = východ → juh, pravá (19 px)
    const start = samples[0];
    expect(start.x).toBeCloseTo(47.95, 6);
    expect(start.y).toBeCloseTo(24.5 + 13 / 64, 6); // ešte v priamom pravom pruhu susednej bunky
    expect(start.angle).toBeCloseTo(90, 6);
    const end = samples[samples.length - 1];
    expect(Math.hypot(end.x - 48, end.y - 25) * 64).toBeCloseTo(19, 6);
    expect(end.angle).toBeCloseTo(90 + 90 * 0.62, 6);
    // po vstupe do bunky zákruty (x ≥ 48) leží vozidlo stále na oblúku s polomerom 19 px okolo rohu (48; 25)
    const inside = samples.filter((sample) => sample.x >= 48);
    expect(inside.length).toBeGreaterThan(10);
    for (const sample of inside) expect(Math.hypot(sample.x - 48, sample.y - 25) * 64).toBeCloseTo(19, 6);
    // plynulosť: najväčší krok medzi susednými vzorkami je len zlomok bunky a uhol sa mení monotónne
    let largest = 0;
    for (let i = 1; i < samples.length; i++) {
      largest = Math.max(largest, Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
      expect(samples[i].angle).toBeGreaterThanOrEqual(samples[i - 1].angle - 1e-9);
    }
    expect(largest).toBeLessThan(0.05);
    expect(errors).toEqual([]);
  });
});

test.describe('F3: typy ciest, šípky jednosmerky a oblúky (scéna road-kinds)', () => {
  test('dvojpruhová, jednopruhová a jednosmerná cesta: vozidlá v pruhu / v strede, šípky, lieviky a vozidlá v oblúku', async ({ page }) => {
    const errors = await openDemo(page, 'road-kinds');

    const state = await page.evaluate(() => {
      const { renderer, scene } = window.__f3RenderDemo!;
      const cellPx = renderer.palette.cellPx;
      const vehicles = (scene.vehicles ?? []).map((vehicle) => {
        const view = renderer.entities.vehicleView(vehicle.id);
        return {
          id: vehicle.id,
          x: (view?.view.x ?? Number.NaN) / cellPx,
          y: (view?.view.y ?? Number.NaN) / cellPx,
          angle: (((view?.view.angle ?? 0) % 360) + 360) % 360,
          textured: view?.texture !== null,
        };
      });
      const style = (x: number, y: number): string | undefined => renderer.roads.tileStyleAt(x, y);
      return {
        vehicles,
        vehicleCount: renderer.entities.vehicleCount,
        styles: {
          wide: style(36, 21),
          narrow: style(36, 23),
          oneWay: style(36, 25),
          taper: style(38, 27),
          crossArm: style(42, 22),
        },
        tiles: renderer.roads.tileCount,
        arrows: renderer.roadMarks.arrowCount,
        arrowE: renderer.roadMarks.arrowAt(36, 25),
        arrowS: renderer.roadMarks.arrowAt(54, 24),
        arrowNone: renderer.roadMarks.arrowAt(36, 23),
        layers: renderer.world.children.map((child) => child.label),
      };
    });
    const scene = await page.evaluate(() => window.__f3RenderDemo!.scene.vehicles ?? []);

    expect(state.vehicleCount).toBe(scene.length);
    expect(state.vehicles.every((vehicle) => vehicle.textured)).toBe(true);
    expect(state.styles).toEqual({ wide: 'wide', narrow: 'narrow:0', oneWay: 'narrow:0', taper: expect.stringMatching(/^narrow:[1-9]/), crossArm: expect.stringMatching(/^narrow:[1-9]/) });
    expect(state.arrows).toBe(92); // okruh 20 + rovná cesta 6 + odbočka 4 + štartová slučka harbor_01 60 (jednosmerka od R1) + západný portál 2 (R4, ADR-041)
    expect([state.arrowE, state.arrowS, state.arrowNone]).toEqual([90, 180, undefined]);
    // vrstva značiek je nad cestami a pod entitami (šípky nezakryjú vozidlá)
    expect(state.layers.indexOf('road-marks')).toBe(state.layers.indexOf('roads') + 1);
    expect(state.layers.indexOf('road-marks')).toBeLessThan(state.layers.indexOf('entities'));

    const at = (id: number) => state.vehicles.find((vehicle) => vehicle.id === id)!;
    const vm = (id: number) => scene.find((vehicle) => vehicle.id === id)!;
    // dvojpruhová cesta y 21: vozidlo na východ je v južnom pruhu (+13/64), na západ v severnom (−13/64)
    expect(at(41).y).toBeCloseTo(vm(41).y + 13 / 64, 6);
    expect(at(42).y).toBeCloseTo(vm(42).y - 13 / 64, 6);
    // jednopruhová a jednosmerná: v strede cesty
    for (const id of [43, 44, 45, 46, 51, 52, 53, 54]) {
      expect(at(id).x, `x ${String(id)}`).toBeCloseTo(vm(id).x, 6);
      expect(at(id).y, `y ${String(id)}`).toBeCloseTo(vm(id).y, 6);
    }
    // zúženie: dvojpruhová časť (x 35–37) v pruhu, jednopruhová (x 38–40) v strede
    expect(at(47).y).toBeCloseTo(vm(47).y + 13 / 64, 6);
    expect(at(48).y).toBeCloseTo(vm(48).y, 6);

    // oblúky na jednosmernom okruhu: polomer 32 px (stred cesty) okolo vnútorného rohu, uhol podľa polohy v bunke
    const ARCS: Record<number, { q: readonly [number, number]; from: number; t: number }> = {
      56: { q: [54, 22], from: 90, t: 0.25 }, //  (54; 21) východ → juh, štvrtina oblúka
      58: { q: [54, 26], from: 180, t: 0.5 }, //  (54; 26) juh → západ, stred oblúka
      60: { q: [50, 26], from: 270, t: 0.75 }, //  (49; 26) západ → sever, tesne po strede
    };
    for (const [id, arc] of Object.entries(ARCS)) {
      const vehicle = at(Number(id));
      expect(Math.hypot(vehicle.x - arc.q[0], vehicle.y - arc.q[1]) * 64, `polomer vozidla ${id}`).toBeCloseTo(32, 6);
      const expected = (((arc.from + 90 * arc.t) % 360) + 360) % 360;
      expect(vehicle.angle, `uhol vozidla ${id}`).toBeCloseTo(expected, 6);
    }

    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-road-kinds.png' });
    expect(errors).toEqual([]);
  });

  test('zblízka a z diaľky: križovatka širokej a úzkych ciest s lievikmi, okruh so šípkami pri zoome 0,5 a 2', async ({ page }) => {
    const errors = await openDemo(page, 'road-kinds');

    const zoomTo = async (zoom: number, cellX: number, cellY: number): Promise<void> => {
      await page.evaluate(async ({ zoom: z, cellX: cx, cellY: cy }) => {
        const { renderer, show, scene } = window.__f3RenderDemo!;
        const { camera } = renderer;
        camera.zoomAt(z / camera.zoom, camera.viewportWidth / 2, camera.viewportHeight / 2);
        camera.centerOn(cx, cy);
        renderer.syncCamera();
        await show(scene);
      }, { zoom, cellX, cellY });
    };

    await zoomTo(2, 44, 24);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-road-kinds-junction.png' });
    await zoomTo(2, 51.5, 23.5);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-road-kinds-ring.png' });
    await zoomTo(2, 42, 27.5);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-road-kinds-bend.png' });
    await zoomTo(0.5, 44.5, 25);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-road-kinds-far.png' });
    expect(errors).toEqual([]);
  });
});
