// F5b č. 10 — audit mierky celej hry (realistická mierka: 1 bunka ≈ 6 m, pruhy ostávajú). Čísla z tabuľky v docs/DESIGN_BRIEF.md §4.1
// sa tu overujú priamo proti SVG a manifestu, takže tabuľka nemôže potichu zastarať. Príčina chyby „vozík sa po naložení scvrkne“:
// sprity vozidiel sa škálovali na šírku pruhu (26 / 56 ≈ 0,46), zatiaľ čo kontajnery na aprone, pod žeriavom a na lodi majú mierku 1 —
// kontajner sa pri naložení zmenšil na menej než polovicu a pri vyložení zväčšil späť.
import { Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  LOADED_VEHICLES,
  MANIFEST_CELL_PX,
  cargoDisplaySize,
  cargoSpriteEntry,
  moduleSprite,
  shipSprite,
  vehicleSprite,
} from '@render/entity-assets';
import { LANE_WIDTH_PX, ROAD_ASPHALT_PX, VEHICLE_SCALE, VEHICLE_WIDTH_PX, laneOverhangPx } from '@render/lane';
import { NARROW_ASPHALT_PX } from '@render/narrow-road';
import { TruckView } from '@render/truck-view';
import { VehicleView } from '@render/vehicle-view';
import {
  CARRIER_LENGTH_PX,
  CARRIER_LENGTH_M,
  CARRIER_WIDTH_PX,
  METERS_PER_CELL,
  PX_PER_METER,
  TEU_LENGTH_M,
  TEU_PX,
  TEU_WIDTH_M,
  TRUCK_LENGTH_M,
  TRUCK_LENGTH_PX,
  TRUCK_WIDTH_PX,
  metersToPx,
} from '@render/world-scale';
import { YARD_BOX_CELLS } from '@render/yard-crane-decor';
import type { TruckVM, VehicleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';
import { contentExtent, outer, readAsset, svgRects, viewBox } from './svg-geometry';

const CELL = MANIFEST_CELL_PX;
const CONTAINER_FILL = '#F28C28';

/** Kontajner (oranžová výplň) v sprite vozidla: vonkajšie rozmery vrátane obrysu. */
function containerIn(svg: string): ReturnType<typeof outer> {
  const found = svgRects(svg).filter((rect) => rect.fill === CONTAINER_FILL);
  expect(found).toHaveLength(1);
  return outer(found[0]);
}

describe('referenčná mierka: 1 bunka = 6 m', () => {
  it('64 px na bunku, ≈ 10,67 px na meter; TEU 20 ft (6,06 × 2,44 m) = 64 × 26 px', () => {
    expect(CELL).toBe(64);
    expect(METERS_PER_CELL).toBe(6);
    expect(PX_PER_METER).toBeCloseTo(64 / 6, 12);
    expect(TEU_PX).toEqual({ w: 64, h: 26 });
    expect(6.06 * PX_PER_METER).toBeCloseTo(64.6, 1); // skutočný 20 ft kontajner ≈ jedna bunka
    expect(TEU_WIDTH_M * PX_PER_METER).toBeCloseTo(26.03, 2);
    expect(metersToPx(TEU_LENGTH_M)).toBe(TEU_PX.w);
    expect(metersToPx(TEU_WIDTH_M)).toBe(TEU_PX.h);
  });

  it('kamión ≈ 2,6 × 10,9 m (28 × 116 px), carrier ≈ 3,2 × 5,8 m (34 × 62 px)', () => {
    expect([TRUCK_WIDTH_PX, TRUCK_LENGTH_PX]).toEqual([28, 116]);
    expect([CARRIER_WIDTH_PX, CARRIER_LENGTH_PX]).toEqual([34, 62]);
    expect(TRUCK_LENGTH_PX / PX_PER_METER).toBeCloseTo(TRUCK_LENGTH_M, 1);
    expect(CARRIER_LENGTH_PX / PX_PER_METER).toBeCloseTo(CARRIER_LENGTH_M, 1);
    // kamión ťahač + podvozok 20 ft je ≈ 2 bunky (footprint 1 × 2), carrier sa zmestí do bunky 1 × 1
    expect(vehicleSprite('truck_container')!.footprint).toEqual({ w: 1, h: 2 });
    expect(TRUCK_LENGTH_PX).toBeLessThanOrEqual(2 * CELL);
    expect(TRUCK_LENGTH_PX).toBeGreaterThan(1.6 * CELL);
    expect(vehicleSprite('straddle_carrier')!.footprint).toEqual({ w: 1, h: 1 });
    expect(CARRIER_LENGTH_PX).toBeLessThanOrEqual(CELL);
  });
});

describe('audit mierky: kontajner TEU je všade rovnako veľký (64 × 26 px)', () => {
  const teu = svgRects(readAsset('cargo/container_teu.svg')).find((rect) => rect.fill === CONTAINER_FILL)!;
  /** Sprite `cargo.container_teu` je nakreslený 64 × 32 px, renderer ho zmenší na šírku 26 px. */
  const canvas = viewBox(readAsset('cargo/container_teu.svg'));
  const displayed = { length: outer(teu).width, across: (outer(teu).height * TEU_PX.h) / canvas.h };

  it('zobrazená veľkosť nákladu: kontajner 64 × 26 (jedno miesto, `cargoDisplaySize`), ostatný náklad z manifestu', () => {
    expect(canvas).toEqual({ w: 64, h: 32 });
    expect(cargoSpriteEntry('container_teu')!.size).toEqual({ w: 64, h: 32 });
    expect(cargoDisplaySize('container_teu')).toEqual(TEU_PX);
    expect(cargoDisplaySize('bulk_pile')).toEqual({ w: 32, h: 32 });
    expect(cargoDisplaySize('neznamy')).toBeUndefined();
  });

  it('kontajner v návese kamióna je TEU: 62 × 24,8 px (64 × 26 s 1 px okrajom); v straddle carrieri rovnako', () => {
    for (const [file, label] of [
      ['entities/truck_container_loaded.svg', 'kamión'],
      ['entities/straddle_carrier_loaded.svg', 'carrier'],
    ] as const) {
      const container = containerIn(readAsset(file));
      // dĺžka pozdĺž jazdy = dĺžka TEU, šírka = šírka TEU zmenšená rovnako ako pri sprite (26 / 32)
      expect(container.height, label).toBeCloseTo(displayed.length, 6);
      expect(container.width, label).toBeCloseTo(displayed.across, 0);
      expect(Math.abs(container.width - displayed.across), label).toBeLessThan(0.5);
    }
  });

  it('kontajner v dvore (políčko sprite 47 × 17) je menší než TEU 64 × 26: nesúlad je v BACKLOG, žeriav dvora ho preberá', () => {
    expect(readAsset('modules/container_yard_small_fill00.svg')).toContain('width="47" height="17"');
    expect(YARD_BOX_CELLS.w * CELL).toBeCloseTo(47, 9);
    expect(YARD_BOX_CELLS.h * CELL).toBeCloseTo(17, 9);
    expect(47).toBeLessThan(TEU_PX.w);
    expect(17).toBeLessThan(TEU_PX.h);
  });

  it('paluba lode má kontajnery nakreslené 32 × 64 (šírka 32, nie 26): SVG lodí nemeníme, nesúlad je v BACKLOG', () => {
    for (const ship of ['ship_feeder_container_loaded', 'ship_handy_container_loaded']) {
      const decks = svgRects(readAsset(`entities/${ship}.svg`)).filter((rect) => rect.width === 32 && rect.height === 64);
      expect(decks.length, ship).toBeGreaterThan(0);
    }
  });
});

describe('audit mierky: vozidlá sú v pomere ku kontajneru a pruhu', () => {
  const carrierEmpty = readAsset('entities/straddle_carrier_empty.svg');
  const carrierLoaded = readAsset('entities/straddle_carrier_loaded.svg');
  const truckEmpty = readAsset('entities/truck_container_empty.svg');
  const truckLoaded = readAsset('entities/truck_container_loaded.svg');

  it('straddle carrier obkročí jeden kontajner: otvor medzi nohami je 26 px (TEU 24,8 + vôľa), šírka 34 px, dĺžka 60–62 px', () => {
    const legs = svgRects(carrierEmpty)
      .filter((rect) => rect.fill === '#F4D03F' && rect.height === 58) // bočné nosníky
      .map(outer)
      .sort((a, b) => a.left - b.left);
    expect(legs).toHaveLength(2);
    const opening = legs[1].left - legs[0].right;
    expect(opening).toBe(TEU_PX.h);
    const container = containerIn(carrierLoaded);
    expect(container.width).toBeLessThanOrEqual(opening);
    expect(contentExtent(carrierEmpty).width).toBe(CARRIER_WIDTH_PX);
    expect(contentExtent(carrierLoaded).width).toBe(CARRIER_WIDTH_PX);
    expect(contentExtent(carrierLoaded).height).toBe(CARRIER_LENGTH_PX);
    expect(contentExtent(carrierEmpty).height).toBeGreaterThanOrEqual(CARRIER_LENGTH_PX - 2);
    expect(contentExtent(carrierEmpty).height).toBeLessThanOrEqual(CELL);
  });

  it('kamión nesie jeden TEU: kontajner v návese 64 × 26; kamión 28 × 116 px, vycentrovaný v plátne 64 × 128', () => {
    const extent = contentExtent(truckEmpty);
    expect(extent.width).toBe(TRUCK_WIDTH_PX);
    expect(extent.height).toBe(TRUCK_LENGTH_PX);
    expect(extent.top + extent.bottom).toBe(viewBox(truckEmpty).h);
    expect((extent.left + extent.right) / 2).toBe(CELL / 2);
    expect(contentExtent(truckLoaded)).toEqual(extent);
    expect(TRUCK_LENGTH_PX / TEU_PX.w).toBeGreaterThan(1.5); // dlhší než kontajner (ťahač + podvozok)
  });

  it('kamión sa zmestí do jedného pruhu (presah ≤ 1 px), carrier ho presahuje o 4 px; obaja stoja na asfalte cesty', () => {
    expect(TRUCK_WIDTH_PX).toBeLessThanOrEqual(LANE_WIDTH_PX + 2);
    expect(laneOverhangPx(TRUCK_WIDTH_PX)).toBeLessThanOrEqual(1);
    expect(laneOverhangPx(CARRIER_WIDTH_PX)).toBeLessThanOrEqual(4);
    expect(CARRIER_WIDTH_PX).toBeLessThan(ROAD_ASPHALT_PX);
    expect(VEHICLE_WIDTH_PX).toBe(CARRIER_WIDTH_PX * VEHICLE_SCALE);
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

  it('F5b č. 10: kontajner pri naložení na carrier nemení veľkosť — vo vozidle aj na aprone má 62 × 24,4 px (pred opravou 41 % × 36 %)', () => {
    const inCarrier = containerIn(carrierLoaded);
    const inTruck = containerIn(truckLoaded);
    expect(inCarrier.width).toBeCloseTo(inTruck.width, 6);
    expect(inCarrier.height).toBeCloseTo(inTruck.height, 6);
    const onApron = { length: TEU_PX.w - 2, across: ((TEU_PX.h / 32) * 30) };
    expect(inCarrier.height).toBeCloseTo(onApron.length, 6);
    expect(Math.abs(inCarrier.width - onApron.across)).toBeLessThan(0.5);
    // pôvodná mierka 26 / 56 by kontajner v carrieri zmenšila na menej než polovicu
    expect((inCarrier.height * 26) / 56 / onApron.length).toBeLessThan(0.5);
  });
});

describe('audit mierky: cesty, lode a moduly', () => {
  it('cesta: dvojpruhový asfalt 52 px (pruh 26), úzka cesta 36 px = najširšie vozidlo + 2 px', () => {
    expect(ROAD_ASPHALT_PX).toBe(52);
    expect(LANE_WIDTH_PX).toBe(26);
    expect(NARROW_ASPHALT_PX).toBe(36);
    expect(NARROW_ASPHALT_PX).toBe(CARRIER_WIDTH_PX + 2);
    expect(NARROW_ASPHALT_PX).toBeGreaterThanOrEqual(TRUCK_WIDTH_PX);
  });

  it('lode: feeder 2 × 6 bunky, handy 2 × 10; brána 2 × 2, rampa 4 × 2 (dok 56 × 62 px), dvor 4 × 4, berth 8 × 3', () => {
    expect(shipSprite('feeder')!.footprint).toEqual({ w: 2, h: 6 });
    expect(shipSprite('handy')!.footprint).toEqual({ w: 2, h: 10 });
    expect(moduleSprite('truck_gate')!.footprint).toEqual({ w: 2, h: 2 });
    expect(moduleSprite('loading_ramp_container')!.footprint).toEqual({ w: 4, h: 2 });
    expect(moduleSprite('loading_ramp_container')!.docks![0]).toMatchObject({ w: 56, h: 62 });
    expect(moduleSprite('container_yard_small')!.footprint).toEqual({ w: 4, h: 4 });
    expect(moduleSprite('berth_standard')!.footprint).toEqual({ w: 8, h: 3 });
  });

  it('stojisko čakacej plochy 40 × 116 px a dok rampy 56 × 62 px: kamión (28 × 116) sa doň zmestí, zadok v doku a kabína von', () => {
    const stall = moduleSprite('truck_waiting_area')!.stalls![0];
    expect([stall.w, stall.h]).toEqual([40, 116]);
    expect(TRUCK_WIDTH_PX).toBeLessThanOrEqual(stall.w);
    expect(TRUCK_LENGTH_PX).toBeLessThanOrEqual(stall.h);
    const dock = moduleSprite('loading_ramp_container')!.docks![0];
    expect(TRUCK_WIDTH_PX).toBeLessThanOrEqual(dock.w);
    expect(dock.h).toBeLessThan(TRUCK_LENGTH_PX); // kabína presahuje z rampy
  });
});
