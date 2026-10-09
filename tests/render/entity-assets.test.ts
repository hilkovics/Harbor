import { Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { assetUrl } from '@render/asset-urls';
import { CargoSprite, cargoSizePx } from '@render/cargo-sprite';
import {
  BLOCKED_BADGE_FILE,
  LOADED_SHIP_VARIANTS,
  LOADED_STATE_MODULES,
  LOADED_VEHICLES,
  MANIFEST_CELL_PX,
  QUEUE_BADGE_FILE,
  QUEUE_BADGE_SIZE,
  WARNING_BADGE_FILE,
  articulatedSprite,
  brakeLightsSprite,
  cargoSpriteEntry,
  cargoTypeOfCategory,
  entitySpriteFiles,
  manifestScale,
  moduleSprite,
  shipSprite,
  vehicleSprite,
} from '@render/entity-assets';
import { TEU_PX } from '@render/world-scale';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

describe('záznamy manifestu pre entity', () => {
  it('berth_standard: footprint 8×4, 8 apron slotov (prvé štyri v strednom riadku pri žeriave), 2 južné a 6 pruhových konektorov (w / e)', () => {
    const berth = moduleSprite('berth_standard');
    expect(berth?.footprint).toEqual({ w: 8, h: 4 });
    expect(berth?.apronSlots).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 5, y: 1 },
      { x: 6, y: 1 },
      { x: 0, y: 1 },
      { x: 7, y: 1 },
      { x: 2, y: 2 },
      { x: 5, y: 2 },
    ]);
    expect(berth?.connectors.map((c) => c.side)).toEqual(['s', 's', 'w', 'w', 'w', 'e', 'e', 'e']);
  });

  it('lode feeder a handy majú varianty paluby; neznáma trieda a kľúče z prototypu objektu nie', () => {
    expect(shipSprite('feeder')?.footprint).toEqual({ w: 2, h: 6 });
    expect(shipSprite('handy')?.footprint).toEqual({ w: 2, h: 10 });
    expect(shipSprite('neexistuje')).toBeUndefined();
    expect(moduleSprite('constructor')).toBeUndefined();
    expect(moduleSprite('toString')).toBeUndefined();
    expect(cargoSpriteEntry('__proto__')).toBeUndefined();
  });

  it('gate_in_lane a gate_out_lane: 1×4, samostatná strecha a časti left / mid / right, konektory na juh a sever; závora pruhu s pivotom a uhlami', () => {
    for (const defId of ['gate_in_lane', 'gate_out_lane']) {
      const lane = moduleSprite(defId);
      expect(lane?.footprint, defId).toEqual({ w: 1, h: 4 });
      expect(lane?.file, defId).toBe(`modules/${defId}_single.svg`);
      expect(Object.keys(lane?.parts ?? {}).sort(), defId).toEqual(['left', 'mid', 'right']);
      expect(lane?.connectors.map((c) => c.side), defId).toEqual(['s', 'n']);
    }
    const barrier = moduleSprite('gate_lane_barrier')?.parts?.['barrier'];
    expect(barrier?.file).toBe('modules/gate_lane_barrier.svg');
    expect([barrier?.closedDeg, barrier?.openDeg]).toEqual([0, -90]);
  });

  it('pre_gate_buffer: 8×8 z pruhov `lane` (1×6); truck_holding: 6×5 so šiestimi státiami; zaniknuté moduly (truck_gate, truck_waiting_area, loading_ramp_*) v manifeste nie sú', () => {
    const buffer = moduleSprite('pre_gate_buffer');
    expect(buffer?.footprint).toEqual({ w: 8, h: 8 });
    expect(buffer?.parts?.['lane']?.footprint).toEqual({ w: 1, h: 6 });
    expect(moduleSprite('truck_holding')?.footprint).toEqual({ w: 6, h: 5 });
    for (const defId of ['truck_gate', 'truck_waiting_area', 'loading_ramp_container', 'loading_ramp_bulk']) expect(moduleSprite(defId), defId).toBeUndefined();
  });

  it('truck_container: kĺbová entita 1×3 z kabíny (1×1, točnica 32, 54) a návesu (1×2, čap 32, 4); nie je obyčajné vozidlo', () => {
    expect(vehicleSprite('truck_container')).toBeUndefined();
    const entry = articulatedSprite('truck_container');
    expect(entry?.footprint).toEqual({ w: 1, h: 3 });
    expect(entry?.cab).toEqual({ file: 'entities/truck_cab.svg', footprint: { w: 1, h: 1 }, pivot: { x: 32, y: 54 } });
    expect(entry?.trailer).toEqual({ file: 'entities/truck_trailer_40.svg', footprint: { w: 1, h: 2 }, pivot: { x: 32, y: 4 } });
  });

  it('straddle_carrier: jeden sprite 1×2 pre stavy empty aj loaded (kontajner kreslí hra); brzdové svetlá majú vlastný sprite', () => {
    const entry = vehicleSprite('straddle_carrier');
    expect(entry?.footprint).toEqual({ w: 1, h: 2 });
    expect(entry?.states).toEqual({ empty: 'entities/straddle_carrier.svg', loaded: 'entities/straddle_carrier.svg' });
    expect(brakeLightsSprite()).toEqual({ file: 'entities/vehicle_brake_lights.svg', footprint: { w: 1, h: 1 } });
  });

  it('queue_badge je 24×24 px a nesie číslo kreslené enginom', () => {
    expect(QUEUE_BADGE_SIZE).toEqual({ w: 24, h: 24 });
  });

  it('cargoTypeOfCategory: kategória → typ nákladu, neznáma / chýbajúca → kontajner', () => {
    expect(cargoTypeOfCategory('container')).toBe('container_teu');
    expect(cargoTypeOfCategory('bulk')).toBe('bulk_pile');
    expect(cargoTypeOfCategory('roro')).toBe('car');
    expect(cargoTypeOfCategory(undefined)).toBe('container_teu');
    expect(cargoTypeOfCategory('constructor')).toBe('container_teu');
  });

  it('container_teu je 64×32 px', () => {
    expect(cargoSpriteEntry('container_teu')?.size).toEqual({ w: 64, h: 32 });
  });

  it('manifestScale prepočíta px zdroja na aktuálnu veľkosť bunky', () => {
    expect(manifestScale(MANIFEST_CELL_PX)).toBe(1);
    expect(manifestScale(MANIFEST_CELL_PX / 2)).toBe(0.5);
    expect(PALETTE.cellPx).toBe(MANIFEST_CELL_PX);
  });
});

