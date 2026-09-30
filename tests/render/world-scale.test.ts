// F5b č. 10 — audit mierky celej hry. Čísla z tabuľky v docs/DESIGN_BRIEF.md §4.1 sa tu overujú priamo proti SVG a manifestu,
// takže tabuľka nemôže potichu zastarať. Príčina chyby „vozík sa po naložení scvrkne“: sprity vozidiel sa škálovali na šírku pruhu
// (26 / 56 ≈ 0,46), zatiaľ čo kontajnery na aprone, pod žeriavom a na lodi majú mierku 1 — kontajner sa pri naložení zmenšil na menej
// než polovicu a pri vyložení zväčšil späť.
import { readFileSync } from 'node:fs';
import { Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { LOADED_VEHICLES, MANIFEST_CELL_PX, cargoSpriteEntry, moduleSprite, shipSprite, vehicleSprite } from '@render/entity-assets';
import { ROAD_ASPHALT_PX, VEHICLE_BODY_WIDTH_PX, VEHICLE_SCALE, VEHICLE_WIDTH_PX } from '@render/lane';
import { NARROW_ASPHALT_PX } from '@render/narrow-road';
import { TruckView } from '@render/truck-view';
import { VehicleView } from '@render/vehicle-view';
import { YARD_BOX_CELLS } from '@render/yard-crane-decor';
import type { TruckVM, VehicleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = MANIFEST_CELL_PX;
const CONTAINER_FILL = '#F28C28';

function readAsset(path: string): string {
  return readFileSync(new URL(`../../assets/${path}`, import.meta.url), 'utf8');
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: string;
}

/** `<rect>` s výplňou (px zdroja); hodnoty v súboroch sú celé px alebo s jedným desatinným miestom. */
function rects(svg: string): Rect[] {
  return [...svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="(#[0-9A-Fa-f]{6})"/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
    fill: match[5].toUpperCase(),
  }));
}

function viewBox(svg: string): { w: number; h: number } {
  const match = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (match === null) throw new Error('SVG bez viewBox');
  return { w: Number(match[1]), h: Number(match[2]) };
}

/** Kontajner (oranžová výplň) v sprite vozidla. */
function containerIn(svg: string): Rect {
  const found = rects(svg).filter((rect) => rect.fill === CONTAINER_FILL);
  expect(found).toHaveLength(1);
  return found[0];
}

const TEU = cargoSpriteEntry('container_teu')!.size; // 64 × 32 (dlhšia strana pozdĺž x pri rot 0)

describe('audit mierky: jeden kontajner TEU 64 × 32 px je základ', () => {
  it('cargo.container_teu: 1 × 0,5 bunky; na lodi (paluba feedera aj handy) sú kontajnery rovnaké (32 × 64 pozdĺž lode)', () => {
    expect(TEU).toEqual({ w: 64, h: 32 });
    for (const ship of ['ship_feeder_container_loaded', 'ship_handy_container_loaded']) {
      const decks = rects(readAsset(`entities/${ship}.svg`)).filter((rect) => rect.width === 32 && rect.height === 64);
      expect(decks.length, ship).toBeGreaterThan(0);
    }
  });

  it('kontajner v políčku dvora je menší (47 × 17 px): dvor nakreslil Claude Design zvlášť, žeriav dvora používa jeho veľkosť', () => {
    const fill00 = readAsset('modules/container_yard_small_fill00.svg');
    expect(fill00).toContain('width="47" height="17"');
    expect(YARD_BOX_CELLS.w * CELL).toBeCloseTo(47, 9);
    expect(YARD_BOX_CELLS.h * CELL).toBeCloseTo(17, 9);
  });
});

