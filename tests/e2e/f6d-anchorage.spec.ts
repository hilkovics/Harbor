import { expect, test, type Page } from '@playwright/test';
import { dismissToasts } from './dismiss-toasts';

// F6d e2e (T6D-03, spätná väzba z hrania 2: „priplávajúce lode najskôr preplávajú okolo prístavu a potom sa vzdialia a niekde stoja“):
// nová hra na harbor_01 → štyri lode cez `SpawnShipDebug` (jedno kotvisko Root, veľký náklad, takže lode pri ňom ostanú) → čas sa posúva
// cez `window.__sim.advance`:
//   1. prvá loď ide rovno ku kotvisku (po sea lane), ostatné dostanú anchorage pri vstupe a plávajú na rejdu PRIAMO zo vstupu na mapu —
//      žiadna z nich nezájde na koniec sea lane pri prístave (najjužnejšia poloha lode mierená na rejdu je rad rejdy, nie y 7,5);
//   2. lode na rejde stoja v jednom rade severne od prístavu, ďaleko od brehu a od dráhy, a všetky jednotne natočené (kurz mapy
//      `anchorageHeading` = 90, predok na východ) — aj tie, čo priplávali zo západnej strany (kurz 270 počas plavby);
//   3. renderer ich naozaj kreslí (views lodí = lode na mape), v konzole žiadna chyba.
// Screenshot (gitignorovaný): `f6d-anchorage.png` — rejda s loďami v rade, pri kotvisku loď s vykládkou.

const SHOTS = 'tests/e2e/__screenshots__';
test.describe.configure({ timeout: 4 * 60_000 });

/** Pohľad na rejdu a prístav: rad rejdy (y 3,5) aj Root kotvisko (y 13–16) v jednom zábere, zoom 0,4 (kamera sa zarovná na horný okraj mapy). */
const ROADSTEAD_VIEW = { x: 53, y: 12, zoom: 0.4 } as const;

async function openGame(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(
    () =>
      window.__sim?.rendered !== undefined &&
      window.__sim.dispatchJSON !== undefined &&
      window.__sim.centerOn !== undefined &&
      window.__sim.advance !== undefined,
  );
  return errors;
}

/** Dva vykreslené snímky za sebou: renderer stihol prekresliť stav sveta. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('lode bez voľného kotviska plávajú priamo na rejdu a stoja tam jednotne natočené', async ({ page }) => {
  const errors = await openGame(page);

  // Sledovanie lodí po každom ticku (stránka): najjužnejšia poloha lode mierenej na rejdu a kurzy počas plavby / na kotve.
  await page.evaluate(() => {
    const sim = window.__sim!;
    const track = { southMost: new Map<number, number>(), sailingHeadings: new Set<number>(), restingHeadings: new Set<number>() };
    (window as unknown as { __track: typeof track }).__track = track;
    const originalAdvance = sim.advance!;
    sim.advance = (ticks: number): number => {
      let done = 0;
      for (let i = 0; i < ticks; i += 1) {
        const executed = originalAdvance(1);
        done += executed;
        for (const ship of sim.world.ships.values()) {
          if (ship.state !== 'waiting_anchorage') continue;
          track.southMost.set(ship.id, Math.max(track.southMost.get(ship.id) ?? 0, ship.y));
          (ship.waypointIndex >= ship.route.length ? track.restingHeadings : track.sailingHeadings).add(ship.heading);
        }
      }
      return done;
    };
  });

  for (const classId of ['feeder', 'handy', 'feeder', 'handy']) {
    const result = await page.evaluate((shipClassId) => window.__sim!.dispatchJSON!({ type: 'SpawnShipDebug', shipClassId, cargoTypeId: 'container_teu', units: 40 }), classId);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  }

  // Posun času, kým tri lode nestoja na rejde (štvrtá je pri kotvisku).
  await page.waitForFunction(
    () => {
      const sim = window.__sim!;
      sim.advance!(50);
      const ships = [...sim.world.ships.values()];
      return ships.length === 4 && ships.filter((ship) => ship.state === 'waiting_anchorage' && ship.waypointIndex >= ship.route.length).length === 3;
    },
    undefined,
    { polling: 'raf', timeout: 3 * 60_000 },
  );
  await page.evaluate(() => window.__sim!.world.clock.setSpeed(0));
  await dismissToasts(page);
  await page.evaluate(([x, y, zoom]) => window.__sim!.centerOn!(x, y, zoom), [ROADSTEAD_VIEW.x, ROADSTEAD_VIEW.y, ROADSTEAD_VIEW.zoom] as const);
  await settle(page);
  await page.mouse.move(0, 0);
  await settle(page);

  const snapshot = await page.evaluate(() => {
    const sim = window.__sim!;
    const track = (window as unknown as { __track: { southMost: Map<number, number>; sailingHeadings: Set<number>; restingHeadings: Set<number> } }).__track;
    const { anchorage, anchorageHeading, seaLane } = sim.world.map;
    const ships = [...sim.world.ships.values()].map((ship) => ({
      id: ship.id,
      state: ship.state,
      resting: ship.state === 'waiting_anchorage' && ship.waypointIndex >= ship.route.length,
      anchorageIndex: ship.anchorageIndex,
      x: ship.x,
      y: ship.y,
      heading: ship.heading,
    }));
    return {
      ships,
      anchorage,
      anchorageHeading,
      laneEndY: seaLane[seaLane.length - 1].y + 0.5,
      southMost: [...track.southMost.values()],
      sailingHeadings: [...track.sailingHeadings].sort((a, b) => a - b),
      restingHeadings: [...track.restingHeadings],
      renderedShips: sim.rendered!().ships,
      vmHeadings: sim.entities().ships.filter((ship) => ship.state === 'waiting_anchorage').map((ship) => ship.heading),
    };
  });

  const resting = snapshot.ships.filter((ship) => ship.resting);
  expect(resting).toHaveLength(3);
  expect(snapshot.ships.filter((ship) => ship.state === 'docked' || ship.state === 'berthing')).toHaveLength(1);
  // jednotný kurz na kotve (kurz mapy), v pokoji aj vo view modeli; počas plavby kurz sleduje trasu (juh po dráhe, východ aj západ)
  expect(snapshot.anchorageHeading).toBe(90);
  expect(snapshot.restingHeadings).toEqual([90]);
  expect(snapshot.vmHeadings).toEqual([90, 90, 90]);
  expect(snapshot.sailingHeadings).toEqual(expect.arrayContaining([90, 180, 270]));
  // lode stoja v jednom rade na bunkách rejdy, ďaleko od brehu (rad leží severne od pásu pred kotviskom, y < 8)
  for (const ship of resting) {
    const cell = snapshot.anchorage[ship.anchorageIndex ?? -1];
    expect([ship.x, ship.y]).toEqual([cell.x + 0.5, cell.y + 0.5]);
    expect(ship.y).toBeLessThan(6);
  }
  expect(new Set(resting.map((ship) => ship.y)).size).toBe(1);
  // priamy vstup: žiadna loď mierená na rejdu nezašla na koniec sea lane pri prístave (y 7,5), ani južnejšie než plavebný pruh pod radom
  expect(snapshot.southMost.length).toBe(3);
  for (const south of snapshot.southMost) expect(south).toBeLessThan(snapshot.laneEndY);
  expect(snapshot.renderedShips).toBe(4);

  await page.screenshot({ path: `${SHOTS}/f6d-anchorage.png` });
  expect(errors).toEqual([]);
});