describe('entitySpriteFiles (čo načíta atlas)', () => {
  const files = entitySpriteFiles();

  it('každý súbor sa dá previesť na URL (je medzi zabalenými SVG; malý súbor Vite vloží ako data URL, ktorú Pixi tiež načíta)', () => {
    for (const file of files) expect(assetUrl(file), file).toMatch(/\.svg|^data:image\/svg\+xml/);
  });

  it('obsahuje berth, časti žeriava, kontajner, odznaky a container varianty feeder / handy', () => {
    for (const expected of [
      'modules/berth_standard.svg',
      'modules/crane_container_gantry_base.svg',
      'modules/crane_container_gantry_boom.svg',
      'modules/crane_container_gantry_trolley.svg',
      'cargo/container_teu.svg',
      BLOCKED_BADGE_FILE,
      WARNING_BADGE_FILE,
      'entities/ship_feeder_container_empty.svg',
      'entities/ship_feeder_container_loaded.svg',
      'entities/ship_handy_container_empty.svg',
      'entities/ship_handy_container_loaded.svg',
    ]) {
      expect(files, expected).toContain(expected);
    }
  });

  it('bez duplicít; z lodí iba varianty z LOADED_SHIP_VARIANTS', () => {
    expect(new Set(files).size).toBe(files.length);
    expect(LOADED_SHIP_VARIANTS).toEqual(['container']);
    const shipFiles = files.filter((file) => file.startsWith('entities/ship_'));
    expect(shipFiles.length).toBeGreaterThan(0);
    for (const file of shipFiles) expect(file).toMatch(/_container_(empty|loaded)\.svg$/);
  });

  it('F3: všetkých päť stavov malého kontajnerového dvora, depo a oba sprity straddle carrieru', () => {
    for (const expected of [
      'modules/container_yard_small_fill00.svg',
      'modules/container_yard_small_fill25.svg',
      'modules/container_yard_small_fill50.svg',
      'modules/container_yard_small_fill75.svg',
      'modules/container_yard_small_fill100.svg',
      'modules/vehicle_depot.svg',
      'entities/straddle_carrier.svg',
    ]) {
      expect(files, expected).toContain(expected);
    }
  });

  it('stavy skladov a vozidlá sa berú len z povoleného zoznamu (veľké sklady a ostatné vozidlá sa nerasterizujú)', () => {
    expect(LOADED_STATE_MODULES).toEqual(['container_yard_small', 'empty_depot']);
    expect(LOADED_VEHICLES).toEqual(['straddle_carrier', 'truck_container', 'empty_handler', 'terminal_tractor']);
    const fillFiles = files.filter((file) => /_fill\d+\.svg$/.test(file));
    expect(fillFiles).toHaveLength(10);
    for (const file of fillFiles) expect(file).toMatch(/^modules\/(container_yard_small|empty_depot)_fill\d+\.svg$/);
    const vehicleFiles = files.filter((file) => /^entities\/(?!ship_)/.test(file));
    expect(vehicleFiles.sort()).toEqual([
      'entities/ech.svg',
      'entities/ech_spreader_20.svg',
      'entities/ech_spreader_40.svg',
      'entities/rtg_frame.svg',
      'entities/rtg_trolley.svg',
      'entities/straddle_carrier.svg',
      'entities/terminal_tractor_cab.svg',
      'entities/terminal_tractor_chassis_40.svg',
      'entities/truck_cab.svg',
      'entities/truck_trailer_40.svg',
      'entities/vehicle_brake_lights.svg',
    ]);
  });

  it('R4: pruhy brány (strecha po častiach), závora pruhu, odznak fronty a časti kamióna (kabína + náves)', () => {
    for (const expected of [
      'modules/gate_in_lane_single.svg',
      'modules/gate_in_lane_left.svg',
      'modules/gate_out_lane_right.svg',
      'modules/gate_lane_barrier.svg',
      'modules/pre_gate_lane.svg',
      'modules/truck_holding.svg',
      QUEUE_BADGE_FILE,
      'entities/truck_cab.svg',
      'entities/truck_trailer_40.svg',
    ]) {
      expect(files, expected).toContain(expected);
    }
  });
});