describe('audit mierky: vozidlá sú v pomere ku kontajneru', () => {
  const carrierEmpty = readAsset('entities/straddle_carrier_empty.svg');
  const carrierLoaded = readAsset('entities/straddle_carrier_loaded.svg');
  const truckLoaded = readAsset('entities/truck_container_loaded.svg');
  const truckEmpty = readAsset('entities/truck_container_empty.svg');

  it('straddle carrier obkročí jeden kontajner: otvor medzi nosníkmi je 32 px = šírka TEU a kontajner v ňom má 30 × 52 px', () => {
    const legs = rects(carrierEmpty).filter((rect) => rect.fill === '#F4D03F' && rect.height === 58); // bočné nosníky 6 × 58
    expect(legs).toHaveLength(2);
    const [left, right] = legs.sort((a, b) => a.x - b.x);
    const opening = right.x - (left.x + left.width);
    expect(opening).toBe(TEU.h); // 32
    const container = containerIn(carrierLoaded);
    expect(container.width).toBeLessThanOrEqual(opening);
    expect(container.width / TEU.h).toBeGreaterThan(0.9);
    expect(container.height / TEU.w).toBeGreaterThan(0.8); // kontajner na vozidle ≥ 80 % TEU (pôvodne 0,36 × 0,41)
    // a rám carriera sa zmestí do bunky
    expect(Math.max(...legs.map((leg) => leg.height))).toBeLessThanOrEqual(CELL);
  });

  it('kamión nesie jeden TEU: kontajner v návese je 32 × 64 px = TEU; obsah kamióna je 1,56 × dlhší než kontajner', () => {
    const container = containerIn(truckLoaded);
    expect([container.width, container.height]).toEqual([TEU.h, TEU.w]);
    const all = rects(truckEmpty);
    const top = Math.min(...all.map((rect) => rect.y));
    const bottom = Math.max(...all.map((rect) => rect.y + rect.height));
    const length = bottom - top;
    expect(length / TEU.w).toBeGreaterThan(1); // o niečo dlhší ako kontajner
    expect(length / TEU.w).toBeLessThan(1.7);
    // a je vycentrovaný v plátne 64 × 128 (zadok aj kabína majú rovnakú rezervu)
    expect(top + bottom).toBeCloseTo(viewBox(truckEmpty).h, 6);
  });

  it('kamión je dlhší než straddle carrier a užší než asfalt cesty; carrier s rezervou prechádza po ceste', () => {
    const truckBody = rects(truckEmpty);
    const truckWidth = Math.max(...truckBody.map((rect) => rect.x + rect.width)) - Math.min(...truckBody.map((rect) => rect.x));
    expect(truckWidth).toBeLessThanOrEqual(VEHICLE_BODY_WIDTH_PX);
    expect(VEHICLE_BODY_WIDTH_PX).toBeLessThan(ROAD_ASPHALT_PX);
    const carrierBody = rects(carrierEmpty);
    const carrierWidth = Math.max(...carrierBody.map((rect) => rect.x + rect.width)) - Math.min(...carrierBody.map((rect) => rect.x));
    expect(carrierWidth).toBe(VEHICLE_BODY_WIDTH_PX);
  });

  it('prázdny a naložený variant majú rovnaké plátno (viewBox) a rovnakú veľkosť vo view — naloženie mierku nemení', () => {
    for (const defId of LOADED_VEHICLES) {
      const entry = vehicleSprite(defId)!;
      const empty = viewBox(readAsset(entry.states.empty));
      const loaded = viewBox(readAsset(entry.states.loaded));
      expect(loaded, defId).toEqual(empty);
      expect(empty, defId).toEqual({ w: entry.footprint.w * CELL, h: entry.footprint.h * CELL });
    }
  });

  it('jediná mierka vozidiel: sprite carriera aj kamióna = footprint × bunka × VEHICLE_SCALE, v oboch stavoch rovnako', () => {
    const textures = new StubTextures();
    const deps = { cellPx: PALETTE.cellPx, palette: ENTITY_PALETTE, textures };
    const carrier: VehicleVM = { id: 1, defId: 'straddle_carrier', x: 5.5, y: 5.5, prevX: 5.5, prevY: 5.5, heading: 0, loaded: false, state: 'idle' };
    const truck: TruckVM = { ...carrier, id: 2, defId: 'truck_container', state: 'to_gate' };
    for (const [view, defId] of [
      [new VehicleView(carrier, deps), 'straddle_carrier'],
      [new TruckView(truck, deps), 'truck_container'],
    ] as const) {
      const footprint = vehicleSprite(defId)!.footprint;
      const sprite = view.view.children[0] as Sprite;
      expect(sprite.width).toBeCloseTo(footprint.w * PALETTE.cellPx * VEHICLE_SCALE, 9);
      expect(sprite.height).toBeCloseTo(footprint.h * PALETTE.cellPx * VEHICLE_SCALE, 9);
      view.update({ ...(defId === 'straddle_carrier' ? carrier : truck), loaded: true }, 1);
      expect(sprite.width).toBeCloseTo(footprint.w * PALETTE.cellPx * VEHICLE_SCALE, 9);
      expect(sprite.height).toBeCloseTo(footprint.h * PALETTE.cellPx * VEHICLE_SCALE, 9);
    }
  });

  it('kontajner na carrieri po mierke ≥ 80 % kontajnera na aprone (pred opravou 41 % × 36 %)', () => {
    const container = containerIn(carrierLoaded);
    const shown = { w: container.width * VEHICLE_SCALE, h: container.height * VEHICLE_SCALE };
    expect(shown.w / TEU.h).toBeGreaterThan(0.8);
    expect(shown.h / TEU.w).toBeGreaterThan(0.8);
    // pôvodná mierka 26 / 56 by to porušila
    expect((container.width * 26) / 56 / TEU.h).toBeLessThan(0.5);
  });
});

