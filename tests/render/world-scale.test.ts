// F5b č. 10 — audit mierky celej hry (realistická mierka: 1 bunka ≈ 6 m, pruhy ostávajú). Čísla z tabuľky v docs/DESIGN_BRIEF.md §4.1
// sa tu overujú priamo proti SVG a manifestu, takže tabuľka nemôže potichu zastarať. Príčina chyby „vozík sa po naložení scvrkne“:
// sprity vozidiel sa škálovali na šírku pruhu (26 / 56 ≈ 0,46), zatiaľ čo kontajnery na aprone, pod žeriavom a na lodi majú mierku 1 —
// kontajner sa pri naložení zmenšil na menej než polovicu a pri vyložení zväčšil späť.
import { Container, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_CELL_PX,
  articulatedSprite,
  cargoDisplaySize,
  cargoSpriteEntry,
  moduleSprite,
  shipSprite,
  vehicleSprite,
} from '@render/entity-assets';
import { CargoSprite, cargoSizePx } from '@render/cargo-sprite';
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
  STRADDLE_BODY_PX,
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

/** Prvý `CargoSprite` v strome view (kontajner na vozidle). */
function findCargo(root: Container): CargoSprite {
  for (const child of root.children) {
    if (child instanceof CargoSprite) return child;
    if (child instanceof Container) {
      const nested = child.children.find((grandchild): grandchild is CargoSprite => grandchild instanceof CargoSprite);
      if (nested !== undefined) return nested;
    }
  }
  throw new Error('kontajner na vozidle chýba');
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
    // R1: kamión je kabína (1 × 1) + náves (1 × 2) = 3 bunky, straddle carrier 1 × 2 (nový sprite 52 × 102 px)
    expect(articulatedSprite('truck_container')!.footprint).toEqual({ w: 1, h: 3 });
    expect(TRUCK_LENGTH_PX).toBeLessThanOrEqual(2 * CELL);
    expect(vehicleSprite('straddle_carrier')!.footprint).toEqual({ w: 1, h: 2 });
    expect(STRADDLE_BODY_PX).toEqual({ w: 52, h: 102 });
    expect(CARRIER_LENGTH_PX).toBeLessThanOrEqual(CELL);
  });
});