describe('CargoSprite', () => {
  const deps = (textures: StubTextures | null) => ({ cellPx: PALETTE.cellPx, palette: ENTITY_PALETTE, textures });

  it('sprite z manifestu (64×32) vycentrovaný na počiatok a zobrazený v jednotnej veľkosti TEU 64×26 (× cell / 64)', () => {
    const textures = new StubTextures();
    const cargo = new CargoSprite(3, 'container_teu', deps(textures));
    expect(cargo.unitId).toBe(3);
    expect(cargo.typeId).toBe('container_teu');
    const sprite = cargo.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor('file/cargo/container_teu.svg'));
    expect(sprite.anchor.x).toBe(0.5);
    expect(sprite.width).toBeCloseTo(64 * manifestScale(PALETTE.cellPx), 6);
    expect(sprite.height).toBeCloseTo(26 * manifestScale(PALETTE.cellPx), 6);
    expect([TEU_PX.w, TEU_PX.h]).toEqual([64, 26]);
  });

  it('cargoSizePx: kontajner TEU 64 × 26 (jedno miesto, `TEU_PX`), ostatný náklad z manifestu, neznámy typ = kontajner TEU', () => {
    const unit = manifestScale(PALETTE.cellPx);
    expect(cargoSizePx('container_teu', PALETTE.cellPx)).toEqual({ w: 64 * unit, h: 26 * unit });
    expect(cargoSizePx('neznamy', PALETTE.cellPx)).toEqual({ w: 64 * unit, h: 26 * unit });
    expect(cargoSizePx('bulk_pile', PALETTE.cellPx)).toEqual({ w: 32 * unit, h: 32 * unit }); // nie kontajner: rozmer z manifestu
  });

  it('bez textúr alebo bez záznamu → `Graphics`', () => {
    expect(new CargoSprite(1, 'container_teu', deps(null)).children[0]).toBeInstanceOf(Graphics);
    expect(new CargoSprite(1, 'neznamy', deps(new StubTextures())).children[0]).toBeInstanceOf(Graphics);
  });
});
