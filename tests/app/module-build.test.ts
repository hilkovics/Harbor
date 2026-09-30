import { describe, expect, it } from 'vitest';
import { PlaceModuleCommand } from '@sim/commands';
import { ROTATIONS } from '@sim/grid';
import { nextRotation, placeCommand, placementAt, previewModule } from '@app/module-build';
import { createApp } from './app-fixtures';

const BERTH = 'berth_standard';
const CRANE = 'crane_container_gantry';

describe('nextRotation', () => {
  it('0 → 90 → 180 → 270 → 0', () => {
    expect(ROTATIONS.map(nextRotation)).toEqual([90, 180, 270, 0]);
  });
});

describe('placementAt (bunka pod kurzorom je stredom footprintu)', () => {
  const { world } = createApp();
  const berth = world.defs.modules.get(BERTH);
  const crane = world.defs.modules.get(CRANE);

  it('kotvisko 8×3: roh je o floor(w/2) = 4 doľava a floor(h/2) = 1 nahor', () => {
    expect(placementAt(berth, { x: 52, y: 15 }, 0)).toEqual({ defId: BERTH, x: 48, y: 14, rotation: 0 });
  });

  it('po rotácii o 90° sa rozmer otočí na 3×8: roh je 1 doľava a 4 nahor', () => {
    expect(placementAt(berth, { x: 52, y: 15 }, 90)).toEqual({ defId: BERTH, x: 51, y: 11, rotation: 90 });
    expect(placementAt(berth, { x: 52, y: 15 }, 180)).toEqual({ defId: BERTH, x: 48, y: 14, rotation: 180 });
    expect(placementAt(berth, { x: 52, y: 15 }, 270)).toEqual({ defId: BERTH, x: 51, y: 11, rotation: 270 });
  });

  it('žeriav 2×3: roh je o 1 doľava a 1 nahor', () => {
    expect(placementAt(crane, { x: 44, y: 15 }, 0)).toEqual({ defId: CRANE, x: 43, y: 14, rotation: 0 });
  });

  it('stred ghostu ostáva pod kurzorom pri každej rotácii (bunka leží vo footprinte)', () => {
    const cell = { x: 40, y: 30 };
    for (const rotation of ROTATIONS) {
      const placement = placementAt(berth, cell, rotation);
      const { w, h } = { w: rotation % 180 === 0 ? 8 : 3, h: rotation % 180 === 0 ? 3 : 8 };
      expect(cell.x).toBeGreaterThanOrEqual(placement.x);
      expect(cell.x).toBeLessThan(placement.x + w);
      expect(cell.y).toBeGreaterThanOrEqual(placement.y);
      expect(cell.y).toBeLessThan(placement.y + h);
    }
  });
});

describe('placeCommand', () => {
  it('serializuje ako PlaceModule s rohom po rotácii', () => {
    const command = placeCommand({ defId: BERTH, x: 48, y: 14, rotation: 0 });
    expect(command).toBeInstanceOf(PlaceModuleCommand);
    expect(command.toJSON()).toEqual({ type: 'PlaceModule', defId: BERTH, x: 48, y: 14, rotation: 0 });
  });
});

describe('previewModule', () => {
  const app = createApp();
  const validate = app.bridge.validate.bind(app.bridge);
  const berth = app.world.defs.modules.get(BERTH);

  it('voľné nábrežie: ghost platný, príkaz prejde, konektory vo svetových bunkách po rotácii', () => {
    const preview = previewModule(berth, { x: 52, y: 15 }, 0, validate);
    expect(preview.placeable).toBe(true);
    expect(preview.fundsShort).toBe(false);
    expect(preview.result).toMatchObject({ ok: true, costCents: 40_000_000 });
    expect(preview.ghost).toEqual({
      defId: BERTH,
      x: 48,
      y: 14,
      rotation: 0,
      w: 8,
      h: 3,
      valid: true,
      connectors: [
        { x: 49, y: 16, side: 's' },
        { x: 54, y: 16, side: 's' },
      ],
    });
  });

  it('pevnina: ghost neplatný, príkaz neprejde, dôvody zo simu', () => {
    const preview = previewModule(berth, { x: 35, y: 25 }, 0, validate);
    expect(preview.placeable).toBe(false);
    expect(preview.ghost.valid).toBe(false);
    expect(preview.result.reasons).toEqual(expect.arrayContaining(['terrain', 'no_water_side']));
  });

  it('len nedostatok peňazí: ghost ostáva platný (zelený), ale príkaz sa neodošle', () => {
    const poor = createApp();
    poor.world.cashCents = 1;
    const preview = previewModule(berth, { x: 52, y: 15 }, 0, poor.bridge.validate.bind(poor.bridge));
    expect(preview.result.reasons).toEqual(['insufficient_funds']);
    expect(preview.fundsShort).toBe(true);
    expect(preview.ghost.valid).toBe(true);
    expect(preview.placeable).toBe(false);
  });

  it('nedostatok peňazí + iný dôvod: ghost neplatný', () => {
    const poor = createApp();
    poor.world.cashCents = 1;
    const preview = previewModule(berth, { x: 35, y: 25 }, 0, poor.bridge.validate.bind(poor.bridge));
    expect(preview.fundsShort).toBe(true);
    expect(preview.ghost.valid).toBe(false);
  });

  it('validáciu robí iba cez odovzdanú funkciu (svet sa nemení)', () => {
    const cash = app.world.cashCents;
    const modules = app.world.modules.size;
    previewModule(berth, { x: 52, y: 15 }, 0, validate);
    expect(app.world.cashCents).toBe(cash);
    expect(app.world.modules.size).toBe(modules);
  });
});