describe('audit mierky: kontajner TEU je všade rovnako veľký (64 × 26 px)', () => {
  /** Sprite `cargo.container_teu` je nakreslený 64 × 32 px, renderer ho zmenší na šírku 26 px. */
  const canvas = viewBox(readAsset('cargo/container_teu.svg'));

  it('zobrazená veľkosť nákladu: kontajner 64 × 26 (jedno miesto, `cargoDisplaySize`), ostatný náklad z manifestu', () => {
    expect(canvas).toEqual({ w: 64, h: 32 });
    expect(cargoSpriteEntry('container_teu')!.size).toEqual({ w: 64, h: 32 });
    expect(cargoDisplaySize('container_teu')).toEqual(TEU_PX);
    expect(cargoDisplaySize('bulk_pile')).toEqual({ w: 32, h: 32 });
    expect(cargoDisplaySize('neznamy')).toBeUndefined();
  });

  it('kontajner na vozidle (kamión, straddle) kreslí hra cez CargoSprite v jednotnej veľkosti TEU 64 × 26, otočený dlhšou stranou v smere jazdy', () => {
    const textures = new StubTextures();
    const deps = { cellPx: PALETTE.cellPx, palette: ENTITY_PALETTE, textures };
    const carrier: VehicleVM = { id: 1, defId: 'straddle_carrier', x: 5.5, y: 5.5, prevX: 5.5, prevY: 5.5, heading: 0, loaded: true, state: 'to_dropoff' };
    const truck: TruckVM = { ...carrier, id: 2, defId: 'truck_container', state: 'to_gate' };
    for (const view of [new VehicleView(carrier, deps), new TruckView(truck, deps)]) {
      expect(view.cargoState).toBe('full');
      const cargo = findCargo(view.view);
      expect(cargo.angle).toBe(90);
      expect(cargo.visible).toBe(true);
      const size = cargoSizePx('container_teu', PALETTE.cellPx);
      expect([size.w, size.h]).toEqual([TEU_PX.w * (PALETTE.cellPx / CELL), TEU_PX.h * (PALETTE.cellPx / CELL)]);
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
  const carrier = readAsset('entities/straddle_carrier.svg');
  const cab = readAsset('entities/truck_cab.svg');
  const trailer = readAsset('entities/truck_trailer_40.svg');

  it('straddle carrier obkročí jeden kontajner: otvor medzi nosníkmi ≥ TEU (26 px), telo 52 × 102 px v plátne 64 × 128, stred je priehľadný', () => {
    const beams = svgRects(carrier)
      .filter((rect) => rect.fill === '#F4D03F' && rect.height === 102) // bočné nosníky
      .map(outer)
      .sort((a, b) => a.left - b.left);
    expect(beams).toHaveLength(2);
    const opening = beams[1].left - beams[0].right;
    expect(opening).toBeGreaterThanOrEqual(TEU_PX.h);
    expect(viewBox(carrier)).toEqual({ w: CELL, h: 2 * CELL });
    const extent = contentExtent(carrier);
    expect(extent.width).toBe(STRADDLE_BODY_PX.w + 2);
    expect(extent.height).toBeLessThanOrEqual(STRADDLE_BODY_PX.h + 2);
  });

  it('kamión: kabína 64 × 64 (točnica 32, 54) a náves 64 × 128 (čap 32, 4), telo 27 px; dokopy ≈ 3 bunky (čap prekrýva kabínu)', () => {
    expect(viewBox(cab)).toEqual({ w: CELL, h: CELL });
    expect(viewBox(trailer)).toEqual({ w: CELL, h: 2 * CELL });
    for (const svg of [cab, trailer]) {
      const extent = contentExtent(svg);
      expect(Math.abs(extent.width - TRUCK_WIDTH_PX)).toBeLessThanOrEqual(1);
    }
    const rig = articulatedSprite('truck_container')!;
    const span = rig.cab.pivot.y + (rig.trailer.footprint.h * CELL - rig.trailer.pivot.y);
    expect(span).toBeLessThanOrEqual(rig.footprint.h * CELL);
    expect(span).toBeGreaterThan(2.5 * CELL);
    expect(span / TEU_PX.w).toBeGreaterThan(1.5); // dlhší než kontajner (ťahač + podvozok)
  });

  it('kamión sa zmestí do jedného pruhu (presah ≤ 1 px), carrier ho presahuje o 4 px; obaja stoja na asfalte cesty', () => {
    expect(TRUCK_WIDTH_PX).toBeLessThanOrEqual(LANE_WIDTH_PX + 2);
    expect(laneOverhangPx(TRUCK_WIDTH_PX)).toBeLessThanOrEqual(1);
    expect(laneOverhangPx(CARRIER_WIDTH_PX)).toBeLessThanOrEqual(4);
    expect(CARRIER_WIDTH_PX).toBeLessThan(ROAD_ASPHALT_PX);
    expect(VEHICLE_WIDTH_PX).toBe(CARRIER_WIDTH_PX * VEHICLE_SCALE);
  });

  it('jediná mierka vozidiel: sprite carriera = footprint × bunka × VEHICLE_SCALE, v oboch stavoch rovnako; kabína a náves kamióna tiež', () => {
    const textures = new StubTextures();
    const deps = { cellPx: PALETTE.cellPx, palette: ENTITY_PALETTE, textures };
    const base: VehicleVM = { id: 1, defId: 'straddle_carrier', x: 5.5, y: 5.5, prevX: 5.5, prevY: 5.5, heading: 0, loaded: false, state: 'idle' };
    const view = new VehicleView(base, deps);
    const footprint = vehicleSprite('straddle_carrier')!.footprint;
    const sprite = view.view.children.find((child): child is Sprite => child instanceof Sprite)!;
    for (const loaded of [false, true]) {
      view.update({ ...base, loaded }, 1);
      expect(sprite.width).toBeCloseTo(footprint.w * PALETTE.cellPx * VEHICLE_SCALE, 9);
      expect(sprite.height).toBeCloseTo(footprint.h * PALETTE.cellPx * VEHICLE_SCALE, 9);
    }
    const truck = new TruckView({ ...base, id: 2, defId: 'truck_container', state: 'to_gate' }, deps);
    const rig = articulatedSprite('truck_container')!;
    for (const [group, part] of [
      [truck.cabView!, rig.cab],
      [truck.trailerView!, rig.trailer],
    ] as const) {
      const partSprite = group.children.find((child): child is Sprite => child instanceof Sprite)!;
      expect(partSprite.width).toBeCloseTo(part.footprint.w * PALETTE.cellPx * VEHICLE_SCALE, 9);
      expect(partSprite.height).toBeCloseTo(part.footprint.h * PALETTE.cellPx * VEHICLE_SCALE, 9);
    }
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

  it('lode: feeder 2 × 6 bunky, handy 2 × 10; pruh brány 1 × 4, predbránová plocha 8 × 8, odstavná plocha 6 × 5, dvor 4 × 4, berth 8 × 4', () => {
    expect(shipSprite('feeder')!.footprint).toEqual({ w: 2, h: 6 });
    expect(shipSprite('handy')!.footprint).toEqual({ w: 2, h: 10 });
    expect(moduleSprite('gate_in_lane')!.footprint).toEqual({ w: 1, h: 4 });
    expect(moduleSprite('gate_out_lane')!.footprint).toEqual({ w: 1, h: 4 });
    expect(moduleSprite('pre_gate_buffer')!.footprint).toEqual({ w: 8, h: 8 });
    expect(moduleSprite('truck_holding')!.footprint).toEqual({ w: 6, h: 5 });
    expect(moduleSprite('container_yard_small')!.footprint).toEqual({ w: 4, h: 4 });
    expect(moduleSprite('berth_standard')!.footprint).toEqual({ w: 8, h: 4 });
  });

  it('kamión (28 px široký) sa zmestí do pruhu brány aj do radu predbránovej plochy (1 bunka), státie odstavnej plochy je 1 × 3 bunky', () => {
    const cell = 64;
    expect(TRUCK_WIDTH_PX).toBeLessThanOrEqual(cell);
    const stall = moduleSprite('truck_holding')!.stallSize!;
    expect(stall.w * cell).toBeGreaterThanOrEqual(TRUCK_WIDTH_PX);
    expect(stall.h * cell).toBeGreaterThanOrEqual(TRUCK_LENGTH_PX);
    const lane = moduleSprite('pre_gate_buffer')!.parts!['lane']!.footprint!;
    expect(lane.h * cell).toBeGreaterThanOrEqual(2 * TRUCK_LENGTH_PX / 2); // dve miesta po 3 bunky v rade
  });
});
