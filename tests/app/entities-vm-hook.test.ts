// F6d (T6D-02): `CraneVM.hook` — stred bunky pod hákom, kde pri odovzdaní stojí vozidlo. Plní sa len pri kotvisku s jazdným nábrežím (režim
// `under_hook`); režim `apron` pole nemá (renderer nechá kontajner pod vozíkom).
import { describe, expect, it } from 'vitest';
import { World } from '@sim/world';
import { craneVMs } from '@app/entities-vm';
import { SEED, createWorld } from './app-fixtures';
import { BUNDLED_DEFS, MAP } from '../sim/world/world-fixtures';

describe('craneVMs: bunka pod hákom', () => {
  it('under_hook: hook = stred pevninského riadku footprintu žeriava na osi výložníka (root žeriav 2 × 3 na (43, 14) → (43,5; 16,5))', () => {
    const world = World.create(BUNDLED_DEFS, MAP, SEED);
    const [crane] = craneVMs(world);
    expect(crane).toMatchObject({ x: 43, y: 14, rotation: 0 });
    expect(crane?.hook).toEqual({ x: 43.5, y: 16.5 });
  });

  it('apron: žeriav nemá pole hook (správanie F2–F6c)', () => {
    const world = createWorld();
    const [crane] = craneVMs(world);
    expect(crane).toBeDefined();
    expect(crane).not.toHaveProperty('hook');
  });
});
