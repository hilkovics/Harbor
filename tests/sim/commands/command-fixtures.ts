// Spoločné pomôcky pre testy príkazov (T01-04). Bunky sa hľadajú v mape harbor_01 podľa vlastností
// (terén, parcela, cesta), nie natvrdo — okrem bunky (0, 54), ktorú pomenúva test (pôvodne (0, 11) z karty T01-04; Fáza 5b ju zmenila na more).
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { CellCoord, Cell } from '@sim/grid';
import { World } from '@sim/world';
import { BARE_MAP, DEFS, MAP, MAP_GRID, RAW_DEFS, SEED, findCell, hashState } from '../world/world-fixtures';

export { BARE_MAP, DEFS, MAP, SEED, findCell, hashState };

export const ROAD_COST = DEFS.infrastructure.road.costPerCellCents;
export const REFUND_RATE = DEFS.economy.removalRefundRate;
export const START_CASH = DEFS.economy.startingCashCents;

export function newWorld(defs: DefRegistry = DEFS): World {
  return World.create(defs, MAP, SEED);
}

/** Svet na harbor_01 bez Root modulu (T02-04) — príkazy modulov stavajú na (40, 14) samy. */
export function newBareWorld(defs: DefRegistry = DEFS): World {
  return World.create(defs, BARE_MAP, SEED);
}

/**
 * Defy s upravenou cenou dvojpruhovej cesty (aj jej alias `road.costPerCellCents`, ADR-020), cenou ďalších typov ciest
 * a/alebo mierou refundácie (ostatné hodnoty z data/defs).
 */
export function defsWith(options: {
  readonly roadCostPerCellCents?: number;
  readonly removalRefundRate?: number;
  readonly oneLaneCostPerCellCents?: number;
  readonly oneWayCostPerCellCents?: number;
}): DefRegistry {
  const { roadKinds } = infrastructureJson;
  const twoLaneCents = options.roadCostPerCellCents ?? roadKinds.two_lane.costPerCellCents;
  return DefRegistry.fromRaw({
    ...RAW_DEFS,
    economy: { ...economyJson, removalRefundRate: options.removalRefundRate ?? economyJson.removalRefundRate },
    infrastructure: {
      ...infrastructureJson,
      road: { ...infrastructureJson.road, costPerCellCents: twoLaneCents },
      roadKinds: {
        two_lane: { ...roadKinds.two_lane, costPerCellCents: twoLaneCents },
        one_lane: { ...roadKinds.one_lane, costPerCellCents: options.oneLaneCostPerCellCents ?? roadKinds.one_lane.costPerCellCents },
        one_way: { ...roadKinds.one_way, costPerCellCents: options.oneWayCostPerCellCents ?? roadKinds.one_way.costPerCellCents },
      },
    },
  });
}

const cellWhere = (predicate: (cell: Cell) => boolean): CellCoord => findCell(MAP_GRID, (cell) => predicate(cell));

/** Parcela na predaj (ownership `none`) — prvá v poradí mapy. */
export const FOR_SALE_PARCEL_ID = (() => {
  const parcel = MAP.parcels.find((p) => p.ownership === 'none');
  if (parcel === undefined) throw new Error('mapa nemá parcelu na predaj');
  return parcel.id;
})();

/** Druhá parcela na predaj (napr. na prenájom v teste `leased`). */
export const OTHER_FOR_SALE_PARCEL_ID = (() => {
  const parcel = MAP.parcels.filter((p) => p.ownership === 'none')[1];
  if (parcel === undefined) throw new Error('mapa nemá dve parcely na predaj');
  return parcel.id;
})();

/** Reprezentatívne bunky harbor_01 (všetky bez cesty, ak nie je uvedené inak). */
export const CELLS = {
  /** Verejná bunka pevniny menovaná v karte T01-04. */
  publicLandNamed: { x: 0, y: 54 },
  publicLand: cellWhere((c) => c.terrain === 'land' && c.parcelId === null && c.road === 'none'),
  publicQuay: cellWhere((c) => c.terrain === 'quay' && c.parcelId === null && c.road === 'none'),
  starterLand: cellWhere((c) => c.terrain === 'land' && c.parcelId === 'starter' && c.road === 'none'),
  starterQuay: cellWhere((c) => c.terrain === 'quay' && c.parcelId === 'starter' && c.road === 'none'),
  deepWater: cellWhere((c) => c.terrain === 'deep_water'),
  shallowWater: cellWhere((c) => c.terrain === 'shallow_water'),
  publicBlocked: cellWhere((c) => c.terrain === 'blocked' && c.parcelId === null),
  forSaleLand: cellWhere((c) => c.terrain === 'land' && c.parcelId === FOR_SALE_PARCEL_ID),
  forSaleBlocked: cellWhere((c) => c.terrain === 'blocked' && c.parcelId !== null && c.parcelId !== 'starter'),
  otherForSaleLand: cellWhere((c) => c.terrain === 'land' && c.parcelId === OTHER_FOR_SALE_PARCEL_ID),
  /** Bunka so starter cestou z mapy. */
  starterRoad: MAP.starter.roads[0],
} as const;

/** `count` rôznych voľných buniek pevniny na starter parcele v jednom riadku (x, x+1, …). */
export function starterRow(count: number): CellCoord[] {
  const { x, y } = CELLS.starterLand;
  return Array.from({ length: count }, (_, i) => ({ x: x + i, y }));
}

export function roadCount(world: World): number {
  let count = 0;
  for (let i = 0; i < world.grid.cellCount; i++) if (world.grid.atIndex(i).road === 'road') count += 1;
  return count;
}

/** Udalosti daného typu. */
export function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}
