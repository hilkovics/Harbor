import { describe, expect, it } from 'vitest';
import { loadBundledMap, type LoadedMap } from '@sim/grid';
import { starterParcelRect } from '@render/world-renderer';

describe('starterParcelRect', () => {
  it('harbor_01: obdĺžnik parcely `starter` (jediná `startOwned`)', () => {
    const map = loadBundledMap();
    const starter = map.parcels.find((parcel) => parcel.id === 'starter');
    expect(starter).toBeDefined();
    expect(starterParcelRect(map)).toEqual(starter?.rect);
  });

  it('mapa bez vlastnenej parcely → celá mapa', () => {
    const map = loadBundledMap();
    const noOwned: LoadedMap = { ...map, parcels: map.parcels.map((parcel) => ({ ...parcel, ownership: 'none' })) };
    expect(starterParcelRect(noOwned)).toEqual({ x: 0, y: 0, w: map.grid.width, h: map.grid.height });
  });
});