describe('audit mierky: cesty, lode a moduly', () => {
  it('cesta: dvojpruhový asfalt 52 px, úzka cesta 40 px; vozidlo (48 px) sa zmestí na dvojpruhovú a na úzkej presahuje o 4 px na strane', () => {
    expect(ROAD_ASPHALT_PX).toBe(52);
    expect(NARROW_ASPHALT_PX).toBe(40);
    expect(VEHICLE_WIDTH_PX).toBe(VEHICLE_BODY_WIDTH_PX * VEHICLE_SCALE);
    expect((VEHICLE_WIDTH_PX - NARROW_ASPHALT_PX) / 2).toBe(4);
  });

  it('lode: feeder 2 × 6 bunky (šírka 4 TEU), handy 2 × 10; brána 2 × 2, rampa 4 × 2 (dok 56 × 62 px), dvor 4 × 4, berth 8 × 3', () => {
    expect(shipSprite('feeder')!.footprint).toEqual({ w: 2, h: 6 });
    expect(shipSprite('handy')!.footprint).toEqual({ w: 2, h: 10 });
    expect(moduleSprite('truck_gate')!.footprint).toEqual({ w: 2, h: 2 });
    expect(moduleSprite('loading_ramp_container')!.footprint).toEqual({ w: 4, h: 2 });
    expect(moduleSprite('loading_ramp_container')!.docks![0]).toMatchObject({ w: 56, h: 62 });
    expect(moduleSprite('container_yard_small')!.footprint).toEqual({ w: 4, h: 4 });
    expect(moduleSprite('berth_standard')!.footprint).toEqual({ w: 8, h: 3 });
  });

  it('dok rampy (56 × 62 px) je o niečo plytší než TEU (64 px) a širší než jeho šírka (32 px): zadok kamióna je v rampe, kabína von', () => {
    const dock = moduleSprite('loading_ramp_container')!.docks![0];
    expect(dock.h).toBeLessThan(TEU.w); // dok je o niečo kratší než kontajner (zadok kamióna je v rampe)
    expect(dock.w).toBeGreaterThan(TEU.h);
  });
});
