// Vjazd skladu `access: 'in'` na jednosmernej slepej ceste (TR5-02b, ADR-042 dodatok): vozidlo, ktoré tam odovzdá náklad, by z bunky nikdy neodišlo
// (jednosmerka nepokračuje) a zablokovalo by vjazd (`TrafficJam`). Stavba takého bloku sa odmietne (`connector_blocked`); priebežná cesta alebo dvojpruhová cesta prejde.
import { describe, expect, it } from 'vitest';
import { loadMap, parseMapDef } from '@sim/grid';
import { DefRegistry } from '@sim/defs';
import { World } from '@sim/world';
import { findPlacementViolations } from '@sim/world';
import { execute } from '../logistics/outbound-fixtures';
import { loadScenarioFile, readRepoJson } from '../helpers/scenario';
import { RAW_DEFS } from '../world/world-fixtures';

const IN_CELL = { x: 56, y: 18 };
const spec = { x: 53, y: 19, rotation: 0 } as const;

function violations(world: World): string[] {
  return findPlacementViolations(world, world.defs.modules.get('reefer_block_8'), spec, 'all').map((v) => v.rule);
}

function freshWorld(): World {
  const scenario = loadScenarioFile('live_terminal');
  return World.create(DefRegistry.fromRaw(RAW_DEFS), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
}

describe('vjazd skladu na jednosmernej slepej ceste', () => {
  it('jednosmerka, ktorá za vjazdom končí, blok odmietne; pokračovanie cesty alebo dvojpruhová cesta ho pustí', () => {
    const world = freshWorld();
    expect(violations(world)).toEqual([]);
    execute(world, { type: 'PlaceRoad', cells: [{ x: 55, y: 18 }, IN_CELL], kind: 'one_way', dirs: ['E', 'E'] });
    expect(violations(world)).toEqual(['connector_blocked']);
    execute(world, { type: 'PlaceRoad', cells: [{ x: 57, y: 18 }], kind: 'one_way', dirs: ['E'] });
    expect(violations(world)).toEqual([]);
  });

  it('dvojpruhová cesta na vjazde je v poriadku (vozidlo sa otočí)', () => {
    const world = freshWorld();
    execute(world, { type: 'PlaceRoad', cells: [{ x: 55, y: 18 }, IN_CELL] });
    expect(violations(world)).toEqual([]);
  });
});
